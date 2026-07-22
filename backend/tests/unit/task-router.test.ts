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
    lookupCreateRequest: vi.fn(),
    create: vi.fn(),
    accept: vi.fn(),
    advanceProgress: vi.fn(),
    startWork: vi.fn(),
    submitProof: vi.fn(),
    rejectProof: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
    workerAbandon: vi.fn(),
  },
}));

vi.mock('../../src/services/TaskScopeService', () => ({
  TaskScopeService: {
    getForParticipant: vi.fn(),
    proposeChange: vi.fn(),
    reviewChange: vi.fn(),
    setChecklistItem: vi.fn(),
  },
}));

vi.mock('../../src/services/VerifiedPosterCompletionService', () => ({
  VerifiedPosterCompletionService: { confirm: vi.fn() },
}));

vi.mock('../../src/lib/task-lifecycle-notifications', () => ({
  notifyApplicationReceived: vi.fn(),
  notifyWorkerAssigned: vi.fn(),
  notifyTaskAccepted: vi.fn(),
  notifyProofSubmitted: vi.fn(),
  notifyProofRejected: vi.fn(),
  notifyTaskCompleted: vi.fn(),
}));

vi.mock('../../src/services/TaskLocationService', () => ({
  TaskLocationService: {
    setByPoster: vi.fn(),
    releaseToReservedWorker: vi.fn(),
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
  TaskRisk: { TIER_0: 0, TIER_1: 1, TIER_2: 2, TIER_3: 3 },
  TaskRiskClassifier: {
    classifyWithTemplate: vi.fn().mockReturnValue(0),
    toLegacyRiskLevel: vi.fn((risk: number) => (
      risk >= 3 ? 'IN_HOME' : risk >= 2 ? 'HIGH' : 'LOW'
    )),
  },
}));

vi.mock('../../src/services/TaskEligibilityPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/TaskEligibilityPolicy')>();
  return { ...actual, assertTaskMutationEligibility: vi.fn() };
});

