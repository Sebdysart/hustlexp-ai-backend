/**
 * outbox-worker.test.ts
 *
 * Tests for processOutboxEvents — specifically covering:
 *  1. Successful enqueue → status set to 'enqueued' (inside tx), bullmq_job_id persisted (outside tx)
 *  2. queue.add() failure with attempts < 5 → status reset to 'pending' (retry-able)
 *  3. queue.add() failure with attempts = 4 (becomes 5) → status set to 'failed' (permanent)
 *
 * Transaction boundary (post-HHH-05 fix):
 *   db.transaction() now wraps BOTH the SELECT FOR UPDATE SKIP LOCKED *and* the
 *   CAS UPDATE (status='enqueued', attempts+1).  BullMQ queue.add() and the
 *   subsequent bullmq_job_id UPDATE run outside the transaction.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Mocks (must be declared before any imports that trigger module evaluation)
// ────────────────────────────────────────────────────────────────────────────

const { mockTransaction, mockQueueAdd } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockQueueAdd: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
    transaction: mockTransaction,
  },
}));

vi.mock('../../src/jobs/queues.js', () => ({
  enqueueJob: mockQueueAdd,
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
import {
  markOutboxEventFailed,
  markOutboxEventProcessed,
  markStripeEventOutboxesProcessed,
  processOutboxEvents,
} from '../../src/jobs/outbox-worker.js';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity.js';

const mockDb = vi.mocked(db);

/**
 * Wire mockTransaction so that calling db.transaction(fn) invokes fn with a
 * mock txQuery.  The txQuery returns the provided selectRows on its FIRST call
 * (the SELECT FOR UPDATE SKIP LOCKED) and then resolves with { rows: [],
 * rowCount: 1 } for every subsequent call (the per-event CAS UPDATEs).
 *
 * This mirrors the new transaction boundary introduced by the HHH-05 fix:
 *   txQuery call 1 → SELECT (returns events)
 *   txQuery call 2..N → CAS UPDATE per event (each returns rowCount=1)
 */
function setupTransactionWithRows(selectRows: unknown[], selectRowCount: number = selectRows.length) {
  mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
    let callIndex = 0;
    const txQuery = vi.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // First call: SELECT FOR UPDATE SKIP LOCKED
        return Promise.resolve({ rows: selectRows, rowCount: selectRowCount });
      }
      // Subsequent calls: CAS UPDATE per event — default success (rowCount=1)
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
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

