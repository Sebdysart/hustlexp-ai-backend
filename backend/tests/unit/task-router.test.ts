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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that transitively touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { TaskService } from '../../src/services/TaskService';
import { ProofService } from '../../src/services/ProofService';
import { taskRouter } from '../../src/routers/task';

const mockDb = vi.mocked(db);
const mockTaskService = vi.mocked(TaskService);
const mockProofService = vi.mocked(ProofService);

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

// ===========================================================================
// task.getById
// ===========================================================================

describe('task.getById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.clearAllMocks();
  });

  it('returns { state } for existing task', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ state: 'ACCEPTED' }],
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
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'OPEN' }], rowCount: 1 } as any);

    await makeCaller().getState({ taskId: TASK_ID });

    const [sql, params] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain('SELECT state FROM tasks');
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
  });

  it('returns task row when worker is assigned and state is ACCEPTED', async () => {
    const task = makeTaskRow({ state: 'ACCEPTED', worker_id: USER_ID });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockDb.query.mockResolvedValueOnce({ rows: [task], rowCount: 1 } as any);

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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
  });

  it('returns { task, proof } on success', async () => {
    const proof = makeProofRow();
    const task = makeTaskRow({ state: 'PROOF_SUBMITTED' });
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
      photoUrls: ['https://example.com/photo.jpg'],
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
        photoUrls: ['https://example.com/photo.jpg'],
        gpsLatitude: 37.7749,
        gpsLongitude: -122.4194,
        biometricHash: 'abc123',
      })
    );
  });

  it('falls back to notes when description is not provided', async () => {
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
    mockProofService.submit.mockResolvedValueOnce({
      success: false,
      error: { code: 'PROOF_ERROR', message: 'Proof failed' },
    });

    await expect(
      makeCaller().submitProof({ taskId: TASK_ID, description: 'x' })
    ).rejects.toThrow('Proof failed');
  });

  it('throws BAD_REQUEST when TaskService.submitProof fails', async () => {
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
    vi.clearAllMocks();
  });

  it('reviews proof by proofId + decision (original schema)', async () => {
    const proof = makeProofRow({ task_id: TASK_ID });
    const task = makeTaskRow({ poster_id: USER_ID });
    const reviewedProof = makeProofRow({ state: 'ACCEPTED', reviewed_by: USER_ID });

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
    // proofLookup via db.query
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: PROOF_ID }],
      rowCount: 1,
    } as any);
    mockProofService.getById.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ task_id: TASK_ID }) as any,
    });
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ poster_id: USER_ID }) as any,
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
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: PROOF_ID }],
      rowCount: 1,
    } as any);
    mockProofService.getById.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ task_id: TASK_ID }) as any,
    });
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ poster_id: USER_ID }) as any,
    });
    mockProofService.review.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ state: 'REJECTED' }) as any,
    });

    await makeCallerAsPoster().reviewProof({ taskId: TASK_ID, approved: false });

    expect(mockProofService.review).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'REJECTED' })
    );
  });

  it('throws BAD_REQUEST when neither proofId nor taskId is given', async () => {
    await expect(makeCallerAsPoster().reviewProof({})).rejects.toThrow('proofId or taskId is required');
  });

  it('throws BAD_REQUEST when neither decision nor approved is given', async () => {
    // Note: the code checks for decision before calling any services,
    // so no service mocks are needed here.
    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID })
    ).rejects.toThrow('decision or approved is required');
  });

  it('throws NOT_FOUND when no proof found for taskId', async () => {
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
    mockProofService.getById.mockResolvedValueOnce({
      success: true,
      data: makeProofRow({ task_id: TASK_ID }) as any,
    });
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: makeTaskRow({ poster_id: USER_ID }) as any,
    });
    mockProofService.review.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_TRANSITION', message: 'Cannot transition' },
    });

    await expect(
      makeCallerAsPoster().reviewProof({ proofId: PROOF_ID, decision: 'ACCEPTED' })
    ).rejects.toThrow('Cannot transition');
  });
});

// ===========================================================================
// task.complete
// ===========================================================================