// Mock Redis so rate-limit checks are controlled in tests.
// Default: allowed=true (no rate limiting). Individual tests can override.
vi.mock('../../src/cache/redis', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { TRPCError } from '@trpc/server';
import { TaskService } from '../../src/services/TaskService';
import { TaskScopeService } from '../../src/services/TaskScopeService';
import { VerifiedPosterCompletionService } from '../../src/services/VerifiedPosterCompletionService';
import { TaskLocationService } from '../../src/services/TaskLocationService';
import { ProofService } from '../../src/services/ProofService';
import { ComplianceGuardianService } from '../../src/services/ComplianceGuardianService';
import { getTemplate, isCareContent, isContentReleaseRequired, getManifest } from '../../src/services/TaskTemplateRegistry';
import { TaskRiskClassifier } from '../../src/services/TaskRiskClassifier';
import { assertTaskMutationEligibility } from '../../src/services/TaskEligibilityPolicy';
import { cachedDbQuery, invalidateTask } from '../../src/cache/db-cache';
import { taskRouter } from '../../src/routers/task';
import { checkRateLimit } from '../../src/cache/redis';
import { notifyProofSubmitted, notifyTaskCompleted } from '../../src/lib/task-lifecycle-notifications';

const mockCheckRateLimit = vi.mocked(checkRateLimit);

const mockDb = vi.mocked(db);
const mockTaskService = vi.mocked(TaskService);
const mockTaskScopeService = vi.mocked(TaskScopeService);
const mockVerifiedPosterCompletion = vi.mocked(VerifiedPosterCompletionService);
const mockTaskLocationService = vi.mocked(TaskLocationService);
const mockProofService = vi.mocked(ProofService);
const mockCompliance = vi.mocked(ComplianceGuardianService);
const mockGetTemplate = vi.mocked(getTemplate);
const mockIsCareContent = vi.mocked(isCareContent);
const mockIsContentReleaseRequired = vi.mocked(isContentReleaseRequired);
const mockGetManifest = vi.mocked(getManifest);
const mockTaskRiskClassifier = vi.mocked(TaskRiskClassifier);
const mockMutationEligibility = vi.mocked(assertTaskMutationEligibility);
const mockCachedDbQuery = vi.mocked(cachedDbQuery);
const mockInvalidateTask = vi.mocked(invalidateTask);
const mockNotifyProofSubmitted = vi.mocked(notifyProofSubmitted);
const mockNotifyTaskCompleted = vi.mocked(notifyTaskCompleted);

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

function makeBridgeCallerAsPoster() {
  return taskRouter.createCaller({
    user: {
      id: USER_ID, email: 'probe@hustlexp.app', full_name: 'Probe',
      role: 'poster', default_mode: 'poster', firebase_uid: 'fb-probe',
    } as any,
    firebaseUid: 'fb-probe',
    engineBridgeAuthorized: true,
    engineBridgeActorId: OTHER_USER_ID,
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
  mockTaskService.lookupCreateRequest.mockResolvedValue({
    success: true,
    data: { status: 'missing' },
  } as any);
  mockMutationEligibility.mockResolvedValue(undefined);
  // Read procedures may perform an additional authorization lookup (for
  // example the active quote shortlist). Tests that need rows override this.
  mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);

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

    expect(result).toEqual({
      ...task,
      viewer_role: 'poster',
      quote_chat_role: null,
      quote_shortlisted_worker_id: null,
    });
    expect(mockTaskService.getById).toHaveBeenCalledWith(TASK_ID);
  });

  it('returns the authenticated engine viewer role instead of requiring Firebase UID comparison', async () => {
    const task = makeTaskRow({ poster_id: OTHER_USER_ID, worker_id: USER_ID });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });

    const result = await makeCaller().getById({ taskId: TASK_ID });

    expect(result).toMatchObject({ id: TASK_ID, viewer_role: 'hustler' });
  });

  it('returns only an observer projection for a discoverable task viewed by a non-participant', async () => {
    const task = makeTaskRow({ state: 'OPEN', poster_id: OTHER_USER_ID, worker_id: null });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });

    const result = await makeCaller().getById({ taskId: TASK_ID });

    expect(result.viewer_role).toBe('observer');
    expect(result.poster_id).toBeUndefined();
    expect(result.worker_id).toBeUndefined();
  });

  it('denies a non-participant access to a non-discoverable task', async () => {
    const task = makeTaskRow({ state: 'IN_PROGRESS', poster_id: OTHER_USER_ID, worker_id: 'worker-other' });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(makeCaller().getById({ taskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
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

  it('denies a non-participant from polling task state', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ state: 'IN_PROGRESS', poster_id: OTHER_USER_ID, worker_id: 'worker-other' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(makeCaller().getState({ taskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    regionCode: 'US-WA',
    category: 'yard',
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

  it('rejects controlled-test provenance without engine bridge authority', async () => {
    await expect(makeCallerAsPoster().create({ ...validInput, isTest: true }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockTaskService.create).not.toHaveBeenCalled();
  });

  it('persists controlled-test provenance only for an authenticated bridge caller', async () => {
    mockTaskService.create.mockResolvedValueOnce({ success: true, data: makeTaskRow() as any });
    await makeBridgeCallerAsPoster().create({ ...validInput, isTest: true });
    expect(mockTaskService.create).toHaveBeenCalledWith(expect.objectContaining({
      automationClassification: 'CONTROLLED_TEST',
    }));
  });

  it('rejects poster-controlled payout economics', async () => {
    await expect(makeCallerAsPoster().create({
      ...validInput,
      hustlerPayoutCents: 3750,
      platformMarginCents: 1250,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockTaskService.create).not.toHaveBeenCalled();
  });

  it('accepts reconciled quote economics only from the engine bridge', async () => {
    mockTaskService.create.mockResolvedValueOnce({ success: true, data: makeTaskRow() as any });
    await makeBridgeCallerAsPoster().create({
      ...validInput,
      hustlerPayoutCents: 3750,
      platformMarginCents: 1250,
    });
    expect(mockTaskService.create).toHaveBeenCalledWith(expect.objectContaining({
      hustlerPayoutCents: 3750,
      platformMarginCents: 1250,
    }));
  });

  it('rejects incomplete or non-reconciling bridge economics', async () => {
    await expect(makeBridgeCallerAsPoster().create({
      ...validInput,
      hustlerPayoutCents: 3750,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(makeBridgeCallerAsPoster().create({
      ...validInput,
      hustlerPayoutCents: 3700,
      platformMarginCents: 1250,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockTaskService.create).not.toHaveBeenCalled();
  });

  it('rejects margin-only bridge economics', async () => {
    await expect(makeBridgeCallerAsPoster().create({
      ...validInput,
      platformMarginCents: 1250,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockTaskService.create).not.toHaveBeenCalled();
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
      clientIdempotencyKey: 'quote-accept-0001',
      roughArea: 'Bellevue, WA',
      regionCode: 'US-WA',
      proof_steps: [{ step: 'Mow the front lawn' }, { step: 'Mow the back lawn' }],
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
        clientIdempotencyKey: 'quote-accept-0001',
        roughArea: 'Bellevue, WA',
        regionCode: 'US-WA',
        proofSteps: ['Mow the front lawn', 'Mow the back lawn'],
      })
    );
  });

  it('maps idempotency-key reuse with changed input to CONFLICT', async () => {
    mockTaskService.lookupCreateRequest.mockResolvedValueOnce({
      success: true,
      data: { status: 'conflict', existingTaskId: TASK_ID },
    } as any);

    await expect(makeCallerAsPoster().create({
      ...validInput,
      clientIdempotencyKey: 'quote-accept-0001',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockTaskService.create).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('replays a completed idempotent request before consuming create rate limit', async () => {
    const task = makeTaskRow();
    mockTaskService.lookupCreateRequest.mockResolvedValueOnce({
      success: true,
      data: { status: 'replay', task },
    } as any);

    const result = await makeCallerAsPoster().create({
      ...validInput,
      clientIdempotencyKey: 'quote-accept-0001',
    });

    expect(result).toMatchObject({ id: TASK_ID, idempotency_replayed: true });
    expect(mockTaskService.create).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCompliance.evaluate).not.toHaveBeenCalled();
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

describe('task.releaseExactLocation', () => {
  it('delegates to the audited location vault policy for the authenticated hustler', async () => {
    mockTaskLocationService.releaseToReservedWorker.mockResolvedValueOnce({
      success: true,
      data: { exactLocation: '123 Main St, Bellevue, WA 98004' },
    });

    const result = await makeCallerAsHustler(OTHER_USER_ID).releaseExactLocation({ taskId: TASK_ID });

    expect(result).toEqual({ exactLocation: '123 Main St, Bellevue, WA 98004' });
    expect(mockTaskLocationService.releaseToReservedWorker).toHaveBeenCalledWith({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });
  });

  it('fails closed before an engine reservation exists', async () => {
    mockTaskLocationService.releaseToReservedWorker.mockResolvedValueOnce({
      success: false,
      error: { code: 'LOCATION_NOT_RELEASED', message: 'not reserved' },
    });

    await expect(
      makeCallerAsHustler(OTHER_USER_ID).releaseExactLocation({ taskId: TASK_ID })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('task.setExactLocation', () => {
  it('stores the poster-provided service location in the private vault', async () => {
    mockTaskLocationService.setByPoster.mockResolvedValueOnce({
      success: true,
      data: { stored: true, idempotencyReplayed: false },
    });

    const result = await makeCallerAsPoster().setExactLocation({
      taskId: TASK_ID,
      exactLocation: '123 Main St, Bellevue, WA 98004',
    });

    expect(result).toEqual({ stored: true, idempotencyReplayed: false });
    expect(mockTaskLocationService.setByPoster).toHaveBeenCalledWith({
      taskId: TASK_ID,
      posterId: USER_ID,
      exactLocation: '123 Main St, Bellevue, WA 98004',
    });
  });

  it('rejects control characters before the location service is called', async () => {
    await expect(makeCallerAsPoster().setExactLocation({
      taskId: TASK_ID,
      exactLocation: '123 Main St\nInjected',
    })).rejects.toThrow();
    expect(mockTaskLocationService.setByPoster).not.toHaveBeenCalled();
  });

  it('fails closed when reservation already locked the location', async () => {
    mockTaskLocationService.setByPoster.mockResolvedValueOnce({
      success: false,
      error: { code: 'LOCATION_LOCKED', message: 'already reserved' },
    });

    await expect(makeCallerAsPoster().setExactLocation({
      taskId: TASK_ID,
      exactLocation: '123 Main St, Bellevue, WA 98004',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
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

  it('returns IN_PROGRESS task from the canonical service', async () => {
    const task = makeTaskRow({ state: 'ACCEPTED', worker_id: USER_ID, progress_state: 'WORKING' });
    mockTaskService.startWork.mockResolvedValueOnce({ success: true, data: task as any });

    const result = await makeCaller().start({ taskId: TASK_ID });

    expect(result).toEqual(task);
    expect(mockTaskService.startWork).toHaveBeenCalledWith(TASK_ID, USER_ID);
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockTaskService.startWork.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });

    await expect(makeCaller().start({ taskId: TASK_ID })).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when user is not the assigned worker', async () => {
    mockTaskService.startWork.mockResolvedValueOnce({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only the engine-reserved hustler can start this task' },
    });

    await expect(makeCaller().start({ taskId: TASK_ID })).rejects.toThrow(
      'Only the engine-reserved hustler can start this task'
    );
  });

  it('throws PRECONDITION_FAILED when task is not in ACCEPTED state', async () => {
    mockTaskService.startWork.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_STATE', message: 'Task must have an active engine reservation before work starts' },
    });

    await expect(makeCaller().start({ taskId: TASK_ID })).rejects.toThrow(
      'active engine reservation'
    );
  });
});

describe('task.markTraveling', () => {
  it('records an assigned Hustler as traveling through the canonical progress service', async () => {
    const traveling = makeTaskRow({ progress_state: 'TRAVELING' });
    mockTaskService.advanceProgress.mockResolvedValueOnce({ success: true, data: traveling as any });

    await expect(makeCaller().markTraveling({ taskId: TASK_ID })).resolves.toEqual(traveling);
    expect(mockTaskService.advanceProgress).toHaveBeenCalledWith({
      taskId: TASK_ID,
      to: 'TRAVELING',
      actor: { type: 'worker', userId: USER_ID },
    });
  });

  it('fails closed when the Hustler does not own the reservation', async () => {
    mockTaskService.advanceProgress.mockResolvedValueOnce({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Worker does not own task' },
    });

    await expect(makeCaller().markTraveling({ taskId: TASK_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    expect(mockDb.transaction).toHaveBeenCalledOnce();
    expect(mockTaskService.submitProof).toHaveBeenCalledWith(TASK_ID, expect.any(Function));
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

    const photoEvidence = {
      uploadReceiptId: 'a0000000-0000-4000-8000-000000000001',
      contentType: 'image/jpeg' as const,
      fileSizeBytes: 12_345,
      checksumSha256: 'a'.repeat(64),
      capturedAt: '2026-07-18T19:00:00.000Z',
    };
    await makeCaller().submitProof({
      taskId: TASK_ID,
      description: 'Done',
      photoEvidence: [photoEvidence],
      notes: 'Extra notes',
      gpsLatitude: 37.7749,
      gpsLongitude: -122.4194,
      gpsAccuracyMeters: 12,
      biometricHash: 'abc123',
    });

    expect(mockProofService.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        submitterId: USER_ID,
        description: 'Done',
        photoEvidence: [photoEvidence],
        gpsLatitude: 37.7749,
        gpsLongitude: -122.4194,
        gpsAccuracyMeters: 12,
        biometricHash: 'abc123',
      }),
      expect.any(Function),
    );
  });

  it('returns an exact synchronized replay without duplicating task, media, or notification effects', async () => {
    const proof = makeProofRow({ idempotency_replayed: true });
    const task = makeTaskRow({
      state: 'PROOF_SUBMITTED',
      worker_id: USER_ID,
      poster_id: OTHER_USER_ID,
      version: 8,
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [task], rowCount: 1 } as any);
    mockProofService.submit.mockResolvedValueOnce({ success: true, data: proof as any });
    mockProofService.addVideo = vi.fn().mockResolvedValue({ success: true, data: { id: 'video-id' } });

    const result = await makeCallerAsHustler().submitProof({
      taskId: TASK_ID,
      description: 'Completed once',
      clientSubmissionId: 'proof:offline:device:41',
      clientSequence: 41,
      priorTaskVersion: 7,
      localOccurredAt: '2026-07-20T10:00:00.000Z',
      deviceVersion: 'web.desktop',
      appVersion: '1.0.0',
    });

    expect(result).toEqual({ task, proof });
    expect(mockTaskService.submitProof).not.toHaveBeenCalled();
    expect(mockProofService.addVideo).not.toHaveBeenCalled();
    expect(mockNotifyProofSubmitted).not.toHaveBeenCalled();
    expect(mockInvalidateTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('rejects a partial offline sync tuple before any database or service work', async () => {
    await expect(makeCallerAsHustler().submitProof({
      taskId: TASK_ID,
      description: 'Completed once',
      clientSubmissionId: 'proof:offline:device:42',
      clientSequence: 42,
    })).rejects.toThrow('Offline sync evidence must be supplied as one complete tuple.');

    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockProofService.submit).not.toHaveBeenCalled();
  });

  it('rejects a payload witness unless the legacy-compatible sync tuple is complete', async () => {
    await expect(makeCallerAsHustler().submitProof({
      taskId: TASK_ID,
      description: 'Completed once',
      clientSubmissionId: 'proof:offline:device:43',
      offlinePayloadHash: 'a'.repeat(64),
    })).rejects.toThrow('Offline payload evidence requires the complete sync tuple.');
    expect(mockDb.query).not.toHaveBeenCalled();
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
      }),
      expect.any(Function),
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

    // New order: db.query (IDOR ownership pre-check) → db.query (proof state check) → ProofService.getById → TaskService.getById (state)
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: USER_ID }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as any);
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
    // New order: TaskService.getById (ownership+state) → db.query (proof lookup) → ProofService.getById → db.query (proof state check)
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
    // R-05: proof state check now runs unconditionally (even in taskId path)
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as any);
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
    // New order: TaskService.getById (ownership+state) → db.query (proof lookup) → ProofService.getById → db.query (proof state check)
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
    // R-05: proof state check now runs unconditionally (even in taskId path)
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as any);
    mockProofService.review.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ state: 'REJECTED' }) as any,
    });
    // CCC-01: REJECTED decision triggers TaskService.rejectProof to revert task to ACCEPTED
    mockTaskService.rejectProof.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ state: 'ACCEPTED' }) as any,
    });

    await makeCallerAsPoster().reviewProof({ taskId: TASK_ID, approved: false, feedback: 'Work is incomplete' });

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
    // IDOR pre-check fires first: db.query returns OTHER_USER_ID as poster → FORBIDDEN
    // immediately, before ProofService.getById is ever called.
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: OTHER_USER_ID }], rowCount: 1 } as any);

    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'ACCEPTED' })
    ).rejects.toThrow('Only the task poster can review proof');
  });

  it('throws NOT_FOUND when proof does not exist', async () => {
    // IDOR pre-check fires first: db.query returns no rows → NOT_FOUND immediately.
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'ACCEPTED' })
    ).rejects.toThrow('Proof not found');
  });

  it('throws BAD_REQUEST when ProofService.review fails', async () => {
    // proofId path: db.query (IDOR pre-check) → db.query (proof state check) → ProofService.getById → TaskService.getById (state)
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: USER_ID }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as any);
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

    // proofId path: db.query (IDOR pre-check) → db.query (proof state check) → ProofService.getById → TaskService.getById (state)
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: USER_ID }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as any);
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

    // proofId path: db.query (IDOR pre-check) → db.query (proof state check) → ProofService.getById → TaskService.getById (state)
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: USER_ID }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as any);
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

    // proofId path: db.query (IDOR pre-check) → db.query (proof state check) → ProofService.getById → TaskService.getById (state)
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: USER_ID }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as any);
    mockProofService.getById.mockResolvedValueOnce({ success: true, data: proof as any });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockProofService.review.mockResolvedValueOnce({ success: true, data: rejectedProof as any });
    mockTaskService.rejectProof.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_STATE', message: 'Task already in terminal state' },
    });

    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'REJECTED', reason: 'Work is incomplete' })
    ).rejects.toThrow('Proof marked rejected but task state could not be reverted');
  });
});

