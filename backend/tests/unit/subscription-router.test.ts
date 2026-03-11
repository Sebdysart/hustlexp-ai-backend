/**
 * Subscription Router Unit Tests
 *
 * Tests tRPC procedures on the subscription router:
 * - getMySubscription (protected, query)
 * - subscribe (protected, mutation) — Stripe bypass path
 * - cancel (protected, mutation) — Stripe bypass path
 * - confirmSubscription (protected, mutation)
 *
 * Note: Stripe is mocked at config level (secretKey = 'placeholder') so
 * the router takes the non-Stripe path for subscribe and cancel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
      secretKey: 'placeholder_test_key',
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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { subscriptionRouter } from '../../src/routers/subscription';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(userId = 'test-uid') {
  return subscriptionRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscription.getMySubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns subscription status for free user', async () => {
    // User query
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: 'free', plan_expires_at: null, stripe_subscription_id: null }],
      rowCount: 1,
    } as any);
    // Recurring task count
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '0' }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getMySubscription();

    expect(result.plan).toBe('free');
    expect(result.recurringTaskCount).toBe(0);
    expect(result.recurringTaskLimit).toBe(0);
    expect(result.canCreateRecurringTask).toBe(false);
  });

  it('returns subscription status for premium user', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: 'premium', plan_expires_at: new Date(), stripe_subscription_id: 'sub_123' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '2' }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getMySubscription();

    expect(result.plan).toBe('premium');
    expect(result.recurringTaskCount).toBe(2);
    expect(result.recurringTaskLimit).toBe(5);
    expect(result.canCreateRecurringTask).toBe(true);
  });

  it('returns canCreateRecurringTask=false when at limit', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: 'premium', plan_expires_at: new Date(), stripe_subscription_id: 'sub_123' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '5' }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getMySubscription();

    expect(result.canCreateRecurringTask).toBe(false);
  });

  it('throws NOT_FOUND when user not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(makeCaller().getMySubscription()).rejects.toThrow('User not found');
  });

  it('defaults to free plan when plan is null', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: null, plan_expires_at: null, stripe_subscription_id: null }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '0' }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getMySubscription();

    expect(result.plan).toBe('free');
    expect(result.recurringTaskLimit).toBe(0);
  });
});

describe('subscription.subscribe (Stripe bypass)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('subscribes to premium monthly (no real Stripe)', async () => {
    // User lookup
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_customer_id: null, email: 'test@test.com', full_name: 'Test' }],
      rowCount: 1,
    } as any);
    // Update user with plan
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await makeCaller().subscribe({ plan: 'premium', interval: 'month' });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('premium');
    expect(result.recurringTaskLimit).toBe(5);
    expect(result.clientSecret).toBeNull();
    expect(result.subscriptionId).toBeNull();
  });

  it('subscribes to pro yearly (no real Stripe)', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_customer_id: 'cus_123', email: 'test@test.com', full_name: 'Test' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await makeCaller().subscribe({ plan: 'pro', interval: 'year' });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.recurringTaskLimit).toBe(999999);
  });

  it('throws NOT_FOUND when user not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().subscribe({ plan: 'premium', interval: 'month' })
    ).rejects.toThrow('User not found');
  });

  it('rejects invalid plan', async () => {
    await expect(
      makeCaller().subscribe({ plan: 'invalid' as any, interval: 'month' })
    ).rejects.toThrow();
  });
});

describe('subscription.cancel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancels subscription and downgrades to free', async () => {
    // User lookup
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_subscription_id: 'sub_placeholder' }],
      rowCount: 1,
    } as any);
    // Downgrade to free
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // Pause recurring task series (none found)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeCaller().cancel();

    expect(result.success).toBe(true);
    expect(result.plan).toBe('free');
    expect(result.recurringTaskLimit).toBe(0);
    expect(result.pausedSeriesCount).toBe(0);
  });

  it('pauses active recurring series and cancels occurrences', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_subscription_id: null }],
      rowCount: 1,
    } as any);
    // Downgrade
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // Pause series - 2 found
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'series-1' }, { id: 'series-2' }],
      rowCount: 2,
    } as any);
    // Cancel occurrences
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 3 } as any);

    const result = await makeCaller().cancel();

    expect(result.pausedSeriesCount).toBe(2);
    // Should have called cancel occurrences with series IDs
    const cancelCall = (mockDb.query as any).mock.calls[3];
    expect(cancelCall[1]).toEqual([['series-1', 'series-2']]);
  });

  it('throws NOT_FOUND when user not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(makeCaller().cancel()).rejects.toThrow('User not found');
  });
});

describe('subscription.confirmSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws INTERNAL_SERVER_ERROR when Stripe not configured (placeholder key)', async () => {
    // With placeholder key, the router skips Stripe logic and throws
    await expect(
      makeCaller().confirmSubscription({ stripeSubscriptionId: 'sub_123' })
    ).rejects.toThrow('Stripe is not configured');
  });
});
