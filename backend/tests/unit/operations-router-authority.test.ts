import { beforeEach, describe, expect, it, vi } from 'vitest';

const operations = vi.hoisted(() => ({
  list: vi.fn(), getDetail: vi.fn(), getModelHealth: vi.fn(), claim: vi.fn(),
  release: vi.fn(), scheduleNotificationRecovery: vi.fn(), cancelNotificationRecovery: vi.fn(),
}));
const aiObservability = vi.hoisted(() => ({
  list: vi.fn(), getDetail: vi.fn(),
}));

vi.mock('../../src/services/OperationsExceptionService', () => ({
  OperationsExceptionService: operations,
  operationsPriorityClasses: ['SAFETY', 'MONEY', 'ACTIVE_TASK', 'SLA', 'TRUST', 'COMMUNICATION', 'DATA'],
}));
vi.mock('../../src/services/AIObservabilityService', () => ({
  AIObservabilityService: aiObservability,
}));
vi.mock('../../src/db', () => ({ db: { query: vi.fn(), transaction: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/cache/redis', () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
  authLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import operationsRouter from '../../src/routers/operations';
import { db } from '../../src/db';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const mockDb = vi.mocked(db);

function caller(isAdmin: boolean) {
  return operationsRouter.createCaller({
    user: {
      id: USER_ID, is_admin: isAdmin, is_banned: false,
      account_status: 'ACTIVE', default_mode: 'poster',
    },
    firebaseUid: 'firebase-operations',
  } as any);
}

describe('Operations router least privilege', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockReset();
    operations.list.mockResolvedValue([]);
    aiObservability.list.mockResolvedValue([]);
    aiObservability.getDetail.mockResolvedValue({ observationId: 'observation-1' });
  });

  it('rejects an ordinary authenticated user before capability lookup', async () => {
    await expect(caller(false).listExceptions({})).rejects.toThrow('Administrator access required');
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(operations.list).not.toHaveBeenCalled();
  });

  it('rejects staff without can_manage_operations', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ role: 'support', capability_granted: false }], rowCount: 1,
    } as any);
    await expect(caller(true).listExceptions({})).rejects.toThrow('Required administrator capability missing');
    expect(String(mockDb.query.mock.calls[0]![0])).toContain('can_manage_operations');
    expect(operations.list).not.toHaveBeenCalled();
  });

  it('allows explicitly capable staff and forwards only normalized input', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ role: 'support', capability_granted: true }], rowCount: 1,
    } as any);
    await expect(caller(true).listExceptions({ priorityClass: 'SAFETY' })).resolves.toEqual([]);
    expect(operations.list).toHaveBeenCalledWith({
      priorityClass: 'SAFETY', ownership: 'ALL', sort: 'PRIORITY', limit: 50, offset: 0,
    }, USER_ID);
  });

  it('retains explicit admin/founder break-glass authority', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ role: 'admin', capability_granted: false }], rowCount: 1,
    } as any);
    await expect(caller(true).listExceptions({})).resolves.toEqual([]);
    expect(operations.list).toHaveBeenCalledTimes(1);
  });

  it('capability-gates the immutable AI activity ledger', async () => {
    await expect(caller(false).listAIActivity({})).rejects.toThrow('Administrator access required');
    expect(aiObservability.list).not.toHaveBeenCalled();

    mockDb.query.mockResolvedValueOnce({
      rows: [{ role: 'support', capability_granted: true }], rowCount: 1,
    } as any);
    await expect(caller(true).listAIActivity({ executionResult: 'FAILED' })).resolves.toEqual([]);
    expect(aiObservability.list).toHaveBeenCalledWith({
      executionResult: 'FAILED', limit: 50, offset: 0,
    });
  });

  it('passes authenticated operator identity and explicit purpose into detail access logging', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ role: 'support', capability_granted: true }], rowCount: 1,
    } as any);
    const purpose = 'Investigate model evidence and realized outcome attribution.';
    await caller(true).getAIObservationDetail({
      observationId: '22222222-2222-4222-8222-222222222222', purpose,
    });
    expect(aiObservability.getDetail).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222', purpose, USER_ID,
    );
  });
});