// ===========================================================================
// task.complete
// ===========================================================================

// Authenticated web confirmation uses the same canonical proof-acceptance and
// payout-ready service as verified messaging. The service performs the poster
// ownership check against its locked task context.
describe('task.complete', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  it('returns completed task when poster calls', async () => {
    const completed = makeTaskRow({
      state: 'COMPLETED',
      worker_id: OTHER_USER_ID,
      completion_idempotency_replayed: false,
    });

    mockVerifiedPosterCompletion.confirm.mockResolvedValueOnce({ success: true, data: completed as any });

    const result = await makeCallerAsPoster().complete({ taskId: TASK_ID });

    expect(result).toEqual(completed);
    expect(mockVerifiedPosterCompletion.confirm).toHaveBeenCalledWith({
      taskId: TASK_ID,
      providerConfirmationId: `web:${TASK_ID}`,
      actorId: USER_ID,
      channel: 'WEB',
      expectedPosterId: USER_ID,
    });
    expect(mockNotifyTaskCompleted).toHaveBeenCalledOnce();
    expect(mockNotifyTaskCompleted).toHaveBeenCalledWith(
      OTHER_USER_ID,
      TASK_ID,
      'Test Task',
    );
  });

  it('does not duplicate the completion notification on an idempotent replay', async () => {
    const replayed = makeTaskRow({
      state: 'COMPLETED',
      worker_id: OTHER_USER_ID,
      completion_idempotency_replayed: true,
    });
    mockVerifiedPosterCompletion.confirm.mockResolvedValueOnce({ success: true, data: replayed as any });

    const result = await makeCallerAsPoster().complete({ taskId: TASK_ID });

    expect(result).toEqual(replayed);
    expect(mockNotifyTaskCompleted).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when service returns NOT_FOUND', async () => {
    mockVerifiedPosterCompletion.confirm.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when service returns FORBIDDEN (user is not poster)', async () => {
    mockVerifiedPosterCompletion.confirm.mockResolvedValueOnce({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only the task poster can mark it complete' },
    });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow(
      'Only the task poster can mark it complete'
    );
  });

  it('throws PRECONDITION_FAILED for HX301 errors (INV-3)', async () => {
    mockVerifiedPosterCompletion.confirm.mockResolvedValueOnce({
      success: false,
      error: { code: 'HX301', message: 'Proof must be accepted' },
    });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow(
      'Proof must be accepted'
    );
  });

  it('throws BAD_REQUEST for other errors', async () => {
    mockVerifiedPosterCompletion.confirm.mockResolvedValueOnce({
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
    // Task exists and is OPEN (the valid state for applications)
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: OTHER_USER_ID, trust_tier_required: null }],
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

  it('rejects unsafe contact or off-platform content before writing an application', async () => {
    await expect(makeCaller().applyForTask({
      taskId: TASK_ID,
      message: 'Text me at 555-867-5309 and pay me directly',
    })).rejects.toThrow(/cannot include contact details/i);

    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('Task not found');
  });

  it('throws PRECONDITION_FAILED when task is not in OPEN state', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'ACCEPTED', poster_id: OTHER_USER_ID, trust_tier_required: null }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('Task must be in OPEN state to apply');
  });

  it('throws BAD_REQUEST when applying for own task', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, trust_tier_required: null }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('Cannot apply for your own task');
  });

  it('throws CONFLICT when already applied', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: OTHER_USER_ID, trust_tier_required: null }],
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
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: OTHER_USER_ID, trust_tier_required: null }],
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

  // T59-1: applyForTask gated on 'OPEN' (not the non-existent 'POSTED' state)
  it('T59-1: applyForTask on state=OPEN does NOT throw PRECONDITION_FAILED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: OTHER_USER_ID, trust_tier_required: null }],
      rowCount: 1,
    } as any);
    const now = new Date();
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: APP_ID,
        task_id: TASK_ID,
        hustler_id: USER_ID,
        status: 'pending',
        message: null,
        created_at: now,
      }],
      rowCount: 1,
    } as any);

    // Should NOT throw — OPEN is the valid state
    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).resolves.toBeDefined();
  });

  it('T59-1: applyForTask on state=ACCEPTED still throws PRECONDITION_FAILED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'ACCEPTED', poster_id: OTHER_USER_ID, trust_tier_required: null }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow(/PRECONDITION_FAILED|must be in OPEN state/i);
  });

  // T60-2: applyForTask state check must be inside a transaction with FOR UPDATE
  // so concurrent assignWorker cannot transition the task between the state read and INSERT.
  it('T60-2: INSERT happens via the transactional query function, not db.query directly', async () => {
    // Track which calls go through the transaction callback vs module-level db.query.
    const txQueryCalls: string[] = [];

    // Override the transaction mock to capture in-tx calls
    (mockDb.transaction as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (fn: (q: typeof mockDb.query) => Promise<unknown>) => {
        const txQuery = vi.fn((...args: unknown[]) => {
          if (typeof args[0] === 'string') txQueryCalls.push(args[0]);
          return (mockDb.query as ReturnType<typeof vi.fn>)(...args);
        });
        return fn(txQuery as typeof mockDb.query);
      }
    );

    const now = new Date();
    // Inside transaction: SELECT FOR UPDATE → OPEN task, then INSERT
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: TASK_ID, state: 'OPEN', poster_id: OTHER_USER_ID, trust_tier_required: null }],
        rowCount: 1,
      } as any) // SELECT FOR UPDATE
      .mockResolvedValueOnce({
        rows: [{
          id: 'app-new',
          task_id: TASK_ID,
          hustler_id: USER_ID,
          message: null,
          status: 'pending',
          created_at: now,
        }],
        rowCount: 1,
      } as any); // INSERT

    await makeCaller().applyForTask({ taskId: TASK_ID });

    // Both the SELECT and the INSERT should be inside the transaction query function
    expect(txQueryCalls.length).toBeGreaterThanOrEqual(2);
    const hasSelectForUpdate = txQueryCalls.some(
      sql => sql.toLowerCase().includes('for update') && sql.toLowerCase().includes('select')
    );
    const hasInsert = txQueryCalls.some(
      sql => sql.toLowerCase().includes('insert into task_applications')
    );
    expect(hasSelectForUpdate).toBe(true);
    expect(hasInsert).toBe(true);
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

  it('tier fallback uses INTEGER 1, not a string (live schema: users.trust_tier is INTEGER)', async () => {
    // REGRESSION GUARD: COALESCE(u.trust_tier, 'rookie') threw
    // `invalid input syntax for type integer: "rookie"` in production —
    // posters could never see applicants. The fallback must be the integer 1.
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: USER_ID }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeCallerAsPoster().listApplicants({ taskId: TASK_ID });

    const applicantsSql = String(mockDb.query.mock.calls[1][0]);
    expect(applicantsSql).not.toContain("'rookie'");
    expect(applicantsSql).toMatch(/COALESCE\(u\.trust_tier,\s*1\)/);
    expect(applicantsSql).toContain("ta.status IN ('pending','countered')");
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
// task quote shortlist — the sole pre-assignment private-chat grant
// ===========================================================================

describe('task quote shortlist', () => {
  it('creates one explicit grant without assigning work or touching escrow', async () => {
    const createdAt = new Date('2026-07-21T08:00:00.000Z');
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: TASK_ID, poster_id: USER_ID, worker_id: null, state: 'OPEN' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({
        rows: [{
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          task_id: TASK_ID,
          worker_id: OTHER_USER_ID,
          status: 'ACTIVE',
          created_at: createdAt,
        }],
        rowCount: 1,
      } as any);

    const result = await makeCallerAsPoster().shortlistApplicant({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });

    expect(result).toMatchObject({
      task_id: TASK_ID,
      worker_id: OTHER_USER_ID,
      status: 'ACTIVE',
      replayed: false,
    });
    expect(mockMutationEligibility).toHaveBeenCalledWith(
      expect.any(Function), TASK_ID, OTHER_USER_ID, { requireCurrentOffer: true },
    );
    const sql = mockDb.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('INSERT INTO task_quote_shortlists');
    expect(sql).not.toContain('UPDATE tasks SET state');
    expect(sql).not.toContain('UPDATE escrows');
  });

  it('is replay-safe for the same active provider and does not insert a second grant', async () => {
    const shortlistId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: TASK_ID, poster_id: USER_ID, worker_id: null, state: 'OPEN' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any)
      .mockResolvedValueOnce({
        rows: [{ id: shortlistId, worker_id: OTHER_USER_ID, created_at: new Date() }],
        rowCount: 1,
      } as any);

    const result = await makeCallerAsPoster().shortlistApplicant({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });

    expect(result).toMatchObject({ id: shortlistId, status: 'ACTIVE', replayed: true });
    expect(mockDb.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO task_quote_shortlists'))).toBe(false);
  });

  it('rejects a provider without an active application', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: TASK_ID, poster_id: USER_ID, worker_id: null, state: 'OPEN' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(makeCallerAsPoster().shortlistApplicant({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    })).rejects.toThrow(/no active provider application/i);
  });

  it('revokes only the named active grant', async () => {
    const shortlistId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ poster_id: USER_ID, state: 'OPEN' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: shortlistId }], rowCount: 1 } as any);

    await expect(makeCallerAsPoster().revokeShortlist({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    })).resolves.toEqual({ success: true, shortlistId });
    expect(String(mockDb.query.mock.calls[1][0])).toContain("status='ACTIVE'");
  });
});

