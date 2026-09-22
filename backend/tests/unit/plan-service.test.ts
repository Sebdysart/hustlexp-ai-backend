import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));
import { db } from '../../src/db.js';
import { PlanService } from '../../src/services/PlanService.js';
const query = vi.mocked(db.query);
beforeEach(() => { vi.resetAllMocks(); });

describe('disabled subscription plan authority', () => {
  it.each(['premium', 'pro', 'free'])('does not grant legacy %s subscription authority', async (plan) => {
    query.mockResolvedValue({ rows: [{ plan, plan_expires_at: new Date(Date.now() + 86400000) }], rowCount: 1 });
    expect(await PlanService.getUserPlan('user')).toBe('free');
    expect(await PlanService.hasLiveTrackingAccess('user')).toBe(false);
    expect(await PlanService.canReceiveProgressEvent('user', 'TRAVELING')).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it('preserves basic progress visibility and low risk task creation', async () => {
    expect(await PlanService.canReceiveProgressEvent('user', 'POSTED')).toBe(true);
    expect(await PlanService.canCreateTaskWithRisk('user', 'LOW')).toEqual({ allowed: true });
  });
  it('preserves expiration-bound preexisting one-off entitlements', async () => {
    query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    expect(await PlanService.hasActiveEntitlement('user', 'HIGH')).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('expires_at > NOW()'), ['user', 'HIGH']);
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await PlanService.hasActiveEntitlement('user', 'HIGH')).toBe(false);
  });
  it.each(['HIGH', 'IN_HOME'] as const)('denies %s creation without an actual entitlement', async (risk) => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await PlanService.canCreateTaskWithRisk('user', risk)).toMatchObject({ allowed: false });
    query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    expect(await PlanService.canCreateTaskWithRisk('user', risk)).toEqual({ allowed: true });
  });
  it('does not treat historical worker plan=pro as a risk entitlement', async () => {
    query.mockResolvedValueOnce({ rows: [{ plan: 'pro', trust_tier: 3, trust_hold: false }], rowCount: 1 });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await PlanService.canAcceptTaskWithRisk('worker', 'HIGH')).toMatchObject({ allowed: false });
  });
  it.each([{ trust_tier: 3, trust_hold: false, allowed: true },
    { trust_tier: 2, trust_hold: false, allowed: false }, { trust_tier: 3, trust_hold: true, allowed: false }])(
    'retains trust requirements with a verified entitlement: %o', async ({ trust_tier, trust_hold, allowed }) => {
      query.mockResolvedValueOnce({ rows: [{ plan: 'free', trust_tier, trust_hold }], rowCount: 1 });
      query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
      expect(await PlanService.canAcceptTaskWithRisk('worker', 'HIGH')).toMatchObject({ allowed });
    });
  it('denies missing workers', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await PlanService.canAcceptTaskWithRisk('missing', 'LOW')).toMatchObject({ allowed: false });
  });
});
