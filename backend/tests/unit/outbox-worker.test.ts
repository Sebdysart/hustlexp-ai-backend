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
  processOutboxEvents,
} from '../../src/jobs/outbox-worker.js';

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
    let claimedIndex = 0;
    const txQuery = vi.fn().mockImplementation((_sql: string, params?: unknown[]) => {
      callIndex++;
      if (callIndex === 1) {
        // Expired pre-provider attempts that exhausted the dispatch budget.
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (callIndex === 2) {
        return Promise.resolve({ rows: selectRows, rowCount: selectRowCount });
      }
      const source = selectRows[claimedIndex++] as Record<string, unknown>;
      return Promise.resolve({
        rows: [{
          ...source,
          status: 'enqueued',
          attempts: params?.[1],
          bullmq_job_id: params?.[2],
          dispatch_attempt_id: params?.[3],
        }],
        rowCount: 1,
      });
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

function resolveQueueJob(state: string = 'waiting') {
  mockQueueAdd.mockImplementationOnce(
    async (...args: unknown[]) => ({
      id: (args[3] as { jobId?: string } | undefined)?.jobId,
      getState: vi.fn().mockResolvedValue(state),
    }),
  );
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
      resolveQueueJob();
      // db.query() outside the transaction: persist bullmq_job_id
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);

      // The only db.query() call outside the transaction should persist bullmq_job_id
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockDb.query.mock.calls[0];
      expect(sql).toContain('bullmq_job_id');
      expect(params).toContainEqual(expect.stringMatching(/^outbox-[0-9a-f]{64}$/));
      expect(params).toContain(event.id);
    });

    it('uses a fresh deterministic dispatch ID while retaining the provider idempotency key', async () => {
      const event = makeEvent({
        event_type: 'push.send_requested',
        aggregate_type: 'push',
        aggregate_id: 'notification-1',
        idempotency_key: 'push.send_requested:notification-1:1',
        queue_name: 'user_notifications',
        attempts: 1,
      });
      setupTransactionWithRows([event], 1);
      resolveQueueJob();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await processOutboxEvents(10);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'user_notifications',
        'push.send_requested',
        expect.objectContaining({
          outbox_idempotency_key: event.idempotency_key,
          outbox_dispatch_attempt_id: expect.any(String),
          outbox_bullmq_job_id: expect.stringMatching(/^outbox-[0-9a-f]{64}-dispatch-2$/),
        }),
        { jobId: expect.stringMatching(/^outbox-[0-9a-f]{64}-dispatch-2$/) },
      );
      const dispatchJobId = mockQueueAdd.mock.calls[0]?.[3]?.jobId;
      expect(dispatchJobId).not.toContain(':');
      expect(mockQueueAdd.mock.calls[0]?.[2]?.outbox_bullmq_job_id).toBe(dispatchJobId);
    });

    it('skips event (does not increment processed) when CAS UPDATE in tx returns rowCount=0', async () => {
      const event = makeEvent({ attempts: 0 });

      // Override: txQuery's CAS UPDATE returns rowCount=0 (another worker claimed it)
      mockTransaction.mockImplementationOnce(async (fn: (txQuery: unknown) => Promise<unknown>) => {
        let callIndex = 0;
        const txQuery = vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) return Promise.resolve({ rows: [], rowCount: 0 });
          if (callIndex === 2) {
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
          if (callIndex === 2) {
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
          if (callIndex === 1) return Promise.resolve({ rows: [], rowCount: 0 });
          if (callIndex === 2) {
            return Promise.resolve({ rows: [event], rowCount: 1 });
          }
          capturedCasSql = sql;
          return Promise.resolve({
            rows: [{ ...event, status: 'enqueued', attempts: 1, bullmq_job_id: event.idempotency_key, dispatch_attempt_id: '00000000-0000-4000-8000-000000000001' }],
            rowCount: 1,
          });
        });
        return fn(txQuery);
      });

      resolveQueueJob();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await processOutboxEvents(10);

      expect(capturedCasSql).toContain("status = 'enqueued'");
      expect(capturedCasSql).toContain("status = 'pending'");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Attempt-based retry logic
  // ──────────────────────────────────────────────────────────────────────────

  describe('durable dispatch lease recovery', () => {
    it('keeps the exact dispatch claim when queue.add has an ambiguous outcome', async () => {
      const event = makeEvent({ attempts: 0 });

      setupTransactionWithRows([event], 1);
      // queue.add() fails
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection refused'));
      // db.query() in catch block: reset status
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toMatchObject({
        eventId: 'event-001',
        error: 'Redis connection refused',
      });

      const updateCall = mockDb.query.mock.calls[0];
      const sql: string = updateCall[0];
      const params: unknown[] = updateCall[1];

      expect(sql).toContain('SET error_message = $1');
      expect(sql).toContain("status = 'enqueued'");
      expect(sql).toContain('dispatch_attempt_id = $3::UUID');
      expect(params[0]).toBe('Redis connection refused');
      expect(params[1]).toBe('event-001');
      expect(params[2]).toEqual(expect.any(String));
    });

    it('re-adds an expired ambiguous queue claim with the same retained job ID', async () => {
      const event = makeEvent({
        status: 'enqueued',
        attempts: 3,
        dispatch_attempt_id: '00000000-0000-4000-8000-000000000009',
        bullmq_job_id: 'retained-job-id',
        dispatch_deadline_at: new Date(0),
      });

      setupTransactionWithRows([event], 1);
      resolveQueueJob('waiting');
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        event.queue_name,
        event.event_type,
        expect.objectContaining({
          outbox_idempotency_key: event.idempotency_key,
          outbox_dispatch_attempt_id: event.dispatch_attempt_id,
          outbox_bullmq_job_id: event.bullmq_job_id,
        }),
        { jobId: 'retained-job-id' },
      );
    });

    it.each(['active', 'delayed', 'prioritized', 'unknown'])(
      'preserves the exact retained job ID while BullMQ reports %s',
      async (state) => {
        const event = makeEvent({
          status: 'enqueued',
          attempts: 2,
          dispatch_attempt_id: '00000000-0000-4000-8000-000000000029',
          bullmq_job_id: 'retained-nonterminal-job',
          dispatch_deadline_at: new Date(0),
        });

        setupTransactionWithRows([event], 1);
        resolveQueueJob(state);
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

        const result = await processOutboxEvents(10);

        expect(result).toMatchObject({ processed: 1, failed: 0 });
        expect(mockQueueAdd).toHaveBeenCalledTimes(1);
        expect(mockQueueAdd.mock.calls[0]?.[3]).toEqual({
          jobId: 'retained-nonterminal-job',
        });
      },
    );

    it.each(['completed', 'failed'])(
      'rotates a retained %s BullMQ job only after the atomic no-effect proof',
      async (state) => {
        const event = makeEvent({
          event_type: 'email.send_requested',
          aggregate_type: 'email',
          aggregate_id: '10000000-0000-4000-8000-000000000001',
          idempotency_key: 'email.send_requested:test:1',
          payload: { emailId: '10000000-0000-4000-8000-000000000001' },
          queue_name: 'user_notifications',
          status: 'enqueued',
          attempts: 3,
          dispatch_attempt_id: '00000000-0000-4000-8000-000000000039',
          bullmq_job_id: 'retained-terminal-job',
          dispatch_deadline_at: new Date(0),
        });

        setupTransactionWithRows([event], 1);
        resolveQueueJob(state);
        mockDb.query.mockResolvedValueOnce({
          rows: [{ ...event, status: 'enqueued', attempts: 4 }],
          rowCount: 1,
        } as any);
        resolveQueueJob('waiting');
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

        const result = await processOutboxEvents(10);

        expect(result).toMatchObject({ processed: 1, failed: 0 });
        expect(mockQueueAdd).toHaveBeenCalledTimes(2);
        expect(mockQueueAdd.mock.calls[0]?.[3]).toEqual({ jobId: 'retained-terminal-job' });
        expect(mockQueueAdd.mock.calls[1]?.[3]?.jobId).toMatch(
          /^outbox-[0-9a-f]{64}-dispatch-4$/,
        );
        expect(mockQueueAdd.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
          outbox_idempotency_key: event.idempotency_key,
          outbox_dispatch_attempt_id: expect.any(String),
          outbox_bullmq_job_id: mockQueueAdd.mock.calls[1]?.[3]?.jobId,
        }));
        expect(mockQueueAdd.mock.calls[1]?.[2]?.outbox_dispatch_attempt_id).not.toBe(
          event.dispatch_attempt_id,
        );

        const rotationSql = mockDb.query.mock.calls[0]?.[0] as string;
        expect(rotationSql).toContain("outbox.status = 'enqueued'");
        expect(rotationSql).toContain('outbox.dispatch_attempt_id = $2::UUID');
        expect(rotationSql).toContain('outbox.bullmq_job_id = $3');
        expect(rotationSql).toContain('outbox.pre_provider_claim_id IS NULL');
        expect(rotationSql).toContain('outbox.provider_io_started_at IS NULL');
        expect(rotationSql).toContain('email.notification_provider_attempt_id IS NULL');
        expect(rotationSql).toContain('email.provider_msg_id IS NULL');
        expect(rotationSql).toContain('email.sent_at IS NULL');
        expect(rotationSql).toContain('delivery.state NOT IN');
        expect(rotationSql).toContain('sms.provider_message_id IS NULL');
        expect(rotationSql).toContain('sms.twilio_sid IS NULL');
        expect(rotationSql).toContain('sms.provider_status IS NULL');
        expect(rotationSql).toContain("WHEN 'push.send_requested' THEN EXISTS");
      },
    );

    it('refuses to rotate a retained terminal job when the no-effect proof loses its CAS', async () => {
      const event = makeEvent({
        event_type: 'push.send_requested',
        aggregate_type: 'push',
        aggregate_id: '20000000-0000-4000-8000-000000000001',
        payload: { notificationId: '20000000-0000-4000-8000-000000000001' },
        queue_name: 'user_notifications',
        status: 'enqueued',
        attempts: 2,
        dispatch_attempt_id: '00000000-0000-4000-8000-000000000049',
        bullmq_job_id: 'retained-unsafe-job',
        dispatch_deadline_at: new Date(0),
      });

      setupTransactionWithRows([event], 1);
      resolveQueueJob('completed');
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await processOutboxEvents(10);

      expect(result).toMatchObject({ processed: 0, failed: 1 });
      expect(result.errors[0]?.error).toBe('retained_terminal_dispatch_not_safely_rotated');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    });

    it('repairs a legacy colon-delimited ambiguous job ID before re-adding it', async () => {
      const event = makeEvent({
        status: 'enqueued',
        attempts: 2,
        dispatch_attempt_id: '00000000-0000-4000-8000-000000000019',
        bullmq_job_id: 'notification:event:legacy',
        dispatch_deadline_at: new Date(0),
      });

      setupTransactionWithRows([event], 1);
      resolveQueueJob();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await processOutboxEvents(10);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        event.queue_name,
        event.event_type,
        expect.objectContaining({ outbox_idempotency_key: event.idempotency_key }),
        { jobId: expect.stringMatching(/^outbox-[0-9a-f]{64}-dispatch-2$/) },
      );
      expect(mockQueueAdd.mock.calls[0]?.[3]?.jobId).not.toContain(':');
    });

    it('issues a fresh dispatch ID after an expired pre-provider processing lease', async () => {
      const event = makeEvent({
        status: 'processing',
        attempts: 1,
        bullmq_job_id: 'completed-retained-job',
        pre_provider_claim_id: '00000000-0000-4000-8000-000000000008',
        pre_provider_claim_deadline_at: new Date(0),
        provider_io_started_at: null,
      });

      setupTransactionWithRows([event], 1);
      resolveQueueJob();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        event.queue_name,
        event.event_type,
        expect.objectContaining({ outbox_idempotency_key: event.idempotency_key }),
        { jobId: expect.stringMatching(/^outbox-[0-9a-f]{64}-dispatch-2$/) },
      );
      expect(mockQueueAdd.mock.calls[0]?.[3]?.jobId).not.toContain(':');
    });

    it('processes multiple events independently — one failure does not abort batch', async () => {
      const okEvent = makeEvent({ id: 'event-ok', attempts: 0 });
      const failEvent = makeEvent({ id: 'event-fail', attempts: 2 });

      // Transaction: SELECT returns two events; both CAS UPDATEs succeed
      setupTransactionWithRows([okEvent, failEvent], 2);

      // First event (ok): queue.add() succeeds → bullmq_job_id UPDATE
      resolveQueueJob();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // bullmq_job_id persist

      // Second event (fail): queue.add() fails → retry UPDATE
      mockQueueAdd.mockRejectedValueOnce(new Error('Queue unavailable'));
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // retry UPDATE

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
      resolveQueueJob();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await processOutboxEvents(10);

      // The payload passed to queue.add should contain the _sig field
      const jobData = mockQueueAdd.mock.calls[0][2];
      expect(jobData.payload).toHaveProperty('_sig', 'mock-signature');
    });
  });
});