// ===========================================================================
// task.assignWorker
// ===========================================================================

describe('task.assignWorker', () => {
  beforeEach(() => {
    // reset handled by global beforeEach
  });

  // NOTE: SECURITY FIX applied — the pre-transaction template_slug SELECT was moved
  // INSIDE the transaction, AFTER the FOR UPDATE lock and ownership check, to prevent
  // task UUID enumeration via NOT_FOUND/FORBIDDEN error discrimination.
  //
  // Updated mock sequence (all via db.query since transaction delegates to the same fn):
  //   [1] In-tx:  SELECT id, state, poster_id, trust_tier_required, template_slug FROM tasks WHERE id = $1 FOR UPDATE
  //   [1b] In-tx: SELECT trust_tier FROM users WHERE id = $1  (ONLY when trust_tier_required is set)
  //   [2] In-tx:  SELECT id FROM task_applications WHERE task_id = $1 AND hustler_id = $2 AND status = 'pending'
  //   [3] In-tx:  UPDATE task_applications SET status = 'accepted'
  //   [4] In-tx:  UPDATE task_applications SET status = 'rejected'
  //   [5] In-tx:  UPDATE tasks SET state = 'ACCEPTED' ... RETURNING id, state, worker_id

  it('assigns worker and returns the accepted task row', async () => {
    const acceptedTask = { id: TASK_ID, state: 'ACCEPTED', worker_id: OTHER_USER_ID };
    // [1] In-tx FOR UPDATE — includes template_slug now
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] Application check
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any);
    // [2b] Escrow funding gate — escrow is FUNDED (beta dispatch rule)
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'FUNDED' }], rowCount: 1 } as any);
    // [3] Accept application update
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // [4] Reject other applications
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // [5] UPDATE tasks RETURNING
    mockDb.query.mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as any);

    const result = await makeCallerAsPoster().assignWorker({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });

    expect(result).toEqual(acceptedTask);
    // TaskService.accept is no longer called — the state change happens directly inside the tx
    expect(mockTaskService.accept).not.toHaveBeenCalled();
  });

  // BETA DISPATCH RULE: a worker may only be committed to a FUNDED task.
  it('throws PRECONDITION_FAILED when the task escrow is not FUNDED (unpaid task)', async () => {
    // [1] In-tx FOR UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] Application check
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any);
    // [2b] Escrow funding gate — escrow exists but is still PENDING (poster never paid)
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'PENDING' }], rowCount: 1 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow(/not funded/i);
  });

  it('throws PRECONDITION_FAILED when the task has no escrow row at all', async () => {
    // [1] In-tx FOR UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] Application check
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any);
    // [2b] Escrow funding gate — no escrow row
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow(/not funded/i);
  });

  it('throws FORBIDDEN when task does not exist (UUID enumeration prevention)', async () => {
    // SECURITY FIX: non-existent task now returns FORBIDDEN (not NOT_FOUND) so that
    // authenticated posters cannot probe arbitrary task UUIDs for existence.
    // In-tx FOR UPDATE returns no rows — but we surface FORBIDDEN, not NOT_FOUND.
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Only the task poster can assign workers');
  });

  it('throws FORBIDDEN when user is not the poster (checked inside transaction)', async () => {
    // [1] In-tx FOR UPDATE — poster_id is OTHER_USER_ID, not the caller
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: OTHER_USER_ID, template_slug: 'standard_physical' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Only the task poster can assign workers');
  });

  it('throws PRECONDITION_FAILED when task is not OPEN (checked inside transaction)', async () => {
    // [1] In-tx FOR UPDATE — task state already ACCEPTED (e.g. concurrent caller won)
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'ACCEPTED', poster_id: USER_ID, template_slug: 'standard_physical' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Task must be OPEN to assign a worker');
  });

  it('throws NOT_FOUND when no pending application for worker', async () => {
    // [1] In-tx FOR UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] Application check — no pending application found
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('No pending application found for this worker');
  });

  it('throws FORBIDDEN when a legacy pending applicant is marked as a minor', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, template_slug: 'standard_physical' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: APP_ID, is_minor: true }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Hustlers must be at least 18 years old');
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('throws PRECONDITION_FAILED when UPDATE tasks affects 0 rows (concurrent assignment detected)', async () => {
    // [1] In-tx FOR UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, template_slug: 'standard_physical' }], rowCount: 1 } as any);
    // [2] Application check
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any);
    // [2b] Escrow funding gate — FUNDED
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'FUNDED' }], rowCount: 1 } as any);
    // [3] Accept application update
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // [4] Reject other applications
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // [5] UPDATE tasks → 0 rows (state changed between FOR UPDATE check and UPDATE)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('concurrent assignment detected');
  });

  it('throws FORBIDDEN when worker trust tier is below task trust_tier_required (H5 bug fix)', async () => {
    // [1] In-tx FOR UPDATE — task requires trust tier 3, template_slug included
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, trust_tier_required: 3, template_slug: 'standard_physical' }],
      rowCount: 1,
    } as any);
    // [1b] Worker trust tier lookup — worker is tier 2 (below requirement)
    mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Task requires trust tier 3');
  });

  it('throws NOT_FOUND when worker does not exist during trust_tier_required check', async () => {
    // [1] In-tx FOR UPDATE — task requires trust tier 2, template_slug included
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, trust_tier_required: 2, template_slug: 'standard_physical' }],
      rowCount: 1,
    } as any);
    // [1b] Worker trust tier lookup — no worker found
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Worker not found');
  });

  it('assigns worker when trust tier meets requirement (H5 bug fix — allow path)', async () => {
    const acceptedTask = { id: TASK_ID, state: 'ACCEPTED', worker_id: OTHER_USER_ID };
    // [1] In-tx FOR UPDATE — task requires trust tier 2, template_slug included
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, trust_tier_required: 2, template_slug: 'standard_physical' }],
      rowCount: 1,
    } as any);
    // [1b] Worker trust tier lookup — worker is tier 2 (meets requirement)
    mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 } as any);
    // [2] Application check
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any);
    // [2b] Escrow funding gate — FUNDED
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'FUNDED' }], rowCount: 1 } as any);
    // [3] Accept application update
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // [4] Reject other applications
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // [5] UPDATE tasks RETURNING
    mockDb.query.mockResolvedValueOnce({ rows: [acceptedTask], rowCount: 1 } as any);

    const result = await makeCallerAsPoster().assignWorker({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });

    expect(result).toEqual(acceptedTask);
  });

  // T58-3: poster must not be able to assign themselves as worker
  it('T58-3: throws BAD_REQUEST when workerId === caller (poster self-assigning)', async () => {
    // The guard must fire before any DB query when workerId === ctx.user.id
    await expect(
      makeCallerAsPoster(USER_ID).assignWorker({ taskId: TASK_ID, workerId: USER_ID })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
    // Task ownership + state check
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'OPEN' }],
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
      rows: [{ poster_id: OTHER_USER_ID, state: 'OPEN' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Only the task poster can reject applicants');
  });

  it('throws NOT_FOUND when no pending application for worker', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'OPEN' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('No pending application found for this worker');
  });

  it('accepts optional reason', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'OPEN' }],
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

  // T63-2: task-state guard — cannot reject applicants once work has started
  it('throws INVALID_STATE when task is IN_PROGRESS', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'IN_PROGRESS' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('throws INVALID_STATE when task is COMPLETED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'COMPLETED' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('throws INVALID_STATE when task is CANCELLED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'CANCELLED' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('throws INVALID_STATE when task is DISPUTED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'DISPUTED' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('throws INVALID_STATE when task is PROOF_SUBMITTED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'PROOF_SUBMITTED' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().rejectApplicant({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('allows rejection when task is OPEN', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'OPEN' }],
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

  it('allows rejection when task is ASSIGNED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: USER_ID, state: 'ASSIGNED' }],
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
        // SELECT state, template_slug, poster_id FOR UPDATE
        rows: [{ state: 'OPEN', template_slug: 'wildcard_bizarre', poster_id: OTHER_USER_ID, mutual_consent_required: true }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({
        // SELECT id FROM task_applications — pending application exists
        rows: [{ id: APP_ID }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({
        // UPDATE tasks SET mutual_consent_accepted ...
        rows: [], rowCount: 1,
      } as any);

    mockGetTemplate.mockReturnValueOnce(CONSENT_TEMPLATE as any);

    const result = await makeCallerAsHustler().acceptWithConsent({
      taskId: TASK_ID,
      consentItems: ['I understand the task is custom', 'I agree to the terms'],
    });

    expect(result).toEqual({ accepted: true });
  });

  // T63-4: application workflow guard
  it('throws FORBIDDEN when hustler has no pending application', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        // SELECT state, template_slug, poster_id FOR UPDATE
        rows: [{ state: 'OPEN', template_slug: 'wildcard_bizarre', poster_id: OTHER_USER_ID, mutual_consent_required: true }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({
        // SELECT id FROM task_applications — no pending application
        rows: [],
        rowCount: 0,
      } as any);

    mockGetTemplate.mockReturnValueOnce(CONSENT_TEMPLATE as any);

    await expect(
      makeCallerAsHustler().acceptWithConsent({
        taskId: TASK_ID,
        consentItems: ['I agree'],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    // FOR UPDATE lock — returns task with non-consent template
    mockDb.query.mockResolvedValueOnce({
      rows: [{ state: 'OPEN', template_slug: 'standard_physical', poster_id: OTHER_USER_ID, mutual_consent_required: false }],
      rowCount: 1,
    } as any);
    mockGetTemplate.mockReturnValueOnce(NO_CONSENT_TEMPLATE as any);

    await expect(
      makeCallerAsHustler().acceptWithConsent({
        taskId: TASK_ID,
        consentItems: ['I agree'],
      })
    ).rejects.toThrow('does not require a consent checklist');
  });

  it('throws PRECONDITION_FAILED when task is no longer available', async () => {
    mockDb.query.mockResolvedValueOnce({
      // FOR UPDATE — task is already claimed/non-OPEN
      rows: [{ state: 'ACCEPTED', template_slug: 'wildcard_bizarre', poster_id: OTHER_USER_ID, mutual_consent_required: true }],
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
// task.submitProof — video receipt boundary
// ===========================================================================

describe('task.submitProof — video URL rejection', () => {
  it('rejects a valid-looking hosted video before database or service work', async () => {
    await expect(makeCallerAsHustler().submitProof({
      taskId: TASK_ID,
      description: 'Done',
      videoUrls: ['https://pub-abc123def456abcd.r2.dev/proof/video1.mp4'],
    })).rejects.toThrow('Video proof requires receipt-backed upload finalization.');

    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockProofService.submit).not.toHaveBeenCalled();
    expect(mockProofService.addVideo).not.toHaveBeenCalled();
    expect(mockTaskService.submitProof).not.toHaveBeenCalled();
  });

  it('continues to accept proof submissions without video URLs', async () => {
    const proofRow = makeProofRow();
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any);
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
    expect(mockTaskService.submitProof).toHaveBeenCalled();
  });
});

// ===========================================================================
// Max-tier changed-line adversarial edges
// ===========================================================================

describe('task router changed-line adversarial edges', () => {
  const validCreateInput = {
    title: 'Mow the lawn',
    description: 'Front and back yard',
    price: 5000,
    regionCode: 'US-WA',
    category: 'yard',
  };

  function callerWithTrust(mode: 'worker' | 'poster', trustTier: number) {
    return taskRouter.createCaller({
      user: {
        id: USER_ID,
        email: 'user@hustlexp.com',
        full_name: 'Test User',
        default_mode: mode,
        trust_tier: trustTier,
      } as any,
      firebaseUid: 'fb-user',
    });
  }

  it('uses the persisted consent requirement instead of trusting a mutable registry lookup', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ state: 'OPEN', template_slug: 'deleted-template', poster_id: OTHER_USER_ID, mutual_consent_required: false }], rowCount: 1,
    } as any);
    mockGetTemplate.mockReturnValueOnce(undefined as any);
    await expect(makeCallerAsHustler().acceptWithConsent({
      taskId: TASK_ID, consentItems: ['I agree'],
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('fails closed when mutual-consent acceptance loses its update race', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ state: 'OPEN', template_slug: 'wildcard_bizarre', poster_id: OTHER_USER_ID, mutual_consent_required: true }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    mockGetTemplate.mockReturnValueOnce({ requiresMutualConsent: true } as any);
    await expect(makeCallerAsHustler().acceptWithConsent({
      taskId: TASK_ID, consentItems: ['I agree'],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('returns the public template manifest', async () => {
    mockGetManifest.mockReturnValueOnce([{ slug: 'standard_physical' }] as any);
    await expect(makeCaller().getTemplateManifest()).resolves.toEqual([{ slug: 'standard_physical' }]);
  });

  it('protects compliance state from non-participants', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: OTHER_USER_ID, worker_id: null, illegal_risk_score: 0, compliance_guardian_notes: {} }], rowCount: 1,
    } as any);
    await expect(makeCaller().getComplianceStatus({ taskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects an application denied by current database eligibility authority', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ state: 'OPEN', poster_id: OTHER_USER_ID, trust_tier_required: 3, title: 'Trusted work' }], rowCount: 1,
    } as any);
    mockMutationEligibility.mockRejectedValueOnce(new TRPCError({
      code: 'FORBIDDEN',
      message: 'This task is not currently eligible for this worker.',
    }));
    await expect(callerWithTrust('worker', 1).applyForTask({ taskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['FORBIDDEN', 'FORBIDDEN'],
    ['INVALID_STATE', 'PRECONDITION_FAILED'],
    ['OTHER', 'BAD_REQUEST'],
  ])('maps worker cancellation %s to %s', async (serviceCode, trpcCode) => {
    mockTaskService.workerAbandon.mockResolvedValueOnce({
      success: false, error: { code: serviceCode, message: 'blocked' },
    } as any);
    await expect(makeCallerAsHustler().workerCancel({ taskId: TASK_ID, reason: 'schedule changed' }))
      .rejects.toMatchObject({ code: trpcCode });
  });

  it('completes a worker cancellation and invalidates the task cache', async () => {
    mockTaskService.workerAbandon.mockResolvedValueOnce({
      success: true, data: makeTaskRow({ state: 'OPEN', worker_id: null }),
    } as any);
    await expect(makeCallerAsHustler().workerCancel({ taskId: TASK_ID }))
      .resolves.toMatchObject({ state: 'OPEN' });
    expect(mockInvalidateTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('does not confuse poster trust with the persisted worker trust requirement', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, trust_tier_required: 3, template_slug: 'care', mutual_consent_required: false, title: 'Care' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ trust_tier: 3 }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ state: 'FUNDED' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'ACCEPTED', worker_id: OTHER_USER_ID }], rowCount: 1 } as any);
    await expect(callerWithTrust('poster', 1).assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID }))
      .resolves.toMatchObject({ state: 'ACCEPTED', worker_id: OTHER_USER_ID });
  });

  it('allows assignment to continue when a legacy task template is no longer registered', async () => {
    mockGetTemplate.mockReturnValueOnce(undefined as any);
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'OPEN', poster_id: USER_ID, trust_tier_required: null, template_slug: 'legacy', mutual_consent_required: false, title: 'Legacy' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: APP_ID }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ state: 'FUNDED' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'ACCEPTED', worker_id: OTHER_USER_ID }], rowCount: 1 } as any);
    await expect(makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID }))
      .resolves.toMatchObject({ state: 'ACCEPTED', worker_id: OTHER_USER_ID });
  });

  it('rejects declared but unimplemented partial-payout task fields', async () => {
    await expect(makeCallerAsPoster().create({ ...validCreateInput, prorate_on_abort: true }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps create preflight storage failure to internal error', async () => {
    mockTaskService.lookupCreateRequest.mockResolvedValueOnce({
      success: false, error: { code: 'DB_ERROR', message: 'lookup failed' },
    } as any);
    await expect(makeCallerAsPoster().create({
      ...validCreateInput, clientIdempotencyKey: 'quote-create-0001',
    })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('hard-blocks illegal create content', async () => {
    mockCompliance.evaluate.mockResolvedValueOnce({ tier: 'hard_block', score: 100, triggeredRules: ['illegal'], notes: {} } as any);
    await expect(makeCallerAsPoster().create(validCreateInput)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an unknown create template', async () => {
    mockGetTemplate.mockReturnValueOnce(undefined as any);
    await expect(makeCallerAsPoster().create({ ...validCreateInput, templateSlug: 'unknown-template' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('allows any eligible poster to request licensed work while worker policy remains authoritative', async () => {
    mockTaskService.create.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ template_slug: 'specialized_licensed' } as any),
    } as any);
    mockGetTemplate.mockReturnValueOnce({
      slug: 'specialized_licensed', displayName: 'Specialized / Licensed', one_line_desc: 'Licensed work',
      defaultRiskTier: 1, requiredTrustTier: 'licensed', completionCriteriaType: 'photo_proof',
      autoReleaseHours: 24, lateCancelPct: 0, requiresMutualConsent: false,
      requiresContentRelease: false, scoperContext: '',
    } as any);
    await expect(callerWithTrust('poster', 1).create({
      ...validCreateInput,
      templateSlug: 'specialized_licensed',
    })).resolves.toBeDefined();
    expect(mockTaskService.create).toHaveBeenCalled();
  });

  it('maps service idempotency conflicts to tRPC conflicts', async () => {
    mockTaskService.create.mockResolvedValueOnce({
      success: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'different request' },
    } as any);
    await expect(makeCallerAsPoster().create(validCreateInput)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('strips poster and worker identity from discoverable tasks', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: true, data: makeTaskRow({ poster_id: OTHER_USER_ID, worker_id: null, state: 'OPEN' }),
    } as any);
    await expect(makeCaller().getById({ taskId: TASK_ID })).resolves.toMatchObject({
      poster_id: undefined, worker_id: undefined,
    });
  });

  it('rejects proof submission by a non-assigned worker', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: OTHER_USER_ID }], rowCount: 1 } as any);
    await expect(makeCallerAsHustler().submitProof({ taskId: TASK_ID, description: 'done' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('logs but contains orphan-proof cleanup failure', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: USER_ID }], rowCount: 1 } as any)
      .mockRejectedValueOnce(new Error('cleanup unavailable'));
    mockProofService.submit.mockResolvedValueOnce({ success: true, data: makeProofRow() as any });
    mockTaskService.submitProof.mockResolvedValueOnce({
      success: false, error: { code: 'INVALID_STATE', message: 'state changed' },
    } as any);
    await expect(makeCallerAsHustler().submitProof({ taskId: TASK_ID, description: 'done' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('requires a rejection reason', async () => {
    await expect(makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'REJECTED' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it.each([
    [{ success: false, error: { code: 'NOT_FOUND', message: 'gone' } }, 'NOT_FOUND'],
    [{ success: true, data: makeTaskRow({ poster_id: OTHER_USER_ID, state: 'PROOF_SUBMITTED' }) }, 'FORBIDDEN'],
    [{ success: true, data: makeTaskRow({ poster_id: USER_ID, state: 'OPEN' }) }, 'PRECONDITION_FAILED'],
  ] as const)('validates task ownership and state before review', async (serviceResult, code) => {
    mockTaskService.getById.mockResolvedValueOnce(serviceResult as any);
    await expect(makeCallerAsPoster().reviewProof({ taskId: TASK_ID, approved: true }))
      .rejects.toMatchObject({ code });
  });

  it('requires a submitted proof state and a canonical proof record', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: USER_ID }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ state: 'ACCEPTED' }], rowCount: 1 } as any);
    await expect(makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'ACCEPTED' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: USER_ID }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as any);
    mockProofService.getById.mockResolvedValueOnce({
      success: false, error: { code: 'NOT_FOUND', message: 'proof missing' },
    } as any);
    await expect(makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'ACCEPTED' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a proof/task mismatch', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: true, data: makeTaskRow({ state: 'PROOF_SUBMITTED' }),
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as any);
    mockProofService.getById.mockResolvedValueOnce({
      success: true, data: makeProofRow({ task_id: OTHER_USER_ID }),
    } as any);
    await expect(makeCallerAsPoster().reviewProof({
      taskId: TASK_ID, proofId: PROOF_ID, decision: 'ACCEPTED',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('completes and emits the post-commit worker notification path', async () => {
    mockVerifiedPosterCompletion.confirm.mockResolvedValueOnce({
      success: true, data: makeTaskRow({ state: 'COMPLETED', worker_id: OTHER_USER_ID }),
    } as any);
    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID }))
      .resolves.toMatchObject({ state: 'COMPLETED' });
  });
});

describe('task execution scope procedures', () => {
  it('reads scope only through participant-authorized service policy', async () => {
    mockTaskScopeService.getForParticipant.mockResolvedValueOnce({
      role: 'HUSTLER', legacy: false, version: { id: PROOF_ID }, checklist: [], pendingChange: null,
    } as never);

    await expect(makeCallerAsHustler().getExecutionScope({ taskId: TASK_ID }))
      .resolves.toMatchObject({ role: 'HUSTLER', legacy: false });
    expect(mockTaskScopeService.getForParticipant).toHaveBeenCalledWith(TASK_ID, USER_ID);
  });

  it('creates a checklist-only scope proposal and invalidates cached task state', async () => {
    mockTaskScopeService.proposeChange.mockResolvedValueOnce({ id: PROOF_ID, status: 'PENDING' } as never);

    await expect(makeCallerAsHustler().proposeScopeChange({
      taskId: TASK_ID,
      observedScopeSummary: 'The cable tray is included.',
      proposedChecklist: ['Protect the floor', 'Assemble the desk', 'Attach the cable tray'],
    })).resolves.toMatchObject({ status: 'PENDING' });
    expect(mockTaskScopeService.proposeChange).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK_ID,
      userId: USER_ID,
    }));
    expect(mockInvalidateTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('routes scope approval through server-side Poster ownership enforcement', async () => {
    mockTaskScopeService.reviewChange.mockResolvedValueOnce({
      proposal: { id: PROOF_ID, status: 'APPROVED' },
      version: { id: APP_ID, version: 2 },
    } as never);

    await expect(makeCallerAsPoster().reviewScopeChange({
      taskId: TASK_ID,
      proposalId: PROOF_ID,
      decision: 'APPROVED',
      reason: 'This remains within the paid desk assembly scope.',
    })).resolves.toMatchObject({ version: { version: 2 } });
    expect(mockTaskScopeService.reviewChange).toHaveBeenCalledWith(expect.objectContaining({
      posterId: USER_ID,
      proposalId: PROOF_ID,
    }));
  });

  it('routes checklist completion with an exact version and item index', async () => {
    mockTaskScopeService.setChecklistItem.mockResolvedValueOnce({
      versionId: APP_ID, itemIndex: 1, completed: true,
    } as never);

    await expect(makeCallerAsHustler().setScopeChecklistItem({
      taskId: TASK_ID,
      versionId: APP_ID,
      itemIndex: 1,
      completed: true,
    })).resolves.toMatchObject({ completed: true });
    expect(mockTaskScopeService.setChecklistItem).toHaveBeenCalledWith({
      taskId: TASK_ID,
      versionId: APP_ID,
      itemIndex: 1,
      completed: true,
      workerId: USER_ID,
    });
  });
});
