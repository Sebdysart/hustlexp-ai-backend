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
  const input = {
    engineTaskId: TASK_ID,
    hustlerRef: WORKER_ID,
    idempotencyKey: 'dispatch-wave-0001-attempt-01',
  };

  it('terminally holds a named platform administrator before reservation logic', async () => {
    await expect(caller().reserve(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM admin_roles'),
      [ADMIN_ID, ['admin', 'support', 'finance', 'moderator', 'founder']],
    );
  });

  it('does not trust forged engine-bridge context fields', async () => {
    await expect(bridgeCaller().reserve(input)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects ordinary authenticated users before reservation logic', async () => {
    await expect(caller(false).reserve(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(reserve).not.toHaveBeenCalled();
  });
});
