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
import { PlanService } from '../../src/services/PlanService';
import { InstantModeKillSwitch } from '../../src/services/InstantModeKillSwitch';
import { InstantRateLimiter } from '../../src/services/InstantRateLimiter';
import { InstantTaskGate } from '../../src/services/InstantTaskGate';
import { EligibilityGuard } from '../../src/services/EligibilityGuard';
import { FraudDetectionService } from '../../src/services/FraudDetectionService';
import * as BackgroundCheckServiceModule from '../../src/services/BackgroundCheckService';
import { ScoperAIService } from '../../src/services/ScoperAIService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockQuery = vi.mocked(db.query);

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    poster_id: 'poster-1',
    worker_id: null,
    title: 'Mow lawn',
    description: 'Mow my lawn',
    price: 2500,
    xp_reward: 250,
    state: 'OPEN',
    risk_level: 'LOW',
    mode: 'STANDARD',
    instant_mode: false,
    sensitive: false,
    requires_proof: true,
    created_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();

  // Default: db.transaction delegates to the callback with db.query as the query fn
  vi.mocked(db.transaction).mockImplementation(async (fn: (q: typeof db.query) => Promise<unknown>) =>
    fn(db.query)
  );
});

// ===========================================================================
// 1. isTerminalState
// ===========================================================================
describe('TaskService.isTerminalState', () => {
  it('returns true for COMPLETED', () => {
    expect(TaskService.isTerminalState('COMPLETED')).toBe(true);
  });

  it('returns true for CANCELLED', () => {
    expect(TaskService.isTerminalState('CANCELLED')).toBe(true);
  });

  it('returns true for EXPIRED', () => {
    expect(TaskService.isTerminalState('EXPIRED')).toBe(true);
  });

  it('returns false for OPEN', () => {
    expect(TaskService.isTerminalState('OPEN')).toBe(false);
  });

  it('returns false for ACCEPTED', () => {
    expect(TaskService.isTerminalState('ACCEPTED')).toBe(false);
  });

  it('returns false for PROOF_SUBMITTED', () => {
    expect(TaskService.isTerminalState('PROOF_SUBMITTED')).toBe(false);
  });

  it('returns false for DISPUTED', () => {
    expect(TaskService.isTerminalState('DISPUTED')).toBe(false);
  });

  it('returns false for MATCHING', () => {
    expect(TaskService.isTerminalState('MATCHING')).toBe(false);
  });
});

// ===========================================================================
// 2. isValidTransition
// ===========================================================================
describe('TaskService.isValidTransition', () => {
  // Valid transitions
  it.each([
    ['OPEN', 'ACCEPTED'],
    ['OPEN', 'CANCELLED'],
    ['OPEN', 'EXPIRED'],
    ['MATCHING', 'ACCEPTED'],
    ['MATCHING', 'CANCELLED'],
    ['MATCHING', 'EXPIRED'],
    ['ACCEPTED', 'PROOF_SUBMITTED'],
    ['ACCEPTED', 'CANCELLED'],
    ['ACCEPTED', 'EXPIRED'],
    ['PROOF_SUBMITTED', 'COMPLETED'],
    ['PROOF_SUBMITTED', 'DISPUTED'],
    ['PROOF_SUBMITTED', 'ACCEPTED'],
    ['DISPUTED', 'COMPLETED'],
    ['DISPUTED', 'CANCELLED'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(TaskService.isValidTransition(from, to)).toBe(true);
  });

  // Terminal states have no outbound transitions
  it.each([
    ['COMPLETED', 'CANCELLED'],
    ['COMPLETED', 'OPEN'],
    ['CANCELLED', 'OPEN'],
    ['CANCELLED', 'COMPLETED'],
    ['EXPIRED', 'OPEN'],
    ['EXPIRED', 'ACCEPTED'],
  ] as const)('blocks %s → %s (terminal)', (from, to) => {
    expect(TaskService.isValidTransition(from, to)).toBe(false);
  });

  // Invalid cross-transitions
  it('blocks OPEN → PROOF_SUBMITTED', () => {
    expect(TaskService.isValidTransition('OPEN', 'PROOF_SUBMITTED')).toBe(false);
  });

  it('blocks ACCEPTED → COMPLETED (skipping PROOF_SUBMITTED)', () => {
    expect(TaskService.isValidTransition('ACCEPTED', 'COMPLETED')).toBe(false);
  });
});

// ===========================================================================
// 3. getById
// ===========================================================================
describe('TaskService.getById', () => {
  it('returns the task when found', async () => {
    const task = makeTask();
    mockQuery.mockResolvedValueOnce({ rows: [task], rowCount: 1 } as never);

    const result = await TaskService.getById('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('task-1');
  });

  it('returns NOT_FOUND when task does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.getById('missing-id');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('returns DB_ERROR when query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down') as never);

    const result = await TaskService.getById('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
    // R-13 FIX: DB error messages are sanitized — raw message never exposed to callers
    expect(result.error?.message).toBe('A database error occurred. Please try again.');
  });
});

// ===========================================================================
// 4. getByPoster
// ===========================================================================
describe('TaskService.getByPoster', () => {
  it('returns tasks for a poster', async () => {
    const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })];
    mockQuery.mockResolvedValueOnce({ rows: tasks, rowCount: 2 } as never);

    const result = await TaskService.getByPoster('poster-1');

    expect(result.success).toBe(true);
    // getByPoster now returns { tasks, nextCursor } for cursor pagination
    expect(result.data?.tasks).toHaveLength(2);
    expect(result.data?.nextCursor).toBeUndefined(); // 2 rows < default limit of 20
  });

  it('returns empty array when poster has no tasks', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.getByPoster('poster-empty');

    expect(result.success).toBe(true);
    expect(result.data?.tasks).toHaveLength(0);
    expect(result.data?.nextCursor).toBeUndefined();
  });
});

