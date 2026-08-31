import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/AutomationLifecycleService', () => ({
  AutomationLifecycleService: { listTasks: vi.fn() },
}));
vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { webOpsRouter } from '../../src/routers/web/ops';
import { AutomationLifecycleService } from '../../src/services/AutomationLifecycleService';
import { db } from '../../src/db';

const listTasks = vi.mocked(AutomationLifecycleService.listTasks);
const mockDb = vi.mocked(db);

function caller(isAdmin = true) {
  return webOpsRouter.createCaller({
    user: {
      id: '22222222-2222-4222-8222-222222222222',
      is_admin: isAdmin,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'poster',
    },
    firebaseUid: 'named-firebase-operator',
    identityAssurance: {
      authenticatedAtSeconds: Math.floor(Date.now() / 1000),
      tokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3_600,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    },
    ip: '127.0.0.1',
  } as any);
}

function authorizeOperations(granted = true) {
  mockDb.query.mockResolvedValueOnce({
    rows: [{ role: 'support', capability_granted: granted }], rowCount: 1,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.query.mockReset();
});

describe('webOps.listEngineTasks', () => {
  it('returns the canonical bounded lifecycle read for the ops compatibility contract', async () => {
    authorizeOperations();
    listTasks.mockResolvedValueOnce({ success: true, data: { tasks: [], nextCursor: null } });
    await expect(caller().listEngineTasks({ limit: 25 }))
      .resolves.toEqual({ ok: true, tasks: [], nextCursor: null });
    expect(listTasks).toHaveBeenCalledWith({ limit: 25, cursor: undefined });
  });

  it('rejects an ordinary authenticated caller before reading lifecycle state', async () => {
    await expect(caller(false).listEngineTasks({ limit: 20 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listTasks).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects staff without the operations capability before lifecycle reads', async () => {
    authorizeOperations(false);
    await expect(caller().listEngineTasks({ limit: 20 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listTasks).not.toHaveBeenCalled();
  });
});
