/**
 * Subscription Router Unit Tests
 *
 * Tests tRPC procedures on the subscription router:
 * - getMySubscription (protected, query)
 * - cancel (protected, mutation) — Stripe bypass path
 * - structural containment of legacy positive writers
 *
 * Stripe client and breaker access are mocked explicitly so cancellation
 * recovery can prove unavailable, failed, and confirmed provider outcomes.
 */

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { enableControlledStripePaymentTestCohortV7 } from '../helpers/payment-underwriting-v7';

const stripeMocks = vi.hoisted(() => {
  const cancelSubscription = vi.fn();
  const retrieveSubscription = vi.fn();
  return {
    cancelSubscription,
    retrieveSubscription,
    getSharedStripe: vi.fn(
      (): {
        subscriptions: {
          cancel: typeof cancelSubscription;
          retrieve: typeof retrieveSubscription;
        };
      } | null => null,
    ),
    execute: vi.fn(async (work: () => Promise<unknown>) => work()),
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
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

vi.mock('../../src/lib/stripe-client.js', () => ({
  getSharedStripe: stripeMocks.getSharedStripe,
}));

vi.mock('../../src/middleware/circuit-breaker.js', () => ({
  stripeBreaker: { execute: stripeMocks.execute },
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
  stripeMocks.cancelSubscription.mockReset();
  stripeMocks.retrieveSubscription.mockReset();
  stripeMocks.getSharedStripe.mockReset();
  stripeMocks.getSharedStripe.mockReturnValue(null);
  stripeMocks.execute.mockReset();
  stripeMocks.execute.mockImplementation(async (work: () => Promise<unknown>) => work());
  enableControlledStripePaymentTestCohortV7();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(userId = 'test-uid') {
  return subscriptionRouter.createCaller({
    user: { id: userId, default_mode: 'poster' } as any,
    firebaseUid: 'fb-uid',
  });
}

function makeLegacyCaller(userId = 'test-uid') {
  return legacySubscriptionRouter.createCaller({
    user: { id: userId, default_mode: 'poster' } as any,
    firebaseUid: 'fb-uid',
  });
}

type CancellationEventStatus =
  | 'CANCELLATION_PENDING'
  | 'PROVIDER_FAILED'
  | 'CANCELLATION_UNCERTAIN'
  | 'CANCELLED_CONFIRMED';

type CancellationHarnessOptions = {
  externalSubscriptionId?: string | null;
  userExists?: boolean;
  events?: Array<{
    operation_id: string;
    status: CancellationEventStatus;
    error_code?: string;
  }>;
  pausedSeriesIds?: string[];
  pauseRowCountNull?: boolean;
  failConfirmedInsertOnce?: boolean;
};

function installCancellationHarness(options: CancellationHarnessOptions = {}) {
  let externalSubscriptionId = options.externalSubscriptionId ?? null;
  let failConfirmedInsertOnce = options.failConfirmedInsertOnce ?? false;
  const events = [...(options.events ?? [])];
  const calls: Array<[string, unknown[] | undefined]> = [];
  const operationId = '10000000-0000-4000-8000-000000000001';
  let transactionTail = Promise.resolve();

  const query = vi.fn(async (sqlValue: string, params?: unknown[]) => {
    const sql = String(sqlValue);
    calls.push([sql, params]);

    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    }
    if (sql.includes('SELECT stripe_subscription_id') && sql.includes('FOR UPDATE')) {
      return options.userExists === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ stripe_subscription_id: externalSubscriptionId }], rowCount: 1 };
    }
    if (sql.includes('SELECT operation_id, status')) {
      const latest = events.at(-1);
      return latest ? { rows: [latest], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("'CANCELLATION_PENDING'") && sql.includes('RETURNING operation_id')) {
      events.push({ operation_id: operationId, status: 'CANCELLATION_PENDING' });
      return { rows: [{ operation_id: operationId }], rowCount: 1 };
    }
    if (sql.includes("'PROVIDER_FAILED'")) {
      const [eventOperationId, , , errorCode] = params ?? [];
      events.push({
        operation_id: String(eventOperationId),
        status: 'PROVIDER_FAILED',
        error_code: String(errorCode),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("'CANCELLATION_UNCERTAIN'")) {
      const [eventOperationId, , , errorCode] = params ?? [];
      events.push({
        operation_id: String(eventOperationId),
        status: 'CANCELLATION_UNCERTAIN',
        error_code: String(errorCode),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("'CANCELLED_CONFIRMED'")) {
      if (failConfirmedInsertOnce) {
        failConfirmedInsertOnce = false;
        throw new Error('simulated database failure after provider success');
      }
      const [eventOperationId] = params ?? [];
      if (!events.some(
        (event) => event.operation_id === eventOperationId && event.status === 'CANCELLED_CONFIRMED',
      )) {
        events.push({
          operation_id: String(eventOperationId),
          status: 'CANCELLED_CONFIRMED',
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE users') && sql.includes('stripe_subscription_id = NULL')) {
      const expectedExternalSubscriptionId = params?.[1] ?? null;
      if (externalSubscriptionId !== expectedExternalSubscriptionId) {
        return { rows: [], rowCount: 0 };
      }
      externalSubscriptionId = null;
      return { rows: [{ id: 'test-uid' }], rowCount: 1 };
    }
    if (sql.includes('UPDATE recurring_task_series')) {
      const rows = (options.pausedSeriesIds ?? []).map((id) => ({ id }));
      return { rows, rowCount: options.pauseRowCountNull ? null : rows.length };
    }
    if (sql.includes('UPDATE recurring_task_occurrences')) {
      return { rows: [], rowCount: options.pausedSeriesIds?.length ?? 0 };
    }
    throw new Error(`Unexpected cancellation SQL: ${sql}`);
  });

  mockDb.transaction.mockImplementation(async (work: any) => {
    let releaseTransaction!: () => void;
    const priorTransaction = transactionTail;
    transactionTail = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await priorTransaction;
    const referenceSnapshot = externalSubscriptionId;
    const eventCountSnapshot = events.length;
    try {
      return await work(query);
    } catch (error) {
      externalSubscriptionId = referenceSnapshot;
      events.splice(eventCountSnapshot);
      throw error;
    } finally {
      releaseTransaction();
    }
  });

  return {
    calls,
    events,
    operationId,
    query,
    externalSubscriptionId: () => externalSubscriptionId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscription production registration', () => {
  const procedures = subscriptionRouter._def.procedures as Record<string, unknown>;

  it('registers only the read and exact cancellation-recovery procedures', () => {
    expect(Object.keys(procedures).sort()).toEqual(['cancel', 'getMySubscription']);
  });

  it.each(['subscribe', 'confirmSubscription'])(
    'does not register legacy positive writer %s',
    (name) => {
      expect(procedures).not.toHaveProperty(name);
    },
  );
});

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
    expect(result.canCreateRecurringTask).toBe(false);
    expect(result.recurringTaskCreationHeldReason).toBe('CONTROLLED_V2_AUTHORITY_REQUIRED');
  });

  it('does not infer recurrence authority from legacy plan capacity', async () => {
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
    expect(result.recurringTaskCreationHeldReason).toBe('CONTROLLED_V2_AUTHORITY_REQUIRED');
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

  it('fails closed in production before reading or changing subscription state', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');

    await expect(
      makeLegacyCaller().subscribe({ plan: 'premium', interval: 'month' })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('No new charge was created'),
      cause: { applicationCode: 'PAYMENT_CREATION_FROZEN' },
    });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('subscribes to premium monthly (no real Stripe)', async () => {
    // User lookup
    mockDb.query.mockResolvedValueOnce({
      rows: [{ stripe_customer_id: null, email: 'test@test.com', full_name: 'Test' }],
      rowCount: 1,
    } as any);
    // Update user with plan
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await makeLegacyCaller().subscribe({ plan: 'premium', interval: 'month' });

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

    const result = await makeLegacyCaller().subscribe({ plan: 'pro', interval: 'year' });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.recurringTaskLimit).toBe(999999);
  });

  it('throws NOT_FOUND when user not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeLegacyCaller().subscribe({ plan: 'premium', interval: 'month' })
    ).rejects.toThrow('User not found');
  });

  it('rejects invalid plan', async () => {
    await expect(
      makeLegacyCaller().subscribe({ plan: 'invalid' as any, interval: 'month' })
    ).rejects.toThrow();
  });
});

describe('subscription.cancel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists a retryable operation and retains the reference when the client is missing', async () => {
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_missing_client',
    });

    await expect(makeCaller().cancel()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Subscription cancellation is pending provider recovery',
    });

    expect(stripeMocks.cancelSubscription).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      { operation_id: harness.operationId, status: 'CANCELLATION_PENDING' },
      {
        operation_id: harness.operationId,
        status: 'PROVIDER_FAILED',
        error_code: 'STRIPE_CLIENT_UNAVAILABLE',
      },
    ]);
    expect(harness.externalSubscriptionId()).toBe('sub_missing_client');
    expect(harness.calls.some(([sql]) => sql.includes('stripe_subscription_id = NULL'))).toBe(false);
  });

  it('retains the reference when provider retrieval is uncertain', async () => {
    stripeMocks.getSharedStripe.mockReturnValue({
      subscriptions: {
        cancel: stripeMocks.cancelSubscription,
        retrieve: stripeMocks.retrieveSubscription,
      },
    });
    stripeMocks.retrieveSubscription.mockRejectedValueOnce(new Error('provider unavailable'));
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_retrieval_uncertain',
    });

    await expect(makeCaller().cancel()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Subscription cancellation is pending provider recovery',
    });

    expect(stripeMocks.cancelSubscription).not.toHaveBeenCalled();
    expect(harness.events.at(-1)).toMatchObject({
      operation_id: harness.operationId,
      status: 'PROVIDER_FAILED',
      error_code: 'STRIPE_RETRIEVAL_FAILED',
    });
    expect(harness.externalSubscriptionId()).toBe('sub_retrieval_uncertain');
  });

  it('reuses a prior provider-failed operation and cancels only after retrieving active state', async () => {
    const priorOperationId = '20000000-0000-4000-8000-000000000001';
    stripeMocks.getSharedStripe.mockReturnValue({
      subscriptions: {
        cancel: stripeMocks.cancelSubscription,
        retrieve: stripeMocks.retrieveSubscription,
      },
    });
    stripeMocks.retrieveSubscription.mockResolvedValueOnce({
      id: 'sub_retry',
      status: 'active',
    });
    stripeMocks.cancelSubscription.mockResolvedValueOnce({
      id: 'sub_retry',
      status: 'canceled',
    });
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_retry',
      events: [{
        operation_id: priorOperationId,
        status: 'PROVIDER_FAILED',
        error_code: 'STRIPE_RETRIEVAL_FAILED',
      }],
    });

    const result = await makeCaller().cancel();

    expect(result.success).toBe(true);
    expect(stripeMocks.retrieveSubscription).toHaveBeenCalledWith('sub_retry');
    expect(stripeMocks.cancelSubscription).toHaveBeenCalledWith('sub_retry');
    expect(harness.events.filter((event) => event.status === 'CANCELLATION_PENDING')).toHaveLength(0);
    expect(harness.events.at(-1)).toMatchObject({
      operation_id: priorOperationId,
      status: 'CANCELLED_CONFIRMED',
    });
    const confirmedInsert = harness.calls.find(([sql]) =>
      sql.includes("VALUES ($1, $2, 'stripe', $3, 'CANCELLED_CONFIRMED')"),
    );
    expect(confirmedInsert?.[0]).toContain(
      "ON CONFLICT (operation_id) WHERE status = 'CANCELLED_CONFIRMED' DO NOTHING",
    );
    expect(harness.externalSubscriptionId()).toBeNull();
  });

  it('recovers a crash after provider success without repeating provider cancellation', async () => {
    const priorOperationId = '30000000-0000-4000-8000-000000000001';
    stripeMocks.getSharedStripe.mockReturnValue({
      subscriptions: {
        cancel: stripeMocks.cancelSubscription,
        retrieve: stripeMocks.retrieveSubscription,
      },
    });
    stripeMocks.retrieveSubscription
      .mockResolvedValueOnce({ id: 'sub_crash', status: 'active' })
      .mockResolvedValueOnce({ id: 'sub_crash', status: 'canceled' });
    stripeMocks.cancelSubscription.mockResolvedValueOnce({
      id: 'sub_crash',
      status: 'canceled',
    });
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_crash',
      events: [{ operation_id: priorOperationId, status: 'CANCELLATION_PENDING' }],
      failConfirmedInsertOnce: true,
    });

    await expect(makeCaller().cancel()).rejects.toThrow(
      'simulated database failure after provider success',
    );
    expect(harness.externalSubscriptionId()).toBe('sub_crash');
    expect(harness.events).toEqual([
      { operation_id: priorOperationId, status: 'CANCELLATION_PENDING' },
    ]);

    const recovered = await makeCaller().cancel();

    expect(recovered.success).toBe(true);
    expect(stripeMocks.retrieveSubscription).toHaveBeenCalledTimes(2);
    expect(stripeMocks.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(harness.events.at(-1)).toMatchObject({
      operation_id: priorOperationId,
      status: 'CANCELLED_CONFIRMED',
    });
    expect(harness.externalSubscriptionId()).toBeNull();
  });

  it('finalizes a prior confirmed operation without another provider call', async () => {
    const priorOperationId = '40000000-0000-4000-8000-000000000001';
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_already_confirmed',
      events: [{ operation_id: priorOperationId, status: 'CANCELLED_CONFIRMED' }],
    });

    const result = await makeCaller().cancel();

    expect(result.success).toBe(true);
    expect(stripeMocks.getSharedStripe).not.toHaveBeenCalled();
    expect(stripeMocks.retrieveSubscription).not.toHaveBeenCalled();
    expect(stripeMocks.cancelSubscription).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      { operation_id: priorOperationId, status: 'CANCELLED_CONFIRMED' },
    ]);
    expect(harness.externalSubscriptionId()).toBeNull();
  });

  it('serializes concurrent attempts and performs one provider cancellation', async () => {
    stripeMocks.getSharedStripe.mockReturnValue({
      subscriptions: {
        cancel: stripeMocks.cancelSubscription,
        retrieve: stripeMocks.retrieveSubscription,
      },
    });
    stripeMocks.retrieveSubscription.mockResolvedValue({
      id: 'sub_concurrent',
      status: 'active',
    });
    stripeMocks.cancelSubscription.mockResolvedValue({
      id: 'sub_concurrent',
      status: 'canceled',
    });
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_concurrent',
    });

    const [first, second] = await Promise.all([
      makeCaller().cancel(),
      makeCaller().cancel(),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(stripeMocks.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(harness.events.filter((event) => event.status === 'CANCELLATION_PENDING')).toHaveLength(1);
    expect(harness.events.filter((event) => event.status === 'CANCELLED_CONFIRMED')).toHaveLength(1);
    expect(harness.calls.some(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(harness.externalSubscriptionId()).toBeNull();
  });

  it('retains the reference when cancellation and post-error reconciliation are uncertain', async () => {
    stripeMocks.getSharedStripe.mockReturnValue({
      subscriptions: {
        cancel: stripeMocks.cancelSubscription,
        retrieve: stripeMocks.retrieveSubscription,
      },
    });
    stripeMocks.retrieveSubscription
      .mockResolvedValueOnce({ id: 'sub_uncertain', status: 'active' })
      .mockRejectedValueOnce(new Error('reconciliation unavailable'));
    stripeMocks.cancelSubscription.mockRejectedValueOnce(new Error('request timeout'));
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_uncertain',
    });

    await expect(makeCaller().cancel()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Subscription cancellation is pending provider recovery',
    });

    expect(harness.events.at(-1)).toMatchObject({
      status: 'CANCELLATION_UNCERTAIN',
      error_code: 'STRIPE_CANCELLATION_UNCERTAIN',
    });
    const failureInsert = harness.calls.find(([sql]) =>
      sql.includes("VALUES ($1, $2, 'stripe', $3, 'CANCELLATION_UNCERTAIN', $4)"),
    );
    expect(failureInsert?.[0]).not.toContain('ON CONFLICT');
    expect(harness.externalSubscriptionId()).toBe('sub_uncertain');
  });

  it('never reissues an ambiguous cancellation while provider visibility is delayed', async () => {
    stripeMocks.getSharedStripe.mockReturnValue({
      subscriptions: {
        cancel: stripeMocks.cancelSubscription,
        retrieve: stripeMocks.retrieveSubscription,
      },
    });
    stripeMocks.retrieveSubscription
      .mockResolvedValueOnce({ id: 'sub_delayed', status: 'active' })
      .mockResolvedValueOnce({ id: 'sub_delayed', status: 'active' })
      .mockResolvedValueOnce({ id: 'sub_delayed', status: 'active' })
      .mockResolvedValueOnce({ id: 'sub_delayed', status: 'canceled' });
    stripeMocks.cancelSubscription.mockRejectedValueOnce(new Error('response lost'));
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_delayed',
    });

    await expect(makeCaller().cancel()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Subscription cancellation is pending provider recovery',
    });
    expect(harness.events.at(-1)).toMatchObject({
      status: 'CANCELLATION_UNCERTAIN',
      error_code: 'STRIPE_CANCELLATION_UNCONFIRMED',
    });

    stripeMocks.getSharedStripe.mockReturnValueOnce(null);
    await expect(makeCaller().cancel()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Subscription cancellation is pending provider recovery',
    });
    expect(harness.events.at(-1)).toMatchObject({
      status: 'CANCELLATION_UNCERTAIN',
      error_code: 'STRIPE_RECONCILIATION_CLIENT_UNAVAILABLE',
    });
    expect(stripeMocks.cancelSubscription).toHaveBeenCalledTimes(1);

    await expect(makeCaller().cancel()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Subscription cancellation is pending provider recovery',
    });
    expect(harness.events.at(-1)).toMatchObject({
      status: 'CANCELLATION_UNCERTAIN',
      error_code: 'STRIPE_CANCELLATION_AWAITING_CONFIRMATION',
    });
    expect(stripeMocks.cancelSubscription).toHaveBeenCalledTimes(1);

    await expect(makeCaller().cancel()).resolves.toMatchObject({ success: true });
    expect(stripeMocks.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(harness.events.at(-1)).toMatchObject({ status: 'CANCELLED_CONFIRMED' });
    expect(harness.externalSubscriptionId()).toBeNull();
  });

  it('accepts externally observed canceled status after a lost cancellation response', async () => {
    stripeMocks.getSharedStripe.mockReturnValue({
      subscriptions: {
        cancel: stripeMocks.cancelSubscription,
        retrieve: stripeMocks.retrieveSubscription,
      },
    });
    stripeMocks.retrieveSubscription
      .mockResolvedValueOnce({ id: 'sub_lost_response', status: 'active' })
      .mockResolvedValueOnce({ id: 'sub_lost_response', status: 'canceled' });
    stripeMocks.cancelSubscription.mockRejectedValueOnce(new Error('response lost'));
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_lost_response',
    });

    const result = await makeCaller().cancel();

    expect(result.success).toBe(true);
    expect(stripeMocks.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(stripeMocks.retrieveSubscription).toHaveBeenCalledTimes(2);
    expect(harness.events.at(-1)).toMatchObject({ status: 'CANCELLED_CONFIRMED' });
    expect(harness.externalSubscriptionId()).toBeNull();
  });

  it('retains the reference when the provider does not confirm canceled status', async () => {
    stripeMocks.getSharedStripe.mockReturnValue({
      subscriptions: {
        cancel: stripeMocks.cancelSubscription,
        retrieve: stripeMocks.retrieveSubscription,
      },
    });
    stripeMocks.retrieveSubscription.mockResolvedValueOnce({
      id: 'sub_unconfirmed',
      status: 'active',
    });
    stripeMocks.cancelSubscription.mockResolvedValueOnce({
      id: 'sub_unconfirmed',
      status: 'active',
    });
    const harness = installCancellationHarness({
      externalSubscriptionId: 'sub_unconfirmed',
    });

    await expect(makeCaller().cancel()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });

    expect(harness.events.at(-1)).toMatchObject({
      status: 'CANCELLATION_UNCERTAIN',
      error_code: 'STRIPE_CANCELLATION_UNCONFIRMED',
    });
    expect(harness.externalSubscriptionId()).toBe('sub_unconfirmed');
  });

  it('finalizes provider-absent state and pauses recurring work atomically', async () => {
    const harness = installCancellationHarness({
      externalSubscriptionId: null,
      pausedSeriesIds: ['series-1', 'series-2'],
    });

    const result = await makeCaller().cancel();

    expect(result.pausedSeriesCount).toBe(2);
    expect(stripeMocks.getSharedStripe).not.toHaveBeenCalled();
    const occurrenceCall = harness.calls.find(([sql]) =>
      sql.includes('UPDATE recurring_task_occurrences'),
    );
    expect(occurrenceCall?.[1]).toEqual([['series-1', 'series-2']]);
  });

  it('normalizes a defensive null pause row count to zero', async () => {
    installCancellationHarness({
      externalSubscriptionId: null,
      pauseRowCountNull: true,
    });

    await expect(makeCaller().cancel()).resolves.toMatchObject({
      success: true,
      pausedSeriesCount: 0,
    });
  });

  it('throws NOT_FOUND when user not found', async () => {
    installCancellationHarness({ userExists: false });

    await expect(makeCaller().cancel()).rejects.toThrow('User not found');
  });
});

describe('subscription.confirmSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks a newly presented subscription while frozen before database or provider work', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENGINE_API_MODE', 'production');
    vi.stubEnv('STRIPE_MODE', 'live');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_forbidden');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'enabled');
    await expect(
      makeLegacyCaller().confirmSubscription({ stripeSubscriptionId: 'sub_forbidden' })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { applicationCode: 'PAYMENT_CREATION_FROZEN' },
    });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('throws INTERNAL_SERVER_ERROR when Stripe not configured (placeholder key)', async () => {
    // With placeholder key, the router skips Stripe logic and throws
    await expect(
      makeLegacyCaller().confirmSubscription({ stripeSubscriptionId: 'sub_123' })
    ).rejects.toThrow('Stripe is not configured');
  });
});