function recoveryAck(event: ReturnType<typeof makeEvent>, status: 'pending' | 'failed', attempts: number) {
  return {
    rows: [{ idempotency_key: event.idempotency_key, status, attempts }],
    rowCount: 1,
  } as any;
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
    it("claims event inside the transaction, then persists bullmq_job_id outside", async () => {
      const event = makeEvent({ attempts: 0 });

      // Transaction: SELECT returns one event; CAS UPDATE succeeds (rowCount=1)
      setupTransactionWithRows([event], 1);
      // queue.add() succeeds
      mockQueueAdd.mockResolvedValueOnce({ id: 'bullmq-job-001' });
      // db.query() outside the transaction: persist bullmq_job_id
      mockDb.query.mockResolvedValueOnce(recoveryAck(event, 'pending', 1));

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);

      // The only db.query() call outside the transaction should persist bullmq_job_id
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockDb.query.mock.calls[0];
      expect(sql).toContain('bullmq_job_id');
      expect(params).toContain('bullmq-job-001');
      expect(params).toContain(event.id);
    });

    it('skips event (does not increment processed) when CAS UPDATE in tx returns rowCount=0', async () => {
      const event = makeEvent({ attempts: 0 });

      // Override: txQuery's CAS UPDATE returns rowCount=0 (another worker claimed it)
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) {
            return Promise.resolve({ rows: [event], rowCount: 1 });
          }
          // CAS UPDATE: already claimed
          return Promise.resolve({ rows: [], rowCount: 0 });
        });
        return fn(txQuery);
      });

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
      // No queue.add() should be called for an unclaimed event
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Concurrency guard — FOR UPDATE SKIP LOCKED inside transaction
  // ──────────────────────────────────────────────────────────────────────────

  describe('SELECT query uses FOR UPDATE SKIP LOCKED inside a transaction', () => {
    it('issues SELECT ... FOR UPDATE SKIP LOCKED via db.transaction()', async () => {
      let capturedSql = '';
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation((sql: string) => {
          callIndex++;
          if (callIndex === 1) {
            capturedSql = sql;
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        });
        return fn(txQuery);
      });

      await processOutboxEvents(10);

      expect(capturedSql).toContain('FOR UPDATE');
      expect(capturedSql).toContain('SKIP LOCKED');
      expect(capturedSql).toContain("status = 'pending'");
      expect(capturedSql).toContain('available_at <= NOW()');
      expect(capturedSql).toContain("status = 'enqueued'");
      expect(capturedSql).toContain("enqueued_at <= NOW() - INTERVAL '2 minutes'");
      expect(capturedSql).toContain('processed_at IS NULL');
      expect(capturedSql).toContain('ORDER BY created_at ASC');
      expect(capturedSql).toContain('LIMIT $1');
    });

    it('issues CAS UPDATE inside the same transaction (second txQuery call)', async () => {
      const event = makeEvent({ attempts: 0 });
      let capturedCasSql = '';

      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation((sql: string) => {
          callIndex++;
          if (callIndex === 1) {
            return Promise.resolve({ rows: [event], rowCount: 1 });
          }
          capturedCasSql = sql;
          return Promise.resolve({ rows: [], rowCount: 1 });
        });
        return fn(txQuery);
      });

      mockQueueAdd.mockResolvedValueOnce({ id: 'job-x' });
      mockDb.query.mockResolvedValueOnce(recoveryAck(event, 'pending', 4));

      await processOutboxEvents(10);

      expect(capturedCasSql).toContain("status = 'enqueued'");
      expect(capturedCasSql).toContain("status = 'pending'");
      expect(capturedCasSql).toContain("status = 'enqueued'");
      expect(capturedCasSql).toContain("enqueued_at <= NOW() - INTERVAL '2 minutes'");
      expect(capturedCasSql).toContain('AND attempts < $2');
    });

    it('reclaims a stale enqueued lease after a crash before queue.add', async () => {
      const staleClaim = makeEvent({
        status: 'enqueued',
        attempts: 1,
        enqueued_at: new Date('2026-08-25T19:00:00.000Z'),
        processed_at: null,
      });
      let capturedCasSql = '';
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation((sql: string) => {
          callIndex++;
          if (callIndex === 1) {
            return Promise.resolve({ rows: [staleClaim], rowCount: 1 });
          }
          capturedCasSql = sql;
          return Promise.resolve({ rows: [], rowCount: 1 });
        });
        return fn(txQuery);
      });
      const transportJobId = outboxTransportJobId(staleClaim.idempotency_key);
      mockQueueAdd.mockResolvedValueOnce({ id: transportJobId });
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result).toMatchObject({ processed: 1, failed: 0, errors: [] });
      expect(capturedCasSql).toContain("status = 'enqueued'");
      expect(capturedCasSql).toContain("enqueued_at <= NOW() - INTERVAL '2 minutes'");
      expect(mockQueueAdd).toHaveBeenCalledWith(
        staleClaim.queue_name,
        staleClaim.event_type,
        expect.any(Object),
        { jobId: transportJobId },
      );
    });

    it('fails an expired claim at the retry ceiling instead of replaying provider work', async () => {
      const exhausted = makeEvent({
        status: 'enqueued',
        attempts: 5,
        enqueued_at: new Date('2026-08-25T19:00:00.000Z'),
        processed_at: null,
      });
      let capturedFailureSql = '';
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation((sql: string) => {
          callIndex++;
          if (callIndex === 1) {
            return Promise.resolve({ rows: [exhausted], rowCount: 1 });
          }
          capturedFailureSql = sql;
          return Promise.resolve({
            rows: [{
              idempotency_key: exhausted.idempotency_key,
              status: 'failed',
              attempts: exhausted.attempts,
            }],
            rowCount: 1,
          });
        });
        return fn(txQuery);
      });

      const result = await processOutboxEvents(10);

      expect(result).toEqual({
        processed: 0,
        failed: 1,
        errors: [{
          eventId: exhausted.id,
          error: 'Outbox claim lease expired after maximum attempts',
        }],
      });
      expect(capturedFailureSql).toContain("SET status = 'failed'");
      expect(capturedFailureSql).toContain('AND attempts >= $2');
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Attempt-based retry logic
  // ──────────────────────────────────────────────────────────────────────────

  describe("retry logic when queue.add() throws", () => {
    it("resets status to 'pending' when attempts < 5 (below max)", async () => {
      // attempts=0 in DB; transaction increments to 1 (still < 5) → should become 'pending'
      const event = makeEvent({ attempts: 0 });

      setupTransactionWithRows([event], 1);
      // queue.add() fails
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection refused'));
      // db.query() in catch block: reset status
      mockDb.query.mockResolvedValueOnce(recoveryAck(event, 'pending', 1));

      const result = await processOutboxEvents(10);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({
        eventId: 'event-001',
        error: 'Redis connection refused',
      });

      // The catch-block db.query() should reset status using CASE expression
      const updateCall = mockDb.query.mock.calls[0];
      const sql: string = updateCall[0];
      const params: unknown[] = updateCall[1];

      expect(sql).toContain('CASE WHEN attempts <');
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
      mockDb.query.mockResolvedValueOnce(recoveryAck(event, 'pending', 4));

      const result = await processOutboxEvents(10);

      expect(result.failed).toBe(1);

      const updateCall = mockDb.query.mock.calls[0];
      const params: unknown[] = updateCall[1];
      // MAX_OUTBOX_ATTEMPTS still 5
      expect(params[0]).toBe(5);
      // attempts was 3 in DB; tx incremented to 4 (< 5) → SQL evaluates to 'pending'
    });

    it("permanently sets status to 'failed' when attempts=4 (would become 5, hitting max)", async () => {
      // attempts=4 in DB; transaction increments to 5, which is NOT < 5 → should become 'failed'
      const event = makeEvent({ attempts: 4 });

      setupTransactionWithRows([event], 1);
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis down'));
      mockDb.query.mockResolvedValueOnce(recoveryAck(event, 'failed', 5));

      const result = await processOutboxEvents(10);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({
        eventId: 'event-001',
        error: 'Redis down',
      });

      const updateCall = mockDb.query.mock.calls[0];
      const sql: string = updateCall[0];
      const params: unknown[] = updateCall[1];

      expect(sql).toContain('CASE WHEN attempts <');
      expect(params[0]).toBe(5);
      // attempts=4 in DB; tx incremented to 5, NOT < 5 → SQL evaluates to 'failed'
      expect(params[2]).toBe('event-001');
    });

    it('processes multiple events independently — one failure does not abort batch', async () => {
      const okEvent = makeEvent({ id: 'event-ok', attempts: 0 });
      const failEvent = makeEvent({ id: 'event-fail', attempts: 2 });

      // Transaction: SELECT returns two events; both CAS UPDATEs succeed
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) {
            return Promise.resolve({ rows: [okEvent, failEvent], rowCount: 2 });
          }
          // CAS UPDATEs for both events succeed
          return Promise.resolve({ rows: [], rowCount: 1 });
        });
        return fn(txQuery);
      });

      // First event (ok): queue.add() succeeds → bullmq_job_id UPDATE
      mockQueueAdd.mockResolvedValueOnce({ id: 'job-ok' });
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // bullmq_job_id persist

      // Second event (fail): queue.add() fails → retry UPDATE
      mockQueueAdd.mockRejectedValueOnce(new Error('Queue unavailable'));
      mockDb.query.mockResolvedValueOnce(recoveryAck(failEvent, 'pending', 3)); // retry UPDATE

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors[0].eventId).toBe('event-fail');
    });

    it('never downgrades a processed ACK when it wins an ambiguous enqueue-failure race', async () => {
      const event = makeEvent({ attempts: 1 });
      setupTransactionWithRows([event], 1);
      mockQueueAdd.mockRejectedValueOnce(new Error('ambiguous Redis timeout'));
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({
          rows: [{
            idempotency_key: event.idempotency_key,
            status: 'processed',
            attempts: 2,
            error_message: null,
          }],
          rowCount: 1,
        } as any);

      const result = await processOutboxEvents(10);

      expect(result).toEqual({ processed: 1, failed: 0, errors: [] });
      const [recoverySql,recoveryParams] = mockDb.query.mock.calls[0];
      expect(recoverySql).toContain("AND status = 'enqueued'");
      expect(recoverySql).toContain('AND attempts = $4');
      expect(recoveryParams).toEqual([5,'ambiguous Redis timeout',event.id,2]);
      expect(String(mockDb.query.mock.calls[1][0])).toContain('SELECT idempotency_key,status,attempts');
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
      mockDb.query.mockResolvedValueOnce(recoveryAck(event, 'pending', 1));

      const result = await processOutboxEvents(10);

      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe('Unknown error');
    });

    it('surfaces a fatal SELECT error to the poll-level failure boundary', async () => {
      // db.transaction() itself throws (e.g. connection failure)
      mockTransaction.mockRejectedValueOnce(new Error('DB unavailable'));

      await expect(processOutboxEvents(10)).rejects.toThrow('DB unavailable');
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

      const transportJobId = outboxTransportJobId(financialEvent.idempotency_key);
      expect(transportJobId).toMatch(/^hxoutbox-[a-f0-9]{64}$/u);
      expect(transportJobId).not.toContain(':');
      expect(mockQueueAdd).toHaveBeenCalledWith(
        financialEvent.queue_name,
        financialEvent.event_type,
        expect.any(Object),
        { jobId: transportJobId },
      );
      // The queue payload retains the durable key inside the signed envelope;
      // ACKs never attempt to reverse the transport hash.
      const jobData = mockQueueAdd.mock.calls[0][2];
      expect(jobData.payload).toHaveProperty('_outbox_key', financialEvent.idempotency_key);
      expect(jobData.payload).toHaveProperty('_sig', 'mock-signature');
    });
  });
});