// ===========================================================================
// 5. getByWorker
// ===========================================================================
describe('TaskService.getByWorker', () => {
  it('returns tasks for a worker', async () => {
    const tasks = [makeTask({ id: 'task-1', worker_id: 'worker-1' })];
    mockQuery.mockResolvedValueOnce({ rows: tasks, rowCount: 1 } as never);

    const result = await TaskService.getByWorker('worker-1');

    expect(result.success).toBe(true);
    // getByWorker now returns { tasks, nextCursor } for cursor pagination
    expect(result.data?.tasks).toHaveLength(1);
    expect(result.data?.nextCursor).toBeUndefined(); // 1 row < default limit of 20
  });
});

// ===========================================================================
// 6. listOpen
// ===========================================================================
describe('TaskService.listOpen', () => {
  it('returns open tasks with defaults', async () => {
    const tasks = [makeTask(), makeTask({ id: 'task-2' })];
    mockQuery.mockResolvedValueOnce({ rows: tasks, rowCount: 2 } as never);

    const result = await TaskService.listOpen();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('passes category filter when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.listOpen({ category: 'CLEANING', limit: 10, offset: 0 });

    expect(result.success).toBe(true);
    // Verify category was passed as a query param
    const callArgs = mockQuery.mock.calls[0];
    expect(callArgs[1]).toContain('CLEANING');
  });
});

// ===========================================================================
// 7. create
// ===========================================================================
describe('TaskService.create', () => {
  const baseParams = {
    posterId: 'poster-1',
    title: 'Mow lawn',
    description: 'Mow the front lawn',
    price: 2500,
  };

  it('creates a standard task successfully', async () => {
    const created = makeTask();
    mockQuery.mockResolvedValueOnce({ rows: [created], rowCount: 1 } as never);

    const result = await TaskService.create(baseParams);

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('task-1');
  });

  it('returns PRICE_TOO_LOW for STANDARD task under 500 cents', async () => {
    const result = await TaskService.create({ ...baseParams, price: 499 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PRICE_TOO_LOW');
  });

  it('returns LIVE_2_VIOLATION for LIVE task under 1500 cents', async () => {
    const result = await TaskService.create({ ...baseParams, price: 1400, mode: 'LIVE' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HX902'); // ErrorCodes.LIVE_2_VIOLATION
  });

  it('returns INVALID_STATE for non-integer price', async () => {
    const result = await TaskService.create({ ...baseParams, price: 25.5 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('positive integer');
  });

  it('returns INVALID_STATE for zero price when ScoperAI fails', async () => {
    // ScoperAI mocked to fail (default mock returns success: false)
    // Zero price triggers ScoperAI path; fallback is 500 for STANDARD — which passes.
    // We test zero price with STANDARD where fallback is 500 → success.
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ price: 500 })], rowCount: 1 } as never);

    const result = await TaskService.create({ ...baseParams, price: 0 });

    expect(result.success).toBe(true);
  });

  it('uses ScoperAI suggested price when price is 0 and AI succeeds', async () => {
    vi.mocked(ScoperAIService.analyzeTaskScope).mockResolvedValueOnce({
      success: true,
      data: {
        suggested_price_cents: 3000,
        suggested_xp: 300,
        difficulty: 'medium',
        price_reasoning: 'fair',
        xp_reasoning: 'fair',
        difficulty_reasoning: 'moderate',
        confidence_score: 0.9,
        flags: [],
      },
    } as never);

    const created = makeTask({ price: 3000 });
    mockQuery.mockResolvedValueOnce({ rows: [created], rowCount: 1 } as never);

    const result = await TaskService.create({ ...baseParams, price: 0 });

    expect(result.success).toBe(true);
    expect(result.data?.price).toBe(3000);
  });

  it('returns PLAN_REQUIRED when plan check blocks the create', async () => {
    vi.mocked(PlanService.canCreateTaskWithRisk).mockResolvedValueOnce({
      allowed: false,
      reason: 'Premium required',
      requiredPlan: 'premium',
    });

    const result = await TaskService.create({ ...baseParams, riskLevel: 'HIGH' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PLAN_REQUIRED');
  });

  it('falls back to OPEN when kill switch disables instant mode', async () => {
    vi.mocked(InstantModeKillSwitch.checkFlags).mockReturnValueOnce({
      instantModeEnabled: false,
      surgeEnabled: false,
      interruptsEnabled: false,
      allEnabled: false,
    });

    // Task is created as OPEN (not MATCHING) — we just need the INSERT to succeed
    const created = makeTask({ state: 'OPEN', instant_mode: false });
    mockQuery.mockResolvedValueOnce({ rows: [created], rowCount: 1 } as never);

    const result = await TaskService.create({ ...baseParams, instantMode: true });

    expect(result.success).toBe(true);
    // The inserted state should have fallen back to OPEN
    expect(result.data?.instant_mode).toBe(false);
  });

  it('returns RATE_LIMIT_EXCEEDED when instant post rate limit is exceeded', async () => {
    vi.mocked(InstantRateLimiter.checkPostLimit).mockResolvedValueOnce({
      allowed: false,
      reason: 'Too many posts',
      retryAfter: 60,
    });

    const result = await TaskService.create({ ...baseParams, instantMode: true });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('returns INSTANT_TASK_INCOMPLETE when InstantTaskGate blocks', async () => {
    vi.mocked(InstantTaskGate.check).mockResolvedValueOnce({
      instantEligible: false,
      blockReason: 'Missing location',
      questions: ['Where is the task?'],
    });

    const result = await TaskService.create({ ...baseParams, instantMode: true });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INSTANT_TASK_INCOMPLETE');
  });

  it('creates instant mode task in MATCHING state', async () => {
    const matchingTask = makeTask({ state: 'MATCHING', instant_mode: true });
    // INSERT → UPDATE matched_at → SELECT reload
    mockQuery
      .mockResolvedValueOnce({ rows: [matchingTask], rowCount: 1 } as never) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)             // UPDATE matched_at
      .mockResolvedValueOnce({ rows: [matchingTask], rowCount: 1 } as never); // SELECT reload

    const result = await TaskService.create({ ...baseParams, instantMode: true });

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('MATCHING');
  });
});

// ===========================================================================
// 8. accept
// ===========================================================================
describe('TaskService.accept', () => {
  const acceptParams = { taskId: 'task-1', workerId: 'worker-1' };

  function makeTaskRow(overrides: Record<string, unknown> = {}) {
    return {
      risk_level: 'LOW',
      instant_mode: false,
      sensitive: false,
      price: 2500,
      // R-2 FIX: standard task.accept now requires MATCHING state (not OPEN).
      // OPEN tasks must go through the full apply → review workflow.
      state: 'MATCHING',
      worker_id: null,
      ...overrides,
    };
  }

  it('accepts an OPEN task successfully', async () => {
    const taskRow = makeTaskRow();
    const acceptedTask = makeTask({ state: 'ACCEPTED', worker_id: 'worker-1' });

    // transaction fn receives db.query — sequence of calls inside the transaction:
    // 1. SELECT FOR UPDATE (task row)
    // 2. UPDATE (accept)
    // advanceProgress also calls db.transaction internally, but that's mocked too.
    mockQuery
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)      // FOR UPDATE select
      .mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as never); // UPDATE accept

    // advanceProgress uses db.transaction — it will be a nested call
    // The outer transaction mock already delegates fn(db.query), so we handle the
    // inner advanceProgress transaction by stubbing additional query calls.
    // advanceProgress queries: FOR UPDATE task, disputes, escrows, UPDATE progress
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'POSTED', state: 'ACCEPTED' }], rowCount: 1 } as never) // advanceProgress FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)             // disputes
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)             // escrows
      .mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as never); // UPDATE progress

    const result = await TaskService.accept(acceptParams);

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('ACCEPTED');
  });

  it('returns NOT_FOUND when task does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.accept(acceptParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_STATE when task is already ACCEPTED', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeTaskRow({ state: 'ACCEPTED' })],
      rowCount: 1,
    } as never);

    const result = await TaskService.accept(acceptParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
  });

  it('returns INVALID_STATE when task already has a worker assigned', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeTaskRow({ worker_id: 'another-worker' })],
      rowCount: 1,
    } as never);

    const result = await TaskService.accept(acceptParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('already accepted');
  });

  it('blocks when EligibilityGuard denies', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeTaskRow()], rowCount: 1 } as never);

    vi.mocked(EligibilityGuard.assertEligibility).mockResolvedValueOnce({
      allowed: false,
      code: 'TRUST_TIER_INSUFFICIENT' as never,
      details: { reason: 'Trust tier too low' },
    });

    const result = await TaskService.accept(acceptParams);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Trust tier too low');
  });

  it('blocks fraud-flagged workers (riskScore > 0.7)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeTaskRow()], rowCount: 1 } as never);

    vi.mocked(FraudDetectionService.getRiskAssessment).mockResolvedValueOnce({
      success: true,
      data: { riskScore: 0.85 },
    } as never);

    const result = await TaskService.accept(acceptParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FRAUD_RISK_HIGH');
  });

  it('allows acceptance when fraud check throws (soft failure)', async () => {
    const taskRow = makeTaskRow();
    const acceptedTask = makeTask({ state: 'ACCEPTED', worker_id: 'worker-1' });

    mockQuery
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as never)
      // advanceProgress calls
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'POSTED', state: 'ACCEPTED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as never);

    vi.mocked(FraudDetectionService.getRiskAssessment).mockRejectedValueOnce(new Error('Fraud service down') as never);

    const result = await TaskService.accept(acceptParams);

    // Fraud check failure is a soft failure — acceptance proceeds
    expect(result.success).toBe(true);
  });

  it('returns BACKGROUND_CHECK_REQUIRED for high-value task (> $500) without check', async () => {
    const highValueRow = makeTaskRow({ price: 60000 }); // > 50000 cents
    mockQuery.mockResolvedValueOnce({ rows: [highValueRow], rowCount: 1 } as never);

    vi.mocked(BackgroundCheckServiceModule.hasValidBackgroundCheck).mockResolvedValueOnce(false);

    const result = await TaskService.accept(acceptParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('BACKGROUND_CHECK_REQUIRED');
  });

  it('allows high-value acceptance when background check passes', async () => {
    const highValueRow = makeTaskRow({ price: 60000 });
    const acceptedTask = makeTask({ state: 'ACCEPTED', worker_id: 'worker-1', price: 60000 });

    mockQuery
      .mockResolvedValueOnce({ rows: [highValueRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'POSTED', state: 'ACCEPTED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as never);

    vi.mocked(BackgroundCheckServiceModule.hasValidBackgroundCheck).mockResolvedValueOnce(true);

    const result = await TaskService.accept(acceptParams);

    expect(result.success).toBe(true);
  });

  it('returns PLAN_REQUIRED when worker plan check fails', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeTaskRow({ risk_level: 'HIGH' })], rowCount: 1 } as never);

    vi.mocked(PlanService.canAcceptTaskWithRisk).mockResolvedValueOnce({
      allowed: false,
      reason: 'Pro plan required',
      requiredPlan: 'pro',
    });

    const result = await TaskService.accept(acceptParams);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PLAN_REQUIRED');
  });

  describe('instant mode accept', () => {
    it('returns INVALID_STATE when kill switch disables instant accept', async () => {
      const instantRow = makeTaskRow({ instant_mode: true, state: 'MATCHING' });
      mockQuery.mockResolvedValueOnce({ rows: [instantRow], rowCount: 1 } as never);

      vi.mocked(InstantModeKillSwitch.checkFlags).mockReturnValueOnce({
        instantModeEnabled: false,
        surgeEnabled: false,
        interruptsEnabled: false,
        allEnabled: false,
      });

      const result = await TaskService.accept(acceptParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_STATE');
      expect(result.error?.message).toContain('Instant Mode is currently disabled');
    });

    it('returns RATE_LIMIT_EXCEEDED when instant accept rate limit is hit', async () => {
      const instantRow = makeTaskRow({ instant_mode: true, state: 'MATCHING' });
      mockQuery.mockResolvedValueOnce({ rows: [instantRow], rowCount: 1 } as never);

      vi.mocked(InstantRateLimiter.checkAcceptLimit).mockResolvedValueOnce({
        allowed: false,
        reason: 'Too many accepts',
        retryAfter: 30,
      });

      const result = await TaskService.accept(acceptParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('returns NOT_FOUND when worker does not exist for trust tier check', async () => {
      const instantRow = makeTaskRow({ instant_mode: true, state: 'MATCHING' });
      mockQuery
        .mockResolvedValueOnce({ rows: [instantRow], rowCount: 1 } as never)   // task FOR UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // users query

      const result = await TaskService.accept(acceptParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NOT_FOUND');
    });

    it('returns INSTANT_TASK_TRUST_INSUFFICIENT when worker is on trust hold', async () => {
      const instantRow = makeTaskRow({ instant_mode: true, state: 'MATCHING' });
      mockQuery
        .mockResolvedValueOnce({ rows: [instantRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ trust_tier: 3, trust_hold: true }], rowCount: 1 } as never);

      const result = await TaskService.accept(acceptParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INSTANT_TASK_TRUST_INSUFFICIENT');
      expect(result.error?.message).toContain('hold');
    });

    it('returns INSTANT_TASK_TRUST_INSUFFICIENT when trust tier is below minimum', async () => {
      const instantRow = makeTaskRow({ instant_mode: true, state: 'MATCHING' });
      mockQuery
        .mockResolvedValueOnce({ rows: [instantRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ trust_tier: 1, trust_hold: false }], rowCount: 1 } as never);

      const result = await TaskService.accept(acceptParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INSTANT_TASK_TRUST_INSUFFICIENT');
    });
  });
});

// ===========================================================================
// 9. submitProof
// ===========================================================================
describe('TaskService.submitProof', () => {
  it('transitions ACCEPTED → PROOF_SUBMITTED successfully', async () => {
    const submitted = makeTask({ state: 'PROOF_SUBMITTED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'ACCEPTED' })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [submitted], rowCount: 1 } as never); // UPDATE

    const result = await TaskService.submitProof('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('PROOF_SUBMITTED');
  });

  it('returns INVALID_STATE when task is in wrong state', async () => {
    // SELECT FOR UPDATE returns task in wrong state → early return INVALID_STATE (no UPDATE needed)
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN' })], rowCount: 1 } as never);

    const result = await TaskService.submitProof('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('ACCEPTED');
  });

  it('returns NOT_FOUND when task row is missing', async () => {
    // SELECT FOR UPDATE returns empty rows → NOT_FOUND immediately
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.submitProof('missing');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// 10. complete
// ===========================================================================
// UU-02 FIX: complete() now accepts an optional posterId and verifies
// ownership inside the FOR UPDATE transaction to prevent TOCTOU.
describe('TaskService.complete', () => {
  it('transitions PROOF_SUBMITTED → COMPLETED successfully (no posterId check)', async () => {
    const completed = makeTask({ state: 'COMPLETED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'PROOF_SUBMITTED', poster_id: 'poster-1' })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [completed], rowCount: 1 } as never); // UPDATE

    const result = await TaskService.complete('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('COMPLETED');
  });

  it('transitions PROOF_SUBMITTED → COMPLETED successfully when posterId matches', async () => {
    const completed = makeTask({ state: 'COMPLETED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'PROOF_SUBMITTED', poster_id: 'poster-1' })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [completed], rowCount: 1 } as never);

    const result = await TaskService.complete('task-1', 'poster-1');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('COMPLETED');
  });

  it('returns FORBIDDEN when posterId does not match poster_id on task', async () => {
    // SELECT FOR UPDATE returns task owned by a different poster
    mockQuery.mockResolvedValueOnce({
      rows: [makeTask({ state: 'PROOF_SUBMITTED', poster_id: 'poster-1' })],
      rowCount: 1,
    } as never);

    const result = await TaskService.complete('task-1', 'other-poster');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.error?.message).toContain('poster');
  });

  it('returns INVALID_STATE when task is in wrong non-terminal state', async () => {
    // SELECT FOR UPDATE returns wrong state → early return INVALID_STATE
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN', poster_id: 'poster-1' })], rowCount: 1 } as never);

    const result = await TaskService.complete('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
  });

  it('returns TASK_TERMINAL when task is already in terminal state', async () => {
    // SELECT FOR UPDATE returns terminal state → early return TASK_TERMINAL
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'CANCELLED', poster_id: 'poster-1' })], rowCount: 1 } as never);

    const result = await TaskService.complete('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HX001'); // ErrorCodes.TASK_TERMINAL
  });
});

// ===========================================================================
// 11. rejectProof
// ===========================================================================
describe('TaskService.rejectProof', () => {
  it('transitions PROOF_SUBMITTED → ACCEPTED (proof rejected)', async () => {
    const reverted = makeTask({ state: 'ACCEPTED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'PROOF_SUBMITTED' })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [reverted], rowCount: 1 } as never); // UPDATE

    const result = await TaskService.rejectProof('task-1', 'Not complete');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('ACCEPTED');
  });

  it('returns INVALID_STATE when task is not in PROOF_SUBMITTED state', async () => {
    // SELECT FOR UPDATE returns wrong state → early return INVALID_STATE
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'DISPUTED' })], rowCount: 1 } as never);

    const result = await TaskService.rejectProof('task-1', 'reason');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('PROOF_SUBMITTED');
  });
});

// ===========================================================================
// 12. openDispute
// ===========================================================================
describe('TaskService.openDispute', () => {
  it('transitions PROOF_SUBMITTED → DISPUTED successfully', async () => {
    const disputed = makeTask({ state: 'DISPUTED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'PROOF_SUBMITTED' })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [disputed], rowCount: 1 } as never); // UPDATE

    const result = await TaskService.openDispute('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('DISPUTED');
  });

  it('returns INVALID_STATE when task is not in PROOF_SUBMITTED', async () => {
    // SELECT FOR UPDATE returns wrong state → early return INVALID_STATE
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN' })], rowCount: 1 } as never);

    const result = await TaskService.openDispute('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
  });
});

// ===========================================================================
// 13. cancel
// ===========================================================================
describe('TaskService.cancel', () => {
  it('cancels an OPEN task successfully (no funded escrow)', async () => {
    const cancelled = makeTask({ state: 'CANCELLED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN' })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 } as never)                   // UPDATE tasks
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                           // SELECT escrows (none)

    const result = await TaskService.cancel('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('CANCELLED');
  });

  // YY-01: posterId ownership check inside FOR UPDATE lock
  it('YY-01: cancels when posterId matches poster_id (ownership verified inside lock)', async () => {
    const cancelled = makeTask({ state: 'CANCELLED' });
    // makeTask defaults poster_id to 'poster-1'
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN', poster_id: 'poster-1' })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 } as never)                                          // UPDATE tasks
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                                                  // SELECT escrows (none)

    const result = await TaskService.cancel('task-1', 'poster-1');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('CANCELLED');
  });

  it('YY-01: returns FORBIDDEN when posterId does not match poster_id (inside FOR UPDATE lock)', async () => {
    // Lock is acquired, then ownership check fails — no UPDATE query should be issued
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN', poster_id: 'poster-1' })], rowCount: 1 } as never); // SELECT FOR UPDATE

    const result = await TaskService.cancel('task-1', 'different-user');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.error?.message).toBe('Not task owner');
    // No UPDATE should have been issued after the ownership rejection
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('YY-01: skips ownership check when posterId is undefined (backward compat)', async () => {
    const cancelled = makeTask({ state: 'CANCELLED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN' })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 } as never)                   // UPDATE tasks
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                           // SELECT escrows (none)

    // No posterId — ownership check must be skipped (same semantics as before YY-01)
    const result = await TaskService.cancel('task-1', undefined);

    expect(result.success).toBe(true);
  });

  it('cancels an ACCEPTED task successfully (no funded escrow)', async () => {
    const cancelled = makeTask({ state: 'CANCELLED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'ACCEPTED' })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 } as never)                       // UPDATE tasks
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                               // SELECT escrows (none)

    const result = await TaskService.cancel('task-1');

    expect(result.success).toBe(true);
  });

  it('FIX-2: emits escrow.refund_requested outbox event when a FUNDED escrow exists on cancellation', async () => {
    // writeToOutbox is mocked at module level — it does NOT call db.query internally.
    // So we only need 3 mockQuery entries: FOR UPDATE, UPDATE tasks, SELECT escrows.
    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWriteToOutbox = vi.mocked(writeToOutbox);
    mockWriteToOutbox.mockClear();

    const cancelled = makeTask({ state: 'CANCELLED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN' })], rowCount: 1 } as never)          // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 } as never)                            // UPDATE tasks → CANCELLED
      .mockResolvedValueOnce({ rows: [{ id: 'escrow-99', state: 'FUNDED' }], rowCount: 1 } as never); // SELECT escrows → FUNDED

    const result = await TaskService.cancel('task-1');

    expect(result.success).toBe(true);
    // writeToOutbox should have been called with the escrow refund event (intercepted by mock)
    expect(mockWriteToOutbox).toHaveBeenCalledOnce();
    const [outboxInput] = mockWriteToOutbox.mock.calls[0];
    expect(outboxInput.eventType).toBe('escrow.refund_requested');
    expect(outboxInput.aggregateId).toBe('escrow-99');
    expect(outboxInput.queueName).toBe('critical_payments');
    expect(outboxInput.payload).toMatchObject({
      escrowId: 'escrow-99',
      reason: 'task_cancelled',
      taskId: 'task-1',
    });
    expect(outboxInput.idempotencyKey).toBe('escrow.refund_on_cancel:escrow-99:task-1');
  });

  it('FIX-2: does NOT emit outbox event when no funded escrow exists', async () => {
    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWriteToOutbox = vi.mocked(writeToOutbox);
    mockWriteToOutbox.mockClear();

    const cancelled = makeTask({ state: 'CANCELLED' });
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN' })], rowCount: 1 } as never) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 } as never)                   // UPDATE tasks → CANCELLED
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                           // SELECT escrows → none

    const result = await TaskService.cancel('task-1');

    expect(result.success).toBe(true);
    expect(mockWriteToOutbox).not.toHaveBeenCalled();
  });

  it('C3 FIX: emits full refund (not partial) when windowHours=0 on ACCEPTED task with late_cancel_pct set', async () => {
    // BUG C3: windowHours >= 0 was always true, triggering partial refund even when no window was configured.
    // With the fix (windowHours > 0), windowHours=0 correctly skips to full refund.
    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWriteToOutbox = vi.mocked(writeToOutbox);
    mockWriteToOutbox.mockClear();

    const acceptedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // accepted 2 hours ago
    const cancelled = makeTask({ state: 'CANCELLED' });
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ state: 'ACCEPTED', late_cancel_pct: 50, cancellation_window_hours: 0, accepted_at: acceptedAt }],
        rowCount: 1,
      } as never)                                                                                      // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 } as never)                             // UPDATE tasks → CANCELLED
      .mockResolvedValueOnce({ rows: [{ id: 'escrow-c3', state: 'FUNDED' }], rowCount: 1 } as never); // SELECT escrows → FUNDED

    const result = await TaskService.cancel('task-1');

    expect(result.success).toBe(true);
    // windowHours=0 means no cancellation window was configured — must issue full refund
    expect(mockWriteToOutbox).toHaveBeenCalledOnce();
    const [outboxInput] = mockWriteToOutbox.mock.calls[0];
    expect(outboxInput.eventType).toBe('escrow.refund_requested');
    expect(outboxInput.payload).toMatchObject({ reason: 'task_cancelled' });
  });

  it('C3 FIX: emits partial refund when cancellation window has expired (windowHours > 0, elapsed > window)', async () => {
    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWriteToOutbox = vi.mocked(writeToOutbox);
    mockWriteToOutbox.mockClear();

    // Accepted 25 hours ago; window is 24 hours → window expired → late cancel
    const acceptedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const cancelled = makeTask({ state: 'CANCELLED' });
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ state: 'ACCEPTED', late_cancel_pct: 50, cancellation_window_hours: 24, accepted_at: acceptedAt }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'escrow-late', state: 'FUNDED' }], rowCount: 1 } as never);

    const result = await TaskService.cancel('task-1');

    expect(result.success).toBe(true);
    expect(mockWriteToOutbox).toHaveBeenCalledOnce();
    const [outboxInput] = mockWriteToOutbox.mock.calls[0];
    expect(outboxInput.eventType).toBe('escrow.partial_refund_requested');
    expect(outboxInput.payload).toMatchObject({
      escrowId: 'escrow-late',
      reason: 'task_cancelled_late',
      workerPercent: 50,
    });
  });

  it('C3 FIX: emits full refund when still within cancellation window (windowHours > 0, elapsed < window)', async () => {
    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWriteToOutbox = vi.mocked(writeToOutbox);
    mockWriteToOutbox.mockClear();

    // Accepted 1 hour ago; window is 24 hours → still within window → full refund
    const acceptedAt = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const cancelled = makeTask({ state: 'CANCELLED' });
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ state: 'ACCEPTED', late_cancel_pct: 50, cancellation_window_hours: 24, accepted_at: acceptedAt }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [cancelled], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'escrow-early', state: 'FUNDED' }], rowCount: 1 } as never);

    const result = await TaskService.cancel('task-1');

    expect(result.success).toBe(true);
    expect(mockWriteToOutbox).toHaveBeenCalledOnce();
    const [outboxInput] = mockWriteToOutbox.mock.calls[0];
    expect(outboxInput.eventType).toBe('escrow.refund_requested');
    expect(outboxInput.payload).toMatchObject({ reason: 'task_cancelled' });
  });

  it('returns TASK_TERMINAL when task is already in a terminal state', async () => {
    // SELECT FOR UPDATE returns terminal state → early return TASK_TERMINAL
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'COMPLETED' })], rowCount: 1 } as never);

    const result = await TaskService.cancel('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HX001'); // ErrorCodes.TASK_TERMINAL
  });

  it('returns INVALID_STATE when task is in PROOF_SUBMITTED (cannot cancel)', async () => {
    // SELECT FOR UPDATE returns PROOF_SUBMITTED → early return INVALID_STATE (not in OPEN/ACCEPTED)
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'PROOF_SUBMITTED' })], rowCount: 1 } as never);

    const result = await TaskService.cancel('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
  });
});

