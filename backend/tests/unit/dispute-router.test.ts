/**
 * Dispute Router Unit Tests
 *
 * Tests tRPC procedures:
 * - create   (protectedProcedure, mutation)
 * - getById  (protectedProcedure, query)
 * - getByTask (protectedProcedure, query)
 * - getMine   (protectedProcedure, query)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
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
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  aiLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('../../src/services/DisputeService', () => ({
  DisputeService: {
    create: vi.fn(),
    getById: vi.fn(),
    getByTaskId: vi.fn(),
    getByUserId: vi.fn(),
  },
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    getById: vi.fn(),
  },
}));

vi.mock('../../src/services/EscrowService', () => ({
  EscrowService: {
    getByTaskId: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { disputeRouter } from '../../src/routers/dispute';
import { DisputeService } from '../../src/services/DisputeService';
import { TaskService } from '../../src/services/TaskService';
import { EscrowService } from '../../src/services/EscrowService';

const mockDispute = vi.mocked(DisputeService);
const mockTask = vi.mocked(TaskService);
const mockEscrow = vi.mocked(EscrowService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POSTER_ID = '11111111-1111-1111-1111-111111111111';
const WORKER_ID = '22222222-2222-2222-2222-222222222222';
const TASK_UUID = '33333333-3333-3333-3333-333333333333';
const ESCROW_UUID = '44444444-4444-4444-4444-444444444444';
const DISPUTE_UUID = '55555555-5555-5555-5555-555555555555';

const fakeTask = {
  id: TASK_UUID,
  poster_id: POSTER_ID,
  worker_id: WORKER_ID,
  escrow_id: ESCROW_UUID,
  completed_at: new Date().toISOString(),
  status: 'completed',
};

const fakeDispute = {
  id: DISPUTE_UUID,
  task_id: TASK_UUID,
  escrow_id: ESCROW_UUID,
  poster_id: POSTER_ID,
  worker_id: WORKER_ID,
  initiated_by: WORKER_ID,
  reason: 'Work not completed',
  description: 'The task was not finished as described.',
  state: 'OPEN',
  created_at: new Date().toISOString(),
};

function makeCaller(userId = WORKER_ID, defaultMode: 'worker' | 'poster' = 'worker') {
  return disputeRouter.createCaller({
    user: { id: userId, default_mode: defaultMode } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests — create
// ---------------------------------------------------------------------------

describe('dispute.create', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a dispute when worker initiates on their task', async () => {
    mockTask.getById.mockResolvedValueOnce({ success: true, data: fakeTask } as any);
    mockEscrow.getByTaskId.mockResolvedValueOnce({ success: true, data: { id: ESCROW_UUID } } as any);
    mockDispute.create.mockResolvedValueOnce({ success: true, data: fakeDispute } as any);

    const result = await makeCaller(WORKER_ID).create({
      taskId: TASK_UUID,
      reason: 'Work not completed',
      description: 'The task was not finished as described.',
    });

    expect(result.id).toBe(DISPUTE_UUID);
    expect(result.state).toBe('OPEN');
    expect(mockDispute.create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_UUID,
        escrowId: ESCROW_UUID,
        initiatedBy: WORKER_ID,
        posterId: POSTER_ID,
        workerId: WORKER_ID,
        reason: 'Work not completed',
      })
    );
  });

  it('creates a dispute when poster initiates', async () => {
    mockTask.getById.mockResolvedValueOnce({ success: true, data: fakeTask } as any);
    mockEscrow.getByTaskId.mockResolvedValueOnce({ success: true, data: { id: ESCROW_UUID } } as any);
    mockDispute.create.mockResolvedValueOnce({
      success: true,
      data: { ...fakeDispute, initiated_by: POSTER_ID },
    } as any);

    const result = await makeCaller(POSTER_ID, 'poster').create({
      taskId: TASK_UUID,
      reason: 'No-show',
      description: 'Worker never arrived.',
    });

    expect(result).toBeDefined();
    expect(mockDispute.create).toHaveBeenCalledWith(
      expect.objectContaining({ initiatedBy: POSTER_ID })
    );
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockTask.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    } as any);

    await expect(
      makeCaller().create({ taskId: TASK_UUID, reason: 'test', description: 'test desc' })
    ).rejects.toThrow('Task not found');
  });

  it('throws PRECONDITION_FAILED when no escrow exists for the task', async () => {
    mockTask.getById.mockResolvedValueOnce({ success: true, data: fakeTask } as any);
    mockEscrow.getByTaskId.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: `No escrow found for task ${TASK_UUID}` },
    } as any);

    await expect(
      makeCaller().create({ taskId: TASK_UUID, reason: 'test', description: 'test desc' })
    ).rejects.toThrow('No escrow found');
  });

  it('throws FORBIDDEN when service returns FORBIDDEN', async () => {
    mockTask.getById.mockResolvedValueOnce({ success: true, data: fakeTask } as any);
    mockEscrow.getByTaskId.mockResolvedValueOnce({ success: true, data: { id: ESCROW_UUID } } as any);
    mockDispute.create.mockResolvedValueOnce({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only poster or worker can initiate disputes' },
    } as any);

    await expect(
      makeCaller('other-user').create({ taskId: TASK_UUID, reason: 'test', description: 'test' })
    ).rejects.toThrow('Only poster or worker can initiate disputes');
  });

  it('throws PRECONDITION_FAILED when service returns INVALID_STATE', async () => {
    mockTask.getById.mockResolvedValueOnce({ success: true, data: fakeTask } as any);
    mockEscrow.getByTaskId.mockResolvedValueOnce({ success: true, data: { id: ESCROW_UUID } } as any);
    mockDispute.create.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_STATE', message: 'Disputes can only be opened for completed tasks' },
    } as any);

    await expect(
      makeCaller().create({ taskId: TASK_UUID, reason: 'test', description: 'test' })
    ).rejects.toThrow('Disputes can only be opened for completed tasks');
  });

  it('throws INTERNAL_SERVER_ERROR on unexpected service failure', async () => {
    mockTask.getById.mockResolvedValueOnce({ success: true, data: fakeTask } as any);
    mockEscrow.getByTaskId.mockResolvedValueOnce({ success: true, data: { id: ESCROW_UUID } } as any);
    mockDispute.create.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Connection lost' },
    } as any);

    await expect(
      makeCaller().create({ taskId: TASK_UUID, reason: 'test', description: 'test' })
    ).rejects.toThrow('Connection lost');
  });
});

// ---------------------------------------------------------------------------
// Tests — getById
// ---------------------------------------------------------------------------

describe('dispute.getById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns dispute for a party (worker)', async () => {
    mockDispute.getById.mockResolvedValueOnce({ success: true, data: fakeDispute } as any);

    const result = await makeCaller(WORKER_ID).getById({ disputeId: DISPUTE_UUID });

    expect(result.id).toBe(DISPUTE_UUID);
  });

  it('returns dispute for a party (poster)', async () => {
    mockDispute.getById.mockResolvedValueOnce({ success: true, data: fakeDispute } as any);

    const result = await makeCaller(POSTER_ID, 'poster').getById({ disputeId: DISPUTE_UUID });

    expect(result.id).toBe(DISPUTE_UUID);
  });

  it('throws FORBIDDEN for a non-party user', async () => {
    mockDispute.getById.mockResolvedValueOnce({ success: true, data: fakeDispute } as any);

    await expect(
      makeCaller('outsider-0000').getById({ disputeId: DISPUTE_UUID })
    ).rejects.toThrow('not a party to this dispute');
  });

  it('throws NOT_FOUND when dispute does not exist', async () => {
    mockDispute.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: `Dispute ${DISPUTE_UUID} not found` },
    } as any);

    await expect(
      makeCaller(WORKER_ID).getById({ disputeId: DISPUTE_UUID })
    ).rejects.toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// Tests — getByTask
// ---------------------------------------------------------------------------

describe('dispute.getByTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns disputes for a task party', async () => {
    mockTask.getById.mockResolvedValueOnce({ success: true, data: fakeTask } as any);
    mockDispute.getByTaskId.mockResolvedValueOnce({ success: true, data: [fakeDispute] } as any);

    const result = await makeCaller(WORKER_ID).getByTask({ taskId: TASK_UUID });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(DISPUTE_UUID);
  });

  it('throws FORBIDDEN for a non-party user', async () => {
    mockTask.getById.mockResolvedValueOnce({ success: true, data: fakeTask } as any);

    await expect(
      makeCaller('outsider-0000').getByTask({ taskId: TASK_UUID })
    ).rejects.toThrow('not a party to this task');
  });

  it('throws NOT_FOUND when task does not exist', async () => {
    mockTask.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    } as any);

    await expect(
      makeCaller(WORKER_ID).getByTask({ taskId: TASK_UUID })
    ).rejects.toThrow('Task not found');
  });
});

// ---------------------------------------------------------------------------
// Tests — getMine
// ---------------------------------------------------------------------------

describe('dispute.getMine', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns disputes for the current user', async () => {
    mockDispute.getByUserId.mockResolvedValueOnce({ success: true, data: [fakeDispute] } as any);

    const result = await makeCaller(WORKER_ID).getMine();

    expect(result).toHaveLength(1);
    expect(mockDispute.getByUserId).toHaveBeenCalledWith(WORKER_ID);
  });

  it('returns empty array when user has no disputes', async () => {
    mockDispute.getByUserId.mockResolvedValueOnce({ success: true, data: [] } as any);

    const result = await makeCaller(WORKER_ID).getMine();

    expect(result).toEqual([]);
  });

  it('throws INTERNAL_SERVER_ERROR on DB failure', async () => {
    mockDispute.getByUserId.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Query timeout' },
    } as any);

    await expect(makeCaller(WORKER_ID).getMine()).rejects.toThrow('Query timeout');
  });
});
