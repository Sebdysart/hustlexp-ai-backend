/**
 * Task Router Unit Tests
 *
 * Tests all public procedures in the task router:
 *
 * READ:
 *   - getById: single task fetch via TaskService
 *   - getState: raw db.query for task state
 *   - listByPoster: cursor-paginated (via TaskService.getByPoster)
 *   - listByWorker: cursor-paginated (via TaskService.getByWorker)
 *   - listOpen: offset-paginated (via TaskService.listOpen)
 *   - getProof: raw db.query for proof by taskId
 *
 * WRITE:
 *   - create: TaskService.create
 *   - accept: TaskService.accept
 *   - start: verify worker ownership + state, return task row
 *   - submitProof: ProofService.submit + TaskService.submitProof
 *   - reviewProof: complex multi-step proof review
 *   - complete: authorization + TaskService.complete
 *   - cancel: authorization + TaskService.cancel
 *
 * APPLICATION MANAGEMENT:
 *   - applyForTask: hustler applies (db.query direct)
 *   - listApplicants: poster sees applicants (db.query direct)
 *   - assignWorker: poster picks hustler (db.query + TaskService.accept)
 *   - rejectApplicant: poster rejects (db.query direct)
 *   - withdrawApplication: hustler withdraws (db.query direct)
 *
 * Pattern: mock db + services at module level, use createCaller with
 * a fake protected context to bypass middleware.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that transitively touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      // Delegate to the callback with the same queryFn so mockResolvedValueOnce
      // sequences set up on db.query work seamlessly inside transactions.
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
  };
});

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  aiLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  taskLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    getById: vi.fn(),
    getByPoster: vi.fn(),
    getByWorker: vi.fn(),
    listOpen: vi.fn(),
    create: vi.fn(),
    accept: vi.fn(),
    submitProof: vi.fn(),
    rejectProof: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock('../../src/services/ProofService', () => ({
  ProofService: {
    submit: vi.fn(),
    getById: vi.fn(),
    review: vi.fn(),
    getPhotos: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getVideos: vi.fn().mockResolvedValue({ success: true, data: [] }),
  },
}));

vi.mock('../../src/cache/db-cache', () => ({
  // Pass-through: execute the wrapped function directly, no cache layer in tests
  cachedDbQuery: vi.fn().mockImplementation((_key: string, fn: () => Promise<unknown>) => fn()),
  invalidateTask: vi.fn().mockResolvedValue(undefined),
  CACHE_KEYS: { taskDetails: (id: string) => `task:${id}` },
  CACHE_TTL: { taskDetails: 60 },
  CACHE_TAGS: { TASK: (id: string) => `task:${id}` },
}));

vi.mock('../../src/services/ComplianceGuardianService', () => ({
  ComplianceGuardianService: {
    evaluate: vi.fn().mockResolvedValue({
      score: 0,
      tier: 'clean',
      triggeredRules: [],
      suggestedAlternative: undefined,
      notes: { score: 0, tier: 'clean', triggered_rules: [], suggested_alternative: null, admin_review_id: null, appeal_status: 'none' },
    }),
  },
}));

vi.mock('../../src/services/TaskTemplateRegistry', () => ({
  TEMPLATE_SLUGS: {
    STANDARD_PHYSICAL: 'standard_physical',
    IN_HOME: 'in_home',
    CARE: 'care',
    CONTENT_CREATOR: 'content_creator',
    EVENT_APPEARANCE: 'event_appearance',
    CREATIVE_PRODUCTION: 'creative_production',
    SPECIALIZED_LICENSED: 'specialized_licensed',
    WILDCARD_BIZARRE: 'wildcard_bizarre',
  },
  getTemplate: vi.fn().mockReturnValue({
    slug: 'standard_physical',
    displayName: 'Standard Physical',
    one_line_desc: 'Help moving, delivery, or muscle work out in the world',
    defaultRiskTier: 0,
    requiredTrustTier: 'rookie',
    completionCriteriaType: 'photo_proof',
    autoReleaseHours: 24,
    lateCancelPct: 0,
    requiresMutualConsent: false,
    requiresContentRelease: false,
    scoperContext: '',
  }),
  getManifest: vi.fn().mockReturnValue([]),
  // FIX 2 & 3: content-based detection helpers — default to false in tests
  isCareContent: vi.fn().mockReturnValue(false),
  isContentReleaseRequired: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/services/TaskRiskClassifier', () => ({
  TaskRiskClassifier: {
    classifyWithTemplate: vi.fn().mockReturnValue(0),
  },
}));

// Mock Redis so rate-limit checks are controlled in tests.
// Default: allowed=true (no rate limiting). Individual tests can override.
vi.mock('../../src/cache/redis', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { TaskService } from '../../src/services/TaskService';
import { ProofService } from '../../src/services/ProofService';
import { ComplianceGuardianService } from '../../src/services/ComplianceGuardianService';
import { getTemplate, isCareContent, isContentReleaseRequired, getManifest } from '../../src/services/TaskTemplateRegistry';
import { TaskRiskClassifier } from '../../src/services/TaskRiskClassifier';
import { cachedDbQuery, invalidateTask } from '../../src/cache/db-cache';
import { taskRouter } from '../../src/routers/task';
import { checkRateLimit } from '../../src/cache/redis';

const mockCheckRateLimit = vi.mocked(checkRateLimit);

const mockDb = vi.mocked(db);
const mockTaskService = vi.mocked(TaskService);
const mockProofService = vi.mocked(ProofService);
const mockCompliance = vi.mocked(ComplianceGuardianService);
const mockGetTemplate = vi.mocked(getTemplate);
const mockIsCareContent = vi.mocked(isCareContent);
const mockIsContentReleaseRequired = vi.mocked(isContentReleaseRequired);
const mockGetManifest = vi.mocked(getManifest);
const mockTaskRiskClassifier = vi.mocked(TaskRiskClassifier);
const mockCachedDbQuery = vi.mocked(cachedDbQuery);
const mockInvalidateTask = vi.mocked(invalidateTask);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TASK_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PROOF_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const APP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: 'Test Task',
    description: 'Do something',
    price: 5000,
    state: 'OPEN',
    poster_id: USER_ID,
    worker_id: null,
    category: 'general',
    location: null,
    requirements: null,
    deadline: null,
    requires_proof: true,
    mode: 'STANDARD',
    instant_mode: false,
    xp_reward: 500,
    created_at: new Date('2025-06-01T00:00:00Z'),
    updated_at: new Date('2025-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeProofRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROOF_ID,
    task_id: TASK_ID,
    submitter_id: OTHER_USER_ID,
    state: 'SUBMITTED',
    description: 'I did it',
    created_at: new Date('2025-06-02T00:00:00Z'),
    submitted_at: new Date('2025-06-02T00:00:00Z'),
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    ...overrides,
  };
}

function makeCaller(userId = USER_ID, defaultMode: 'worker' | 'poster' = 'worker') {
  const fakeUser = {
    id: userId,
    email: 'user@hustlexp.com',
    full_name: 'Test User',
    role: defaultMode === 'worker' ? 'hustler' : 'poster',
    default_mode: defaultMode,
    firebase_uid: 'fb-user',
  };
  return taskRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-user',
  });
}

// Convenience helpers matching the tRPC middleware checks:
//   hustlerProcedure → default_mode === 'worker'
//   posterProcedure  → default_mode === 'poster'
const makeCallerAsHustler = (userId = USER_ID) => makeCaller(userId, 'worker');
const makeCallerAsPoster = (userId = USER_ID) => makeCaller(userId, 'poster');

// ---------------------------------------------------------------------------
// Global beforeEach — reset all mocks then restore always-on defaults.
// Centralising vi.resetAllMocks() here (instead of per-describe) ensures the
// default implementations are re-established AFTER the reset, so they are
// always available. Per-describe beforeEach blocks have been emptied of their
// vi.resetAllMocks() calls to avoid wiping these defaults a second time.
// ---------------------------------------------------------------------------
beforeEach(() => {
  // Reset all mocks first (clears Once queues AND implementations)
  vi.resetAllMocks();

  // Cache pass-through: execute the wrapped fn directly, no cache in tests
  mockCachedDbQuery.mockImplementation((_key: string, fn: () => Promise<unknown>) => fn());
  mockInvalidateTask.mockResolvedValue(undefined);

  // Rate limiting: allowed by default
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 10 });

  // Compliance: clean result by default
  mockCompliance.evaluate.mockResolvedValue({
    score: 0,
    tier: 'clean',
    triggeredRules: [],
    suggestedAlternative: undefined,
    notes: { score: 0, tier: 'clean', triggered_rules: [], suggested_alternative: null, admin_review_id: null, appeal_status: 'none' },
  });

  // Template stubs
  mockGetTemplate.mockReturnValue({
    slug: 'standard_physical',
    displayName: 'Standard Physical',
    one_line_desc: 'Help moving, delivery, or muscle work out in the world',
    defaultRiskTier: 0,
    requiredTrustTier: 'rookie',
    completionCriteriaType: 'photo_proof',
    autoReleaseHours: 24,
    lateCancelPct: 0,
    requiresMutualConsent: false,
    requiresContentRelease: false,
    scoperContext: '',
  } as any);
  mockGetManifest.mockReturnValue([]);
  mockIsCareContent.mockReturnValue(false);
  mockIsContentReleaseRequired.mockReturnValue(false);

  // Risk classifier
  mockTaskRiskClassifier.classifyWithTemplate.mockReturnValue(0);

  // ProofService safe defaults
  mockProofService.getPhotos.mockResolvedValue({ success: true, data: [] } as any);
  mockProofService.getVideos.mockResolvedValue({ success: true, data: [] } as any);

  // db.transaction: delegate to callback with the same query fn
  mockDb.transaction.mockImplementation((fn: (q: typeof mockDb.query) => Promise<unknown>) => fn(mockDb.query));
});

// ===========================================================================
// task.getById
// ===========================================================================

describe('task.getById', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns task data when found', async () => {
    const task = makeTaskRow();
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });

    const result = await makeCaller().getById({ taskId: TASK_ID });

    expect(result).toEqual(task);
    expect(mockTaskService.getById).toHaveBeenCalledWith(TASK_ID);
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });

    await expect(makeCaller().getById({ taskId: TASK_ID })).rejects.toThrow('Task not found');
  });

  it('rejects invalid UUID input', async () => {
    await expect(makeCaller().getById({ taskId: 'not-a-uuid' })).rejects.toThrow();
  });
});

// ===========================================================================
// task.getState
// ===========================================================================

describe('task.getState', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns { state } for existing task', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ state: 'ACCEPTED', poster_id: USER_ID, worker_id: null }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getState({ taskId: TASK_ID });

    expect(result).toEqual({ state: 'ACCEPTED' });
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(makeCaller().getState({ taskId: TASK_ID })).rejects.toThrow('Task not found');
  });

  it('passes taskId to db.query', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'OPEN', poster_id: USER_ID, worker_id: null }], rowCount: 1 } as any);

    await makeCaller().getState({ taskId: TASK_ID });

    const [sql, params] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain('SELECT state');
    expect(sql).toContain('FROM tasks');
    expect(params).toContain(TASK_ID);
  });

  it('rejects invalid UUID input', async () => {
    await expect(makeCaller().getState({ taskId: 'bad' })).rejects.toThrow();
  });
});

// ===========================================================================
// task.listByPoster — cursor-based (via TaskService)
// ===========================================================================

describe('task.listByPoster', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns { tasks, nextCursor } from TaskService', async () => {
    const tasks = [makeTaskRow()];
    mockTaskService.getByPoster.mockResolvedValueOnce({
      success: true,
      data: { tasks: tasks as any, nextCursor: '2025-06-01T00:00:00Z' },
    });

    const result = await makeCallerAsPoster().listByPoster({});

    expect(result).toHaveProperty('tasks');
    expect(result).toHaveProperty('nextCursor');
    expect(result.tasks).toHaveLength(1);
    expect(result.nextCursor).toBe('2025-06-01T00:00:00Z');
  });

  it('defaults to ctx.user.id when no posterId given', async () => {
    mockTaskService.getByPoster.mockResolvedValueOnce({
      success: true,
      data: { tasks: [] as any, nextCursor: undefined },
    });

    await makeCallerAsPoster().listByPoster({});

    expect(mockTaskService.getByPoster).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ cursor: null, limit: 20 })
    );
  });

  it('throws FORBIDDEN when posterId does not match user', async () => {
    await expect(
      makeCallerAsPoster().listByPoster({ posterId: OTHER_USER_ID })
    ).rejects.toThrow('You can only view your own posted tasks');
  });

  it('returns empty tasks when none found', async () => {
    mockTaskService.getByPoster.mockResolvedValueOnce({
      success: true,
      data: { tasks: [] as any, nextCursor: undefined },
    });

    const result = await makeCallerAsPoster().listByPoster({});

    expect(result.tasks).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('passes cursor and limit to TaskService', async () => {
    mockTaskService.getByPoster.mockResolvedValueOnce({
      success: true,
      data: { tasks: [] as any, nextCursor: undefined },
    });

    await makeCallerAsPoster().listByPoster({ cursor: '2025-01-01T00:00:00Z', limit: 10 });

    expect(mockTaskService.getByPoster).toHaveBeenCalledWith(
      USER_ID,
      { cursor: '2025-01-01T00:00:00Z', limit: 10 }
    );
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockTaskService.getByPoster.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Database unavailable' },
    });

    await expect(makeCallerAsPoster().listByPoster({})).rejects.toThrow('Database unavailable');
  });

  it('accepts undefined input (no params at all)', async () => {
    mockTaskService.getByPoster.mockResolvedValueOnce({
      success: true,
      data: { tasks: [] as any, nextCursor: undefined },
    });

    const result = await makeCallerAsPoster().listByPoster(undefined as any);

    expect(result.tasks).toHaveLength(0);
  });
});

// ===========================================================================
// task.listByWorker — cursor-based (via TaskService)
// ===========================================================================

describe('task.listByWorker', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns { tasks, nextCursor } from TaskService', async () => {
    const tasks = [makeTaskRow({ worker_id: USER_ID, state: 'ACCEPTED' })];
    mockTaskService.getByWorker.mockResolvedValueOnce({
      success: true,
      data: { tasks: tasks as any, nextCursor: undefined },
    });

    const result = await makeCaller().listByWorker({});

    expect(result).toHaveProperty('tasks');
    expect(result).toHaveProperty('nextCursor');
    expect(result.tasks).toHaveLength(1);
  });

  it('throws FORBIDDEN when workerId does not match user', async () => {
    await expect(
      makeCaller().listByWorker({ workerId: OTHER_USER_ID })
    ).rejects.toThrow('You can only view your own accepted tasks');
  });

  it('defaults to ctx.user.id when no workerId given', async () => {
    mockTaskService.getByWorker.mockResolvedValueOnce({
      success: true,
      data: { tasks: [] as any, nextCursor: undefined },
    });

    await makeCaller().listByWorker({});

    expect(mockTaskService.getByWorker).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ cursor: null, limit: 20 })
    );
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockTaskService.getByWorker.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'DB down' },
    });

    await expect(makeCaller().listByWorker({})).rejects.toThrow('DB down');
  });
});

// ===========================================================================
// task.listOpen — offset-based (via TaskService)
// ===========================================================================

describe('task.listOpen', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns task data array from TaskService', async () => {
    const tasks = [makeTaskRow(), makeTaskRow({ id: 'ff000000-0000-0000-0000-000000000001' })];
    mockTaskService.listOpen.mockResolvedValueOnce({
      success: true,
      data: tasks as any,
    });

    const result = await makeCaller().listOpen({ limit: 20, offset: 0 });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('passes limit and offset to TaskService', async () => {
    mockTaskService.listOpen.mockResolvedValueOnce({
      success: true,
      data: [] as any,
    });

    await makeCaller().listOpen({ limit: 10, offset: 30 });

    expect(mockTaskService.listOpen).toHaveBeenCalledWith({ limit: 10, offset: 30 });
  });

  it('uses default limit of 20 and offset of 0', async () => {
    mockTaskService.listOpen.mockResolvedValueOnce({
      success: true,
      data: [] as any,
    });

    await makeCaller().listOpen({});

    expect(mockTaskService.listOpen).toHaveBeenCalledWith({ limit: 20, offset: 0 });
  });

  it('returns empty array when no open tasks', async () => {
    mockTaskService.listOpen.mockResolvedValueOnce({
      success: true,
      data: [] as any,
    });

    const result = await makeCaller().listOpen({ limit: 20, offset: 0 });

    expect(result).toHaveLength(0);
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockTaskService.listOpen.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Connection lost' },
    });

    await expect(makeCaller().listOpen({ limit: 20, offset: 0 })).rejects.toThrow('Connection lost');
  });
});

// ===========================================================================
// task.create
// ===========================================================================

describe('task.create', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  const validInput = {
    title: 'Mow the lawn',
    description: 'Front and back yard',
    price: 5000,
  };

  it('returns created task from TaskService', async () => {
    const task = makeTaskRow({ title: 'Mow the lawn' });
    mockTaskService.create.mockResolvedValueOnce({ success: true, data: task as any });

    const result = await makeCallerAsPoster().create(validInput);

    expect(result).toEqual(task);
  });

  it('passes posterId from ctx.user.id', async () => {
    mockTaskService.create.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow() as any,
    });

    await makeCallerAsPoster().create(validInput);

    expect(mockTaskService.create).toHaveBeenCalledWith(
      expect.objectContaining({ posterId: USER_ID })
    );
  });

  it('passes all optional fields', async () => {
    mockTaskService.create.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow() as any,
    });

    await makeCallerAsPoster().create({
      ...validInput,
      requirements: 'Bring your own mower',
      location: '123 Main St',
      category: 'landscaping',
      deadline: '2025-12-31T23:59:59Z',
      requiresProof: false,
      mode: 'LIVE',
      liveBroadcastRadiusMiles: 10,
      instantMode: true,
    });

    expect(mockTaskService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requirements: 'Bring your own mower',
        location: '123 Main St',
        category: 'landscaping',
        requiresProof: false,
        mode: 'LIVE',
        liveBroadcastRadiusMiles: 10,
        instantMode: true,
      })
    );
  });

  it('throws BAD_REQUEST when service returns generic error', async () => {
    mockTaskService.create.mockResolvedValueOnce({
      success: false,
      error: { code: 'PRICE_TOO_LOW', message: 'Too cheap' },
    });

    await expect(makeCallerAsPoster().create(validInput)).rejects.toThrow('Too cheap');
  });

  it('throws PRECONDITION_FAILED for HX901/HX902 errors', async () => {
    mockTaskService.create.mockResolvedValueOnce({
      success: false,
      error: { code: 'HX902', message: 'Live violation' },
    });

    await expect(makeCallerAsPoster().create(validInput)).rejects.toThrow('Live violation');
  });

  it('rejects input with empty title', async () => {
    await expect(
      makeCallerAsPoster().create({ ...validInput, title: '' })
    ).rejects.toThrow();
  });

  it('rejects input with negative price', async () => {
    await expect(
      makeCallerAsPoster().create({ ...validInput, price: -100 })
    ).rejects.toThrow();
  });

  it('rejects input with non-integer price', async () => {
    await expect(
      makeCallerAsPoster().create({ ...validInput, price: 50.5 })
    ).rejects.toThrow();
  });
});

// ===========================================================================
// task.accept
// ===========================================================================

describe('task.accept', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns accepted task from TaskService', async () => {
    const task = makeTaskRow({ state: 'ACCEPTED', worker_id: USER_ID });
    mockTaskService.accept.mockResolvedValueOnce({ success: true, data: task as any });

    const result = await makeCaller().accept({ taskId: TASK_ID });

    expect(result).toEqual(task);
    expect(mockTaskService.accept).toHaveBeenCalledWith({
      taskId: TASK_ID,
      workerId: USER_ID,
    });
  });

  it('throws PRECONDITION_FAILED for HX002 errors', async () => {
    mockTaskService.accept.mockResolvedValueOnce({
      success: false,
      error: { code: 'HX002', message: 'Invalid state' },
    });

    await expect(makeCaller().accept({ taskId: TASK_ID })).rejects.toThrow('Invalid state');
  });

  it('throws BAD_REQUEST for other errors', async () => {
    mockTaskService.accept.mockResolvedValueOnce({
      success: false,
      error: { code: 'SOME_ERROR', message: 'Something wrong' },
    });

    await expect(makeCaller().accept({ taskId: TASK_ID })).rejects.toThrow('Something wrong');
  });

  it('rejects invalid UUID input', async () => {
    await expect(makeCaller().accept({ taskId: 'nope' })).rejects.toThrow();
  });
});

// ===========================================================================
// task.start
// ===========================================================================

describe('task.start', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns task row when worker is assigned and state is ACCEPTED', async () => {
    const task = makeTaskRow({ state: 'ACCEPTED', worker_id: USER_ID });
    // First getById: ownership/state check; second getById: return after invalidation
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });

    const result = await makeCaller().start({ taskId: TASK_ID });

    expect(result).toEqual(task);
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });

    await expect(makeCaller().start({ taskId: TASK_ID })).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when user is not the assigned worker', async () => {
    const task = makeTaskRow({ state: 'ACCEPTED', worker_id: OTHER_USER_ID });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });

    await expect(makeCaller().start({ taskId: TASK_ID })).rejects.toThrow(
      'Only the assigned worker can start this task'
    );
  });

  it('throws PRECONDITION_FAILED when task is not in ACCEPTED state', async () => {
    const task = makeTaskRow({ state: 'OPEN', worker_id: USER_ID });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });

    await expect(makeCaller().start({ taskId: TASK_ID })).rejects.toThrow(
      'Task must be ACCEPTED to start'
    );
  });
});

// ===========================================================================
// task.getProof
// ===========================================================================

describe('task.getProof', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns proof row when found', async () => {
    const proof = makeProofRow();
    mockDb.query.mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as any);

    const result = await makeCaller().getProof({ taskId: TASK_ID });

    // Router enriches proof with photos/videos arrays
    expect(result).toMatchObject(proof);
    expect(result).toHaveProperty('photos');
    expect(result).toHaveProperty('videos');
  });

  it('throws NOT_FOUND when no proof exists', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(makeCaller().getProof({ taskId: TASK_ID })).rejects.toThrow(
      'No proof found for this task'
    );
  });

  it('passes taskId and userId to the query', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [makeProofRow()], rowCount: 1 } as any);

    await makeCaller().getProof({ taskId: TASK_ID });

    const [sql, params] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain('task_id = $1');
    expect(params).toContain(TASK_ID);
    expect(params).toContain(USER_ID);
  });

  it('rejects invalid UUID input', async () => {
    await expect(makeCaller().getProof({ taskId: 'bad-uuid' })).rejects.toThrow();
  });
});

// ===========================================================================
// task.submitProof
// ===========================================================================

describe('task.submitProof', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  // YY-02: raw BEGIN/COMMIT/ROLLBACK removed. ProofService.submit and
  // TaskService.submitProof each manage their own internal db.transaction().
  // The mock sequences no longer include BEGIN/COMMIT/ROLLBACK entries.

  it('returns { task, proof } on success', async () => {
    const proof = makeProofRow();
    const task = makeTaskRow({ state: 'PROOF_SUBMITTED' });
    // KK4: ownership check
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any);
    mockProofService.submit.mockResolvedValueOnce({ success: true, data: proof as any });
    mockTaskService.submitProof.mockResolvedValueOnce({ success: true, data: task as any });

    const result = await makeCaller().submitProof({
      taskId: TASK_ID,
      description: 'Completed the work',
    });

    expect(result).toHaveProperty('task');
    expect(result).toHaveProperty('proof');
    expect(result.task).toEqual(task);
    expect(result.proof).toEqual(proof);
  });

  it('passes extended fields to ProofService.submit', async () => {
    // KK4: ownership check
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any);
    mockProofService.submit.mockResolvedValueOnce({
      success: true,
      data: makeProofRow() as any,
    });
    mockTaskService.submitProof.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ state: 'PROOF_SUBMITTED' }) as any,
    });

    await makeCaller().submitProof({
      taskId: TASK_ID,
      description: 'Done',
      photoUrls: ['https://pub-abc123def456abcd.r2.dev/proof/photo.jpg'],
      notes: 'Extra notes',
      gpsLatitude: 37.7749,
      gpsLongitude: -122.4194,
      biometricHash: 'abc123',
    });

    expect(mockProofService.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        submitterId: USER_ID,
        description: 'Done',
        photoUrls: ['https://pub-abc123def456abcd.r2.dev/proof/photo.jpg'],
        gpsLatitude: 37.7749,
        gpsLongitude: -122.4194,
        biometricHash: 'abc123',
      })
    );
  });

  it('falls back to notes when description is not provided', async () => {
    // KK4: ownership check
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any);
    mockProofService.submit.mockResolvedValueOnce({
      success: true,
      data: makeProofRow() as any,
    });
    mockTaskService.submitProof.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ state: 'PROOF_SUBMITTED' }) as any,
    });

    await makeCaller().submitProof({
      taskId: TASK_ID,
      notes: 'Used as description',
    });

    expect(mockProofService.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Used as description',
      })
    );
  });

  it('throws BAD_REQUEST when ProofService.submit fails', async () => {
    // KK4: ownership check passes
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any);
    mockProofService.submit.mockResolvedValueOnce({
      success: false,
      error: { code: 'PROOF_ERROR', message: 'Proof failed' },
    });

    await expect(
      makeCaller().submitProof({ taskId: TASK_ID, description: 'x' })
    ).rejects.toThrow('Proof failed');
  });

  it('throws BAD_REQUEST when TaskService.submitProof fails', async () => {
    // KK4: ownership check passes
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any);
    mockProofService.submit.mockResolvedValueOnce({
      success: true,
      data: makeProofRow() as any,
    });
    mockTaskService.submitProof.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_STATE', message: 'Not ACCEPTED' },
    });

    await expect(
      makeCaller().submitProof({ taskId: TASK_ID, description: 'x' })
    ).rejects.toThrow('Not ACCEPTED');
  });

  it('rejects invalid photoUrls', async () => {
    await expect(
      makeCaller().submitProof({
        taskId: TASK_ID,
        photoUrls: ['not-a-url'],
      })
    ).rejects.toThrow();
  });

  it('rejects gpsLatitude out of range', async () => {
    await expect(
      makeCaller().submitProof({
        taskId: TASK_ID,
        gpsLatitude: 100,
      })
    ).rejects.toThrow();
  });
});

// ===========================================================================
// task.reviewProof
// ===========================================================================

describe('task.reviewProof', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('reviews proof by proofId + decision (original schema)', async () => {
    const proof = makeProofRow({ task_id: TASK_ID });
    const task = makeTaskRow({ poster_id: USER_ID, state: 'PROOF_SUBMITTED' });
    const reviewedProof = makeProofRow({ state: 'ACCEPTED', reviewed_by: USER_ID });

    // New order: ProofService.getById → TaskService.getById (ownership + state, one call)
    mockProofService.getById.mockResolvedValueOnce({ success: true, data: proof as any });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockProofService.review.mockResolvedValueOnce({ success: true, data: reviewedProof as any });

    const result = await makeCallerAsPoster().reviewProof({
      proofId: PROOF_ID,
      decision: 'ACCEPTED',
      reason: 'Looks good',
    });

    expect(result).toEqual(reviewedProof);
    expect(mockProofService.review).toHaveBeenCalledWith({
      proofId: PROOF_ID,
      reviewerId: USER_ID,
      decision: 'ACCEPTED',
      reason: 'Looks good',
    });
  });

  it('reviews proof by taskId + approved (iOS schema)', async () => {
    // New order: TaskService.getById (ownership+state) → db.query (proof lookup) → ProofService.getById
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ poster_id: USER_ID, state: 'PROOF_SUBMITTED' }) as any,
    });
    // proofLookup via db.query
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: PROOF_ID }],
      rowCount: 1,
    } as any);
    mockProofService.getById.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ task_id: TASK_ID }) as any,
    });
    mockProofService.review.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ state: 'ACCEPTED' }) as any,
    });

    const result = await makeCallerAsPoster().reviewProof({
      taskId: TASK_ID,
      approved: true,
      feedback: 'Nice work',
    });

    expect(result).toBeDefined();
    expect(mockProofService.review).toHaveBeenCalledWith(
      expect.objectContaining({
        proofId: PROOF_ID,
        decision: 'ACCEPTED',
        reason: 'Nice work',
      })
    );
  });

  it('maps approved=false to REJECTED decision', async () => {
    // New order: TaskService.getById (ownership+state) → db.query (proof lookup) → ProofService.getById
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ poster_id: USER_ID, state: 'PROOF_SUBMITTED' }) as any,
    });
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: PROOF_ID }],
      rowCount: 1,
    } as any);
    mockProofService.getById.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ task_id: TASK_ID }) as any,
    });
    mockProofService.review.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ state: 'REJECTED' }) as any,
    });
    // CCC-01: REJECTED decision triggers TaskService.rejectProof to revert task to ACCEPTED
    mockTaskService.rejectProof.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ state: 'ACCEPTED' }) as any,
    });

    await makeCallerAsPoster().reviewProof({ taskId: TASK_ID, approved: false });

    expect(mockProofService.review).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'REJECTED' })
    );
    expect(mockTaskService.rejectProof).toHaveBeenCalledWith(TASK_ID, expect.any(String));
  });

  it('throws BAD_REQUEST when neither decision nor approved is given (no taskId)', async () => {
    // decision/approved is checked first (before proofId/taskId validation)
    await expect(makeCallerAsPoster().reviewProof({})).rejects.toThrow('decision or approved is required');
  });

  it('throws BAD_REQUEST when neither proofId nor taskId is given (decision provided)', async () => {
    // Once decision is valid, the code checks for proofId/taskId
    await expect(
      makeCallerAsPoster().reviewProof({ decision: 'ACCEPTED' })
    ).rejects.toThrow('proofId or taskId is required');
  });

  it('throws BAD_REQUEST when neither decision nor approved is given (proofId provided)', async () => {
    // decision/approved is checked first — no service mocks needed
    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID })
    ).rejects.toThrow('decision or approved is required');
  });

  it('throws NOT_FOUND when no proof found for taskId', async () => {
    // Ownership + state check happens before the proof lookup
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ poster_id: USER_ID, state: 'PROOF_SUBMITTED' }) as any,
    });
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().reviewProof({ taskId: TASK_ID, approved: true })
    ).rejects.toThrow('No proof found for this task');
  });

  it('throws FORBIDDEN when user is not the poster', async () => {
    const proof = makeProofRow({ task_id: TASK_ID });
    const task = makeTaskRow({ poster_id: OTHER_USER_ID });

    mockProofService.getById.mockResolvedValueOnce({ success: true, data: proof as any });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });

    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'ACCEPTED' })
    ).rejects.toThrow('Only the task poster can review proof');
  });

  it('throws NOT_FOUND when proof does not exist', async () => {
    mockProofService.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Proof not found' },
    });

    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'ACCEPTED' })
    ).rejects.toThrow('Proof not found');
  });

  it('throws BAD_REQUEST when ProofService.review fails', async () => {
    // proofId path: ProofService.getById first, then one TaskService.getById (ownership+state)
    mockProofService.getById.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ task_id: TASK_ID }) as any,
    });
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ poster_id: USER_ID, state: 'PROOF_SUBMITTED' }) as any,
    });
    mockProofService.review.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_TRANSITION', message: 'Cannot transition' },
    });

    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'ACCEPTED' })
    ).rejects.toThrow('Cannot transition');
  });

  // CCC-01: REJECTED decision must call TaskService.rejectProof() to revert task to ACCEPTED
  it('CCC-01: calls TaskService.rejectProof when decision is REJECTED', async () => {
    const proof = makeProofRow({ task_id: TASK_ID });
    const task = makeTaskRow({ poster_id: USER_ID, state: 'PROOF_SUBMITTED' });
    const rejectedProof = makeProofRow({ state: 'REJECTED', reviewed_by: USER_ID });
    const revertedTask = makeTaskRow({ state: 'ACCEPTED' });

    // proofId path: ProofService.getById first, then one TaskService.getById (ownership+state)
    mockProofService.getById.mockResolvedValueOnce({ success: true, data: proof as any });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockProofService.review.mockResolvedValueOnce({ success: true, data: rejectedProof as any });
    mockTaskService.rejectProof.mockResolvedValueOnce({ success: true, data: revertedTask as any });

    const result = await makeCallerAsPoster().reviewProof({
      proofId: PROOF_ID,
      decision: 'REJECTED',
      reason: 'Work is incomplete',
    });

    expect(result).toEqual(rejectedProof);
    expect(mockTaskService.rejectProof).toHaveBeenCalledWith(
      TASK_ID,
      'Work is incomplete'
    );
  });

  it('CCC-01: does NOT call TaskService.rejectProof when decision is ACCEPTED', async () => {
    const proof = makeProofRow({ task_id: TASK_ID });
    const task = makeTaskRow({ poster_id: USER_ID, state: 'PROOF_SUBMITTED' });
    const acceptedProof = makeProofRow({ state: 'ACCEPTED', reviewed_by: USER_ID });

    // proofId path: ProofService.getById first, then one TaskService.getById (ownership+state)
    mockProofService.getById.mockResolvedValueOnce({ success: true, data: proof as any });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockProofService.review.mockResolvedValueOnce({ success: true, data: acceptedProof as any });

    await makeCallerAsPoster().reviewProof({
      proofId: PROOF_ID,
      decision: 'ACCEPTED',
    });

    expect(mockTaskService.rejectProof).not.toHaveBeenCalled();
  });

  it('CCC-01: throws INTERNAL_SERVER_ERROR when TaskService.rejectProof fails after proof REJECTED', async () => {
    const proof = makeProofRow({ task_id: TASK_ID });
    const task = makeTaskRow({ poster_id: USER_ID, state: 'PROOF_SUBMITTED' });
    const rejectedProof = makeProofRow({ state: 'REJECTED', reviewed_by: USER_ID });

    // proofId path: ProofService.getById first, then one TaskService.getById (ownership+state)
    mockProofService.getById.mockResolvedValueOnce({ success: true, data: proof as any });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockProofService.review.mockResolvedValueOnce({ success: true, data: rejectedProof as any });
    mockTaskService.rejectProof.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_STATE', message: 'Task already in terminal state' },
    });

    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'REJECTED' })
    ).rejects.toThrow('Proof marked rejected but task state could not be reverted');
  });
});

// ===========================================================================
// task.complete
// ===========================================================================

// UU-02 FIX: poster ownership check moved inside TaskService.complete() under
// the FOR UPDATE lock.  The router no longer calls getById for auth — it passes
// ctx.user.id directly to complete() and the service returns NOT_FOUND /
// FORBIDDEN as ServiceResult error codes when appropriate.
describe('task.complete', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns completed task when poster calls', async () => {
    const completed = makeTaskRow({ state: 'COMPLETED' });

    // No getById call — complete() handles auth + state check atomically.
    mockTaskService.complete.mockResolvedValueOnce({ success: true, data: completed as any });

    const result = await makeCallerAsPoster().complete({ taskId: TASK_ID });

    expect(result).toEqual(completed);
    // Verify posterId was forwarded into the service call.
    expect(mockTaskService.complete).toHaveBeenCalledWith(TASK_ID, USER_ID);
  });

  it('throws NOT_FOUND when service returns NOT_FOUND', async () => {
    mockTaskService.complete.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when service returns FORBIDDEN (user is not poster)', async () => {
    mockTaskService.complete.mockResolvedValueOnce({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only the task poster can mark it complete' },
    });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow(
      'Only the task poster can mark it complete'
    );
  });

  it('throws PRECONDITION_FAILED for HX301 errors (INV-3)', async () => {
    mockTaskService.complete.mockResolvedValueOnce({
      success: false,
      error: { code: 'HX301', message: 'Proof must be accepted' },
    });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow(
      'Proof must be accepted'
    );
  });

  it('throws BAD_REQUEST for other errors', async () => {
    mockTaskService.complete.mockResolvedValueOnce({
      success: false,
      error: { code: 'OTHER', message: 'Something else' },
    });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow('Something else');
  });
});

// ===========================================================================
// task.cancel
// ===========================================================================

describe('task.cancel', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  // YY-01: ownership check moved inside TaskService.cancel(). Router passes
  // ctx.user.id as posterId and maps FORBIDDEN / NOT_FOUND error codes.

  it('returns cancelled task when poster calls', async () => {
    const cancelled = makeTaskRow({ state: 'CANCELLED' });

    mockTaskService.cancel.mockResolvedValueOnce({ success: true, data: cancelled as any });

    const result = await makeCallerAsPoster().cancel({ taskId: TASK_ID });

    expect(result).toEqual(cancelled);
    // Ownership check is now inside TaskService.cancel — getById must not be called.
    expect(mockTaskService.getById).not.toHaveBeenCalled();
    // Poster id is forwarded to the service
    expect(mockTaskService.cancel).toHaveBeenCalledWith(TASK_ID, USER_ID);
  });

  it('throws NOT_FOUND when TaskService.cancel returns NOT_FOUND', async () => {
    mockTaskService.cancel.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });

    await expect(makeCallerAsPoster().cancel({ taskId: TASK_ID })).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when TaskService.cancel returns FORBIDDEN (not task owner)', async () => {
    mockTaskService.cancel.mockResolvedValueOnce({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Not task owner' },
    });

    await expect(makeCallerAsPoster().cancel({ taskId: TASK_ID })).rejects.toThrow('Not task owner');
  });

  it('throws BAD_REQUEST when TaskService.cancel fails with a non-auth error', async () => {
    mockTaskService.cancel.mockResolvedValueOnce({
      success: false,
      error: { code: 'TERMINAL', message: 'Already completed' },
    });

    await expect(makeCallerAsPoster().cancel({ taskId: TASK_ID })).rejects.toThrow('Already completed');
  });

  it('accepts optional reason and still passes posterId to service', async () => {
    const cancelled = makeTaskRow({ state: 'CANCELLED' });

    mockTaskService.cancel.mockResolvedValueOnce({ success: true, data: cancelled as any });

    const result = await makeCallerAsPoster().cancel({ taskId: TASK_ID, reason: 'Changed my mind' });

    expect(result).toEqual(cancelled);
    expect(mockTaskService.cancel).toHaveBeenCalledWith(TASK_ID, USER_ID);
  });
});

// ===========================================================================
// task.applyForTask
// ===========================================================================

describe('task.applyForTask', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns application data on success', async () => {
    // Task exists and is POSTED
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: OTHER_USER_ID, trust_tier_required: null }],
      rowCount: 1,
    } as any);
    // Insert returns new application (ON CONFLICT DO NOTHING path — rowCount > 0)
    const now = new Date();
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: APP_ID,
        task_id: TASK_ID,
        hustler_id: USER_ID,
        status: 'pending',
        message: 'I can do this',
        created_at: now,
      }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().applyForTask({
      taskId: TASK_ID,
      message: 'I can do this',
    });

    expect(result).toEqual({
      id: APP_ID,
      taskId: TASK_ID,
      status: 'pending',
      message: 'I can do this',
      appliedAt: now,
    });
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('Task not found');
  });

  it('throws PRECONDITION_FAILED when task is not in POSTED state', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'ACCEPTED', poster_id: OTHER_USER_ID, trust_tier_required: null }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('Task must be in POSTED state to apply');
  });

  it('throws BAD_REQUEST when applying for own task', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID, trust_tier_required: null }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('Cannot apply for your own task');
  });

  it('throws CONFLICT when already applied', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: OTHER_USER_ID, trust_tier_required: null }],
      rowCount: 1,
    } as any);
    // ON CONFLICT DO NOTHING — rowCount 0 means a conflicting row already exists
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('You already have an active application');
  });

  it('accepts optional message', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: OTHER_USER_ID, trust_tier_required: null }],
      rowCount: 1,
    } as any);
    // INSERT with ON CONFLICT DO NOTHING — message is null when not provided
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: APP_ID,
        task_id: TASK_ID,
        hustler_id: USER_ID,
        status: 'pending',
        message: null,
        created_at: new Date(),
      }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().applyForTask({ taskId: TASK_ID });

    expect(result.message).toBeNull();
  });
});

// ===========================================================================
// task.listApplicants
// ===========================================================================

describe('task.listApplicants', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns array of applicant objects', async () => {
    // Task ownership check
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID }],
      rowCount: 1,
    } as any);
    // Applicants
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: APP_ID,
          user_id: OTHER_USER_ID,
          name: 'Hustler Jane',
          rating: 4.8,
          completed_tasks: 15,
          tier: 'veteran',
          applied_at: new Date('2025-06-01T00:00:00Z'),
          message: 'Pick me!',
        },
      ],
      rowCount: 1,
    } as any);

    const result = await makeCallerAsPoster().listApplicants({ taskId: TASK_ID });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].user_id).toBe(OTHER_USER_ID);
    expect(result[0].name).toBe('Hustler Jane');
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().listApplicants({ taskId: TASK_ID })
    ).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when user is not the poster', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: OTHER_USER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().listApplicants({ taskId: TASK_ID })
    ).rejects.toThrow('Only the task poster can view applicants');
  });

  it('returns empty array when no applicants', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeCallerAsPoster().listApplicants({ taskId: TASK_ID });

    expect(result).toHaveLength(0);
  });

  it('makes 2 db.query calls (ownership check + applicants)', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeCallerAsPoster().listApplicants({ taskId: TASK_ID });

    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// task.assignWorker
// ===========================================================================

describe('task.assignWorker', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  // NOTE: The new assignWorker implementation wraps all 5 DB ops in db.transaction()
  // with a SELECT FOR UPDATE as the first statement inside the transaction.
  // Mock sequence (all via db.query since transaction delegates to the same fn):
  //   [1] Pre-tx: SELECT template_slug FROM tasks WHERE id = $1
  //   [2] In-tx:  SELECT id, state, poster_id, trust_tier_required FROM tasks WHERE id = $1 FOR UPDATE
  //   [2b] In-tx: SELECT trust_tier FROM users WHERE id = $1  (ONLY when trust_tier_required is set)
  //   [3] In-tx:  SELECT id FROM task_applications WHERE task_id = $1 AND hustler_id = $2 AND status = 'pending'
  //   [4] In-tx:  UPDATE task_applications SET status = 'accepted'
  //   [5] In-tx:  UPDATE task_applications SET status = 'rejected'
  //   [6] In-tx:  UPDATE tasks SET state = 'ACCEPTED' ... RETURNING id, state, worker_id

  it('assigns worker and returns the accepted task row', async () => {
    const acceptedTask = { id: TASK_ID, state: 'ACCEPTED', worker_id: OTHER_USER_ID };
    // [1] Pre-tx template_slug lookup
    mockDb.query.mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] In-tx FOR UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID }], rowCount: 1 } as any);
    // [3] Application check
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any);
    // [4] Accept application update
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // [5] Reject other applications
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // [6] UPDATE tasks RETURNING
    mockDb.query.mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as any);

    const result = await makeCallerAsPoster().assignWorker({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });

    expect(result).toEqual(acceptedTask);
    // TaskService.accept is no longer called — the state change happens directly inside the tx
    expect(mockTaskService.accept).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when task does not exist (pre-tx template slug lookup)', async () => {
    // Pre-tx SELECT returns no rows
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when user is not the poster (checked inside transaction)', async () => {
    // [1] Pre-tx template_slug lookup — returns task owned by a DIFFERENT poster
    mockDb.query.mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] In-tx FOR UPDATE — poster_id is OTHER_USER_ID, not the caller
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: OTHER_USER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Only the task poster can assign workers');
  });

  it('throws PRECONDITION_FAILED when task is not POSTED (checked inside transaction)', async () => {
    // [1] Pre-tx template_slug lookup
    mockDb.query.mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] In-tx FOR UPDATE — task state already ACCEPTED (e.g. concurrent caller won)
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'ACCEPTED', poster_id: USER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Task must be POSTED to assign a worker');
  });

  it('throws NOT_FOUND when no pending application for worker', async () => {
    // [1] Pre-tx template_slug lookup
    mockDb.query.mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] In-tx FOR UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID }], rowCount: 1 } as any);
    // [3] Application check — no pending application found
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('No pending application found for this worker');
  });

  it('throws PRECONDITION_FAILED when UPDATE tasks affects 0 rows (concurrent assignment detected)', async () => {
    // [1] Pre-tx template_slug lookup
    mockDb.query.mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] In-tx FOR UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID }], rowCount: 1 } as any);
    // [3] Application check
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any);
    // [4] Accept application update
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // [5] Reject other applications
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // [6] UPDATE tasks → 0 rows (state changed between FOR UPDATE check and UPDATE)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('concurrent assignment detected');
  });

  it('throws FORBIDDEN when worker trust tier is below task trust_tier_required (H5 bug fix)', async () => {
    // [1] Pre-tx template_slug lookup
    mockDb.query.mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] In-tx FOR UPDATE — task requires trust tier 3
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID, trust_tier_required: 3 }],
      rowCount: 1,
    } as any);
    // [2b] Worker trust tier lookup — worker is tier 2 (below requirement)
    mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Task requires trust tier 3');
  });

  it('throws NOT_FOUND when worker does not exist during trust_tier_required check', async () => {
    // [1] Pre-tx template_slug lookup
    mockDb.query.mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] In-tx FOR UPDATE — task requires trust tier 2
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID, trust_tier_required: 2 }],
      rowCount: 1,
    } as any);
    // [2b] Worker trust tier lookup — no worker found
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Worker not found');
  });

  it('assigns worker when trust tier meets requirement (H5 bug fix — allow path)', async () => {
    const acceptedTask = { id: TASK_ID, state: 'ACCEPTED', worker_id: OTHER_USER_ID };
    // [1] Pre-tx template_slug lookup
    mockDb.query.mockResolvedValueOnce({ rows: [{ template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] In-tx FOR UPDATE — task requires trust tier 2
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID, trust_tier_required: 2 }],
      rowCount: 1,
    } as any);
    // [2b] Worker trust tier lookup — worker is tier 2 (meets requirement)
    mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 } as any);
    // [3] Application check
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any);
    // [4] Accept application update
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // [5] Reject other applications
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // [6] UPDATE tasks RETURNING
    mockDb.query.mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as any);

    const result = await makeCallerAsPoster().assignWorker({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });

    expect(result).toEqual(acceptedTask);
  });
});

// ===========================================================================
// task.rejectApplicant
// ===========================================================================

describe('task.rejectApplicant', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns { success: true } on successful rejection', async () => {
    // Task ownership check
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID }],
      rowCount: 1,
    } as any);
    // Update application
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: APP_ID }],
      rowCount: 1,
    } as any);

    const result = await makeCallerAsPoster().rejectApplicant({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
      reason: 'Not a good fit',
    });

    expect(result).toEqual({ success: true });
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when user is not the poster', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: OTHER_USER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Only the task poster can reject applicants');
  });

  it('throws NOT_FOUND when no pending application for worker', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('No pending application found for this worker');
  });

  it('accepts optional reason', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: APP_ID }],
      rowCount: 1,
    } as any);

    const result = await makeCallerAsPoster().rejectApplicant({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });

    expect(result).toEqual({ success: true });
  });
});

// ===========================================================================
// task.withdrawApplication
// ===========================================================================

describe('task.withdrawApplication', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns { success: true } on successful withdrawal', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: APP_ID }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().withdrawApplication({ taskId: TASK_ID });

    expect(result).toEqual({ success: true });
  });

  it('throws NOT_FOUND when no active application exists', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().withdrawApplication({ taskId: TASK_ID })
    ).rejects.toThrow('No active application found to withdraw');
  });

  it('passes taskId and userId to the query', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: APP_ID }],
      rowCount: 1,
    } as any);

    await makeCaller().withdrawApplication({ taskId: TASK_ID });

    const [sql, params] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain('task_applications');
    expect(params).toContain(TASK_ID);
    expect(params).toContain(USER_ID);
  });

  it('only withdraws pending or countered applications', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: APP_ID }],
      rowCount: 1,
    } as any);

    await makeCaller().withdrawApplication({ taskId: TASK_ID });

    const [sql] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'countered'");
  });
});

// ===========================================================================
// task.evaluateDraft
// ===========================================================================

describe('task.evaluateDraft', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns compliance result for a clean description', async () => {
    mockCompliance.evaluate.mockResolvedValueOnce({
      score: 5,
      tier: 'clean',
      triggeredRules: [],
      notes: {
        score: 5,
        tier: 'clean',
        triggered_rules: [],
        suggested_alternative: null,
        admin_review_id: null,
        appeal_status: 'none',
      },
    });

    const result = await makeCallerAsPoster().evaluateDraft({
      description: 'Help me move furniture to the second floor',
    });

    expect(result.score).toBe(5);
    expect(result.tier).toBe('clean');
    expect(result.triggeredRules).toEqual([]);
    expect(mockCompliance.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Help me move furniture to the second floor',
      })
    );
  });

  it('returns soft_flag result without throwing', async () => {
    mockCompliance.evaluate.mockResolvedValueOnce({
      score: 35,
      tier: 'soft_flag',
      triggeredRules: ['physical_contact_ambiguous'],
      suggestedAlternative: 'specialized_licensed',
      notes: {
        score: 35,
        tier: 'soft_flag',
        triggered_rules: ['physical_contact_ambiguous'],
        suggested_alternative: 'specialized_licensed',
        admin_review_id: null,
        appeal_status: 'none',
      },
    });

    const result = await makeCallerAsPoster().evaluateDraft({
      description: 'I need a massage at home tonight',
    });

    expect(result.score).toBe(35);
    expect(result.tier).toBe('soft_flag');
    expect(result.triggeredRules).toContain('physical_contact_ambiguous');
    expect(result.suggestedAlternative).toBe('specialized_licensed');
  });

  it('throws BAD_REQUEST for hard_block result', async () => {
    mockCompliance.evaluate.mockResolvedValueOnce({
      score: 85,
      tier: 'hard_block',
      triggeredRules: ['hard_block_pattern'],
      notes: {
        score: 85,
        tier: 'hard_block',
        triggered_rules: ['hard_block_pattern'],
        suggested_alternative: null,
        admin_review_id: null,
        appeal_status: 'none',
      },
    });

    await expect(
      makeCallerAsPoster().evaluateDraft({
        description: 'deliver package no questions asked downtown',
      })
    ).rejects.toThrow('blocked');
  });

  it('passes templateSlug to compliance service', async () => {
    mockCompliance.evaluate.mockResolvedValueOnce({
      score: 0,
      tier: 'clean',
      triggeredRules: [],
      notes: {
        score: 0,
        tier: 'clean',
        triggered_rules: [],
        suggested_alternative: null,
        admin_review_id: null,
        appeal_status: 'none',
      },
    });

    await makeCallerAsPoster().evaluateDraft({
      description: 'Be a brand ambassador at a local event for 4 hours',
      templateSlug: 'event_appearance',
    });

    expect(mockCompliance.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ templateSlug: 'event_appearance' })
    );
  });
});

// ===========================================================================
// task.evaluateDraft — per-user rate limit (5/min)
// ===========================================================================
// The rate limit is now Redis-backed (checkRateLimit from cache/redis.ts).
// Tests control the limit by mocking checkRateLimit's return value.
// ===========================================================================

describe('task.evaluateDraft rate limit', () => {
  const RATE_LIMIT_USER = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  const cleanResult = {
    score: 0,
    tier: 'clean' as const,
    triggeredRules: [],
    notes: {
      score: 0,
      tier: 'clean',
      triggered_rules: [],
      suggested_alternative: null,
      admin_review_id: null,
      appeal_status: 'none',
    },
  };

  beforeEach(() => {
    // reset handled by global beforeEach
    // Default: allow all rate-limit checks
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 10 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows calls when checkRateLimit returns allowed=true', async () => {
    const caller = makeCallerAsPoster(RATE_LIMIT_USER);
    mockCompliance.evaluate.mockResolvedValue(cleanResult);
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });

    for (let i = 0; i < 5; i++) {
      await expect(
        caller.evaluateDraft({ description: 'Help move boxes' })
      ).resolves.toBeDefined();
    }

    expect(mockCompliance.evaluate).toHaveBeenCalledTimes(5);
  });

  it('throws TOO_MANY_REQUESTS when checkRateLimit returns allowed=false', async () => {
    const caller = makeCallerAsPoster(RATE_LIMIT_USER);
    mockCompliance.evaluate.mockResolvedValue(cleanResult);
    // Simulate Redis returning rate-limited on first call
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    await expect(
      caller.evaluateDraft({ description: 'Help move boxes' })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    // Compliance was never called — rate limit fired first
    expect(mockCompliance.evaluate).not.toHaveBeenCalled();
  });

  it('allows calls after rate limit window resets (allowed=true again)', async () => {
    const caller = makeCallerAsPoster(RATE_LIMIT_USER);
    mockCompliance.evaluate.mockResolvedValue(cleanResult);

    // Simulate exhausted limit
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    await expect(
      caller.evaluateDraft({ description: 'Help move boxes' })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    // Window resets — Redis now allows again
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 5 });
    await expect(
      caller.evaluateDraft({ description: 'Help move boxes after reset' })
    ).resolves.toBeDefined();
  });

  it('tracks limits independently per user (Redis uses per-user keys)', async () => {
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001';
    const userB = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002';
    mockCompliance.evaluate.mockResolvedValue(cleanResult);

    // checkRateLimit is called with (userId, action, limit, window).
    // Simulate user A exhausted, user B not.
    mockCheckRateLimit.mockImplementation(async (userId: string) => {
      if (userId === userA) return { allowed: false, remaining: 0 };
      return { allowed: true, remaining: 5 };
    });

    // User A is rate-limited
    const callerA = makeCallerAsPoster(userA);
    await expect(
      callerA.evaluateDraft({ description: 'Help move boxes' })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    // User B is unaffected
    const callerB = makeCallerAsPoster(userB);
    await expect(
      callerB.evaluateDraft({ description: 'Help move boxes' })
    ).resolves.toBeDefined();
  });

  it('fails open when Redis throws (allows the request with a warning log)', async () => {
    const caller = makeCallerAsPoster(RATE_LIMIT_USER);
    mockCompliance.evaluate.mockResolvedValue(cleanResult);
    // Simulate Redis connection error
    mockCheckRateLimit.mockRejectedValue(new Error('Redis ECONNREFUSED'));

    // Should NOT throw — rate limiting fails open
    await expect(
      caller.evaluateDraft({ description: 'Help move boxes' })
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// task.acceptWithConsent
// ===========================================================================

describe('task.acceptWithConsent', () => {
  const CONSENT_TEMPLATE = {
    slug: 'wildcard_bizarre',
    displayName: 'Wildcard / Custom',
    defaultRiskTier: 1,
    requiredTrustTier: 'verified',
    completionCriteriaType: 'hybrid',
    autoReleaseHours: 48,
    lateCancelPct: 75,
    requiresMutualConsent: true,
    requiresContentRelease: false,
    scoperContext: '',
  };

  const NO_CONSENT_TEMPLATE = {
    slug: 'standard_physical',
    displayName: 'Standard Physical',
    defaultRiskTier: 0,
    requiredTrustTier: 'rookie',
    completionCriteriaType: 'photo_proof',
    autoReleaseHours: 24,
    lateCancelPct: 0,
    requiresMutualConsent: false,
    requiresContentRelease: false,
    scoperContext: '',
  };

  beforeEach(() => {
    // reset handled by global beforeEach
    // Make db.transaction call through so queries inside use the mockDb.query queue
    vi.mocked((mockDb as any).transaction).mockImplementation((fn: (q: typeof mockDb.query) => Promise<unknown>) => fn(mockDb.query));
  });

  it('successfully accepts a wildcard task with mutual consent', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        // Pre-transaction: get template_slug + state
        rows: [{ template_slug: 'wildcard_bizarre', state: 'OPEN' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({
        // Inside transaction: SELECT state FOR UPDATE
        rows: [{ state: 'OPEN' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({
        // Inside transaction: UPDATE tasks SET ... WHERE state = 'OPEN'
        rows: [], rowCount: 1,
      } as any);

    mockGetTemplate.mockReturnValueOnce(CONSENT_TEMPLATE as any);

    const result = await makeCallerAsHustler().acceptWithConsent({
      taskId: TASK_ID,
      consentItems: ['I understand the task is custom', 'I agree to the terms'],
    });

    expect(result).toEqual({ accepted: true });
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsHustler().acceptWithConsent({
        taskId: TASK_ID,
        consentItems: ['I agree'],
      })
    ).rejects.toThrow('Task not found');
  });

  it('throws BAD_REQUEST when template does not require consent', async () => {
    // Router: db.query first (returns task row), then getTemplate is called
    mockDb.query.mockResolvedValueOnce({
      rows: [{ template_slug: 'standard_physical', state: 'posted' }],
      rowCount: 1,
    } as any);
    mockGetTemplate.mockReturnValueOnce(NO_CONSENT_TEMPLATE as any);

    await expect(
      makeCallerAsHustler().acceptWithConsent({
        taskId: TASK_ID,
        consentItems: ['I agree'],
      })
    ).rejects.toThrow('does not require consent checklist');
  });

  it('throws PRECONDITION_FAILED when task is no longer available', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        // Pre-transaction: get template_slug + state
        rows: [{ template_slug: 'wildcard_bizarre', state: 'claimed' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({
        // Inside transaction: SELECT state FOR UPDATE → returns claimed (not 'posted')
        rows: [{ state: 'claimed' }],
        rowCount: 1,
      } as any);

    mockGetTemplate.mockReturnValueOnce(CONSENT_TEMPLATE as any);

    await expect(
      makeCallerAsHustler().acceptWithConsent({
        taskId: TASK_ID,
        consentItems: ['I agree'],
      })
    ).rejects.toThrow('no longer available');
  });
});

// ===========================================================================
// task.getComplianceStatus
// ===========================================================================

describe('task.getComplianceStatus', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns score and notes for an existing task', async () => {
    const notes = {
      score: 45,
      tier: 'soft_flag',
      triggered_rules: ['overnight_ambiguous'],
      suggested_alternative: null,
      admin_review_id: null,
      appeal_status: 'none',
    };

    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, worker_id: null, illegal_risk_score: 45, compliance_guardian_notes: notes }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getComplianceStatus({ taskId: TASK_ID });

    expect(result.score).toBe(45);
    expect(result.notes).toEqual(notes);
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().getComplianceStatus({ taskId: TASK_ID })
    ).rejects.toThrow('Task not found');
  });

  it('returns clean score for a newly created task', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, worker_id: null, illegal_risk_score: 0, compliance_guardian_notes: { tier: 'clean' } }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getComplianceStatus({ taskId: TASK_ID });

    expect(result.score).toBe(0);
  });
});

// ===========================================================================
// task.submitProof — video attachment branch
// ===========================================================================

describe('task.submitProof — video URLs branch', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('attaches video URLs to proof when videoUrls provided', async () => {
    const proofRow = makeProofRow();
    // KK4: ownership check
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any);
    // YY-02: no BEGIN/COMMIT — each service owns its own internal transaction
    mockProofService.submit.mockResolvedValueOnce({
      success: true,
      data: proofRow as any,
    });
    mockProofService.addVideo = vi.fn().mockResolvedValue({
      success: true,
      data: { id: 'vid-1' },
    });
    mockTaskService.submitProof.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow() as any,
    });

    const result = await makeCallerAsHustler().submitProof({
      taskId: TASK_ID,
      description: 'Done',
      videoUrls: ['https://pub-abc123def456abcd.r2.dev/proof/video1.mp4'],
    });

    expect(mockProofService.addVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        proofId: proofRow.id,
        storageKey: 'https://pub-abc123def456abcd.r2.dev/proof/video1.mp4',
        contentType: 'video/mp4',
      })
    );
    expect(result).toBeDefined();
  });

  it('does not call addVideo when no videoUrls provided', async () => {
    const proofRow = makeProofRow();
    // KK4: ownership check
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any);
    // YY-02: no BEGIN/COMMIT — each service owns its own internal transaction
    mockProofService.submit.mockResolvedValueOnce({
      success: true,
      data: proofRow as any,
    });
    mockProofService.addVideo = vi.fn().mockResolvedValue({ success: true, data: {} });
    mockTaskService.submitProof.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow() as any,
    });

    await makeCallerAsHustler().submitProof({
      taskId: TASK_ID,
      description: 'Done',
    });

    expect(mockProofService.addVideo).not.toHaveBeenCalled();
  });

  it('continues submission when addVideo fails (non-blocking)', async () => {
    const proofRow = makeProofRow();
    // KK4: ownership check
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any);
    // YY-02: no BEGIN/COMMIT — each service owns its own internal transaction
    mockProofService.submit.mockResolvedValueOnce({
      success: true,
      data: proofRow as any,
    });
    mockProofService.addVideo = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'DB_ERROR', message: 'Storage error' },
    });
    mockTaskService.submitProof.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow() as any,
    });

    // Should not throw even though addVideo failed
    const result = await makeCallerAsHustler().submitProof({
      taskId: TASK_ID,
      description: 'Done',
      videoUrls: ['https://pub-abc123def456abcd.r2.dev/proof/video1.mp4'],
    });

    expect(result).toBeDefined();
    expect(mockTaskService.submitProof).toHaveBeenCalled();
  });
});
