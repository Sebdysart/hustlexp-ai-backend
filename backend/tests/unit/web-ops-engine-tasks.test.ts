import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../src/services/AutomationLifecycleService', () => ({
  AutomationLifecycleService: { listTasks: vi.fn() },
}));
vi.mock('../../src/db', () => ({ db: { query: mocks.query, transaction: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { webOpsRouter } from '../../src/routers/web/ops';
import { AutomationLifecycleService } from '../../src/services/AutomationLifecycleService';

const listTasks = vi.mocked(AutomationLifecycleService.listTasks);
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function publicCaller() {
  return webOpsRouter.createCaller({ user: null, firebaseUid: null, ip: '127.0.0.1' });
}

function opsCaller() {
  return webOpsRouter.createCaller({
    user: {
      id: USER_ID,
      email: 'ops@example.com',
      full_name: 'Ops',
      firebase_uid: 'ops-firebase',
      is_admin: true,
      account_status: 'ACTIVE',
      is_banned: false,
    },
  } as any);
}

function grantOps() {
  mocks.query.mockResolvedValueOnce({
    rows: [{ role: 'admin', capability_granted: true }],
    rowCount: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
});

describe('webOps.listEngineTasks', () => {
  it('returns the canonical bounded lifecycle read for the ops compatibility contract', async () => {
    grantOps();
    listTasks.mockResolvedValueOnce({ success: true, data: { tasks: [], nextCursor: null } });
    await expect(opsCaller().listEngineTasks({ limit: 25 }))
      .resolves.toEqual({ ok: true, tasks: [], nextCursor: null });
    expect(listTasks).toHaveBeenCalledWith({ limit: 25, cursor: undefined });
  });

  it('rejects an anonymous caller before reading lifecycle state', async () => {
    await expect(publicCaller().listEngineTasks({ limit: 20 }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(listTasks).not.toHaveBeenCalled();
  });
});
