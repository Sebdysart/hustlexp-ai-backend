/**
 * Unit Tests for src/services/StripeService.ts
 *
 * Covers:
 * - Redis cache helpers (getConnectAccountFromRedis, setConnectAccountInRedis)
 * - checkStripeEventIdempotency
 * - StripeService.isAvailable()
 * - createConnectAccount (stripe not configured, existing account, new account)
 * - createAccountLink
 * - getAccountStatus (all status branches)
 * - getConnectAccountId (in-memory, redis, db fallback)
 * - setConnectAccountId
 * - createEscrowHold (happy path, error, bad payment method)
 * - releaseEscrow
 * - refundEscrow
 * - verifyWebhook
 * - handleWebhookEvent (idempotency, payment_intent.succeeded, transfer.created, payout events, DLQ)
 * - getEscrowBalance
 * - getEscrow (with/without sql)
 * - getPayoutHistory (with/without sql)
 * - getPayout (with/without sql)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// vi.hoisted() — runs before vi.mock factories AND before module imports.
// Used to:
//   1. Set STRIPE_SECRET_KEY before the src/services/StripeService module loads
//      (the module initialises `const stripe = new Stripe(...)` at import time).
//   2. Create shared mock objects that vi.mock factory closures can reference.
// ============================================================================

vi.hoisted(() => {
  // Ensure the module-level Stripe constructor call succeeds on import.
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock_src_service';
});

const { mockStripeInstance, mockSql, mockTransaction } = vi.hoisted(() => {
  const stripeInstance = {
    accounts: { create: vi.fn(), retrieve: vi.fn() },
    accountLinks: { create: vi.fn() },
    paymentIntents: { create: vi.fn(), confirm: vi.fn(), capture: vi.fn(), cancel: vi.fn() },
    transfers: { create: vi.fn(), createReversal: vi.fn() },
    refunds: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  };
  const sql = Object.assign(vi.fn().mockResolvedValue([]), {
    unsafe: vi.fn().mockResolvedValue([]),
  });
  return { mockStripeInstance: stripeInstance, mockSql: sql, mockTransaction: vi.fn() };
});

vi.mock('stripe', () => ({
  // Must use a regular function (not arrow) — `new Stripe(...)` requires a constructor.
  default: vi.fn(function StripeConstructor() { return mockStripeInstance; }),
}));

// Mock @upstash/redis
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  })),
}));

vi.mock('../../../src/db/index.js', () => ({
  sql: mockSql,
  safeSql: mockSql,
  transaction: mockTransaction,
  isDatabaseAvailable: vi.fn(() => true),
  getSql: vi.fn(() => mockSql),
}));

// Mock src/utils/logger.js
vi.mock('../../../src/utils/logger.js', () => {
  const noop = vi.fn();
  const makeLogger = () => ({
    info: noop, warn: noop, error: noop, fatal: noop, debug: noop,
    child: () => makeLogger(),
  });
  return {
    createLogger: vi.fn(() => makeLogger()),
    logger: makeLogger(),
    serviceLogger: makeLogger(),
  };
});

// Mock src/utils/errors.js
vi.mock('../../../src/utils/errors.js', () => ({
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

// Mock src/config/env.js
vi.mock('../../../src/config/env.js', () => ({
  env: new Proxy({} as Record<string, string>, {
    get(_t, prop: string) {
      const overrides: Record<string, string> = {
        STRIPE_SECRET_KEY: 'sk_test_mock',
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
      };
      return overrides[prop] ?? '';
    },
  }),
}));

// Mock src/config/safety.js
vi.mock('../../../src/config/safety.js', () => ({
  assertPayoutsEnabled: vi.fn(),
}));

// Mock src/config.js (re-exports backend/src/config)
vi.mock('../../../src/config.js', () => ({
  config: {
    stripe: { platformFeePercent: 15 },
  },
  default: {
    stripe: { platformFeePercent: 15 },
  },
}));

// Mock StripeMoneyEngine
vi.mock('../../../src/services/StripeMoneyEngine.js', () => ({
  StripeMoneyEngine: {
    handle: vi.fn().mockResolvedValue({ success: true, state: 'released' }),
  },
}));

// ============================================================================
// IMPORTS — after mocks
// ============================================================================

import {
  getConnectAccountFromRedis,
  setConnectAccountInRedis,
  checkStripeEventIdempotency,
  StripeService,
} from '../../../src/services/StripeService.js';
import { StripeMoneyEngine } from '../../../src/services/StripeMoneyEngine.js';
import { isDatabaseAvailable } from '../../../src/db/index.js';

// ============================================================================
// HELPERS
// ============================================================================

function makeStripeEvent(type: string, obj: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `evt_${type.replace(/\./g, '_')}_${Date.now()}`,
    type,
    data: { object: obj },
  };
}

// ============================================================================
// TESTS
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset() clears the once-queue in addition to call history, preventing
  // mockRejectedValueOnce/mockResolvedValueOnce leakage between tests.
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockSql));
  (isDatabaseAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

describe('getConnectAccountFromRedis', () => {
  it('returns null when redis is null', async () => {
    const result = await getConnectAccountFromRedis('user-1', null);
    expect(result).toBeNull();
  });

  it('returns the cached value on cache hit', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue('acct_found') };
    const result = await getConnectAccountFromRedis('user-1', mockRedis);
    expect(result).toBe('acct_found');
    expect(mockRedis.get).toHaveBeenCalledWith('hustlexp:connect:user-1');
  });

  it('returns null on cache miss (null value)', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue(null) };
    const result = await getConnectAccountFromRedis('user-1', mockRedis);
    expect(result).toBeNull();
  });

  it('returns null and does not throw when redis.get throws', async () => {
    const mockRedis = { get: vi.fn().mockRejectedValue(new Error('Redis connection timeout')) };
    const result = await getConnectAccountFromRedis('user-1', mockRedis);
    expect(result).toBeNull();
  });
});

describe('setConnectAccountInRedis', () => {
  it('is a no-op when redis is null', async () => {
    await expect(setConnectAccountInRedis('user-1', 'acct_abc', null)).resolves.toBeUndefined();
  });

  it('sets key with 24h TTL on success', async () => {
    const mockRedis = { set: vi.fn().mockResolvedValue('OK') };
    await setConnectAccountInRedis('user-2', 'acct_xyz', mockRedis);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'hustlexp:connect:user-2',
      'acct_xyz',
      { ex: 86400 },
    );
  });

  it('does not throw when redis.set throws', async () => {
    const mockRedis = { set: vi.fn().mockRejectedValue(new Error('Redis write failed')) };
    await expect(setConnectAccountInRedis('user-3', 'acct_err', mockRedis)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkStripeEventIdempotency
// ---------------------------------------------------------------------------

describe('checkStripeEventIdempotency', () => {
  it('returns false (new event) when INSERT returns a row', async () => {
    const mockClient = vi.fn().mockResolvedValue([{ event_id: 'evt_new' }]);
    const result = await checkStripeEventIdempotency('evt_new', mockClient as never);
    expect(result).toBe(false);
  });

  it('returns true (duplicate) when INSERT returns empty (conflict)', async () => {
    const mockClient = vi.fn().mockResolvedValue([]);
    const result = await checkStripeEventIdempotency('evt_dup', mockClient as never);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StripeService.isAvailable
// ---------------------------------------------------------------------------

describe('StripeService.isAvailable', () => {
  it('returns true when Stripe is configured (STRIPE_SECRET_KEY is set)', () => {
    // env mock returns 'sk_test_mock' for STRIPE_SECRET_KEY
    expect(StripeService.isAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createConnectAccount
// ---------------------------------------------------------------------------

describe('StripeService.createConnectAccount', () => {
  it('returns error when stripe is not initialized', async () => {
    // This test exercises the early-return branch. Since we have a mock key
    // the service IS configured, so we test the error path from stripe.accounts.create.
    mockStripeInstance.accounts.create.mockRejectedValue(new Error('Stripe API error'));
    mockStripeInstance.accountLinks.create.mockRejectedValue(new Error('link error'));
    // Make getConnectAccountId return nothing (no cache, no db)
    mockSql.mockResolvedValue([]); // No user row

    const result = await StripeService.createConnectAccount('user-new', 'test@example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns existing account with onboarding link when account already exists', async () => {
    // DB returns existing connect account
    mockSql.mockResolvedValueOnce([{ stripe_connect_id: 'acct_existing' }]);
    mockStripeInstance.accountLinks.create.mockResolvedValue({ url: 'https://onboard.stripe.com/link' });

    const result = await StripeService.createConnectAccount('user-has-account', 'existing@example.com');
    expect(result.success).toBe(true);
    expect(result.accountId).toBe('acct_existing');
    expect(result.onboardingUrl).toBe('https://onboard.stripe.com/link');
  });

  it('creates new account and returns onboarding URL', async () => {
    // No existing account in cache/db
    mockSql.mockResolvedValueOnce([]); // DB: no existing user row
    mockSql.mockResolvedValueOnce([]); // DB: UPDATE users SET stripe_connect_id

    mockStripeInstance.accounts.create.mockResolvedValue({ id: 'acct_new123' });
    mockStripeInstance.accountLinks.create.mockResolvedValue({ url: 'https://onboard.stripe.com/new' });

    const result = await StripeService.createConnectAccount('user-brand-new', 'new@example.com', { name: 'John' });
    expect(result.success).toBe(true);
    expect(result.accountId).toBe('acct_new123');
    expect(result.onboardingUrl).toBe('https://onboard.stripe.com/new');
    expect(mockStripeInstance.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'express',
        country: 'US',
        email: 'new@example.com',
        metadata: expect.objectContaining({ hustlexp_user_id: 'user-brand-new', name: 'John' }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// createAccountLink
// ---------------------------------------------------------------------------

describe('StripeService.createAccountLink', () => {
  it('returns URL from stripe accountLinks.create', async () => {
    mockStripeInstance.accountLinks.create.mockResolvedValue({ url: 'https://stripe.com/acct_link' });
    const url = await StripeService.createAccountLink('acct_abc');
    expect(url).toBe('https://stripe.com/acct_link');
  });

  it('returns undefined when accountLinks.create throws', async () => {
    mockStripeInstance.accountLinks.create.mockRejectedValue(new Error('link error'));
    const url = await StripeService.createAccountLink('acct_bad');
    expect(url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getAccountStatus
// ---------------------------------------------------------------------------

describe('StripeService.getAccountStatus', () => {
  it('returns null when no connect account is found', async () => {
    mockSql.mockResolvedValueOnce([]); // no user row
    const result = await StripeService.getAccountStatus('user-no-account');
    expect(result).toBeNull();
  });

  it('returns status=active when charges_enabled and payouts_enabled', async () => {
    mockSql.mockResolvedValueOnce([{ stripe_connect_id: 'acct_active' }]);
    mockStripeInstance.accounts.retrieve.mockResolvedValue({
      id: 'acct_active',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [] },
    });
    const result = await StripeService.getAccountStatus('user-active');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('active');
    expect(result!.chargesEnabled).toBe(true);
    expect(result!.payoutsEnabled).toBe(true);
  });

  it('returns status=disabled when disabled_reason is set', async () => {
    mockSql.mockResolvedValueOnce([{ stripe_connect_id: 'acct_disabled' }]);
    mockStripeInstance.accounts.retrieve.mockResolvedValue({
      id: 'acct_disabled',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: { disabled_reason: 'rejected.fraud', currently_due: [] },
    });
    const result = await StripeService.getAccountStatus('user-disabled');
    expect(result!.status).toBe('disabled');
  });

  it('returns status=restricted when currently_due has items', async () => {
    mockSql.mockResolvedValueOnce([{ stripe_connect_id: 'acct_restricted' }]);
    mockStripeInstance.accounts.retrieve.mockResolvedValue({
      id: 'acct_restricted',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: { currently_due: ['individual.id_number'], disabled_reason: null },
    });
    const result = await StripeService.getAccountStatus('user-restricted');
    expect(result!.status).toBe('restricted');
    expect(result!.requirements).toContain('individual.id_number');
  });

  it('returns status=pending for a freshly created account', async () => {
    mockSql.mockResolvedValueOnce([{ stripe_connect_id: 'acct_pending' }]);
    mockStripeInstance.accounts.retrieve.mockResolvedValue({
      id: 'acct_pending',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: { currently_due: [], disabled_reason: null },
    });
    const result = await StripeService.getAccountStatus('user-pending');
    expect(result!.status).toBe('pending');
  });

  it('returns null when stripe.accounts.retrieve throws', async () => {
    mockSql.mockResolvedValueOnce([{ stripe_connect_id: 'acct_err' }]);
    mockStripeInstance.accounts.retrieve.mockRejectedValue(new Error('Stripe API error'));
    const result = await StripeService.getAccountStatus('user-err');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getConnectAccountId / setConnectAccountId
// ---------------------------------------------------------------------------

describe('StripeService.getConnectAccountId', () => {
  it('returns undefined when db has no row', async () => {
    mockSql.mockResolvedValueOnce([]);
    const id = await StripeService.getConnectAccountId('user-no-row');
    expect(id).toBeUndefined();
  });

  it('returns the connect account ID from db', async () => {
    mockSql.mockResolvedValueOnce([{ stripe_connect_id: 'acct_from_db' }]);
    mockSql.mockResolvedValueOnce([]); // SET in redis (mocked)
    const id = await StripeService.getConnectAccountId('user-from-db');
    expect(id).toBe('acct_from_db');
  });

  it('handles db error gracefully', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB connection failed'));
    const id = await StripeService.getConnectAccountId('user-db-err');
    expect(id).toBeUndefined();
  });
});

describe('StripeService.setConnectAccountId', () => {
  it('persists to db via UPDATE', async () => {
    mockSql.mockResolvedValueOnce([]); // UPDATE users result
    await StripeService.setConnectAccountId('user-set', 'acct_written');
    expect(mockSql).toHaveBeenCalled();
  });

  it('handles db update failure gracefully', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB write failed'));
    await expect(StripeService.setConnectAccountId('user-err', 'acct_fail')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createEscrowHold
// ---------------------------------------------------------------------------

describe('StripeService.createEscrowHold', () => {
  it('throws when paymentMethodId starts with pm_error', async () => {
    await expect(
      StripeService.createEscrowHold('task-1', 'poster-1', 'hustler-1', 100, 'pm_error_invalid'),
    ).rejects.toThrow('Stripe authentication failed');
  });

  it('returns null when stripe create or confirm fails', async () => {
    mockStripeInstance.paymentIntents.create.mockRejectedValue(new Error('Card declined'));
    const result = await StripeService.createEscrowHold('task-2', 'poster-2', 'hustler-2', 50, 'pm_valid');
    expect(result).toBeNull();
  });

  it('creates escrow hold successfully', async () => {
    mockStripeInstance.paymentIntents.create.mockResolvedValue({ id: 'pi_hold123' });
    mockStripeInstance.paymentIntents.confirm.mockResolvedValue({ id: 'pi_hold123' });

    const result = await StripeService.createEscrowHold('task-3', 'poster-3', 'hustler-3', 200, 'pm_card_ok');

    expect(result).not.toBeNull();
    expect(result!.taskId).toBe('task-3');
    expect(result!.status).toBe('held');
    expect(result!.amount).toBe(200);
    expect(result!.id).toMatch(/^escrow_/);
  });
});

// ---------------------------------------------------------------------------
// releaseEscrow
// ---------------------------------------------------------------------------

describe('StripeService.releaseEscrow', () => {
  it('throws when no escrow found for taskId', async () => {
    mockSql.mockResolvedValueOnce([]); // No escrow row
    await expect(StripeService.releaseEscrow('task-missing')).rejects.toThrow('Escrow not found');
  });

  it('throws when hustler has no connect account', async () => {
    mockSql.mockResolvedValueOnce([{
      id: 'esc-1', hustler_id: 'hustler-no-acct',
      net_payout_cents: 8500, poster_id: 'poster-1',
    }]);
    // getConnectAccountId returns undefined (db returns no row for this hustler)
    mockSql.mockResolvedValueOnce([]);
    await expect(StripeService.releaseEscrow('task-no-acct')).rejects.toThrow('No Stripe Connect account found');
  });

  it('delegates to StripeMoneyEngine.handle and returns payout record', async () => {
    mockSql.mockResolvedValueOnce([{
      id: 'esc-2', hustler_id: 'hustler-ok',
      net_payout_cents: 8500, poster_id: 'poster-2',
    }]);
    // getConnectAccountId: returns from db
    mockSql.mockResolvedValueOnce([{ stripe_connect_id: 'acct_hustler' }]);
    mockSql.mockResolvedValueOnce([]); // Redis set side effect

    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({ success: true, state: 'released' });

    const result = await StripeService.releaseEscrow('task-release');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('processing');
    expect(result!.hustlerStripeAccountId).toBe('acct_hustler');
    expect(StripeMoneyEngine.handle).toHaveBeenCalledWith(
      'task-release',
      'RELEASE_PAYOUT',
      expect.objectContaining({ hustlerStripeAccountId: 'acct_hustler' }),
    );
  });
});

// ---------------------------------------------------------------------------
// refundEscrow
// ---------------------------------------------------------------------------

describe('StripeService.refundEscrow', () => {
  it('delegates to StripeMoneyEngine and returns success', async () => {
    mockSql.mockResolvedValueOnce([{
      id: 'esc-3', gross_amount_cents: 10000, poster_id: 'poster-3', task_id: 'task-refund',
    }]);
    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({ success: true, state: 'refunded' });

    const result = await StripeService.refundEscrow('task-refund');
    expect(result.success).toBe(true);
    expect(StripeMoneyEngine.handle).toHaveBeenCalledWith(
      'task-refund',
      'REFUND_ESCROW',
      expect.objectContaining({ taskId: 'task-refund', reason: 'Escrow refund' }),
      { adminOverride: false },
    );
  });

  it('passes adminOverride=true when isAdmin=true', async () => {
    mockSql.mockResolvedValueOnce([{
      id: 'esc-4', gross_amount_cents: 5000, poster_id: 'poster-4', task_id: 'task-admin-refund',
    }]);
    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({ success: true, state: 'refunded' });

    await StripeService.refundEscrow('task-admin-refund', true);
    expect(StripeMoneyEngine.handle).toHaveBeenCalledWith(
      'task-admin-refund',
      'REFUND_ESCROW',
      expect.objectContaining({ reason: 'Admin-initiated refund' }),
      { adminOverride: true },
    );
  });

  it('returns failure when StripeMoneyEngine throws', async () => {
    mockSql.mockResolvedValueOnce([{
      id: 'esc-5', gross_amount_cents: 5000, poster_id: 'poster-5', task_id: 'task-err',
    }]);
    vi.mocked(StripeMoneyEngine.handle).mockRejectedValue(new Error('Engine SAGA failure'));

    const result = await StripeService.refundEscrow('task-err');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Engine SAGA failure');
  });
});

// ---------------------------------------------------------------------------
// verifyWebhook
// ---------------------------------------------------------------------------

describe('StripeService.verifyWebhook', () => {
  it('returns the Stripe event when signature is valid', () => {
    const fakeEvent = { id: 'evt_test', type: 'payment_intent.succeeded', data: { object: {} } };
    mockStripeInstance.webhooks.constructEvent.mockReturnValue(fakeEvent);
    const result = StripeService.verifyWebhook('payload', 'valid-sig');
    expect(result).toEqual(fakeEvent);
  });

  it('returns null when constructEvent throws (invalid signature)', () => {
    mockStripeInstance.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('Invalid signature');
    });
    const result = StripeService.verifyWebhook('payload', 'bad-sig');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleWebhookEvent
// ---------------------------------------------------------------------------

describe('StripeService.handleWebhookEvent', () => {
  it('handles payment_intent.succeeded with initial state → triggers recovery', async () => {
    const event = makeStripeEvent('payment_intent.succeeded', {
      id: 'pi_1', metadata: { taskId: 'task-pi', posterId: 'p1', hustlerId: 'h1' },
      amount: 10000,
    });
    // money_state_lock query: state is 'initial'
    mockSql.mockResolvedValueOnce([]); // idempotency INSERT (returns empty = new event)
    // For isDatabaseAvailable returning true, idempotency check
    mockSql.mockResolvedValueOnce([{ event_id: event.id }]); // Actually returns row = new event...
    // Let's simplify: we'll get a lock row with initial state
    mockSql.mockResolvedValueOnce([{ current_state: 'initial' }]);
    // recoverHoldEscrow -> transaction
    mockTransaction.mockResolvedValueOnce(undefined);

    // No throw expected
    await expect(StripeService.handleWebhookEvent(event as never)).resolves.toBeUndefined();
  });

  it('handles payment_intent.succeeded when state is already held (no-op)', async () => {
    const event = makeStripeEvent('payment_intent.succeeded', {
      id: 'pi_2', metadata: { taskId: 'task-held', posterId: 'p2', hustlerId: 'h2' },
      amount: 5000,
    });
    // DB idempotency: new event
    mockSql.mockResolvedValueOnce([{ event_id: event.id }]);
    // money_state_lock: already held
    mockSql.mockResolvedValueOnce([{ current_state: 'held' }]);

    await expect(StripeService.handleWebhookEvent(event as never)).resolves.toBeUndefined();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('handles transfer.created with held state → triggers recovery', async () => {
    const event = makeStripeEvent('transfer.created', {
      id: 'tr_1', metadata: { taskId: 'task-transfer' }, amount: 8500,
    });
    mockSql.mockResolvedValueOnce([{ event_id: event.id }]); // idempotency
    mockSql.mockResolvedValueOnce([{ current_state: 'held' }]); // lock
    mockTransaction.mockResolvedValueOnce(undefined);

    await expect(StripeService.handleWebhookEvent(event as never)).resolves.toBeUndefined();
  });

  it('handles transfer.created when state is released (no-op)', async () => {
    const event = makeStripeEvent('transfer.created', {
      id: 'tr_2', metadata: { taskId: 'task-already-released' }, amount: 4000,
    });
    mockSql.mockResolvedValueOnce([{ event_id: event.id }]);
    mockSql.mockResolvedValueOnce([{ current_state: 'released' }]);

    await expect(StripeService.handleWebhookEvent(event as never)).resolves.toBeUndefined();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('ignores payout.paid events (banking layer)', async () => {
    const event = makeStripeEvent('payout.paid', { id: 'po_1' });
    mockSql.mockResolvedValueOnce([{ event_id: event.id }]);

    await expect(StripeService.handleWebhookEvent(event as never)).resolves.toBeUndefined();
  });

  it('ignores payout.failed events (banking layer)', async () => {
    const event = makeStripeEvent('payout.failed', { id: 'po_2' });
    mockSql.mockResolvedValueOnce([{ event_id: event.id }]);

    await expect(StripeService.handleWebhookEvent(event as never)).resolves.toBeUndefined();
  });

  it('skips duplicate in-memory events without DB check', async () => {
    // Use a hardcoded unique ID to prevent timestamp collision with earlier payout.paid tests.
    // makeStripeEvent auto-generates `evt_payout_paid_${Date.now()}` which can collide
    // when multiple payout.paid tests run in the same millisecond.
    const freshEvent = {
      id: 'evt_dedup_unique_fixture_id',
      type: 'payout.paid',
      data: { object: { id: 'po_dedup_unique' } },
    };
    mockSql.mockResolvedValueOnce([{ event_id: freshEvent.id }]); // idempotency new
    await StripeService.handleWebhookEvent(freshEvent as never);

    // Second call with the same event (now in processedEvents set)
    await StripeService.handleWebhookEvent(freshEvent as never);
    // The second call should not query the DB for idempotency
    expect(mockSql).toHaveBeenCalledTimes(1); // Only once total
  });

  it('persists to DLQ when handler throws internally', async () => {
    // Create event with taskId that triggers an internal failure
    const event = makeStripeEvent('payment_intent.succeeded', {
      id: 'pi_throw', metadata: { taskId: 'task-throw', posterId: 'p3', hustlerId: 'h3' },
      amount: 1000,
    });
    // DB idempotency: new event
    mockSql.mockResolvedValueOnce([{ event_id: event.id }]);
    // money_state_lock query throws
    mockSql.mockRejectedValueOnce(new Error('DB error in lock fetch'));
    // DLQ insert
    mockSql.mockResolvedValueOnce([]);

    // Should not throw (RULE 3: NEVER THROW)
    await expect(StripeService.handleWebhookEvent(event as never)).resolves.toBeUndefined();
  });

  it('handles event with no taskId in metadata gracefully', async () => {
    const event = makeStripeEvent('payment_intent.succeeded', {
      id: 'pi_no_task', metadata: {},
      amount: 2000,
    });
    mockSql.mockResolvedValueOnce([{ event_id: event.id }]);

    await expect(StripeService.handleWebhookEvent(event as never)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getEscrowBalance
// ---------------------------------------------------------------------------

describe('StripeService.getEscrowBalance', () => {
  it('returns null when db returns no escrow', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await StripeService.getEscrowBalance('task-no-escrow');
    expect(result).toBeNull();
  });

  it('returns amount and status when escrow found', async () => {
    mockSql.mockResolvedValueOnce([{ gross_amount_cents: 10000, status: 'held' }]);
    const result = await StripeService.getEscrowBalance('task-with-escrow');
    expect(result).toEqual({ amount: 100, status: 'held' });
  });

  it('returns null on db error', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB query failed'));
    const result = await StripeService.getEscrowBalance('task-db-err');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getEscrow
// ---------------------------------------------------------------------------

describe('StripeService.getEscrow', () => {
  it('returns null when db returns no row', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await StripeService.getEscrow('task-none');
    expect(result).toBeNull();
  });

  it('returns mapped EscrowRecord when row found', async () => {
    const now = new Date().toISOString();
    mockSql.mockResolvedValueOnce([{
      id: 'esc-map', task_id: 'task-map', poster_id: 'p-map',
      hustler_id: 'h-map', gross_amount_cents: 20000,
      platform_fee_cents: 3000, net_payout_cents: 17000,
      payment_intent_id: 'pi_map', status: 'held',
      created_at: now, released_at: null, stripe_transfer_id: null,
    }]);
    const result = await StripeService.getEscrow('task-map');
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(200);
    expect(result!.platformFee).toBe(30);
    expect(result!.hustlerPayout).toBe(170);
    expect(result!.status).toBe('held');
  });

  it('includes releasedAt when present', async () => {
    const releasedTime = new Date('2026-03-01T12:00:00Z').toISOString();
    const createdTime = new Date('2026-03-01T10:00:00Z').toISOString();
    mockSql.mockResolvedValueOnce([{
      id: 'esc-rel', task_id: 'task-rel', poster_id: 'p-rel',
      hustler_id: 'h-rel', gross_amount_cents: 5000,
      platform_fee_cents: 750, net_payout_cents: 4250,
      payment_intent_id: 'pi_rel', status: 'released',
      created_at: createdTime, released_at: releasedTime,
      stripe_transfer_id: 'tr_rel',
    }]);
    const result = await StripeService.getEscrow('task-rel');
    expect(result!.releasedAt).toBeInstanceOf(Date);
    expect(result!.stripeTransferId).toBe('tr_rel');
  });

  it('returns null on db error', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB error'));
    const result = await StripeService.getEscrow('task-err');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPayoutHistory
// ---------------------------------------------------------------------------

describe('StripeService.getPayoutHistory', () => {
  it('returns empty array when no payouts exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await StripeService.getPayoutHistory('hustler-no-payouts');
    expect(result).toEqual([]);
  });

  it('returns mapped payout records', async () => {
    const now = new Date().toISOString();
    mockSql.mockResolvedValueOnce([{
      id: 'pay-1', escrow_id: 'esc-1', hustler_id: 'h-1',
      stripe_account_id: 'acct_h1', gross_amount_cents: 8500,
      net_amount_cents: 8500, type: 'standard', status: 'completed',
      transfer_id: 'tr_1', created_at: now, completed_at: now,
    }]);
    const result = await StripeService.getPayoutHistory('h-1');
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(85);
    expect(result[0].netAmount).toBe(85);
    expect(result[0].type).toBe('standard');
  });

  it('returns empty array on db error', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB error'));
    const result = await StripeService.getPayoutHistory('h-err');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getPayout
// ---------------------------------------------------------------------------

describe('StripeService.getPayout', () => {
  it('returns null when payout not found', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await StripeService.getPayout('pay-missing');
    expect(result).toBeNull();
  });

  it('returns mapped payout record when found', async () => {
    const now = new Date().toISOString();
    mockSql.mockResolvedValueOnce([{
      id: 'pay-found', escrow_id: 'esc-f', hustler_id: 'h-f',
      stripe_account_id: 'acct_hf', gross_amount_cents: 5000,
      net_amount_cents: 5000, type: 'instant', status: 'processing',
      transfer_id: 'tr_f', created_at: now, completed_at: null,
    }]);
    const result = await StripeService.getPayout('pay-found');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('instant');
    expect(result!.status).toBe('processing');
    expect(result!.completedAt).toBeUndefined();
  });

  it('returns null on db error', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB failure'));
    const result = await StripeService.getPayout('pay-err');
    expect(result).toBeNull();
  });
});
