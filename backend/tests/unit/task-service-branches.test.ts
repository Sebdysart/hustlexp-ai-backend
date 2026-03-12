/**
 * TaskService Branch Coverage Tests
 *
 * Targets backend/src/services/TaskService.ts branches NOT covered by
 * the existing task-service.test.ts:
 *
 * - getByPoster / getByWorker: cursor pagination branch (cursor provided → different query)
 *   and the nextCursor path (more rows than limit returned)
 * - create: invariant violation catch branch (isInvariantViolation returns true)
 * - complete: INV-3 violation catch branch (HX301 error code path)
 * - advanceProgress: idempotency branch (from === to → no-op)
 * - advanceProgress: dispute freeze branch (active dispute present)
 * - advanceProgress: escrow terminal freeze branch
 * - advanceProgress: authorization error branches (worker mismatch, system required)
 * - advanceProgress: task not found branch
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — identical set as task-service.test.ts
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
    info: vi.fn(), error: vi.fn(), warn: vi.fn(),
    debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child,
  });
  return {
    logger:      { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    taskLogger:  { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    aiLogger:    { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    escrowLogger:{ child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
  };
});

vi.mock('../../src/jobs/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue({ id: 'outbox-1', idempotencyKey: 'k' }),
}));

vi.mock('../../src/services/InstantModeKillSwitch', () => ({
  InstantModeKillSwitch: {
    checkFlags: vi.fn().mockReturnValue({ instantModeEnabled: true }),
  },
}));

vi.mock('../../src/services/InstantRateLimiter', () => ({
  InstantRateLimiter: {
    checkPostLimit:   vi.fn().mockResolvedValue({ allowed: true }),
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
    getRiskAssessment: vi.fn().mockResolvedValue({ success: true, data: { riskScore: 0.1 } }),
  },
}));

vi.mock('../../src/services/BackgroundCheckService', () => ({
  hasValidBackgroundCheck: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/services/ScoperAIService', () => ({
  ScoperAIService: {
    analyzeTaskScope: vi.fn().mockResolvedValue({ success: false }),
  },
}));

vi.mock('../../src/services/PlanService', () => ({
  PlanService: {
    canCreateTaskWithRisk: vi.fn().mockResolvedValue({ allowed: true }),
    canAcceptTaskWithRisk: vi.fn().mockResolvedValue({ allowed: true }),
    getUserPlan:           vi.fn().mockResolvedValue('free'),
    hasActiveEntitlement:  vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('../../src/services/InstantObservability', () => ({
  InstantObservability: { logAcceptRace: vi.fn() },
}));

vi.mock('../../src/services/InstantTrustConfig', () => ({
  MIN_INSTANT_TIER: 2,
  MIN_SENSITIVE_INSTANT_TIER: 3,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { TaskService } from '../../src/services/TaskService';
import { db, isInvariantViolation } from '../../src/db';

const mockQuery       = vi.mocked(db.query);
const mockTransaction = vi.mocked(db.transaction);
const mockIsInvariant = vi.mocked(isInvariantViolation);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    poster_id: 'poster-1',
    worker_id: 'worker-1',
    title: 'Mow lawn',
    description: 'Mow the front lawn',
    price: 2500,
    xp_reward: 250,
    state: 'OPEN',
    risk_level: 'LOW',
    mode: 'STANDARD',
    instant_mode: false,
    sensitive: false,
    requires_proof: true,
    progress_state: 'POSTED',
    created_at: new Date('2024-01-15T10:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockIsInvariant.mockReturnValue(false);

  // Default transaction implementation delegates to the callback with db.query
  mockTransaction.mockImplementation(async (fn: (q: typeof db.query) => Promise<unknown>) =>
    fn(db.query)
  );
});

// ===========================================================================
// getByPoster — cursor pagination branches
// ===========================================================================

describe('TaskService.getByPoster — cursor pagination', () => {
  it('uses no-cursor query and returns nextCursor when result has more than limit rows', async () => {
    // With limit=2 and fetchLimit=3, return 3 rows → hasMore=true → nextCursor set
    const tasks = [
      makeTask({ id: 'task-1', created_at: new Date('2024-01-15T10:00:00Z') }),
      makeTask({ id: 'task-2', created_at: new Date('2024-01-14T10:00:00Z') }),
      makeTask({ id: 'task-3', created_at: new Date('2024-01-13T10:00:00Z') }),
    ];
    mockQuery.mockResolvedValueOnce({ rows: tasks, rowCount: 3 } as never);

    const result = await TaskService.getByPoster('poster-1', { limit: 2 });

    expect(result.success).toBe(true);
    expect(result.data?.tasks).toHaveLength(2); // sliced to limit
    expect(result.data?.nextCursor).toBeDefined(); // hasMore=true sets cursor
    expect(typeof result.data?.nextCursor).toBe('string');
  });

  it('uses cursor-based query when cursor is provided', async () => {
    const cursorTs = '2024-01-14T10:00:00.000Z';
    const tasks = [makeTask({ id: 'task-2', created_at: new Date('2024-01-13T10:00:00Z') })];
    mockQuery.mockResolvedValueOnce({ rows: tasks, rowCount: 1 } as never);

    const result = await TaskService.getByPoster('poster-1', { cursor: cursorTs, limit: 20 });

    expect(result.success).toBe(true);
    expect(result.data?.tasks).toHaveLength(1);
    expect(result.data?.nextCursor).toBeUndefined(); // 1 row < limit → no next page

    // Verify cursor was passed to the query
    const callArgs = mockQuery.mock.calls[0];
    expect(callArgs[1]).toContain(cursorTs);
  });

  it('returns DB_ERROR when query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db connection lost') as never);

    const result = await TaskService.getByPoster('poster-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ===========================================================================
// getByWorker — cursor pagination branches
// ===========================================================================

describe('TaskService.getByWorker — cursor pagination', () => {
  it('returns nextCursor when more rows than limit', async () => {
    const tasks = [
      makeTask({ id: 'task-1', worker_id: 'worker-1', created_at: new Date('2024-01-15T10:00:00Z') }),
      makeTask({ id: 'task-2', worker_id: 'worker-1', created_at: new Date('2024-01-14T10:00:00Z') }),
      makeTask({ id: 'task-3', worker_id: 'worker-1', created_at: new Date('2024-01-13T10:00:00Z') }),
    ];
    mockQuery.mockResolvedValueOnce({ rows: tasks, rowCount: 3 } as never);

    const result = await TaskService.getByWorker('worker-1', { limit: 2 });

    expect(result.success).toBe(true);
    expect(result.data?.tasks).toHaveLength(2);
    expect(result.data?.nextCursor).toBeDefined();
  });

  it('uses cursor-based query when cursor is provided', async () => {
    const cursorTs = '2024-01-13T10:00:00.000Z';
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await TaskService.getByWorker('worker-1', { cursor: cursorTs, limit: 20 });

    const callArgs = mockQuery.mock.calls[0];
    expect(callArgs[1]).toContain(cursorTs);
  });
});

// ===========================================================================
// create — invariant violation catch branch
// ===========================================================================

describe('TaskService.create — invariant violation in DB', () => {
  it('returns invariant violation error when DB raises a trigger error', async () => {
    // PlanService and ScoperAI pass by default; DB INSERT throws invariant violation
    const invariantError = Object.assign(new Error('HX101: invariant violated'), {
      code: 'HX101',
    });
    mockIsInvariant.mockReturnValue(true);
    mockQuery.mockRejectedValueOnce(invariantError as never);

    const result = await TaskService.create({
      posterId: 'poster-1',
      title: 'Mow lawn',
      description: 'Mow the lawn',
      price: 1000,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HX101');
  });
});

// ===========================================================================
// complete — INV-3 violation catch branch (HX301)
// ===========================================================================

describe('TaskService.complete — INV-3 violation (HX301)', () => {
  it('returns INV_3_VIOLATION when DB trigger rejects COMPLETED without accepted proof', async () => {
    const hx301Error = Object.assign(new Error('HX301: proof must be accepted'), {
      code: 'HX301',
    });
    mockIsInvariant.mockReturnValue(true);
    mockQuery.mockRejectedValueOnce(hx301Error as never);

    const result = await TaskService.complete('task-1');

    expect(result.success).toBe(false);
    // The code for INV-3 violation (mapped from ErrorCodes.INV_3_VIOLATION)
    expect(result.error?.code).toMatch(/INV_3|HX301/);
  });
});

// ===========================================================================
// advanceProgress — idempotency branch (from === to)
// ===========================================================================

describe('TaskService.advanceProgress — idempotency', () => {
  it('returns current task state without error when from === to (idempotent no-op)', async () => {
    const task = makeTask({ progress_state: 'ACCEPTED', state: 'ACCEPTED' });

    // Transaction callback is called with db.query:
    // 1st call: FOR UPDATE SELECT → returns task with progress_state 'ACCEPTED'
    // 2nd call: SELECT * (idempotency re-fetch) → returns same task
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'ACCEPTED', state: 'ACCEPTED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [task], rowCount: 1 } as never);

    // writeToOutbox still fires for idempotent transitions
    const result = await TaskService.advanceProgress({
      taskId: 'task-1',
      to: 'ACCEPTED', // same as current progress_state
      actor: { type: 'system' },
    });

    expect(result.success).toBe(true);
    expect(result.data?.progress_state).toBe('ACCEPTED');
  });
});

// ===========================================================================
// advanceProgress — task not found branch
// ===========================================================================

describe('TaskService.advanceProgress — not found', () => {
  it('returns NOT_FOUND when task does not exist', async () => {
    // Transaction callback: FOR UPDATE SELECT returns empty rows
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskService.advanceProgress({
      taskId: 'nonexistent-task',
      to: 'TRAVELING',
      actor: { type: 'worker', userId: 'worker-1' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// advanceProgress — invalid transition branch
// ===========================================================================

describe('TaskService.advanceProgress — invalid transition', () => {
  it('returns INVALID_TRANSITION when transition is not in VALID_PROGRESS_TRANSITIONS', async () => {
    // Task progress_state is 'POSTED' — 'WORKING' is not a valid direct transition from POSTED
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'POSTED', state: 'OPEN' }],
      rowCount: 1,
    } as never);

    const result = await TaskService.advanceProgress({
      taskId: 'task-1',
      to: 'WORKING', // POSTED → WORKING is invalid; POSTED → ACCEPTED is the valid path
      actor: { type: 'system' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TRANSITION');
    expect(result.error?.message).toContain('Invalid progress transition');
  });
});

// ===========================================================================
// advanceProgress — authorization branches
// ===========================================================================

describe('TaskService.advanceProgress — authorization', () => {
  it('returns FORBIDDEN when worker actor does not own the task', async () => {
    // TRAVELING requires worker actor; worker-2 tries but task.worker_id is worker-1
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'ACCEPTED', state: 'ACCEPTED' }],
      rowCount: 1,
    } as never);

    const result = await TaskService.advanceProgress({
      taskId: 'task-1',
      to: 'TRAVELING',
      actor: { type: 'worker', userId: 'worker-2' }, // wrong worker
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.error?.message).toContain('does not own task');
  });

  it('returns FORBIDDEN when system-only transition is attempted by worker actor', async () => {
    // ACCEPTED is a system-only transition
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'POSTED', state: 'OPEN' }],
      rowCount: 1,
    } as never);

    const result = await TaskService.advanceProgress({
      taskId: 'task-1',
      to: 'ACCEPTED', // system-only
      actor: { type: 'worker', userId: 'worker-1' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.error?.message).toContain('requires');
  });
});

// ===========================================================================
// advanceProgress — dispute freeze branch
// ===========================================================================

describe('TaskService.advanceProgress — dispute freeze', () => {
  it('returns INVALID_STATE when task has an active (non-RESOLVED) dispute', async () => {
    // Sequence of query calls inside transaction:
    // 1. FOR UPDATE task select → task with progress_state='ACCEPTED'
    // 2. disputes SELECT → dispute with state='OPEN' (active, non-RESOLVED)
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'ACCEPTED', state: 'ACCEPTED' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ state: 'OPEN' }], // active dispute
        rowCount: 1,
      } as never);

    const result = await TaskService.advanceProgress({
      taskId: 'task-1',
      to: 'TRAVELING',
      actor: { type: 'worker', userId: 'worker-1' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('active dispute');
  });
});

// ===========================================================================
// advanceProgress — escrow terminal freeze branch
// ===========================================================================

describe('TaskService.advanceProgress — escrow terminal freeze', () => {
  it('returns INVALID_STATE when escrow is in terminal state RELEASED', async () => {
    // Sequence inside transaction:
    // 1. FOR UPDATE task select
    // 2. disputes SELECT → empty (no active dispute)
    // 3. escrows SELECT → escrow with state='RELEASED' (terminal)
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'ACCEPTED', state: 'ACCEPTED' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // no disputes
      .mockResolvedValueOnce({ rows: [{ state: 'RELEASED' }], rowCount: 1 } as never); // terminal escrow

    const result = await TaskService.advanceProgress({
      taskId: 'task-1',
      to: 'TRAVELING',
      actor: { type: 'worker', userId: 'worker-1' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('terminal state');
  });
});

// ===========================================================================
// advanceProgress — happy path (full success)
// ===========================================================================

describe('TaskService.advanceProgress — success', () => {
  it('advances from ACCEPTED to TRAVELING with worker actor (full happy path)', async () => {
    const updatedTask = makeTask({ progress_state: 'TRAVELING', state: 'ACCEPTED' });

    // Sequence:
    // 1. FOR UPDATE task select (progress_state='ACCEPTED', worker_id='worker-1')
    // 2. disputes SELECT → empty
    // 3. escrows SELECT → empty
    // 4. UPDATE task SET progress_state='TRAVELING' → returns updated task
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', progress_state: 'ACCEPTED', state: 'ACCEPTED' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)  // no disputes
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)  // no escrow
      .mockResolvedValueOnce({ rows: [updatedTask], rowCount: 1 } as never); // UPDATE result

    const result = await TaskService.advanceProgress({
      taskId: 'task-1',
      to: 'TRAVELING',
      actor: { type: 'worker', userId: 'worker-1' },
    });

    expect(result.success).toBe(true);
    expect(result.data?.progress_state).toBe('TRAVELING');
  });
});
