/**
 * StripeService — configured-client coverage (REVIEW FIX / coverage lift, PR242 follow-up).
 *
 * The pre-existing stripe-service*.test.ts files mock config with secretKey:null,
 * so the module-level `stripe` is null and EVERY real method body short-circuits
 * to STRIPE_NOT_CONFIGURED — leaving the happy/error paths (the bulk of the file)
 * uncovered (46% stmt / 35% branch). This suite instantiates a CONTROLLABLE mock
 * Stripe client (secretKey set) and exercises the success + thrown-error branch
 * of every payment method, plus the idempotency-key construction and the
 * resource_already_exists reversal special case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable mock Stripe client — every method is a spy we can resolve/reject.
const stripeClient = vi.hoisted(() => ({
  paymentIntents: { create: vi.fn(), retrieve: vi.fn() },
  transfers: { create: vi.fn(), createReversal: vi.fn() },
  refunds: { create: vi.fn(), cancel: vi.fn() },
  webhooks: { constructEvent: vi.fn() },
}));

vi.mock('stripe', () => ({
  // The service does `new Stripe(secretKey, {...})`; a class constructor that
  // returns an object replaces `this`, so `new Stripe()` yields our mock client.
  default: class MockStripe {
    constructor() { return stripeClient; }
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: 'sk_test_configured_coverage', // non-placeholder → stripe instantiated
      webhookSecret: 'whsec_test',
      minimumTaskValueCents: 500,
      platformFeePercent: 15,
    },
  },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  // Pass-through breaker: runs the wrapped fn so the real Stripe call path executes.
  stripeBreaker: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
  CircuitBreaker: vi.fn(),
  CircuitOpenError: class extends Error { retryAfterMs = 0; },
}));

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../src/services/AdminNotificationHelper', () => ({ notifyAdmins: vi.fn() }));

import { StripeService } from '../../src/services/StripeService';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.HX_STRIPE_STUB; // ensure real bodies run, not the stub branch
});

describe('StripeService (configured client) — createPaymentIntent', () => {
  it('creates a PI and returns id/clientSecret/amount on success', async () => {
    stripeClient.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_1', client_secret: 'cs_1' });
    const r = await StripeService.createPaymentIntent({
      taskId: 't1', posterId: 'p1', escrowId: 'e1', amount: 5000, description: 'd',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.paymentIntentId).toBe('pi_1');
      expect(r.data.clientSecret).toBe('cs_1');
      expect(r.data.amount).toBe(5000);
    }
    // idempotency key is escrow-scoped
    const opts = stripeClient.paymentIntents.create.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe('pi_create_e1');
    // platform_fee metadata = round(5000×15%) = 750
    const body = stripeClient.paymentIntents.create.mock.calls[0][0];
    expect(body.metadata.platform_fee).toBe('750');
  });

  it('uses the immutable escrow margin in metadata instead of the configured fallback', async () => {
    stripeClient.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_canonical', client_secret: 'cs_canonical' });

    const r = await StripeService.createPaymentIntent({
      taskId: 't-price-book', posterId: 'p1', escrowId: 'e-price-book', amount: 5000,
      platformFeeCents: 1000,
    });

    expect(r.success).toBe(true);
    const body = stripeClient.paymentIntents.create.mock.calls[0][0];
    expect(body.amount).toBe(5000);
    expect(body.metadata.platform_fee).toBe('1000');
  });

  it('rejects amounts below the minimum task value', async () => {
    const r = await StripeService.createPaymentIntent({
      taskId: 't1', posterId: 'p1', escrowId: 'e1', amount: 499,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('INVALID_AMOUNT');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('maps a thrown Stripe error to STRIPE_ERROR', async () => {
    stripeClient.paymentIntents.create.mockRejectedValueOnce(new Error('card_declined'));
    const r = await StripeService.createPaymentIntent({
      taskId: 't1', posterId: 'p1', escrowId: 'e1', amount: 5000,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('STRIPE_ERROR');
      expect(r.error.message).toBe('card_declined');
    }
  });
});

describe('StripeService (configured) — createTaxPaymentIntent', () => {
  it('creates a tax PI (no platform fee, distinct idempotency key)', async () => {
    stripeClient.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_tax', client_secret: 'cs_tax' });
    const r = await StripeService.createTaxPaymentIntent('u1', 1200, 1700000000000);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.paymentIntentId).toBe('pi_tax');
    const opts = stripeClient.paymentIntents.create.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe('xp_tax_pi_u1_1200_1700000000000');
  });

  it('rejects tax amounts below the $0.50 Stripe minimum', async () => {
    const r = await StripeService.createTaxPaymentIntent('u1', 49, Date.now());
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('INVALID_AMOUNT');
  });

  it('maps thrown error to STRIPE_ERROR', async () => {
    stripeClient.paymentIntents.create.mockRejectedValueOnce(new Error('boom'));
    const r = await StripeService.createTaxPaymentIntent('u1', 1200, Date.now());
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('STRIPE_ERROR');
  });
});

describe('StripeService (configured) — verifyPaymentIntent', () => {
  it('returns status/amount/metadata on retrieve', async () => {
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({ status: 'succeeded', amount: 1200, metadata: { type: 'xp_tax' } });
    const r = await StripeService.verifyPaymentIntent('pi_x');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe('succeeded');
      expect(r.data.amountCents).toBe(1200);
      expect(r.data.metadata.type).toBe('xp_tax');
    }
  });

  it('defaults metadata to {} when absent', async () => {
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({ status: 'requires_payment_method', amount: 0, metadata: null });
    const r = await StripeService.verifyPaymentIntent('pi_x');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.metadata).toEqual({});
  });

  it('maps thrown error to STRIPE_ERROR', async () => {
    stripeClient.paymentIntents.retrieve.mockRejectedValueOnce(new Error('not_found'));
    const r = await StripeService.verifyPaymentIntent('pi_x');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('STRIPE_ERROR');
  });
});

describe('StripeService (configured) — createTransfer', () => {
  it('creates a transfer and builds a destination-scoped idempotency key', async () => {
    stripeClient.transfers.create.mockResolvedValueOnce({ id: 'tr_1', amount: 4250 });
    const r = await StripeService.createTransfer({
      escrowId: 'e1', taskId: 't1', workerId: 'w1',
      workerStripeAccountId: 'acct_ABCDEFGH', amount: 4250, idempotencyKeySuffix: 'svc_partial_refund',
    });
    expect(r.success).toBe(true);
    if (r.success) { expect(r.data.transferId).toBe('tr_1'); expect(r.data.amount).toBe(4250); }
    const opts = stripeClient.transfers.create.mock.calls[0][1];
    // includes amount, last-8 of destination, and the suffix
    expect(opts.idempotencyKey).toBe('tr_create_e1_4250_ABCDEFGH_svc_partial_refund');
  });

  it('builds the key without a suffix when none is given', async () => {
    stripeClient.transfers.create.mockResolvedValueOnce({ id: 'tr_2', amount: 100 });
    await StripeService.createTransfer({ escrowId: 'e2', taskId: 't', workerId: 'w', workerStripeAccountId: 'acct_ZYXWVUTS', amount: 100 });
    const opts = stripeClient.transfers.create.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe('tr_create_e2_100_ZYXWVUTS');
  });

  it('maps thrown error to STRIPE_ERROR', async () => {
    stripeClient.transfers.create.mockRejectedValueOnce(new Error('insufficient_funds'));
    const r = await StripeService.createTransfer({ escrowId: 'e1', taskId: 't', workerId: 'w', workerStripeAccountId: 'acct_x', amount: 100 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('STRIPE_ERROR');
  });

  it('returns a stub transfer in HX_STRIPE_STUB mode without calling Stripe', async () => {
    process.env.HX_STRIPE_STUB = '1';
    const r = await StripeService.createTransfer({ escrowId: 'e1', taskId: 't', workerId: 'w', workerStripeAccountId: 'acct_x', amount: 777 });
    expect(r.success).toBe(true);
    if (r.success) { expect(r.data.transferId).toMatch(/^tr_test_/); expect(r.data.amount).toBe(777); }
    expect(stripeClient.transfers.create).not.toHaveBeenCalled();
  });
});

describe('StripeService (configured) — createRefund', () => {
  it('creates a partial refund with a suffix-scoped key', async () => {
    stripeClient.refunds.create.mockResolvedValueOnce({ id: 're_1', amount: 2000, status: 'succeeded' });
    const r = await StripeService.createRefund({ paymentIntentId: 'pi_1', escrowId: 'e1', amount: 2000, reason: 'requested_by_customer', idempotencyKeySuffix: 'svc_partial_refund' });
    expect(r.success).toBe(true);
    if (r.success) { expect(r.data.refundId).toBe('re_1'); expect(r.data.status).toBe('succeeded'); }
    const opts = stripeClient.refunds.create.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe('re_create_pi_1_2000_svc_partial_refund');
  });

  it('builds a "full" key when amount is undefined', async () => {
    stripeClient.refunds.create.mockResolvedValueOnce({ id: 're_2', amount: 5000, status: 'pending' });
    await StripeService.createRefund({ paymentIntentId: 'pi_2', escrowId: 'e2' });
    const opts = stripeClient.refunds.create.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe('re_create_pi_2_full');
  });

  it('maps thrown error to STRIPE_ERROR', async () => {
    stripeClient.refunds.create.mockRejectedValueOnce(new Error('charge_already_refunded'));
    const r = await StripeService.createRefund({ paymentIntentId: 'pi_1', escrowId: 'e1', amount: 100 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('STRIPE_ERROR');
  });
});

describe('StripeService (configured) — cancelRefund', () => {
  it('cancels a pending refund', async () => {
    stripeClient.refunds.cancel.mockResolvedValueOnce({ id: 're_1', status: 'canceled' });
    const r = await StripeService.cancelRefund('re_1');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.status).toBe('canceled');
  });

  it('maps thrown error to STRIPE_ERROR', async () => {
    stripeClient.refunds.cancel.mockRejectedValueOnce(new Error('cannot_cancel'));
    const r = await StripeService.cancelRefund('re_1');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('STRIPE_ERROR');
  });
});

describe('StripeService (configured) — createTransferReversal', () => {
  it('reverses a transfer on success', async () => {
    stripeClient.transfers.createReversal.mockResolvedValueOnce({ id: 'trr_1' });
    const r = await StripeService.createTransferReversal('tr_1', 'e1');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reversalId).toBe('trr_1');
    const opts = stripeClient.transfers.createReversal.mock.calls[0][2];
    expect(opts.idempotencyKey).toBe('tr_reversal_e1');
  });

  it('treats resource_already_exists as idempotent success', async () => {
    const err = Object.assign(new Error('exists'), { code: 'resource_already_exists' });
    stripeClient.transfers.createReversal.mockRejectedValueOnce(err);
    const r = await StripeService.createTransferReversal('tr_1', 'e1');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reversalId).toBe('already_reversed');
  });

  it('maps other thrown errors to STRIPE_ERROR', async () => {
    stripeClient.transfers.createReversal.mockRejectedValueOnce(new Error('boom'));
    const r = await StripeService.createTransferReversal('tr_1', 'e1');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('STRIPE_ERROR');
  });
});

describe('StripeService (configured) — verifyWebhook', () => {
  it('constructs and returns the event on a valid signature', () => {
    stripeClient.webhooks.constructEvent.mockReturnValueOnce({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const r = StripeService.verifyWebhook('raw', 'sig');
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as { id: string }).id).toBe('evt_1');
  });

  it('returns WEBHOOK_VERIFICATION_FAILED on a bad signature', () => {
    stripeClient.webhooks.constructEvent.mockImplementationOnce(() => { throw new Error('bad sig'); });
    const r = StripeService.verifyWebhook('raw', 'sig');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('WEBHOOK_VERIFICATION_FAILED');
  });
});
