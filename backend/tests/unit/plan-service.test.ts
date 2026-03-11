import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (BEFORE imports) ──────────────────────────────────────────────────
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error ${code}`),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// ── Imports ─────────────────────────────────────────────────────────────────
import { PlanService } from '../../src/services/PlanService';
import { db } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// hasActiveEntitlement
// ═══════════════════════════════════════════════════════════════════════════
describe('PlanService.hasActiveEntitlement', () => {
  it('returns true when an active entitlement exists', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });

    const result = await PlanService.hasActiveEntitlement('user-1', 'MEDIUM');
    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('plan_entitlements'), ['user-1', 'MEDIUM']);
  });

  it('returns false when no active entitlement exists', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await PlanService.hasActiveEntitlement('user-1', 'HIGH');
    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getUserPlan
// ═══════════════════════════════════════════════════════════════════════════
describe('PlanService.getUserPlan', () => {
  it('returns free when user not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const plan = await PlanService.getUserPlan('missing-user');
    expect(plan).toBe('free');
  });

  it('returns the plan when not expired', async () => {
    const future = new Date(Date.now() + 86400000);
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'premium', plan_expires_at: future }] });

    const plan = await PlanService.getUserPlan('user-1');
    expect(plan).toBe('premium');
  });

  it('resets to free when plan is expired', async () => {
    const past = new Date(Date.now() - 86400000);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan: 'premium', plan_expires_at: past }] })
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE

    const plan = await PlanService.getUserPlan('user-1');
    expect(plan).toBe('free');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('returns plan when plan_expires_at is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'pro', plan_expires_at: null }] });

    const plan = await PlanService.getUserPlan('user-1');
    expect(plan).toBe('pro');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// canCreateTaskWithRisk
// ═══════════════════════════════════════════════════════════════════════════
describe('PlanService.canCreateTaskWithRisk', () => {
  it('allows LOW risk for all users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', plan_expires_at: null }] });

    const result = await PlanService.canCreateTaskWithRisk('user-1', 'LOW');
    expect(result.allowed).toBe(true);
  });

  it('allows MEDIUM for premium users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'premium', plan_expires_at: null }] });

    const result = await PlanService.canCreateTaskWithRisk('user-1', 'MEDIUM');
    expect(result.allowed).toBe(true);
  });

  it('allows MEDIUM for free users with entitlement', async () => {
    // getUserPlan
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', plan_expires_at: null }] });
    // hasActiveEntitlement
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });

    const result = await PlanService.canCreateTaskWithRisk('user-1', 'MEDIUM');
    expect(result.allowed).toBe(true);
  });

  it('allows MEDIUM for free users without entitlement but flags requiredPlan', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', plan_expires_at: null }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await PlanService.canCreateTaskWithRisk('user-1', 'MEDIUM');
    expect(result.allowed).toBe(true);
    expect(result.requiredPlan).toBe('premium');
  });

  it('blocks HIGH risk for free users without entitlement', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', plan_expires_at: null }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await PlanService.canCreateTaskWithRisk('user-1', 'HIGH');
    expect(result.allowed).toBe(false);
    expect(result.requiredPlan).toBe('premium');
  });

  it('allows HIGH risk for premium users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'premium', plan_expires_at: null }] });

    const result = await PlanService.canCreateTaskWithRisk('user-1', 'HIGH');
    expect(result.allowed).toBe(true);
  });

  it('allows IN_HOME for premium users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'premium', plan_expires_at: null }] });

    const result = await PlanService.canCreateTaskWithRisk('user-1', 'IN_HOME');
    expect(result.allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// canAcceptTaskWithRisk
// ═══════════════════════════════════════════════════════════════════════════
describe('PlanService.canAcceptTaskWithRisk', () => {
  it('returns not allowed when user not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await PlanService.canAcceptTaskWithRisk('missing', 'LOW');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('User not found');
  });

  it('allows LOW risk for any worker', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', trust_tier: 1, trust_hold: false }] });

    const result = await PlanService.canAcceptTaskWithRisk('user-1', 'LOW');
    expect(result.allowed).toBe(true);
  });

  it('allows MEDIUM risk for any worker', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', trust_tier: 1, trust_hold: false }] });

    const result = await PlanService.canAcceptTaskWithRisk('user-1', 'MEDIUM');
    expect(result.allowed).toBe(true);
  });

  it('allows HIGH risk for pro workers with trust tier 3+', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'pro', trust_tier: 3, trust_hold: false }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // hasActiveEntitlement check

    const result = await PlanService.canAcceptTaskWithRisk('user-1', 'HIGH');
    expect(result.allowed).toBe(true);
  });

  it('blocks HIGH risk for workers with trust hold', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'pro', trust_tier: 3, trust_hold: true }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await PlanService.canAcceptTaskWithRisk('user-1', 'HIGH');
    expect(result.allowed).toBe(false);
  });

  it('blocks HIGH risk for workers below trust tier 3', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'pro', trust_tier: 2, trust_hold: false }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await PlanService.canAcceptTaskWithRisk('user-1', 'HIGH');
    expect(result.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// canReceiveProgressEvent
// ═══════════════════════════════════════════════════════════════════════════
describe('PlanService.canReceiveProgressEvent', () => {
  it('allows all events for premium users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'premium', plan_expires_at: null }] });

    expect(await PlanService.canReceiveProgressEvent('user-1', 'TRAVELING')).toBe(true);
  });

  it('allows POSTED for free users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', plan_expires_at: null }] });

    expect(await PlanService.canReceiveProgressEvent('user-1', 'POSTED')).toBe(true);
  });

  it('blocks TRAVELING for free users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', plan_expires_at: null }] });

    expect(await PlanService.canReceiveProgressEvent('user-1', 'TRAVELING')).toBe(false);
  });

  it('blocks WORKING for free users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', plan_expires_at: null }] });

    expect(await PlanService.canReceiveProgressEvent('user-1', 'WORKING')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// hasLiveTrackingAccess
// ═══════════════════════════════════════════════════════════════════════════
describe('PlanService.hasLiveTrackingAccess', () => {
  it('returns true for premium users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'premium', plan_expires_at: null }] });

    expect(await PlanService.hasLiveTrackingAccess('user-1')).toBe(true);
  });

  it('returns false for free users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'free', plan_expires_at: null }] });

    expect(await PlanService.hasLiveTrackingAccess('user-1')).toBe(false);
  });
});