describe('authoritative outbox acknowledgements', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.transaction = mockTransaction;
  });

  it('returns only an exact processed acknowledgement', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ idempotency_key: 'escrow.released:escrow-1', status: 'processed', attempts: 2 }],
      rowCount: 1,
    } as any);

    await expect(markOutboxEventProcessed('escrow.released:escrow-1')).resolves.toEqual({
      idempotency_key: 'escrow.released:escrow-1', status: 'processed', attempts: 2,
    });
    expect(String(mockDb.query.mock.calls[0][0])).toContain('RETURNING idempotency_key,status,attempts');
  });

  it('returns pending for a transient failure below the attempt ceiling', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ idempotency_key: 'escrow.released:escrow-1', status: 'pending', attempts: 4 }],
      rowCount: 1,
    } as any);

    await expect(markOutboxEventFailed(
      'escrow.released:escrow-1', 'transient database failure',
    )).resolves.toMatchObject({ status: 'pending', attempts: 4 });
  });

  it('returns failed only when the authoritative attempt ceiling is exhausted', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ idempotency_key: 'escrow.released:escrow-1', status: 'failed', attempts: 5 }],
      rowCount: 1,
    } as any);

    await expect(markOutboxEventFailed(
      'escrow.released:escrow-1', 'immutable witness conflict',
    )).resolves.toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('never downgrades an authoritative processed row on a late duplicate failure', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ idempotency_key: 'escrow.released:escrow-1', status: 'processed', attempts: 5 }],
      rowCount: 1,
    } as any);

    await expect(markOutboxEventFailed(
      'escrow.released:escrow-1', 'late duplicate failed after another worker converged',
    )).resolves.toMatchObject({ status: 'processed', attempts: 5 });
    expect(String(mockDb.query.mock.calls[0][0])).toContain("WHEN status = 'processed' THEN 'processed'");
  });

  it('terminally fails only an already-claimed row after BullMQ exhausts retries', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ idempotency_key: 'escrow.released:escrow-1', status: 'failed', attempts: 1 }],
      rowCount: 1,
    } as any);

    await expect(markOutboxEventFailed(
      'escrow.released:escrow-1',
      'BullMQ exhausted release reconciliation',
      { terminal: true, requireClaimed: true },
    )).resolves.toMatchObject({ status: 'failed', attempts: 1 });
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(String(sql)).toContain("status IN ('enqueued','processing','failed','processed')");
    expect(params).toEqual([
      'BullMQ exhausted release reconciliation', 'escrow.released:escrow-1', true,
    ]);
  });

  it('rejects terminal failure when no claimed authoritative row exists', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(markOutboxEventFailed(
      'escrow.released:escrow-1',
      'unsigned injected job',
      { terminal: true, requireClaimed: true },
    )).rejects.toThrow('OUTBOX_ACK_MISSING');
  });

  it('rejects a missing or contradictory acknowledgement row', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    await expect(markOutboxEventProcessed('escrow.released:missing'))
      .rejects.toThrow('OUTBOX_ACK_MISSING');

    mockDb.query.mockResolvedValueOnce({
      rows: [{ idempotency_key: 'escrow.released:escrow-1', status: 'failed', attempts: 2 }],
      rowCount: 1,
    } as any);
    await expect(markOutboxEventFailed('escrow.released:escrow-1', 'transient'))
      .rejects.toThrow('OUTBOX_ACK_MISSING');
  });
});