// ===========================================================================
// 14. expire
// ===========================================================================
// UU-03 FIX: expire() now runs inside a transaction.  The query sequence is:
//   1. SELECT state … FOR UPDATE  (lock + read pre-expire state)
//   2. UPDATE … RETURNING *        (expire the task)
//   3. SELECT id FROM escrows …    (executed when state was MATCHING or OPEN)
//   writeToOutbox is called atomically for MATCHING/OPEN tasks with a funded escrow.
// CCC-02 FIX: OPEN tasks can also have funded escrows; the escrow query now runs
//   for both MATCHING and OPEN pre-expire states.
describe('TaskService.expire', () => {
  it('expires a non-MATCHING/non-OPEN task successfully (no escrow query)', async () => {
    const expired = makeTask({ state: 'EXPIRED' });

    // 1. FOR UPDATE → task is in ACCEPTED state (has a worker, no funded escrow to refund)
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'ACCEPTED' })], rowCount: 1 } as never);
    // 2. UPDATE → task expired
    mockQuery.mockResolvedValueOnce({ rows: [expired], rowCount: 1 } as never);
    // No escrow query because pre-expire state was ACCEPTED (not MATCHING or OPEN).

    const result = await TaskService.expire('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('EXPIRED');
  });

  // CCC-02: OPEN tasks with a funded escrow must also emit a refund outbox event on expiry
  it('CCC-02: expires an OPEN task with funded escrow and emits refund outbox event', async () => {
    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWriteToOutbox = vi.mocked(writeToOutbox);
    mockWriteToOutbox.mockClear();

    const expired = makeTask({ state: 'EXPIRED' });

    // 1. FOR UPDATE → task is in OPEN state
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN' })], rowCount: 1 } as never);
    // 2. UPDATE → task expired
    mockQuery.mockResolvedValueOnce({ rows: [expired], rowCount: 1 } as never);
    // 3. SELECT escrow → funded escrow found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'escrow-open-1' }], rowCount: 1 } as never);

    const result = await TaskService.expire('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('EXPIRED');
    expect(mockWriteToOutbox).toHaveBeenCalledOnce();
    expect(mockWriteToOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'escrow.refund_requested',
        payload: expect.objectContaining({ reason: 'task_expired', taskId: 'task-1' }),
      }),
      expect.any(Function)
    );
  });

  it('CCC-02: expires an OPEN task with NO funded escrow without emitting outbox event', async () => {
    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWriteToOutbox = vi.mocked(writeToOutbox);
    mockWriteToOutbox.mockClear();

    const expired = makeTask({ state: 'EXPIRED' });

    // 1. FOR UPDATE → task is in OPEN state
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN' })], rowCount: 1 } as never);
    // 2. UPDATE → task expired
    mockQuery.mockResolvedValueOnce({ rows: [expired], rowCount: 1 } as never);
    // 3. SELECT escrow → no funded escrow (poster never pre-funded)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.expire('task-1');

    expect(result.success).toBe(true);
    expect(mockWriteToOutbox).not.toHaveBeenCalled();
  });

  it('expires a MATCHING task and emits escrow refund outbox event', async () => {
    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWriteToOutbox = vi.mocked(writeToOutbox);
    mockWriteToOutbox.mockClear();

    const expired = makeTask({ state: 'EXPIRED' });

    // 1. FOR UPDATE → task is in MATCHING state
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'MATCHING' })], rowCount: 1 } as never);
    // 2. UPDATE → task expired
    mockQuery.mockResolvedValueOnce({ rows: [expired], rowCount: 1 } as never);
    // 3. SELECT escrow → funded escrow found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'escrow-1' }], rowCount: 1 } as never);

    const result = await TaskService.expire('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.state).toBe('EXPIRED');
    expect(mockWriteToOutbox).toHaveBeenCalledOnce();
    expect(mockWriteToOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'escrow.refund_requested',
        payload: expect.objectContaining({ reason: 'task_expired', taskId: 'task-1' }),
      }),
      expect.any(Function)
    );
  });

  it('expires a MATCHING task with no funded escrow without emitting outbox event', async () => {
    const { writeToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWriteToOutbox = vi.mocked(writeToOutbox);
    mockWriteToOutbox.mockClear();

    const expired = makeTask({ state: 'EXPIRED' });

    // 1. FOR UPDATE → task is in MATCHING state
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'MATCHING' })], rowCount: 1 } as never);
    // 2. UPDATE → task expired
    mockQuery.mockResolvedValueOnce({ rows: [expired], rowCount: 1 } as never);
    // 3. SELECT escrow → no funded escrow
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.expire('task-1');

    expect(result.success).toBe(true);
    expect(mockWriteToOutbox).not.toHaveBeenCalled();
  });

  it('returns INVALID_STATE when task is not found (FOR UPDATE returns empty)', async () => {
    // 1. FOR UPDATE → task not found
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.expire('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
  });

  it('returns INVALID_STATE when UPDATE returns no rows (deadline not passed or already terminal)', async () => {
    // 1. FOR UPDATE → task found in some non-terminal state
    mockQuery.mockResolvedValueOnce({ rows: [makeTask({ state: 'OPEN' })], rowCount: 1 } as never);
    // 2. UPDATE → 0 rows (deadline not yet reached or state already terminal)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.expire('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('deadline');
  });

  it('returns DB_ERROR when transaction throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost') as never);

    const result = await TaskService.expire('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ===========================================================================
// 15. getValidTransitions helper
// ===========================================================================
describe('TaskService.getValidTransitions', () => {
  it('returns allowed transitions for OPEN', () => {
    const transitions = TaskService.getValidTransitions('OPEN');
    expect(transitions).toContain('ACCEPTED');
    expect(transitions).toContain('CANCELLED');
    expect(transitions).toContain('EXPIRED');
  });

  it('returns empty array for COMPLETED (terminal)', () => {
    expect(TaskService.getValidTransitions('COMPLETED')).toHaveLength(0);
  });

  it('returns empty array for CANCELLED (terminal)', () => {
    expect(TaskService.getValidTransitions('CANCELLED')).toHaveLength(0);
  });

  it('returns empty array for EXPIRED (terminal)', () => {
    expect(TaskService.getValidTransitions('EXPIRED')).toHaveLength(0);
  });

  it('returns correct transitions for PROOF_SUBMITTED', () => {
    const transitions = TaskService.getValidTransitions('PROOF_SUBMITTED');
    expect(transitions).toContain('COMPLETED');
    expect(transitions).toContain('DISPUTED');
    expect(transitions).toContain('ACCEPTED'); // proof rejected
  });
});
