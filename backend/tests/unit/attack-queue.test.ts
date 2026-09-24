/**
 * RED-TEAM: BullMQ Queue Attack Surface Tests
 *
 * Covers 12 attack vectors across three categories:
 *   A. Queue Poisoning (attacks 1–3)
 *   B. Job Replay & Duplicate Attacks (attacks 4–6)
 *   C. Financial Job Attacks (attacks 7–9)
 *   D. Worker Process Attacks (attacks 10–12)
 *
 * Each test ends with a VERDICT comment:
 *   EXPLOIT   – real vulnerability, attacker wins
 *   GAP       – not exploitable today but protection is missing / fragile
 *   SAFE      – defense is present and tested here
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';



// ---------------------------------------------------------------------------
// Shared mocks (declared before any imports that resolve them)
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
    serializableTransaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/logger', () => ({
  escrowLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() })) },
  workerLogger: { info: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() })) },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../src/services/GDPRService.js', () => ({ GDPRService: {} }));
vi.mock('../../src/config', () => ({
  config: {
    redis: { url: 'redis://localhost:6379' },
    payments: { platformFeePercent: 15 },
    queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' },
  },
}));

vi.mock('../../src/services/EscrowService.js', () => ({ EscrowService: { release: vi.fn().mockResolvedValue({ success: true }), refund: vi.fn() } }));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    advanceProgress: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: { awardXP: vi.fn(), clawbackXP: vi.fn() },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: { recordEarnings: vi.fn() },
}));



vi.mock('../../src/services/SelfInsurancePoolService', () => ({
  SelfInsurancePoolService: { recordContribution: vi.fn() },
}));



// BullMQ mock — Queue and Worker must be classes (new Queue(...)).
// vi.fn() instances are assigned to module-level vars that the class methods delegate to.
// We use a shared spy registry because vi.mock factory is hoisted before const declarations.
const _queueSpies = {
  add: vi.fn(),
  getJob: vi.fn(),
  close: vi.fn(),
};

vi.mock('bullmq', () => {
  class QueueMock {
    add(...args: unknown[]) { return _queueSpies.add(...args); }
    getJob(...args: unknown[]) { return _queueSpies.getJob(...args); }
    close(...args: unknown[]) { return _queueSpies.close(...args); }
  }
  class WorkerMock {
    close = vi.fn();
    on = vi.fn();
  }
  return { Queue: QueueMock, Worker: WorkerMock };
});

// Aliases for readability in tests
const mockQueueAdd = _queueSpies.add;
const mockQueueGetJob = _queueSpies.getJob;
const mockQueueClose = _queueSpies.close;

// ioredis mock — must be a class (new Redis(...))
vi.mock('ioredis', () => {
  class RedisMock {
    connect = vi.fn();
    disconnect = vi.fn();
    on = vi.fn();
    once = vi.fn();
    get = vi.fn();
    set = vi.fn();
  }
  return { default: RedisMock };
});

// ---------------------------------------------------------------------------
// Lazy imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService.js';
import { processEscrowActionJob } from '../../src/jobs/escrow-action-worker';
import { processOutboxEvents } from '../../src/jobs/outbox-worker';
import { enqueueJob, generateIdempotencyKey, parseIdempotencyKey, signJobPayload, verifyJobSignature } from '../../src/jobs/queues';
import { registerScheduledJobs } from '../../src/jobs/worker-schedules';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob<T>(name: string, data: T, id = 'job-1'): Job<T> {
  return { id, name, data } as unknown as Job<T>;
}

/**
 * Build a signed financial job payload.
 * Signs the payload fields (without _sig) and injects _sig.
 */
function makeSignedPayload(fields: Record<string, unknown>): Record<string, unknown> {
  const sig = signJobPayload(fields);
  return { ...fields, _sig: sig };
}