describe('Stripe event canonical and recovery outbox acknowledgements', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.transaction = mockTransaction;
  });

  it.each([
    'stripe.event_received:evt_ack',
    'stripe.event_received.recovery:evt_ack:1787668800000',
  ])('uses %s as exact signed authority and converges every sibling', async (signedKey) => {
    const canonicalKey = 'stripe.event_received:evt_ack';
    const recoveryKey = 'stripe.event_received.recovery:evt_ack:1787668800000';
    let transactionQuery: ReturnType<typeof vi.fn> | undefined;
    mockTransaction.mockImplementationOnce(async (fn: (query: unknown) => Promise<unknown>) => {
      transactionQuery = vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            idempotency_key: signedKey,
            status: 'enqueued',
            attempts: 2,
            event_type: 'stripe.event_received',
            aggregate_type: 'stripe_event',
            aggregate_id: 'evt_ack',
            queue_name: 'critical_payments',
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            { idempotency_key: recoveryKey, status: 'processed', attempts: 1 },
            { idempotency_key: canonicalKey, status: 'processed', attempts: 2 },
          ],
          rowCount: 2,
        });
      return fn(transactionQuery);
    });

    await expect(markStripeEventOutboxesProcessed({
      idempotencyKey: signedKey,
      stripeEventId: 'evt_ack',
    })).resolves.toEqual({
      signed: {
        idempotency_key: signedKey,
        status: 'processed',
        attempts: signedKey === canonicalKey ? 2 : 1,
      },
      acknowledgedKeys: [canonicalKey, recoveryKey].sort(),
    });

    expect(String(transactionQuery?.mock.calls[0]?.[0])).toContain('FOR UPDATE');
    expect(transactionQuery?.mock.calls[0]?.[1]).toEqual([signedKey]);
    expect(String(transactionQuery?.mock.calls[1]?.[0])).toContain(
      "status IN ('pending','enqueued','processing','processed','failed')",
    );
    expect(transactionQuery?.mock.calls[1]?.[1]).toEqual(['evt_ack']);
  });

  it.each([
    ['missing signed row', []],
    ['pending unclaimed row', [{
      idempotency_key: 'stripe.event_received:evt_ack',
      status: 'pending',
      attempts: 0,
      event_type: 'stripe.event_received',
      aggregate_type: 'stripe_event',
      aggregate_id: 'evt_ack',
      queue_name: 'critical_payments',
    }]],
    ['wrong aggregate binding', [{
      idempotency_key: 'stripe.event_received:evt_ack',
      status: 'enqueued',
      attempts: 1,
      event_type: 'stripe.event_received',
      aggregate_type: 'stripe_event',
      aggregate_id: 'evt_other',
      queue_name: 'critical_payments',
    }]],
    ['wrong queue binding', [{
      idempotency_key: 'stripe.event_received:evt_ack',
      status: 'enqueued',
      attempts: 1,
      event_type: 'stripe.event_received',
      aggregate_type: 'stripe_event',
      aggregate_id: 'evt_ack',
      queue_name: 'notifications',
    }]],
  ])('rejects %s without acknowledging siblings', async (_label, authorityRows) => {
    let transactionQuery: ReturnType<typeof vi.fn> | undefined;
    mockTransaction.mockImplementationOnce(async (fn: (query: unknown) => Promise<unknown>) => {
      transactionQuery = vi.fn().mockResolvedValueOnce({
        rows: authorityRows,
        rowCount: authorityRows.length,
      });
      return fn(transactionQuery);
    });

    await expect(markStripeEventOutboxesProcessed({
      idempotencyKey: 'stripe.event_received:evt_ack',
      stripeEventId: 'evt_ack',
    })).rejects.toThrow('OUTBOX_ACK_MISSING');

    expect(transactionQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects an update result that omits the exact signed delivery row', async () => {
    mockTransaction.mockImplementationOnce(async (fn: (query: unknown) => Promise<unknown>) => {
      const transactionQuery = vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            idempotency_key: 'stripe.event_received:evt_ack',
            status: 'enqueued',
            attempts: 1,
            event_type: 'stripe.event_received',
            aggregate_type: 'stripe_event',
            aggregate_id: 'evt_ack',
            queue_name: 'critical_payments',
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{
            idempotency_key: 'stripe.event_received.recovery:evt_ack:1787668800000',
            status: 'processed',
            attempts: 1,
          }],
          rowCount: 1,
        });
      return fn(transactionQuery);
    });

    await expect(markStripeEventOutboxesProcessed({
      idempotencyKey: 'stripe.event_received:evt_ack',
      stripeEventId: 'evt_ack',
    })).rejects.toThrow('did not converge');
  });
});
