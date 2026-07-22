import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/OfflineActionReconciliationService', () => ({
  reconcileOfflineActions: vi.fn(),
}));
vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { router } from '../../src/trpc.js';
import { TaskOfflineSyncProcedures } from '../../src/routers/TaskOfflineSyncProcedures.js';
import { reconcileOfflineActions } from '../../src/services/OfflineActionReconciliationService.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const procedures = router({ ...TaskOfflineSyncProcedures });
const reconcile = vi.mocked(reconcileOfflineActions);

function caller(authenticated = true) {
  return procedures.createCaller({
    user: authenticated ? {
      id: USER_ID, email: 'participant@example.com', full_name: 'Participant',
      default_mode: 'worker', account_status: 'ACTIVE', is_minor: false,
    } as any : null,
    firebaseUid: authenticated ? 'firebase-participant' : null,
  });
}

const probe = {
  actionClass: 'SAFETY' as const,
  clientIdentity: '11111111-1111-4111-8111-111111111111',
  clientSequence: 100,
  priorServerVersion: 3,
  localOccurredAt: '2026-07-20T12:00:00.000Z',
  payloadHash: 'a'.repeat(64),
};

describe('task offline reconciliation router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reconcile.mockResolvedValue({ taskId: TASK_ID, actions: [] } as any);
  });

  it('binds reconciliation to the authenticated actor and forwards strict probes', async () => {
    await caller().reconcileOfflineActions({ taskId: TASK_ID, actions: [probe] });
    expect(reconcile).toHaveBeenCalledWith({ taskId: TASK_ID, actions: [probe] }, USER_ID);
  });

  it('allows a lifecycle-only check with no local actions', async () => {
    await caller().reconcileOfflineActions({ taskId: TASK_ID, actions: [] });
    expect(reconcile).toHaveBeenCalledWith({ taskId: TASK_ID, actions: [] }, USER_ID);
  });

  it.each([
    ['bad identity', { ...probe, clientIdentity: 'contains spaces' }],
    ['zero sequence', { ...probe, clientSequence: 0 }],
    ['zero prior version', { ...probe, priorServerVersion: 0 }],
    ['future-invalid time', { ...probe, localOccurredAt: 'not-a-time' }],
    ['uppercase hash', { ...probe, payloadHash: 'A'.repeat(64) }],
    ['unknown field', { ...probe, actorId: USER_ID }],
  ])('rejects a probe with %s', async (_label, invalid) => {
    await expect(caller().reconcileOfflineActions({ taskId: TASK_ID, actions: [invalid] as any }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects more than ten probes', async () => {
    await expect(caller().reconcileOfflineActions({
      taskId: TASK_ID,
      actions: Array.from({ length: 11 }, (_, index) => ({ ...probe, clientSequence: index + 1 })),
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('requires authentication', async () => {
    await expect(caller(false).reconcileOfflineActions({ taskId: TASK_ID, actions: [] }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
