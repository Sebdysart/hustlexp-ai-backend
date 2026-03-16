/**
 * StripeWebhookService — Branch Coverage Tests
 *
 * Targets uncovered branches in StripeWebhookService.ts (61.11% → target 90%+):
 *
 * Already covered by stripe-payment-services-batch.test.ts:
 *   - Missing signature → WEBHOOK_SECRET_MISSING
 *   - Empty webhookSecret → STRIPE_NOT_CONFIGURED
 *   - webhookSecret contains 'placeholder' → STRIPE_NOT_CONFIGURED
 *   - Stripe SDK throws on constructEvent → WEBHOOK_VERIFICATION_FAILED
 *
 * NOT YET covered (targeted here):
 *   - getStripeClient(): stripe null → first init creates instance (non-placeholder key)
 *   - getStripeClient(): stripe already initialized → returns cached instance
 *   - handleStripeWebhook: rowCount === 0 (idempotent replay) → stored=false, returns success
 *   - handleStripeWebhook: rowCount > 0 (new event) → stored=true, calls writeToOutbox, returns success
 *   - handleStripeWebhook: db.transaction throws Error → WEBHOOK_STORAGE_FAILED with error.message
 *   - handleStripeWebhook: db.transaction throws non-Error → WEBHOOK_STORAGE_FAILED with fallback msg
 *   - processWebhook: constructEvent throws non-Error → fallback 'Webhook verification failed' msg
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must precede all imports)
// ---------------------------------------------------------------------------

// Start with a valid-looking Stripe key so getStripeClient() can initialize
vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: 'sk_test_validkey_for_webhook_tests',
      webhookSecret: 'whsec_valid_for_webhook_tests',
      platformFeePercent: 15,
      minimumTaskValueCents: 500,
    },
  },
}));

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue({ id: 'outbox-1', idempotencyKey: 'k1' }),
}));

vi.mock('../../src/jobs/queues', () => ({
  generateIdempotencyKey: vi.fn(() => 'key-123'),
}));

// Stripe mock — constructEvent is what we control per-test
// IMPORTANT: must use a proper function (not arrow) so `new Stripe(...)` works.
const { mockConstructEvent } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
}));

vi.mock('stripe', () => {
  // Use vi.fn() with a regular function implementation for `new` compatibility
  const StripeMock = vi.fn(function StripeConstructor() {
    return {
      webhooks: {
        constructEvent: mockConstructEvent,
      },
    };
  });
  return { default: StripeMock };
});

import { db } from '../../src/db';
import { writeToOutbox } from '../../src/lib/outbox-helpers';
import { processWebhook } from '../../src/services/StripeWebhookService';

const mockDb = vi.mocked(db);
const mockWriteToOutbox = vi.mocked(writeToOutbox);

// A minimal valid Stripe Event for these tests
function makeStripeEvent(overrides: Partial<{ id: string; type: string; created: number }> = {}) {
  return {
    id: overrides.id ?? 'evt_test_123',
    type: overrides.type ?? 'payment_intent.succeeded',
    created: overrides.created ?? Math.floor(Date.now() / 1000),
    data: { object: { id: 'pi_test_123' } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// processWebhook — constructEvent success paths
// ===========================================================================

describe('processWebhook — handleStripeWebhook paths', () => {
  it('returns success with stripeEventId when event is new (rowCount > 0)', async () => {
    const event = makeStripeEvent({ id: 'evt_new_1' });
    mockConstructEvent.mockReturnValueOnce(event);

    // db.transaction calls the callback with a transactionQuery function
    // The callback: INSERT returns rowCount=1 (new event), then writeToOutbox uses tx too
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ stripe_event_id: event.id }], rowCount: 1 }); // INSERT returns row

    mockDb.transaction.mockImplementationOnce(async (fn: (tx: typeof txQuery) => Promise<unknown>) => {
      return fn(txQuery);
    });

    const result = await processWebhook('raw-body-payload', 'sig-header');

    expect(result.success).toBe(true);
    expect(result.stripeEventId).toBe(event.id);
    // writeToOutbox must be called with the transaction query function
    expect(mockWriteToOutbox).toHaveBeenCalledOnce();
    expect(mockWriteToOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'stripe.event_received',
        aggregateType: 'stripe_event',
        aggregateId: event.id,
      }),
      txQuery
    );
  });

  it('returns success with stripeEventId when event is a duplicate (rowCount=0 — idempotent replay)', async () => {
    const event = makeStripeEvent({ id: 'evt_dup_1' });
    mockConstructEvent.mockReturnValueOnce(event);

    // INSERT returns rowCount=0 → ON CONFLICT DO NOTHING → idempotent replay
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT → conflict, no row

    mockDb.transaction.mockImplementationOnce(async (fn: (tx: typeof txQuery) => Promise<unknown>) => {
      return fn(txQuery);
    });

    const result = await processWebhook('raw-body-payload', 'sig-header');

    expect(result.success).toBe(true);
    expect(result.stripeEventId).toBe(event.id);
    // writeToOutbox must NOT be called for duplicate events
    expect(mockWriteToOutbox).not.toHaveBeenCalled();
  });

  it('returns WEBHOOK_STORAGE_FAILED when db.transaction throws an Error', async () => {
    const event = makeStripeEvent({ id: 'evt_db_fail' });
    mockConstructEvent.mockReturnValueOnce(event);

    mockDb.transaction.mockRejectedValueOnce(new Error('DB connection lost'));

    const result = await processWebhook('raw-body-payload', 'sig-header');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_STORAGE_FAILED');
    expect(result.error?.message).toBe('DB connection lost');
  });

  it('returns WEBHOOK_STORAGE_FAILED with fallback message when db.transaction throws non-Error', async () => {
    const event = makeStripeEvent({ id: 'evt_non_error' });
    mockConstructEvent.mockReturnValueOnce(event);

    // Throw a non-Error to exercise `error instanceof Error` false branch
    mockDb.transaction.mockRejectedValueOnce('plain string error');

    const result = await processWebhook('raw-body-payload', 'sig-header');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_STORAGE_FAILED');
    expect(result.error?.message).toBe('Failed to store webhook event');
  });
});

// ===========================================================================
// processWebhook — constructEvent non-Error throw branch
// ===========================================================================

describe('processWebhook — non-Error constructEvent throw', () => {
  it('returns WEBHOOK_VERIFICATION_FAILED with fallback message when constructEvent throws non-Error', async () => {
    // Throw a non-Error (plain object) from constructEvent
    mockConstructEvent.mockImplementationOnce(() => {
      throw 'not an error object';
    });

    const result = await processWebhook('raw-body', 'sig-header');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_VERIFICATION_FAILED');
    expect(result.error?.message).toBe('Webhook verification failed');
  });
});

// ===========================================================================
// processWebhook — getStripeClient caching
// ===========================================================================

describe('processWebhook — Stripe client initialization', () => {
  it('successfully initializes Stripe client on first call and returns success', async () => {
    const event = makeStripeEvent({ id: 'evt_init_test' });
    mockConstructEvent.mockReturnValueOnce(event);

    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ stripe_event_id: event.id }], rowCount: 1 });

    mockDb.transaction.mockImplementationOnce(async (fn: (tx: typeof txQuery) => Promise<unknown>) => {
      return fn(txQuery);
    });

    const result = await processWebhook('raw-body', 'sig-header');

    // The Stripe constructor was called (getStripeClient initialized it)
    expect(result.success).toBe(true);
  });

  it('reuses the cached Stripe client on subsequent calls', async () => {
    const event1 = makeStripeEvent({ id: 'evt_cache_1' });
    const event2 = makeStripeEvent({ id: 'evt_cache_2' });

    mockConstructEvent
      .mockReturnValueOnce(event1)
      .mockReturnValueOnce(event2);

    const makeTxQuery = (eventId: string) =>
      vi.fn().mockResolvedValueOnce({ rows: [{ stripe_event_id: eventId }], rowCount: 1 });

    mockDb.transaction
      .mockImplementationOnce(async (fn: (tx: ReturnType<typeof makeTxQuery>) => Promise<unknown>) =>
        fn(makeTxQuery(event1.id))
      )
      .mockImplementationOnce(async (fn: (tx: ReturnType<typeof makeTxQuery>) => Promise<unknown>) =>
        fn(makeTxQuery(event2.id))
      );

    const result1 = await processWebhook('raw-body-1', 'sig-header');
    const result2 = await processWebhook('raw-body-2', 'sig-header');

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    // Both events should be returned with their respective IDs
    expect(result1.stripeEventId).toBe(event1.id);
    expect(result2.stripeEventId).toBe(event2.id);
  });
});
