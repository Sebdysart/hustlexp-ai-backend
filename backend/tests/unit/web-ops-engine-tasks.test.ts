import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/AutomationLifecycleService', () => ({
  AutomationLifecycleService: { listTasks: vi.fn() },
}));
vi.mock('../../src/db', () => ({ db: { query: vi.fn(), transaction: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { webOpsRouter } from '../../src/routers/web/ops';
import { AutomationLifecycleService } from '../../src/services/AutomationLifecycleService';

const listTasks = vi.mocked(AutomationLifecycleService.listTasks);
const SERVICE_KEY = 'test-ops-admin-key!'; // 18 chars

function caller() {
  return webOpsRouter.createCaller({ user: null, firebaseUid: null, ip: '127.0.0.1' });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENGINE_OPS_ADMIN_KEY = SERVICE_KEY;
  process.env.OPS_ADMIN_KEY = SERVICE_KEY;
});

describe('webOps.listEngineTasks', () => {
  it('returns the canonical bounded lifecycle read for the ops compatibility contract', async () => {
    listTasks.mockResolvedValueOnce({ success: true, data: { tasks: [], nextCursor: null } });
    await expect(caller().listEngineTasks({ adminKey: SERVICE_KEY, limit: 25 }))
      .resolves.toEqual({ ok: true, tasks: [], nextCursor: null });
    expect(listTasks).toHaveBeenCalledWith({ limit: 25, cursor: undefined });
  });

  it('rejects an invalid ops admin key before reading lifecycle state', async () => {
    await expect(caller().listEngineTasks({ adminKey: 'wrong-key-too-short', limit: 20 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listTasks).not.toHaveBeenCalled();
  });
});