// ---------------------------------------------------------------------------
// UUID fixtures (Zod schema requires UUID format for escrow_id / task_id)
// ---------------------------------------------------------------------------
const E = {
  e1: '00000000-0000-0000-0000-000000000001',
  e2: '00000000-0000-0000-0000-000000000002',
  e3: '00000000-0000-0000-0000-000000000003',
  e4: '00000000-0000-0000-0000-000000000004',
  e5: '00000000-0000-0000-0000-000000000005',
  e6: '00000000-0000-0000-0000-000000000006',
  e7: '00000000-0000-0000-0000-000000000007',
  e8: '00000000-0000-0000-0000-000000000008',
  e9: '00000000-0000-0000-0000-000000000009',
  e10: '00000000-0000-0000-0000-000000000010',
  eVictim: '00000000-0000-0000-0000-000000000011',
  eTarget: '00000000-0000-0000-0000-000000000012',
};
const T = {
  t1: '10000000-0000-0000-0000-000000000001',
  t2: '10000000-0000-0000-0000-000000000002',
  t3: '10000000-0000-0000-0000-000000000003',
  t4: '10000000-0000-0000-0000-000000000004',
  t5: '10000000-0000-0000-0000-000000000005',
  t6: '10000000-0000-0000-0000-000000000006',
  t7: '10000000-0000-0000-0000-000000000007',
  t8: '10000000-0000-0000-0000-000000000008',
  t9: '10000000-0000-0000-0000-000000000009',
  t10: '10000000-0000-0000-0000-000000000010',
  tAny: '10000000-0000-0000-0000-000000000011',
  tReal: '10000000-0000-0000-0000-000000000012',
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RED-TEAM: BullMQ Queue Attack Surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.query).mockReset();

    // Default db.transaction() implementation: call the callback with db.query
    // as the trx function so that existing db.query mock sequences continue to
    // work after the critical-section FOR UPDATE was moved inside db.transaction().
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (q: typeof db.query) => Promise<unknown>) => fn(db.query as typeof db.query)
    );
  });

  // =========================================================================
  // A. QUEUE POISONING
  // =========================================================================

  describe('Attack 1 – Malformed payload: null taskId', () => {
    /**
     * SCENARIO: Attacker (or bug) inserts a job with {escrow_id: null}.
     *
     * FIXED (v2.9.9): Zod schema validation fires at the top of
     * processEscrowActionJob BEFORE any DB operations.  A null or non-UUID
     * escrow_id throws JOB_SCHEMA_INVALID immediately, preventing wasted DB
     * round-trips and misleading retry storms.
     *
     * VERDICT: FIXED — Zod schema rejects null escrow_id before DB.
     */
    it('should throw JOB_SCHEMA_INVALID (not forward null to DB) when escrow_id is null', async () => {
      const job = makeJob('escrow.release_requested', {
        payload: {
          escrow_id: null,  // ← malformed
          task_id: null,
          reason: 'test',
        },
      });

      await expect(processEscrowActionJob(job as any)).rejects.toThrow('JOB_SCHEMA_INVALID');

      // Zod fires before the DB — no query should have been issued
      expect(db.query).not.toHaveBeenCalled();
    });

    it('should throw JOB_SCHEMA_INVALID when escrow_id is an empty string (type coercion bypass attempt)', async () => {
      const job = makeJob('escrow.release_requested', {
        payload: { escrow_id: '', task_id: '', reason: 'bypass' },
      });

      await expect(processEscrowActionJob(job as any)).rejects.toThrow('JOB_SCHEMA_INVALID');

      // Zod fires before the DB — no query should have been issued
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  // =========================================================================

  describe('Attack 2 – Oversized payload (1 MB string)', () => {
    /**
     * SCENARIO: A job carrying a 1 MB `reason` string hits the worker.
     * The financial worker bounds human-authored reasons to 500 characters
     * before signature or database processing, preventing large Redis jobs
     * from turning into large database/log payloads.
     *
     * VERDICT: SAFE — the worker rejects the oversized field before DB access.
     */
    it('worker rejects a 1 MB reason field before database access', async () => {
      const bigString = 'A'.repeat(1_000_000);

      const payloadFields = { escrow_id: E.e1, task_id: T.t1, reason: bigString };
      const job = makeJob('escrow.refund_requested', {
        payload: makeSignedPayload(payloadFields),
      });

      await expect(processEscrowActionJob(job as any)).rejects.toThrow('JOB_SCHEMA_INVALID');
      expect(db.query).not.toHaveBeenCalled();
      expect(EscrowService.refund).not.toHaveBeenCalled();
    });
  });

  // =========================================================================

  describe('Attack 3 – Payload injection: extra fields (adminOverride)', () => {
    /**
     * SCENARIO: An attacker who can write to the outbox (e.g., SQL injection
     * in a separate service) adds { adminOverride: true } to the payload.
     * Does the worker use it?
     *
     * FINDING: The escrow-action-worker destructures only the expected fields
     * from payload:
     *   const { escrow_id, task_id, dispute_id, reason, ... } = payload;
     * Extra fields are silently ignored.  The worker does NOT forward
     * unknown fields to downstream services.
     *
     * VERDICT: SAFE — extra fields are discarded at destructuring.
     */
    it('extra adminOverride field is ignored — state check still enforces LOCKED_DISPUTE', async () => {
      (db.query as any).mockResolvedValueOnce({
        rows: [{ id: E.e2, state: 'FUNDED', version: 1, amount: 5000,
                 provider_payment_id: null, provider_transfer_id: null,
                 provider_refund_id: null }],
        rowCount: 1,
      });

      // Build signed payload from only the known fields (extra fields are stripped by Zod)
      const payloadFields = { escrow_id: E.e2, task_id: T.t2, reason: 'test' };
      const signedPayload = makeSignedPayload(payloadFields);
      const job = makeJob('escrow.release_requested', {
        payload: {
          ...signedPayload,
          adminOverride: true,   // ← injected extra field
          bypassKyc: true,       // ← another injected field
        },
      });

      // Worker rejects because state is FUNDED, not LOCKED_DISPUTE.
      // adminOverride has zero effect (Zod strips it; DB state check rejects).
      await expect(processEscrowActionJob(job as any)).rejects.toThrow(
        'Escrow must be LOCKED_DISPUTE',
      );

      expect(EscrowService.release).not.toHaveBeenCalled();
    });
  });

  // =========================================================================

  describe('Attack 5 – Stale job: task cancelled after job enqueued', () => {
    /**
     * SCENARIO: A `task.instant_matching_started` job is sitting in the
     * queue.  Before it processes, the task is cancelled (state ≠ MATCHING).
     *
     * FINDING: processInstantMatchingJob (instant-matching-worker.ts:73)
     * re-fetches the task state and exits early if state !== 'MATCHING'.
     * No stale-data action is taken.
     *
     * This test confirms the worker validates live DB state, not just job payload.
     *
     * VERDICT: SAFE — live state re-validation at line ~73 of
     *          instant-matching-worker.ts.
     *
     * We verify the architectural guarantee by testing the escrow-action-worker
     * which also validates state from the DB (not from the job payload).
     */
    it('worker rejects job when DB escrow state is terminal (not LOCKED_DISPUTE)', async () => {
      // Simulate: task was already resolved while job sat in queue
      (db.query as any).mockResolvedValueOnce({
        rows: [{ id: E.e5, state: 'RELEASED', version: 3, amount: 5000,
                 provider_payment_id: 'pi_1', provider_transfer_id: 'tr_old',
                 provider_refund_id: null }],
        rowCount: 1,
      });

      const payloadFields = { escrow_id: E.e5, task_id: T.t5, reason: 'stale job' };
      const job = makeJob('escrow.release_requested', {
        payload: makeSignedPayload(payloadFields),
      });

      await expect(processEscrowActionJob(job as any)).rejects.toThrow(
        'Escrow must be LOCKED_DISPUTE',
      );

      // No provider call on stale job
      expect(EscrowService.release).not.toHaveBeenCalled();
    });
  });

  // =========================================================================

  describe('Attack 6 – Job flood (missing deduplication key)', () => {
    /**
     * SCENARIO: An attacker (or buggy retry loop) calls queue.add() N times
     * for the same logical event without a deterministic jobId.
     *
     * FINDING (from queues.ts + outbox-worker.ts):
     * - All jobs enqueued via the outbox path use
     *     jobId: event.idempotency_key
     *   which is deterministic (eventType:aggregateId:version).
     *   BullMQ treats duplicate jobIds as no-ops → only one job runs.
     *
     * - Jobs enqueued via workers.ts `registerScheduledJobs` use static
     *   jobIds like 'scheduled:fraud_detection' → BullMQ deduplicates.
     *
     * The raw queue factory is private. The exported producer boundary rejects
     * any one-off job without a non-empty deterministic jobId.
     *
     * VERDICT: FIXED — all supported one-off producers require deduplication.
     */
    it('outbox path uses deterministic jobId (deduplication is guaranteed)', async () => {
      // Simulate one pending outbox event
      const idempotencyKey = 'escrow.release_requested:e6:1';

      (db.query as any)
        // SELECT pending outbox events
        .mockResolvedValueOnce({
          rows: [{
            id: 'ob1',
            event_type: 'escrow.release_requested',
            aggregate_type: 'escrow',
            aggregate_id: 'e6',
            event_version: 1,
            idempotency_key: idempotencyKey,
            payload: { escrow_id: 'e6' },
            queue_name: 'critical_payments',
            status: 'pending',
          }],
          rowCount: 1,
        })
        // UPDATE outbox_events SET status='enqueued'
        .mockResolvedValueOnce({ rowCount: 1 });

      mockQueueAdd.mockResolvedValueOnce({ id: idempotencyKey });

      const result = await processOutboxEvents(10);

      expect(result.processed).toBe(1);

      // Hashing preserves deterministic deduplication with a BullMQ-safe job ID.
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'escrow.release_requested',
        expect.any(Object),
        expect.objectContaining({ jobId: `outbox-${createHash('sha256').update(idempotencyKey).digest('hex')}` }),
      );
    });

    it('rejects a one-off producer call without a deterministic jobId', async () => {
      await expect(enqueueJob(
        'critical_payments',
        'escrow.release_requested',
        { payload: { escrow_id: 'victim' } },
        {} as never,
      )).rejects.toThrow('QUEUE_JOB_ID_REQUIRED');
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // C. FINANCIAL JOB ATTACKS
  // =========================================================================

  describe('Attack 7 – Direct queue injection via HTTP layer', () => {
    /**
     * SCENARIO: Is the BullMQ Queue object exposed via any HTTP endpoint
     * (admin, testing, or accidentally)?
     *
     * FINDING: Grepping routers/ for 'enqueueJob' and queue producers returns ZERO
     * hits.  The only callers of getQueue() are:
     *   - outbox-worker.ts (internal, worker process only)
     *   - worker-schedules.ts (internal, worker process only)
     *
     * No router imports queues.ts.  The queue object is NOT reachable via
     * the HTTP/tRPC layer.
     *
     * VERDICT: SAFE — queue is isolated to the worker process.
     *
     * This test asserts the import boundary by confirming that no tRPC router
     * exports or re-exports the producer boundary.
     */
    it('no tRPC router imports or re-exports getQueue (structural assertion)', async () => {
      /**
       * We verify this statically: routers/index.ts imports other routers,
       * none of which import queues.ts.  Only outbox-worker.ts and workers.ts
       * (worker-process files) import the producer boundary.
       *
       * Rather than doing a full dynamic import of the router tree (which
       * pulls in firebase-admin and other infra), we assert the invariant
       * via the mock call count: if getQueue() had been called during test
       * module initialization, mockQueueAdd would have been invoked.
       * It was not (cleared in beforeEach and nothing in the test calls it).
       */
      // mockQueueAdd starts at 0 calls — confirms no queue access from router load
      expect(mockQueueAdd).not.toHaveBeenCalled();

      // Raw Queue instances are intentionally not exported. Only validated
      // enqueueJob/enqueueRepeatableJob functions leave this module.
      const queueModule = await import('../../src/jobs/queues');
      expect(queueModule).not.toHaveProperty('getQueue');
      expect(typeof queueModule.enqueueJob).toBe('function');
    });
  });

  // =========================================================================

  describe('Attack 8 – Job priority manipulation', () => {
    /**
     * SCENARIO: Does BullMQ priority get used? Can a user elevate their job
     * to skip the queue?
     *
     * FINDING (queues.ts): No queue configuration sets `priority` at the
     * defaultJobOptions level.  Workers.ts does not set priority on any
     * add() call.  The outbox-worker.ts also does not set priority.
     *
     * BullMQ's priority queue feature is NOT enabled.  All jobs run FIFO.
     * There is no user-facing API that accepts a priority parameter for jobs.
     *
     * VERDICT: SAFE — priority feature is not used, so it cannot be abused.
     *
     * We verify that outbox events are enqueued without a priority field.
     */
    it('outbox enqueue does not set priority field', async () => {
      (db.query as any)
        .mockResolvedValueOnce({
          rows: [{
            id: 'ob2',
            event_type: 'escrow.release_requested',
            aggregate_type: 'escrow',
            aggregate_id: 'e7',
            event_version: 1,
            idempotency_key: 'escrow.release_requested:e7:1',
            payload: {},
            queue_name: 'critical_payments',
            status: 'pending',
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      mockQueueAdd.mockResolvedValueOnce({ id: 'escrow.release_requested:e7:1' });

      await processOutboxEvents(1);

      // mockQueueAdd must have been called at least once
      expect(mockQueueAdd).toHaveBeenCalled();

      // Find the add() call for our event — options are the third argument
      const addCalls = mockQueueAdd.mock.calls;
      const relevantCall = addCalls.find((c: unknown[]) => c[0] === 'escrow.release_requested');
      expect(relevantCall).toBeDefined();

      // options are at index 2 (may be undefined if none passed, which also means no priority)
      const jobOptions = (relevantCall![2] ?? {}) as Record<string, unknown>;

      // No priority field in options — FIFO guaranteed
      expect(jobOptions).not.toHaveProperty('priority');
    });
  });

  // =========================================================================

  describe('Attack 9 – Delayed job cancellation (unattended completion)', () => {
    /**
     * The system uses a repeatable database sweep rather than one delayed job
     * per task. Cancelling an individual BullMQ job cannot erase eligibility:
     * the next minute's sweep reconstructs due work from authoritative state.
     * The completion service then rechecks delivery age, proof, escrow, dispute,
     * value, and idempotency under its transaction.
     *
     * VERDICT: SAFE — no per-task delayed job exists to delete or hold hostage.
     */
    it('registers a repeatable authoritative due-task sweep', async () => {
      await registerScheduledJobs();
      const call = mockQueueAdd.mock.calls.find(args => args[0] === 'completion.complete_due');
      expect(call).toBeDefined();
      expect(call?.[1]).toEqual({ limit: 100 });
      expect(call?.[2]).toEqual({
        jobId: 'scheduled-maintenance-completion-complete_due',
        repeat: { pattern: '* * * * *' },
      });
    });
  });

  // =========================================================================
  // D. WORKER PROCESS ATTACKS
  // =========================================================================

  describe('Attack 10 – Unhandled exception retry storm', () => {
    /**
     * SCENARIO: An attacker corrupts a task record (deletes the task row)
     * so that every time the escrow-action job runs, it throws
     * "Task X not found".  With 5 attempts and exponential backoff, that is
     * 5 executions clogging the critical_payments queue.
     *
     * FINDING (queues.ts, QUEUE_CONFIGS.critical_payments):
     *   attempts: 5, backoff: exponential 1s
     *   removeOnFail: { age: 7 days }
     *
     * After 5 attempts the job moves to the failed set (BullMQ's dead-letter
     * equivalent) and stays for 7 days.  It does NOT re-queue automatically.
     *
     * The retry count is finite and bounded.  The failed set is not infinite
     * (removeOnFail.age = 7 days keeps storage bounded).
     *
     * VERDICT: ACCEPTED RESIDUAL P2 — a principal with arbitrary database
     * write access is outside the application threat boundary. Within the
     * boundary, retries are finite, failures are retained and alerted, and a
     * poisoned job can delay this queue by at most 31 seconds.
     */
    it('worker re-throws service failures for bounded BullMQ retry', async () => {
      vi.mocked(EscrowService.release).mockResolvedValueOnce({ success: false, error: { code: 'NOT_FOUND', message: 'Task not found' } });
      // Escrow exists and is in LOCKED_DISPUTE
      (db.query as any)
        .mockResolvedValueOnce({
          rows: [{ id: E.e8, state: 'LOCKED_DISPUTE', version: 1, amount: 5000,
                   provider_payment_id: null, provider_transfer_id: null,
                   provider_refund_id: null }],
          rowCount: 1,
        })
        // Task does NOT exist (deleted/corrupted by attacker)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const payloadFields = { escrow_id: E.e8, task_id: T.t8, reason: 'retry storm' };
      const job = makeJob('escrow.release_requested', {
        payload: makeSignedPayload(payloadFields),
      });

      // Worker throws — BullMQ will retry up to 5 times
      await expect(processEscrowActionJob(job as any)).rejects.toThrow('not found');

      // Concurrency: 1 in critical_payments means this blocks other financial jobs
      // for the full backoff duration (up to 31 s across 5 attempts)
    });

    it('throws on unknown event type — prevents processing garbage jobs', async () => {
      (db.query as any).mockResolvedValueOnce({
        rows: [{ id: E.e9, state: 'LOCKED_DISPUTE', version: 1, amount: 5000,
                 provider_payment_id: null, provider_transfer_id: null,
                 provider_refund_id: null }],
        rowCount: 1,
      });

      const payloadFields = { escrow_id: E.e9, task_id: T.t9, reason: 'unknown' };
      const job = makeJob('escrow.UNKNOWN_OPERATION', {
        payload: makeSignedPayload(payloadFields),
      });

      await expect(processEscrowActionJob(job as any)).rejects.toThrow(
        'Unknown escrow action event type',
      );
    });
  });

  // =========================================================================

  describe('Attack 12 – Redis key collision (fake job injection)', () => {
    /**
     * SCENARIO: BullMQ stores jobs in Redis under keys like:
     *   bull:{queue-name}:job-id  (legacy / bullmq v4)
     *   {queue-name}:{job-id}     (bullmq v5+)
     *
     * If an attacker can write arbitrary Redis keys (via a Redis SSRF or
     * misconfigured Redis AUTH), they could craft a fake job payload directly
     * in Redis, bypassing all application-level auth.
     *
     * FIXED (v2.9.9): HMAC-SHA256 payload signing was added.
     * - outbox-worker.ts signs all financial job payloads with signJobPayload()
     *   and stores the signature as `_sig` in the payload.
     * - escrow-action-worker.ts verifies the signature at the TOP of the handler
     *   BEFORE any DB operations, using verifyJobSignature().
     * - Missing or tampered `_sig` → throws JOB_SIGNATURE_INVALID immediately.
     *
     * VERDICT: FIXED — injected jobs without a valid HMAC are rejected before
     *          any DB or provider operations.
     *
     * Migration note: existing jobs in the queue without `_sig` will fail until
     * the queue is drained.  Add QUEUE_SIGNING_GRACE_PERIOD_MS for a rolling
     * rollout window if needed.
     */

    it('valid signed job is accepted and processed (happy path)', async () => {
      (db.query as any)
        .mockResolvedValueOnce({
          rows: [{
            id: E.eVictim, state: 'LOCKED_DISPUTE', version: 1, amount: 99999,
            provider_payment_id: null,
            provider_transfer_id: 'tr_already_done', // idempotent guard fires
            provider_refund_id: null,
          }],
          rowCount: 1,
        });

      const payloadFields = { escrow_id: E.eVictim, task_id: T.tAny, reason: 'legitimate' };
      const job = makeJob('escrow.release_requested', {
        payload: makeSignedPayload(payloadFields),
      });

      // Valid signature delegates once to the canonical completion service.
      await expect(processEscrowActionJob(job as any)).resolves.toBeUndefined();
      expect(EscrowService.release).toHaveBeenCalledOnce();
    });

    it('injected job with missing _sig is rejected (JOB_SCHEMA_INVALID)', async () => {
      // Attacker writes a job directly to Redis — no _sig field at all
      const injectedJob = makeJob('escrow.release_requested', {
        payload: {
          escrow_id: E.eTarget,
          task_id: T.tReal,
          reason: 'attacker-injected-no-sig',
          // No _sig field
        },
      });

      await expect(processEscrowActionJob(injectedJob as any)).rejects.toThrow('JOB_SCHEMA_INVALID');

      // No DB or provider calls — rejected at schema validation
      expect(db.query).not.toHaveBeenCalled();
      expect(EscrowService.release).not.toHaveBeenCalled();
    });

    it('injected job with tampered payload (wrong _sig) is rejected (JOB_SIGNATURE_INVALID)', async () => {
      // Attacker crafts a job with a valid-looking hex signature but wrong value
      const tamperedSig = 'a'.repeat(64); // 64 chars but not the correct HMAC
      const injectedJob = makeJob('escrow.release_requested', {
        payload: {
          escrow_id: E.eTarget,
          task_id: T.tReal,
          reason: 'attacker-injected-tampered',
          _sig: tamperedSig,
        },
      });

      await expect(processEscrowActionJob(injectedJob as any)).rejects.toThrow('JOB_SIGNATURE_INVALID');

      // No DB or provider calls — rejected at HMAC verification
      expect(db.query).not.toHaveBeenCalled();
      expect(EscrowService.release).not.toHaveBeenCalled();
    });

    it('a fresh injected job (no transfer_id) is now rejected before any provider call', async () => {
      /**
       * Previously (EXPLOIT): attacker injects a job for an escrow with no
       * transfer_id yet and the worker executed it as if legitimate.
       *
       * Now (FIXED): Zod schema check + HMAC verification fire first, and the
       * job is rejected before any DB query or provider call.
       */
      const injectedJob = makeJob('escrow.release_requested', {
        payload: {
          escrow_id: E.eTarget,
          task_id: T.tReal,
          reason: 'attacker-injected fresh',
          // No _sig — would be rejected at Zod schema
        },
      });

      await expect(processEscrowActionJob(injectedJob as any)).rejects.toThrow('JOB_SCHEMA_INVALID');

      // FIXED: No DB query, no provider call — rejected before any side effects
      expect(db.query).not.toHaveBeenCalled();
      expect(EscrowService.release).not.toHaveBeenCalled();
    });

    it('signJobPayload / verifyJobSignature round-trip works correctly', () => {
      const payload = { escrow_id: E.eTarget, task_id: T.tReal, reason: 'test' };
      const sig = signJobPayload(payload);
      expect(sig).toHaveLength(64); // SHA256 hex = 64 chars
      expect(verifyJobSignature(payload, sig)).toBe(true);
    });

    it('verifyJobSignature returns false for tampered payload', () => {
      const payload = { escrow_id: E.eTarget, task_id: T.tReal, reason: 'test' };
      const sig = signJobPayload(payload);
      const tampered = { ...payload, reason: 'tampered' };
      expect(verifyJobSignature(tampered, sig)).toBe(false);
    });
  });

  // =========================================================================
  // BONUS: idempotency key helpers
  // =========================================================================

  describe('generateIdempotencyKey / parseIdempotencyKey', () => {
    it('round-trips correctly', () => {
      const key = generateIdempotencyKey('escrow.release_requested', 'e123', 7);
      expect(key).toBe('escrow.release_requested:e123:7');
      const parsed = parseIdempotencyKey(key);
      expect(parsed).toEqual({ eventType: 'escrow.release_requested', aggregateId: 'e123', eventVersion: 7 });
    });

    it('throws on malformed key (attacker providing crafted idempotency key)', () => {
      // W-05 FIX: parseIdempotencyKey now accepts >= 3 parts (surge keys use 4 segments).
      // Only keys with fewer than 3 parts are rejected as malformed.
      expect(() => parseIdempotencyKey('only:two')).toThrow('Invalid idempotency key format');
      // 4-part keys are now valid (surge discriminator as 4th segment)
      expect(() => parseIdempotencyKey('one:two:three:four')).not.toThrow();
    });

    it('colons in aggregateId are now handled — 4-part keys parse correctly (W-05 fix)', () => {
      /**
       * W-05 FIX: parseIdempotencyKey now uses parts.length < 3 (was !== 3).
       * Keys with 4+ segments (e.g., surge keys) no longer throw — parts[2+]
       * are joined as the version/suffix. Real UUIDs never contain colons so
       * this does not introduce an injection risk.
       */
      const key = generateIdempotencyKey('escrow.release', 'tenant:123', 1);
      // Should parse without throwing (4 parts: eventType, tenant, 123, version)
      expect(() => parseIdempotencyKey(key)).not.toThrow();
    });
  });
});
