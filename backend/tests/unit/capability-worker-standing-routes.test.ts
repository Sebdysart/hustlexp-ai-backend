import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getDeactivation: vi.fn(),
  openDeactivation: vi.fn(),
  getStanding: vi.fn(),
  listPending: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/services/WorkerStandingAppealService.js', () => ({
  getDeactivationAppealByToken: mocks.getDeactivation,
  openDeactivationAppeal: mocks.openDeactivation,
  addDeactivationAppealEvidence: vi.fn(),
  getMyWorkerStanding: mocks.getStanding,
  openProgressionAppeal: vi.fn(),
  addProgressionAppealEvidence: vi.fn(),
  listPendingWorkerStandingAppeals: mocks.listPending,
  resolveWorkerStandingAppeal: mocks.resolve,
}));

import { router } from '../../src/trpc.js';
import { capabilityWorkerStandingProcedures } from '../../src/routers/capabilityWorkerStandingRoutes.js';

const standingRouter = router(capabilityWorkerStandingProcedures);
const token = 'A'.repeat(48);
const worker = {
  id: '11111111-1111-4111-8111-111111111111', default_mode: 'worker',
  is_minor: false, is_banned: false, account_status: 'ACTIVE', is_admin: false,
};
const admin = {
  id: '22222222-2222-4222-8222-222222222222', default_mode: 'poster',
  is_minor: false, is_banned: false, account_status: 'ACTIVE', is_admin: true,
};

describe('worker standing capability routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows the narrow deactivation token route without admitting a user session', async () => {
    mocks.getDeactivation.mockResolvedValue({ decision: { id: 'decision-1' } });
    const caller = standingRouter.createCaller({ user: null, firebaseUid: null, ip: '127.0.0.1' });
    await expect(caller.getDeactivationAppeal({ token })).resolves.toEqual({ decision: { id: 'decision-1' } });
    expect(mocks.getDeactivation).toHaveBeenCalledWith(token);
  });

  it('keeps progression records behind the active Hustler boundary', async () => {
    const anonymous = standingRouter.createCaller({ user: null, firebaseUid: null, ip: null });
    await expect(anonymous.getMyWorkerStanding()).rejects.toThrow('Authentication required');
    const poster = standingRouter.createCaller({ user: { ...worker, default_mode: 'poster' } as any, firebaseUid: 'poster', ip: null });
    await expect(poster.getMyWorkerStanding()).rejects.toThrow('Hustler access required');
    mocks.getStanding.mockResolvedValue({ currentTier: 2 });
    const hustler = standingRouter.createCaller({ user: worker as any, firebaseUid: 'worker', ip: null });
    await expect(hustler.getMyWorkerStanding()).resolves.toEqual({ currentTier: 2 });
  });

  it('requires current trust capability before exposing or deciding the human queue', async () => {
    const caller = standingRouter.createCaller({ user: admin as any, firebaseUid: 'admin', ip: null });
    mocks.query.mockResolvedValueOnce({ rows: [{ role: 'moderator', capability_granted: false }] });
    await expect(caller.listPendingWorkerStandingAppeals({ limit: 10 })).rejects.toThrow('Required administrator capability missing');
    mocks.query.mockResolvedValueOnce({ rows: [{ role: 'moderator', capability_granted: true }] });
    mocks.listPending.mockResolvedValue([]);
    await expect(caller.listPendingWorkerStandingAppeals({ limit: 10 })).resolves.toEqual([]);
    expect(mocks.listPending).toHaveBeenCalledWith(10);
  });
});
