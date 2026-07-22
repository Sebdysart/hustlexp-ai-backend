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
import { db } from '../../src/db';

const reserve = vi.mocked(TaskReservationService.reserve);
const query = vi.mocked(db.query);
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
    engineBridgeAuthorized: false,
    engineBridgeActorId: null,
    ip: null,
  });
}

function bridgeCaller() {
  return assignmentRouter.createCaller({
    user: null,
    firebaseUid: null,
    engineBridgeAuthorized: true,
    engineBridgeActorId: ADMIN_ID,
    ip: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
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

  it('allows the authenticated engine bridge and records its configured actor', async () => {
    reserve.mockResolvedValueOnce({
      success: true,
      data: {
        reservationId: 'reservation-bridge',
        engineTaskId: TASK_ID,
        hustlerRef: WORKER_ID,
        state: 'ENGINE_RESERVED',
        idempotencyReplayed: false,
      },
    });
    const result = await bridgeCaller().reserve({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-bridge-attempt-01',
    });
    expect(result.state).toBe('ENGINE_RESERVED');
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ actorId: ADMIN_ID }));
  });

  it('rejects a request that has neither an admin user nor authenticated bridge authority', async () => {
    const unauthenticated = assignmentRouter.createCaller({
      user: null,
      firebaseUid: null,
      engineBridgeAuthorized: false,
      engineBridgeActorId: null,
      ip: null,
    });
    await expect(unauthenticated.reserve({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-unauthenticated-01',
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects a suspended admin identity before reservation', async () => {
    const suspended = assignmentRouter.createCaller({
      user: {
        id: ADMIN_ID,
        account_status: 'SUSPENDED',
        is_admin: true,
      } as any,
      firebaseUid: 'firebase-suspended',
      engineBridgeAuthorized: false,
      engineBridgeActorId: null,
      ip: null,
    });
    await expect(suspended.reserve({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-suspended-01',
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('loads an uncached admin role before allowing reservation', async () => {
    query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
    reserve.mockResolvedValueOnce({
      success: true,
      data: {
        reservationId: 'reservation-role-lookup',
        engineTaskId: TASK_ID,
        hustlerRef: WORKER_ID,
        state: 'ENGINE_RESERVED',
        idempotencyReplayed: false,
      },
    });
    const roleLookup = assignmentRouter.createCaller({
      user: {
        id: ADMIN_ID,
        account_status: 'ACTIVE',
        is_admin: undefined,
      } as any,
      firebaseUid: 'firebase-role-lookup',
      engineBridgeAuthorized: false,
      engineBridgeActorId: null,
      ip: null,
    });
    await expect(roleLookup.reserve({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-role-lookup-01',
    })).resolves.toMatchObject({ state: 'ENGINE_RESERVED' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT role FROM admin_roles'),
      [ADMIN_ID, ['admin', 'founder']],
    );
  });

  it('denies a cached support identity from engine-equivalent reservation authority', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    await expect(caller(true).reserve({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-support-denied-01',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('fails closed if an accepted admin context has no reservation actor id', async () => {
    const malformed = assignmentRouter.createCaller({
      user: {
        id: undefined,
        account_status: 'ACTIVE',
        is_admin: true,
      } as any,
      firebaseUid: 'firebase-malformed-admin',
      engineBridgeAuthorized: false,
      engineBridgeActorId: null,
      ip: null,
    });
    await expect(malformed.reserve({
      engineTaskId: TASK_ID,
      hustlerRef: WORKER_ID,
      idempotencyKey: 'dispatch-wave-malformed-admin-01',
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(reserve).not.toHaveBeenCalled();
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
