import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    transaction: vi.fn((fn: (q: typeof query) => Promise<unknown>) => fn(query)),
    outbox: vi.fn(),
  };
});

vi.mock('../../src/db', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));
vi.mock('../../src/lib/outbox-helpers', () => ({ writeToOutbox: mocks.outbox }));
vi.mock('../../src/logger', () => ({
  taskLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { TaskProgressService } from '../../src/services/TaskProgressService';
import { TaskReadService } from '../../src/services/TaskReadService';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const POSTER_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';
const query = mocks.query;

function rows(value: unknown[] = [], rowCount = value.length) {
  return { rows: value, rowCount } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockReset();
  mocks.transaction.mockImplementation((fn: (q: typeof query) => Promise<unknown>) => fn(query));
});

describe('TaskProgressService changed-line edges', () => {
  it('returns same-state retries without emitting a duplicate progress event', async () => {
    const travelingTask = {
      id: TASK_ID,
      poster_id: POSTER_ID,
      worker_id: WORKER_ID,
      progress_state: 'TRAVELING',
      state: 'ACCEPTED',
      scope_change_pending: false,
    };
    query.mockResolvedValueOnce(rows([travelingTask]))
      .mockResolvedValueOnce(rows([travelingTask]));

    await expect(TaskProgressService.advanceProgress({
      taskId: TASK_ID,
      to: 'TRAVELING',
      actor: { type: 'worker', userId: WORKER_ID },
    })).resolves.toMatchObject({ success: true, data: travelingTask });
    expect(mocks.outbox).not.toHaveBeenCalled();
  });

  it('requires worker identity for worker-owned transitions', async () => {
    query.mockResolvedValueOnce(rows([{
      id: TASK_ID, poster_id: POSTER_ID, worker_id: WORKER_ID,
      progress_state: 'ACCEPTED', state: 'ACCEPTED',
    }]));
    await expect(TaskProgressService.advanceProgress({
      taskId: TASK_ID, to: 'TRAVELING', actor: { type: 'system' },
    })).resolves.toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
  });

  it('detects a concurrently locked active dispute', async () => {
    query.mockResolvedValueOnce(rows([{
      id: TASK_ID, poster_id: POSTER_ID, worker_id: WORKER_ID,
      progress_state: 'ACCEPTED', state: 'ACCEPTED',
    }])).mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows([{ count: '1' }]));
    await expect(TaskProgressService.advanceProgress({
      taskId: TASK_ID, to: 'TRAVELING', actor: { type: 'worker', userId: WORKER_ID },
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
  });

  it('fails closed when a progress update affects no task', async () => {
    query.mockResolvedValueOnce(rows([{
      id: TASK_ID, poster_id: POSTER_ID, worker_id: null,
      progress_state: 'POSTED', state: 'OPEN',
    }])).mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows([{ count: '0' }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await expect(TaskProgressService.advanceProgress({
      taskId: TASK_ID, to: 'ACCEPTED', actor: { type: 'system' },
    })).resolves.toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
});

describe('TaskReadService changed-line edges', () => {
  it('rejects malformed poster and worker cursors before querying', async () => {
    await expect(TaskReadService.getByPoster(POSTER_ID, { cursor: 'bad' })).resolves.toMatchObject({
      success: false, error: { code: 'BAD_REQUEST' },
    });
    await expect(TaskReadService.getByWorker(WORKER_ID, { cursor: 'bad' })).resolves.toMatchObject({
      success: false, error: { code: 'BAD_REQUEST' },
    });
  });

  it('maps worker-list and open-list database failures', async () => {
    query.mockRejectedValueOnce(new Error('worker query'));
    await expect(TaskReadService.getByWorker(WORKER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
    query.mockRejectedValueOnce('open query');
    await expect(TaskReadService.listOpen()).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });

  it('covers every create-idempotency preflight outcome', async () => {
    const base = { posterId: POSTER_ID, title: 'Task', description: 'Description', price: 500 };
    await expect(TaskReadService.lookupCreateRequest(base)).resolves.toMatchObject({
      success: true, data: { status: 'missing' },
    });
    query.mockResolvedValueOnce(rows());
    await expect(TaskReadService.lookupCreateRequest({ ...base, clientIdempotencyKey: 'create-key' }))
      .resolves.toMatchObject({ success: true, data: { status: 'missing' } });
    query.mockResolvedValueOnce(rows([{ id: TASK_ID, request_hash: 'different' }]));
    await expect(TaskReadService.lookupCreateRequest({ ...base, clientIdempotencyKey: 'create-key' }))
      .resolves.toMatchObject({ success: true, data: { status: 'conflict', existingTaskId: TASK_ID } });
    query.mockRejectedValueOnce(new Error('preflight db'));
    await expect(TaskReadService.lookupCreateRequest({ ...base, clientIdempotencyKey: 'create-key' }))
      .resolves.toMatchObject({ success: false, error: { code: 'DB_ERROR' } });
  });
});
