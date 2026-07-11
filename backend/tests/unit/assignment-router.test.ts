import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/TaskReservationService', () => ({
  TaskReservationService: { reserve: vi.fn() },
}));

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { assignmentRouter } from '../../src/routers/assignment';
import { TaskReservationService } from '../../src/services/TaskReservationService';

const reserve = vi.mocked(TaskReservationService.reserve);
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const WORKER_ID = '550e8400-e29b-41d4-a716-446655440001';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440002';

function caller(isAdmin = true) {
  return assignmentRouter.createCaller({
    user: {
      id: ADMIN_ID,
      email: 'ops@hustlexp.com',
      full_name: 'Ops',
      default_mode: 'poster',
      account_status: 'ACTIVE',
      is_admin: isAdmin,
    } as any,
    firebaseUid: 'firebase-ops',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assignment.reserve', () => {
  it('allows an admin ops caller without a poster credential', async () => {
    reserve.mockResolvedValueOnce({
      success: true,
      data: {
        reservationId: 'reservation-1',
        engineTaskId: TASK_ID,
        hustlerRef: WORKER_ID,
        state: 'ENGINE_RESERVED',
        idempotencyReplayed: false,
      },
    });

    const result = await caller().reserve({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-0001-attempt-01',
    });

    expect(result.state).toBe('ENGINE_RESERVED');
    expect(reserve).toHaveBeenCalledWith({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-0001-attempt-01',
      actorId: ADMIN_ID,
    });
  });

  it('maps a reservation race to CONFLICT', async () => {
    reserve.mockResolvedValueOnce({
      success: false,
      error: { code: 'RESERVATION_CONFLICT', message: 'already reserved' },
    });

    await expect(caller().reserve({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-0001-attempt-01',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects non-admin callers', async () => {
    await expect(caller(false).reserve({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-0001-attempt-01',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(reserve).not.toHaveBeenCalled();
  });
});
