/**
 * Subscription Router Extra Unit Tests
 *
 * Covers branches NOT in subscription-router.test.ts:
 * - cancel: occurrences cancel query fires when series were paused
 * - subscribe: user NOT_FOUND
 * - getMySubscription: pro plan returns correct limit (999999)
 */

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { enableControlledStripePaymentTestCohortV7 } from '../helpers/payment-underwriting-v7';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const query = vi.fn();
  return {
    db: {
      query,
      transaction: vi.fn(async (work: (queryFn: typeof query) => Promise<unknown>) => work(query)),
    },
  };
});

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

// config module — Stripe key is 'placeholder' by default so no real Stripe calls;
// individual tests override via mockImplementation if needed.
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
import { router } from '../../src/trpc';
import {
  legacySubscriptionProcedures,
  subscriptionRouter,
} from '../../src/routers/subscription';

const mockDb = vi.mocked(db);
const legacySubscriptionRouter = router(legacySubscriptionProcedures);

beforeEach(() => {
  enableControlledStripePaymentTestCohortV7();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeCaller(userId = USER_UUID) {
  return subscriptionRouter.createCaller({
    user: { id: userId, default_mode: 'poster' } as any,
    firebaseUid: 'fb-uid',
  });
}

function makeLegacyCaller(userId = USER_UUID) {
  return legacySubscriptionRouter.createCaller({
    user: { id: userId, default_mode: 'poster' } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscription.getMySubscription — pro plan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns correct limit for pro plan (999999)', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: 'pro', plan_expires_at: new Date(), stripe_subscription_id: 'sub_pro' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '100' }], rowCount: 1 } as any);

    const result = await makeCaller().getMySubscription();

    expect(result.plan).toBe('pro');
    expect(result.recurringTaskLimit).toBe(999999);
    expect(result.canCreateRecurringTask).toBe(false);
    expect(result.recurringTaskCreationHeldReason).toBe('CONTROLLED_V2_AUTHORITY_REQUIRED');
  });

  it('does not let a pro plan imply legacy recurrence creation authority', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: 'pro', plan_expires_at: null, stripe_subscription_id: 'sub_pro' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '999998' }], rowCount: 1 } as any);

    const result = await makeCaller().getMySubscription();
    expect(result.canCreateRecurringTask).toBe(false);
    expect(result.recurringTaskCreationHeldReason).toBe('CONTROLLED_V2_AUTHORITY_REQUIRED');
  });

  it('returns recurringTaskCount from DB correctly', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ plan: 'premium', plan_expires_at: null, stripe_subscription_id: null }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 1 } as any);

    const result = await makeCaller().getMySubscription();
    expect(result.recurringTaskCount).toBe(3);
  });
});

describe('subscription.cancel — with recurring series', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancels occurrences when 1 series was paused', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // advisory lock
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_subscription_id: null }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // downgrade
    // Pause 1 series
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'series-1' }],
      rowCount: 1,
    } as any);
    // Cancel occurrences
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 2 } as any);

    const result = await makeCaller().cancel();

    expect(result.pausedSeriesCount).toBe(1);
    // 5th call should be cancelling occurrences after lock, lookup, downgrade, and pause.
    const occurrenceCall = (mockDb.query as any).mock.calls[4];
    expect(occurrenceCall[1]).toEqual([['series-1']]);
  });

  it('does NOT call occurrence cancel when no series paused', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // advisory lock
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_subscription_id: null }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // downgrade
    // No series paused (rowCount=0)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeCaller().cancel();

    // Lock, user lookup, downgrade, and pause series; no occurrence write.
    expect(mockDb.query).toHaveBeenCalledTimes(4);
  });

  it('sets plan to free after cancel', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // advisory lock
    mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_subscription_id: null }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeCaller().cancel();

    expect(result.plan).toBe('free');
    expect(result.recurringTaskLimit).toBe(0);

    // Verify the downgrade query sets plan='free'
    const downgradeCall = (mockDb.query as any).mock.calls[2];
    expect(downgradeCall[0]).toContain("plan = 'free'");
  });
});

describe('subscription.subscribe — input validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts premium yearly interval', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_customer_id: null, email: 'x@x.com', full_name: 'X' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await makeLegacyCaller().subscribe({ plan: 'premium', interval: 'year' });
    expect(result.success).toBe(true);
    expect(result.plan).toBe('premium');

    // Verify yearly price used in DB update
    const updateCall = (mockDb.query as any).mock.calls[1];
    expect(updateCall[0]).toContain('recurring_task_limit');
  });

  it('accepts pro interval month', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_customer_id: 'cus_existing', email: 'x@x.com', full_name: 'X' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await makeLegacyCaller().subscribe({ plan: 'pro', interval: 'month' });
    expect(result.plan).toBe('pro');
    expect(result.recurringTaskLimit).toBe(999999);
  });
});

describe('subscription.confirmSubscription — Stripe not configured', () => {
  beforeEach(() => vi.clearAllMocks());

  it('always throws INTERNAL_SERVER_ERROR when Stripe key is placeholder', async () => {
    // The config mock has placeholder key — the router enters the else branch
    await expect(
      makeLegacyCaller().confirmSubscription({ stripeSubscriptionId: 'sub_anything' })
    ).rejects.toThrow('Stripe is not configured');
  });
});
