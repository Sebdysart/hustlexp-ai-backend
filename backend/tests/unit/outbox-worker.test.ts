/**
 * outbox-worker.test.ts
 *
 * Tests for processOutboxEvents — specifically covering:
 *  1. Successful enqueue → status set to 'enqueued'
 *  2. queue.add() failure with attempts < 5 → status reset to 'pending' (retry-able)
 *  3. queue.add() failure with attempts = 4 (becomes 5) → status set to 'failed' (permanent)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Mocks (must be declared before any imports that trigger module evaluation)
// ────────────────────────────────────────────────────────────────────────────

const { mockTransaction } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
    transaction: mockTransaction,
  },
}));

const mockQueueAdd = vi.fn();
vi.mock('../../src/jobs/queues.js', () => ({
  getQueue: vi.fn(() => ({ add: mockQueueAdd })),
  signJobPayload: vi.fn(() => 'mock-signature'),
}));

vi.mock('../../src/logger.js', () => {
  const base = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => base,
  };
  return {
    logger: base,
    workerLogger: base,
  };
});

// ────────────────────────────────────────────────────────────────────────────
// Imports (after mocks)
// ────────────────────────────────────────────────────────────────────────────

import { db } from '../../src/db.js';
import { processOutboxEvents } from '../../src/jobs/outbox-worker.js';

const mockDb = vi.mocked(db);

/**
 * Wire mockTransaction so that calling db.transaction(fn) invokes fn with a
 * mock txQuery that returns the provided rows, then resolves with that result.
 * This mirrors what db.transaction() does in production.
 */
