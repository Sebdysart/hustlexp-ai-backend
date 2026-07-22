import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/CompletionRetentionService', () => ({
  CompletionRetentionService: { rebook: vi.fn() },
}));
vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { router } from '../../src/trpc';
import { TaskRetentionProcedures } from '../../src/routers/TaskRetentionProcedures';
import { CompletionRetentionService } from '../../src/services/CompletionRetentionService';

const SOURCE_TASK_ID = '11111111-1111-4111-8111-111111111111';
const POSTER_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';
const retentionRouter = router({ ...TaskRetentionProcedures });
const retention = vi.mocked(CompletionRetentionService);

function caller(mode: 'poster' | 'worker' = 'poster') {
  return retentionRouter.createCaller({
    user: {
      id: POSTER_ID, email: 'poster@example.com', full_name: 'Poster',
      default_mode: mode, account_status: 'ACTIVE', is_minor: false,
    } as any,
    firebaseUid: 'firebase-poster',
  });
}

describe('task.rebook Poster contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes only the authenticated Poster identity and normalized date to the service', async () => {
    retention.rebook.mockResolvedValue({
      success: true,
      data: {
        taskId: '44444444-4444-4444-8444-444444444444',
        sourceTaskId: SOURCE_TASK_ID, preferredWorkerId: WORKER_ID,
        state: 'OPEN', paymentState: 'PENDING', requiresNewFunding: true,
        idempotencyReplayed: false,
      },
    });
    const result = await caller().rebook({
      sourceTaskId: SOURCE_TASK_ID,
      scheduledFor: '2026-07-25T18:00:00.000Z',
      clientIdempotencyKey: 'rebook-request-0001',
    });

    expect(result.paymentState).toBe('PENDING');
    expect(retention.rebook).toHaveBeenCalledWith({
      sourceTaskId: SOURCE_TASK_ID,
      posterId: POSTER_ID,
      scheduledFor: new Date('2026-07-25T18:00:00.000Z'),
      clientIdempotencyKey: 'rebook-request-0001',
    });
  });

  it('rejects a Hustler-mode caller before the service can run', async () => {
    await expect(caller('worker').rebook({
      sourceTaskId: SOURCE_TASK_ID,
      clientIdempotencyKey: 'rebook-request-0002',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(retention.rebook).not.toHaveBeenCalled();
  });

  it('maps idempotency conflicts without hiding them as generic failures', async () => {
    retention.rebook.mockResolvedValue({
      success: false,
      error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Input changed' },
    });
    await expect(caller().rebook({
      sourceTaskId: SOURCE_TASK_ID,
      clientIdempotencyKey: 'rebook-request-0003',
    })).rejects.toMatchObject({ code: 'CONFLICT', message: 'Input changed' });
  });

  it('rejects unrecognized fields and malformed idempotency keys', async () => {
    await expect(caller().rebook({
      sourceTaskId: SOURCE_TASK_ID,
      clientIdempotencyKey: 'bad key',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(retention.rebook).not.toHaveBeenCalled();
  });
});
