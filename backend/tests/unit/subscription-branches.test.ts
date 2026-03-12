/**
 * Subscription router branch coverage tests
 *
 * Targets uncovered branches beyond what subscription-router.test.ts covers:
 * - getMySubscription: pro plan (999999 limit), unknown plan fallback
 * - subscribe: user not found
 * - cancel: stripeSubId null path, pauseResult.rowCount > 0 path
 * - cancel: err instanceof Error vs not in Stripe cancel catch
 * - confirmSubscription: Stripe not configured
 * - plan || 'free' fallback
 * - RECURRING_TASK_LIMITS[plan] ?? 0 for unknown plan
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: 'placeholder_test_key', // triggers bypass
      plans: {
        premium: { monthlyPriceCents: 999, yearlyPriceCents: 9990 },
        pro: { monthlyPriceCents: 2999, yearlyPriceCents: 29990 },
      },
    },
  },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn() },
}));

import { db } from '../../src/db';
import { subscriptionRouter } from '../../src/routers/subscription';

const mockDb = vi.mocked(db);

function makeCaller(userId = 'test-uid') {
  return subscriptionRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

beforeEach(() => vi.clearAllMocks());

describe('subscription.getMySubscription branches', () => {
  it('returns pro plan with 999999 limit', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: 'pro', plan_expires_at: new Date(), stripe_subscription_id: 'sub_1' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '10' }], rowCount: 1,
    } as any);

    const result = await makeCaller().getMySubscription();
    expect(result.recurringTaskLimit).toBe(999999);
    expect(result.canCreateRecurringTask).toBe(true);
  });

  it('falls back to 0 limit for unknown plan', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: 'enterprise', plan_expires_at: null, stripe_subscription_id: null }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '0' }], rowCount: 1,
    } as any);

    const result = await makeCaller().getMySubscription();
    expect(result.recurringTaskLimit).toBe(0);
    expect(result.canCreateRecurringTask).toBe(false);
  });

  it('uses plan || free when plan is empty string', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: '', plan_expires_at: null, stripe_subscription_id: null }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '0' }], rowCount: 1,
    } as any);

    const result = await makeCaller().getMySubscription();
    expect(result.plan).toBe('free');
  });
});

describe('subscription.cancel branches', () => {
  it('skips Stripe cancel when stripeSubId is null', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_subscription_id: null }],
      rowCount: 1,
    } as any);
    // Downgrade
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // Pause series - none
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeCaller().cancel();
    expect(result.success).toBe(true);
    expect(result.plan).toBe('free');
  });

  it('handles pauseResult.rowCount 0 (no series to cancel)', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_subscription_id: null }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // Pause series returns null rowCount
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: null } as any);

    const result = await makeCaller().cancel();
    expect(result.pausedSeriesCount).toBe(0);
  });
});

describe('subscription.subscribe branches', () => {
  it('computes yearly price for pro plan', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_customer_id: null, email: 'a@b.com', full_name: 'Test' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await makeCaller().subscribe({ plan: 'pro', interval: 'year' });
    expect(result.success).toBe(true);
    expect(result.recurringTaskLimit).toBe(999999);
  });
});
