/**
 * TaskService Unit Tests
 *
 * Coverage: state machine helpers, all CRUD and state-transition methods,
 * kill-switch, rate-limiter, InstantTaskGate, EligibilityGuard, fraud,
 * background-check, and plan-check branches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that pull those modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/logger', () => {
  const child = (): object => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child,
  });
  return {
    logger: { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    workerLogger: { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    stripeLogger: { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    authLogger: { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    dbLogger: { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    taskLogger: { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    aiLogger: { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    escrowLogger: { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
  };
});

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue({ id: 'outbox-1', idempotencyKey: 'k' }),
}));

// Dynamic-import mocks (hoisted at module level so import() inside service resolves them)
vi.mock('../../src/services/InstantModeKillSwitch', () => ({
  InstantModeKillSwitch: {
    checkFlags: vi.fn().mockReturnValue({
      instantModeEnabled: true,
      surgeEnabled: true,
      interruptsEnabled: true,
      allEnabled: true,
    }),
  },
}));

vi.mock('../../src/services/InstantRateLimiter', () => ({
  InstantRateLimiter: {
    checkPostLimit: vi.fn().mockResolvedValue({ allowed: true }),
    checkAcceptLimit: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('../../src/services/InstantTaskGate', () => ({
  InstantTaskGate: {
    check: vi.fn().mockResolvedValue({ instantEligible: true }),
  },
}));

vi.mock('../../src/services/EligibilityGuard', () => ({
  EligibilityGuard: {
    assertEligibility: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('../../src/services/FraudDetectionService', () => ({
  FraudDetectionService: {
    getRiskAssessment: vi.fn().mockResolvedValue({
      success: true,
      data: { riskScore: 0.1 },
    }),
  },
}));

vi.mock('../../src/services/BackgroundCheckService', () => ({
  hasValidBackgroundCheck: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/services/ScoperAIService', () => ({
  ScoperAIService: {
    analyzeTaskScope: vi.fn().mockResolvedValue({
      success: false, // disabled by default; individual tests override
    }),
  },
}));

vi.mock('../../src/services/PlanService', () => ({
  PlanService: {
    canCreateTaskWithRisk: vi.fn().mockResolvedValue({ allowed: true }),
    canAcceptTaskWithRisk: vi.fn().mockResolvedValue({ allowed: true }),
    getUserPlan: vi.fn().mockResolvedValue('free'),
    hasActiveEntitlement: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('../../src/services/InstantObservability', () => ({
  InstantObservability: {
    logAcceptRace: vi.fn(),
  },
}));

vi.mock('../../src/services/InstantTrustConfig', () => ({
  MIN_INSTANT_TIER: 2,
  MIN_SENSITIVE_INSTANT_TIER: 3,
}));

// ---------------------------------------------------------------------------
// Actual imports (after mocks)
// ---------------------------------------------------------------------------
import { TaskService } from '../../src/services/TaskService';
import { db } from '../../src/db';
import { writeToOutbox } from '../../src/lib/outbox-helpers';

/**
 * task-complete-outbox.test.ts — TDD (red-first)
 *
 * INV-6 (atomicity): when a task transitions PROOF_SUBMITTED→COMPLETED and its
 * escrow is FUNDED with in-app payment, TaskService.complete must write the
 * 'escrow.completion_release_requested' outbox event IN THE SAME TRANSACTION
 * (transactional outbox) so completion and payout-request commit atomically.
 */
const dbQuery = db.query as unknown as ReturnType<typeof vi.fn>;
const dbTransaction = db.transaction as unknown as ReturnType<typeof vi.fn>;
const outboxSpy = writeToOutbox as unknown as ReturnType<typeof vi.fn>;

const TASK_ID = '10000000-0000-0000-0000-0000000000bb';
const POSTER_ID = '30000000-0000-0000-0000-0000000000bb';
const ESCROW_ID = '00000000-0000-0000-0000-0000000000bb';

function completedTaskRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: TASK_ID, state: 'COMPLETED', poster_id: POSTER_ID,
    payment_method: 'escrow', price: 100, ...over,
  };
}

/** tx mock that passes a DISTINCT query fn so we can prove the outbox write used the tx connection */
let txQueryFn: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  txQueryFn = vi.fn();
  dbTransaction.mockImplementation(async (fn: (q: typeof txQueryFn) => Promise<unknown>) => fn(txQueryFn));
  outboxSpy.mockResolvedValue({ id: 'outbox-evt-1', idempotencyKey: 'k1' });
});

describe('TaskService.complete — transactional outbox for completion release', () => {
  it('FUNDED escrow + in-app payment → writes escrow.completion_release_requested inside the SAME transaction', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID }] }) // FOR UPDATE lock
      .mockResolvedValueOnce({ rows: [completedTaskRow()], rowCount: 1 })                    // UPDATE → COMPLETED
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, state: 'FUNDED' }] });               // escrow lookup

    const result = await TaskService.complete(TASK_ID, POSTER_ID);

    expect(result.success).toBe(true);
    expect(outboxSpy).toHaveBeenCalledTimes(1);
    const [input, qfn] = outboxSpy.mock.calls[0];
    expect(input.eventType).toBe('escrow.completion_release_requested');
    expect(input.aggregateType).toBe('escrow');
    expect(input.aggregateId).toBe(ESCROW_ID);
    expect(input.queueName).toBe('critical_payments');
    expect(input.payload).toEqual(
      expect.objectContaining({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'task_completed' })
    );
    // Transactional-outbox proof: the write used the tx query fn, not db.query
    expect(qfn).toBe(txQueryFn);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('no escrow row → completes successfully, NO outbox event', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID }] })
      .mockResolvedValueOnce({ rows: [completedTaskRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] }); // no escrow

    const result = await TaskService.complete(TASK_ID, POSTER_ID);
    expect(result.success).toBe(true);
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('escrow not FUNDED (PENDING) → completes, NO outbox event (never auto-release unfunded money)', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID }] })
      .mockResolvedValueOnce({ rows: [completedTaskRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, state: 'PENDING' }] });

    const result = await TaskService.complete(TASK_ID, POSTER_ID);
    expect(result.success).toBe(true);
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('offline payment task → completes, NO outbox event', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID }] })
      .mockResolvedValueOnce({ rows: [completedTaskRow({ payment_method: 'offline_venmo' })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, state: 'FUNDED' }] });

    const result = await TaskService.complete(TASK_ID, POSTER_ID);
    expect(result.success).toBe(true);
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('completion rejected (wrong state) → NO outbox event', async () => {
    txQueryFn.mockResolvedValueOnce({ rows: [{ state: 'OPEN', poster_id: POSTER_ID }] });
    const result = await TaskService.complete(TASK_ID, POSTER_ID);
    expect(result.success).toBe(false);
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('outbox write failure → transaction propagates the error (completion must NOT commit without the release request)', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID }] })
      .mockResolvedValueOnce({ rows: [completedTaskRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, state: 'FUNDED' }] });
    outboxSpy.mockRejectedValueOnce(new Error('outbox insert failed'));

    const result = await TaskService.complete(TASK_ID, POSTER_ID);
    // db.transaction would roll back; service surfaces a failure result (DB_ERROR path)
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.code).toBeTruthy();
  });
});

describe('financial event signing allowlist', () => {
  it('escrow.completion_release_requested is HMAC-signed by the outbox dispatcher', async () => {
    const { FINANCIAL_EVENT_TYPES } = await import('../../src/jobs/outbox-worker.js');
    expect(FINANCIAL_EVENT_TYPES.has('escrow.completion_release_requested')).toBe(true);
  });
});