describe('outbox callback dispatch fencing', () => {
  const authority = {
    dispatchAttemptId: '00000000-0000-4000-8000-000000000099',
    bullmqJobId: 'outbox-exact-job',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.transaction = mockTransaction;
  });

  it('marks processed only through the exact attempt/job CAS and reports a stale no-op', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const changed = await markOutboxEventProcessed('event:key', authority);

    expect(changed).toBe(false);
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain('dispatch_attempt_id = $2::UUID');
    expect(sql).toContain('bullmq_job_id = $3');
    expect(sql).toContain("status IN ('enqueued', 'processing')");
    expect(params).toEqual(['event:key', authority.dispatchAttemptId, authority.bullmqJobId]);
  });

  it('marks failed through the exact attempt/job CAS and never retries after provider I/O', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const changed = await markOutboxEventFailed('event:key', 'pre-provider failure', authority);

    expect(changed).toBe(true);
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain('dispatch_attempt_id = $5::UUID');
    expect(sql).toContain('bullmq_job_id = $6');
    expect(sql).toContain('provider_io_started_at IS NULL');
    expect(params).toEqual([
      'pre-provider failure',
      'event:key',
      5,
      false,
      authority.dispatchAttemptId,
      authority.bullmqJobId,
    ]);
  });

  it('supports exact terminal closure inside a caller-owned transaction', async () => {
    const txQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });

    const changed = await markOutboxEventFailed(
      'event:key',
      'channel_attempts_exhausted',
      authority,
      { terminal: true, query: txQuery },
    );

    expect(changed).toBe(true);
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(txQuery.mock.calls[0]?.[1]?.[3]).toBe(true);
  });
});
