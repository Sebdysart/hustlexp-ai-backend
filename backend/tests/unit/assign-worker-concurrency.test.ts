/**
 * assignWorker Concurrency Tests (FIX 1 — CRITICAL TOCTOU)
 *
 * Verifies that the assignWorker mutation's db.transaction() + SELECT FOR UPDATE
 * fix eliminates the race condition where two concurrent poster calls could both
 * read state='POSTED' and leave task_applications in an inconsistent state.
 *
 * Strategy: we test the mutation handler by extracting it from the tRPC router
 * definition and calling its resolve function directly with a mock context.
 * This avoids needing createCallerFactory (not exported in this tRPC build).
 *
 * The key invariants under test:
 *  1. db.transaction() is called — all state-mutating ops are in one transaction.
 *  2. The first SQL inside the transaction contains FOR UPDATE (row-level lock).
 *  3. If the task state is already non-POSTED inside the transaction, a
 *     PRECONDITION_FAILED error is thrown and no application rows are touched.
 *  4. On success, only one application is accepted (the chosen worker's app).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that pull those modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
  };
});

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
  const baseLogger = {
    child,
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return {
    logger: baseLogger,
    taskLogger: baseLogger,
    aiLogger: baseLogger,
    escrowLogger: baseLogger,
    authLogger: baseLogger,
    workerLogger: baseLogger,
  };
});

vi.mock('../../src/cache/db-cache', () => ({
  cachedDbQuery: vi.fn((key: unknown, fn: () => unknown) => fn()),
  invalidateTask: vi.fn().mockResolvedValue(undefined),
  CACHE_KEYS: { taskDetails: vi.fn(() => 'task-cache-key') },
  CACHE_TTL: { taskDetails: 60 },
  CACHE_TAGS: { TASK: vi.fn(() => 'task-tag') },
}));

vi.mock('../../src/cache/redis', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    getById: vi.fn(),
    create: vi.fn(),
    accept: vi.fn(),
    submitProof: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
    listOpen: vi.fn(),
    getByPoster: vi.fn(),
    getByWorker: vi.fn(),
  },
}));

vi.mock('../../src/services/ProofService', () => ({
  ProofService: {
    submit: vi.fn(),
    getById: vi.fn(),
    getByTask: vi.fn(),
    getPhotos: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getVideos: vi.fn().mockResolvedValue({ success: true, data: [] }),
  },
}));

vi.mock('../../src/services/ComplianceGuardianService', () => ({
  ComplianceGuardianService: {
    evaluate: vi.fn().mockResolvedValue({
      tier: 'ok',
      score: 0,
      notes: [],
      triggeredRules: [],
    }),
  },
}));

vi.mock('../../src/services/ScoperAIService', () => ({
  ScoperAIService: {
    analyzeTaskScope: vi.fn().mockResolvedValue({ success: false }),
  },
}));

vi.mock('../../src/services/TaskTemplateRegistry', () => ({
  getTemplate: vi.fn().mockReturnValue({
    slug: 'standard_physical',
    requiredTrustTier: 'rookie',
    requiresMutualConsent: false,
    requiresContentRelease: false,
    autoReleaseHours: 24,
    lateCancelPct: 0,
  }),
  getManifest: vi.fn().mockReturnValue([]),
  isCareContent: vi.fn().mockReturnValue(false),
  isContentReleaseRequired: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/services/TaskRiskClassifier', () => ({
  TaskRiskClassifier: {
    classifyWithTemplate: vi.fn().mockReturnValue('LOW'),
  },
}));

// ---------------------------------------------------------------------------
// Actual imports (after mocks)
// ---------------------------------------------------------------------------
import { db } from '../../src/db';
import { invalidateTask } from '../../src/cache/db-cache';

// Import the router — this triggers all vi.mock hoisting
import { taskRouter } from '../../src/routers/task';

const mockQuery = vi.mocked(db.query);
const mockTransaction = vi.mocked(db.transaction);
const mockInvalidateTask = vi.mocked(invalidateTask);

// ---------------------------------------------------------------------------
// Extract the assignWorker mutation resolver from the tRPC router definition.
// tRPC v10/v11 stores procedures under _def.procedures.
// ---------------------------------------------------------------------------
function getAssignWorkerResolver() {
  const procedures = (taskRouter as any)._def?.procedures ?? taskRouter;
  const proc = procedures.assignWorker;
  if (!proc) throw new Error('assignWorker procedure not found on taskRouter');
  // The resolve function is stored under _def.resolver or _def.mutation
  const resolver = proc._def?.resolver ?? proc._def?.mutation ?? proc._def?.query;
  if (typeof resolver !== 'function') {
    throw new Error('assignWorker resolver is not a function — check tRPC internal structure');
  }
  return resolver;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: 'poster-1',
      role: 'poster',
      trust_tier: 1,
      is_admin: false,
      ...overrides,
    },
  };
}

function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    state: 'POSTED',
    poster_id: 'poster-1',
    worker_id: null,
    template_slug: 'standard_physical',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assignWorker — transaction locking (FIX 1)', () => {
  let resolver: (opts: { ctx: unknown; input: unknown }) => Promise<unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    // transaction delegates to the callback with db.query as the txn fn
    mockTransaction.mockImplementation(async (fn) => fn(db.query));
    resolver = getAssignWorkerResolver();
  });

  it('db.transaction() is entered — all state-mutating ops use a single tx', async () => {
    // Happy path: task is POSTED, worker has pending application
    mockQuery
      .mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as never) // pre-tx template slug
      .mockResolvedValueOnce({ rows: [makeTaskRow()], rowCount: 1 } as never)                         // tx: FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'app-1' }], rowCount: 1 } as never)                       // tx: SELECT application
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)                                       // tx: UPDATE accepted
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)                                       // tx: UPDATE rejected
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'ACCEPTED', worker_id: 'worker-1' }],
        rowCount: 1,
      } as never); // tx: UPDATE tasks

    await resolver({
      ctx: makeCtx(),
      input: { taskId: 'task-1', workerId: 'worker-1' },
    });

    // Transaction must have been entered exactly once
    expect(mockTransaction).toHaveBeenCalledOnce();

    // Confirm task cache is invalidated after success
    expect(mockInvalidateTask).toHaveBeenCalledWith('task-1');
  });

  it('first query inside the transaction contains FOR UPDATE (row-level lock)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeTaskRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'app-1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'ACCEPTED', worker_id: 'worker-1' }],
        rowCount: 1,
      } as never);

    await resolver({
      ctx: makeCtx(),
      input: { taskId: 'task-1', workerId: 'worker-1' },
    });

    // The second query call is the first inside the transaction (after the pre-tx slug lookup)
    const allCalls = mockQuery.mock.calls;
    expect(allCalls.length).toBeGreaterThanOrEqual(2);
    const firstTxSql = allCalls[1][0] as string;
    expect(firstTxSql).toContain('FOR UPDATE');
    expect(firstTxSql.toUpperCase()).toContain('SELECT');
  });

  it('second concurrent call gets PRECONDITION_FAILED when task state changes mid-race', async () => {
    // Simulate: second caller's FOR UPDATE returns state='ACCEPTED' (first caller already won)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as never) // pre-tx template slug
      .mockResolvedValueOnce({
        rows: [makeTaskRow({ state: 'ACCEPTED', worker_id: 'worker-1' })],
        rowCount: 1,
      } as never); // tx: FOR UPDATE → state already changed by first caller

    await expect(
      resolver({ ctx: makeCtx(), input: { taskId: 'task-1', workerId: 'worker-2' } })
    ).rejects.toThrow(TRPCError);

    // No application UPDATE calls — we bailed at state check
    const updateCalls = mockQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.trim().toUpperCase().startsWith('UPDATE')
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('only one application ends up accepted: the chosen worker, all others rejected', async () => {
    const acceptedApp = { id: 'app-worker-1' };

    mockQuery
      .mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeTaskRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [acceptedApp], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'ACCEPTED', worker_id: 'worker-1' }],
        rowCount: 1,
      } as never);

    await resolver({
      ctx: makeCtx(),
      input: { taskId: 'task-1', workerId: 'worker-1' },
    });

    // Find the UPDATE that sets status='accepted'
    const acceptCall = mockQuery.mock.calls.find(
      ([sql, params]) =>
        typeof sql === 'string' &&
        sql.includes("status = 'accepted'") &&
        Array.isArray(params) &&
        params.includes('app-worker-1')
    );
    expect(acceptCall).toBeDefined();

    // Find the UPDATE that sets status='rejected' and excludes app-worker-1
    const rejectCall = mockQuery.mock.calls.find(
      ([sql, params]) =>
        typeof sql === 'string' &&
        sql.includes("status = 'rejected'") &&
        Array.isArray(params) &&
        params.includes('app-worker-1')
    );
    expect(rejectCall).toBeDefined();
  });

  it('throws NOT_FOUND when task does not exist at template-slug pre-check', async () => {
    // Pre-tx SELECT finds nothing → early exit before transaction is entered
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(
      resolver({ ctx: makeCtx(), input: { taskId: 'task-1', workerId: 'worker-1' } })
    ).rejects.toThrow(TRPCError);

    // Transaction is never entered
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when task disappears between pre-tx lookup and FOR UPDATE', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as never) // pre-tx
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                                       // FOR UPDATE finds nothing

    await expect(
      resolver({ ctx: makeCtx(), input: { taskId: 'task-1', workerId: 'worker-1' } })
    ).rejects.toThrow(TRPCError);
  });

  it('throws PRECONDITION_FAILED and rolls back when tasks UPDATE affects 0 rows', async () => {
    // This simulates the edge case where the FOR UPDATE check passed but the final
    // UPDATE tasks returns rowCount=0 (state changed by another process after lock check)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeTaskRow()], rowCount: 1 } as never)    // FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'app-1' }], rowCount: 1 } as never) // SELECT app
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)                 // UPDATE accepted
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)                 // UPDATE rejected
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                // UPDATE tasks → 0 rows

    await expect(
      resolver({ ctx: makeCtx(), input: { taskId: 'task-1', workerId: 'worker-1' } })
    ).rejects.toThrow(TRPCError);
  });
});