function setupTransactionWithRows(rows: unknown[], rowCount: number = rows.length) {
  mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows, rowCount });
    return fn(txQuery);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-001',
    event_type: 'escrow.funded',
    aggregate_type: 'escrow',
    aggregate_id: 'escrow-001',
    event_version: 1,
    idempotency_key: 'escrow.funded:escrow-001:v1',
    payload: { amount: 5000 },
    queue_name: 'escrow',
    status: 'pending',
    enqueued_at: null,
    processed_at: null,
    error_message: null,
    attempts: 0,
    bullmq_job_id: null,
    created_at: new Date(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('processOutboxEvents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-attach mockTransaction after resetAllMocks clears it
    mockDb.transaction = mockTransaction;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Success path
  // ──────────────────────────────────────────────────────────────────────────

  describe('successful enqueue', () => {
    it("sets status to 'enqueued' when queue.add() succeeds", async () => {
      const event = makeEvent({ attempts: 0 });

      // SELECT returns one pending event (inside transaction with FOR UPDATE SKIP LOCKED)
      setupTransactionWithRows([event], 1);
      // queue.add() succeeds, returns a job with an id
      mockQueueAdd.mockResolvedValueOnce({ id: 'bullmq-job-001' });
      // UPDATE status='enqueued' succeeds (rowCount=1 → no skip)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify the UPDATE used 'enqueued' status (now calls[0] — SELECT is in transaction)
      const updateCall = mockDb.query.mock.calls[0];
      expect(updateCall[0]).toContain("status = 'enqueued'");
      expect(updateCall[1]).toContain('bullmq-job-001');
      expect(updateCall[1]).toContain(event.id);
    });

    it('skips event (does not increment processed) when another worker already claimed it (rowCount=0)', async () => {
      const event = makeEvent({ attempts: 0 });

      setupTransactionWithRows([event], 1);
      mockQueueAdd.mockResolvedValueOnce({ id: 'bullmq-job-002' });
      // rowCount=0 → another worker already set status away from 'pending'
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Concurrency guard — FOR UPDATE SKIP LOCKED
  // ──────────────────────────────────────────────────────────────────────────

  describe('SELECT query uses FOR UPDATE SKIP LOCKED inside a transaction', () => {
    it('issues SELECT ... FOR UPDATE SKIP LOCKED via db.transaction()', async () => {
      let capturedSql = '';
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        const txQuery = vi.fn().mockImplementationOnce((sql: string) => {
          capturedSql = sql;
          return Promise.resolve({ rows: [], rowCount: 0 });
        });
        return fn(txQuery);
      });

      await processOutboxEvents(10);

      expect(capturedSql).toContain('FOR UPDATE');
      expect(capturedSql).toContain('SKIP LOCKED');
      expect(capturedSql).toContain("WHERE status = 'pending'");
      expect(capturedSql).toContain('ORDER BY created_at ASC');
      expect(capturedSql).toContain('LIMIT $1');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Attempt-based retry logic
  // ──────────────────────────────────────────────────────────────────────────

  describe("retry logic when queue.add() throws", () => {
    it("resets status to 'pending' when attempts < 5 (below max)", async () => {
      // attempts=0 → after increment = 1, which is < 5 → should become 'pending'
      const event = makeEvent({ attempts: 0 });

      setupTransactionWithRows([event], 1);
      // queue.add() fails
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection refused'));
      // UPDATE (catch block)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({
        eventId: 'event-001',
        error: 'Redis connection refused',
      });

      // Verify the CASE expression used MAX_OUTBOX_ATTEMPTS=5 as $1
      // calls[0] is the retry UPDATE (SELECT is in transaction, no prior db.query calls)
      const updateCall = mockDb.query.mock.calls[0];
      const sql: string = updateCall[0];
      const params: unknown[] = updateCall[1];

      expect(sql).toContain('CASE WHEN attempts + 1 <');
      expect(sql).toContain("THEN 'pending'");
      expect(sql).toContain("ELSE 'failed'");
      // $1 = MAX_OUTBOX_ATTEMPTS (5)
      expect(params[0]).toBe(5);
      // $2 = error message
      expect(params[1]).toBe('Redis connection refused');
      // $3 = event id
      expect(params[2]).toBe('event-001');
    });

    it("resets status to 'pending' when attempts=3 (still below max of 5)", async () => {
      const event = makeEvent({ attempts: 3 });

      setupTransactionWithRows([event], 1);
      mockQueueAdd.mockRejectedValueOnce(new Error('Queue timeout'));
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.failed).toBe(1);

      const updateCall = mockDb.query.mock.calls[0];
      const params: unknown[] = updateCall[1];
      // MAX_OUTBOX_ATTEMPTS still 5
      expect(params[0]).toBe(5);
      // attempts=3 → attempts+1=4 < 5 → SQL evaluates to 'pending'
    });

    it("permanently sets status to 'failed' when attempts=4 (would become 5, hitting max)", async () => {
      // attempts=4 → after increment = 5, which is NOT < 5 → should become 'failed'
      const event = makeEvent({ attempts: 4 });

      setupTransactionWithRows([event], 1);
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis down'));
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({
        eventId: 'event-001',
        error: 'Redis down',
      });

      const updateCall = mockDb.query.mock.calls[0];
      const sql: string = updateCall[0];
      const params: unknown[] = updateCall[1];

      // CASE expression is present with correct MAX value
      expect(sql).toContain('CASE WHEN attempts + 1 <');
      expect(params[0]).toBe(5);
      // attempts=4 → attempts+1=5, NOT < 5 → SQL evaluates to 'failed'
      expect(params[2]).toBe('event-001');
    });

    it('processes multiple events independently — one failure does not abort batch', async () => {
      const okEvent = makeEvent({ id: 'event-ok', attempts: 0 });
      const failEvent = makeEvent({ id: 'event-fail', attempts: 2 });

      // SELECT returns two events (inside transaction)
      setupTransactionWithRows([okEvent, failEvent], 2);
      // First event: queue.add() succeeds
      mockQueueAdd.mockResolvedValueOnce({ id: 'job-ok' });
      // UPDATE enqueued for first event
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      // Second event: queue.add() fails
      mockQueueAdd.mockRejectedValueOnce(new Error('Queue unavailable'));
      // UPDATE (retry logic) for second event
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors[0].eventId).toBe('event-fail');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns zero counts when no pending events', async () => {
      setupTransactionWithRows([], 0);

      const result = await processOutboxEvents(50);

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('handles non-Error throws gracefully', async () => {
      const event = makeEvent({ attempts: 0 });

      setupTransactionWithRows([event], 1);
      mockQueueAdd.mockRejectedValueOnce('string error');
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe('Unknown error');
    });

    it('handles fatal SELECT error gracefully (outer catch)', async () => {
      // db.transaction() itself throws (e.g. connection failure)
      mockTransaction.mockRejectedValueOnce(new Error('DB unavailable'));

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('signs financial event payloads with HMAC', async () => {
      const financialEvent = makeEvent({
        event_type: 'escrow.release_requested',
        queue_name: 'escrow',
        attempts: 0,
      });

      setupTransactionWithRows([financialEvent], 1);
      mockQueueAdd.mockResolvedValueOnce({ id: 'job-financial' });
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await processOutboxEvents(10);

      // The payload passed to queue.add should contain the _sig field
      const jobData = mockQueueAdd.mock.calls[0][1];
      expect(jobData.payload).toHaveProperty('_sig', 'mock-signature');
    });
  });
});