describe('task.complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns completed task when poster calls', async () => {
    const task = makeTaskRow({ poster_id: USER_ID, state: 'PROOF_SUBMITTED' });
    const completed = makeTaskRow({ state: 'COMPLETED' });

    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockTaskService.complete.mockResolvedValueOnce({ success: true, data: completed as any });

    const result = await makeCallerAsPoster().complete({ taskId: TASK_ID });

    expect(result).toEqual(completed);
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when user is not the poster', async () => {
    const task = makeTaskRow({ poster_id: OTHER_USER_ID });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow(
      'Only the task poster can mark it complete'
    );
  });

  it('throws PRECONDITION_FAILED for HX301 errors (INV-3)', async () => {
    const task = makeTaskRow({ poster_id: USER_ID });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockTaskService.complete.mockResolvedValueOnce({
      success: false,
      error: { code: 'HX301', message: 'Proof must be accepted' },
    });

    await expect(makeCallerAsPoster().complete({ taskId: TASK_ID })).rejects.toThrow(
      'Proof must be accepted'
    );
  });

  it('throws BAD_REQUEST for other errors', async () => {
    const task = makeTaskRow({ poster_id: USER_ID });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
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
    vi.clearAllMocks();
  });

  it('returns cancelled task when poster calls', async () => {
    const task = makeTaskRow({ poster_id: USER_ID, state: 'OPEN' });
    const cancelled = makeTaskRow({ state: 'CANCELLED' });

    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockTaskService.cancel.mockResolvedValueOnce({ success: true, data: cancelled as any });

    const result = await makeCallerAsPoster().cancel({ taskId: TASK_ID });

    expect(result).toEqual(cancelled);
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });

    await expect(makeCallerAsPoster().cancel({ taskId: TASK_ID })).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when user is not the poster', async () => {
    const task = makeTaskRow({ poster_id: OTHER_USER_ID });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });

    await expect(makeCallerAsPoster().cancel({ taskId: TASK_ID })).rejects.toThrow(
      'Only the task poster can cancel'
    );
  });

  it('throws BAD_REQUEST when TaskService.cancel fails', async () => {
    const task = makeTaskRow({ poster_id: USER_ID });
    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockTaskService.cancel.mockResolvedValueOnce({
      success: false,
      error: { code: 'TERMINAL', message: 'Already completed' },
    });

    await expect(makeCallerAsPoster().cancel({ taskId: TASK_ID })).rejects.toThrow('Already completed');
  });

  it('accepts optional reason', async () => {
    const task = makeTaskRow({ poster_id: USER_ID });
    const cancelled = makeTaskRow({ state: 'CANCELLED' });

    mockTaskService.getById.mockResolvedValueOnce({ success: true, data: task as any });
    mockTaskService.cancel.mockResolvedValueOnce({ success: true, data: cancelled as any });

    // Should not throw — reason is optional in input schema
    const result = await makeCallerAsPoster().cancel({ taskId: TASK_ID, reason: 'Changed my mind' });

    expect(result).toEqual(cancelled);
  });
});

// ===========================================================================
// task.applyForTask
// ===========================================================================

describe('task.applyForTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns application data on success', async () => {
    // Task exists and is POSTED
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: OTHER_USER_ID }],
      rowCount: 1,
    } as any);
    // No existing application
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // Insert returns new application
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
      rows: [{ id: TASK_ID, state: 'ACCEPTED', poster_id: OTHER_USER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('Task must be in POSTED state to apply');
  });

  it('throws BAD_REQUEST when applying for own task', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('Cannot apply for your own task');
  });

  it('throws CONFLICT when already applied', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: OTHER_USER_ID }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'existing-app' }],
      rowCount: 1,
    } as any);

    await expect(
      makeCaller().applyForTask({ taskId: TASK_ID })
    ).rejects.toThrow('You already have an active application');
  });

  it('accepts optional message', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: OTHER_USER_ID }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
  });

  it('assigns worker and returns task', async () => {
    // Task lookup
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID }],
      rowCount: 1,
    } as any);
    // Application check
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: APP_ID }],
      rowCount: 1,
    } as any);
    // Accept application update
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // Reject other applications
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // TaskService.accept
    const acceptedTask = makeTaskRow({ state: 'ACCEPTED', worker_id: OTHER_USER_ID });
    mockTaskService.accept.mockResolvedValueOnce({ success: true, data: acceptedTask as any });

    const result = await makeCallerAsPoster().assignWorker({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });

    expect(result).toEqual(acceptedTask);
    expect(mockTaskService.accept).toHaveBeenCalledWith({
      taskId: TASK_ID,
      workerId: OTHER_USER_ID,
    });
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Task not found');
  });

  it('throws FORBIDDEN when user is not the poster', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: OTHER_USER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Only the task poster can assign workers');
  });

  it('throws PRECONDITION_FAILED when task is not POSTED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'ACCEPTED', poster_id: USER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Task must be POSTED to assign a worker');
  });

  it('throws NOT_FOUND when no pending application for worker', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('No pending application found for this worker');
  });

  it('throws BAD_REQUEST when TaskService.accept fails', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, state: 'POSTED', poster_id: USER_ID }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: APP_ID }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    mockTaskService.accept.mockResolvedValueOnce({
      success: false,
      error: { code: 'ERR', message: 'Accept failed' },
    });

    await expect(
      makeCallerAsPoster().assignWorker({ taskId: TASK_ID, workerId: OTHER_USER_ID })
    ).rejects.toThrow('Accept failed');
  });
});

// ===========================================================================
// task.rejectApplicant
// ===========================================================================

describe('task.rejectApplicant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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
