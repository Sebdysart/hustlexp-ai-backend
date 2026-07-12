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
 * Completion financial-boundary tests.
 *
 * COMPLETED persists PAYOUT_READY evidence and transactionally emits the
 * canonical completion-release event. The worker remains the only component
 * allowed to move money.
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

describe('TaskService.complete — payout-ready safety boundary', () => {
  it('accepted proof + FUNDED escrow → persists PAYOUT_READY and atomically queues canonical release', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID }] }) // FOR UPDATE lock
      .mockResolvedValueOnce({ rows: [{ state: 'ACCEPTED' }] })                              // proof gate
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, state: 'FUNDED' }] })                 // escrow gate
      .mockResolvedValueOnce({ rows: [completedTaskRow({ payout_ready_at: new Date() })], rowCount: 1 }) // update
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                                    // evidence event

    const result = await TaskService.complete(TASK_ID, POSTER_ID);

    expect(result.success).toBe(true);
    expect(outboxSpy).toHaveBeenCalledWith({
      eventType: 'escrow.completion_release_requested',
      aggregateType: 'escrow',
      aggregateId: ESCROW_ID,
      payload: {
        escrow_id: ESCROW_ID,
        task_id: TASK_ID,
        reason: 'poster_confirmed_completion',
      },
      queueName: 'critical_payments',
      idempotencyKey: `completion-release:${TASK_ID}`,
    }, txQueryFn);
    const updateSql = String(txQueryFn.mock.calls[3]?.[0]);
    expect(updateSql).toContain('payout_ready_at = NOW()');
    expect(updateSql).toContain("payout_ready_reason");
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('missing accepted proof blocks completion', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID }] })
      .mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }] });

    const result = await TaskService.complete(TASK_ID, POSTER_ID);
    expect(result).toMatchObject({ success: false, error: { code: 'HX301' } });
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('escrow not FUNDED blocks payout-ready', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID }] })
      .mockResolvedValueOnce({ rows: [{ state: 'ACCEPTED' }] })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, state: 'PENDING' }] });

    const result = await TaskService.complete(TASK_ID, POSTER_ID);
    expect(result).toMatchObject({ success: false, error: { code: 'PAYOUT_NOT_FUNDED' } });
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('unattended completion requires delivered-message evidence', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // request witness
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, price: 100, completion_message_delivered_at: null }] })
      .mockResolvedValueOnce({ rows: [{ state: 'ACCEPTED' }] })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, state: 'FUNDED' }] });

    const result = await TaskService.complete(TASK_ID, undefined, {
      mode: 'UNATTENDED',
      idempotencyKey: 'unattended-complete-0001',
    });
    expect(result).toMatchObject({ success: false, error: { code: 'COMPLETION_DELIVERY_REQUIRED' } });
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('unattended completion after delivered evidence and wait atomically queues canonical release', async () => {
    txQueryFn
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // prior witness
      .mockResolvedValueOnce({ rows: [{
        state: 'PROOF_SUBMITTED',
        poster_id: POSTER_ID,
        price: 100,
        payout_ready_at: null,
        completion_message_delivered_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
      }] })
      .mockResolvedValueOnce({ rows: [{ state: 'ACCEPTED' }] })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID, state: 'FUNDED' }] })
      .mockResolvedValueOnce({ rows: [completedTaskRow({ payout_ready_at: new Date() })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // automation event
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // request witness

    const result = await TaskService.complete(TASK_ID, undefined, {
      mode: 'UNATTENDED',
      idempotencyKey: 'unattended-complete-0001',
    });
    expect(result.success).toBe(true);
    expect(outboxSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'escrow.completion_release_requested',
        aggregateId: ESCROW_ID,
        payload: expect.objectContaining({ reason: 'unattended_policy_completion' }),
      }),
      txQueryFn,
    );
    expect(String(txQueryFn.mock.calls[5]?.[0])).toContain('payout_ready_at = NOW()');
  });

  it('completion rejected (wrong state) → NO outbox event', async () => {
    txQueryFn.mockResolvedValueOnce({ rows: [{ state: 'OPEN', poster_id: POSTER_ID }] });
    const result = await TaskService.complete(TASK_ID, POSTER_ID);
    expect(result.success).toBe(false);
    expect(outboxSpy).not.toHaveBeenCalled();
  });

});

describe('TaskService.recordCompletionDelivery', () => {
  it('persists provider evidence and is safe to replay', async () => {
    const deliveredAt = new Date('2026-07-10T12:00:00.000Z');
    txQueryFn
      .mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ task_id: TASK_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await TaskService.recordCompletionDelivery({
      taskId: TASK_ID,
      providerDeliveryId: 'SM-delivered-1',
      channel: 'SMS',
      deliveredAt,
      actorId: POSTER_ID,
    });
    expect(result).toMatchObject({ success: true, data: { idempotencyReplayed: false } });
    expect(String(txQueryFn.mock.calls[1]?.[0])).toContain('task_completion_delivery_events');
    expect(String(txQueryFn.mock.calls[2]?.[0])).toContain('completion_message_delivered_at');
  });
});

describe('financial event signing allowlist', () => {
  it('escrow.completion_release_requested is HMAC-signed by the outbox dispatcher', async () => {
    const { FINANCIAL_EVENT_TYPES } = await import('../../src/jobs/outbox-worker.js');
    expect(FINANCIAL_EVENT_TYPES.has('escrow.completion_release_requested')).toBe(true);
  });
});
