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
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enableControlledStripePaymentTestCohortV7,
  HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7,
  stubPaymentCreationEnvironmentV7,
} from '../helpers/payment-underwriting-v7';

// Controllable mock Stripe client — every method is a spy we can resolve/reject.
const stripeClient = vi.hoisted(() => ({
  paymentIntents: { create: vi.fn(), retrieve: vi.fn() },
  transfers: { create: vi.fn(), retrieve: vi.fn(), createReversal: vi.fn() },
  refunds: { create: vi.fn(), retrieve: vi.fn(), list:vi.fn(), cancel: vi.fn() },
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
  enableControlledStripePaymentTestCohortV7();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('StripeService (configured client) — readTransferWitness', () => {
  it('normalizes the complete current transfer witness while creation is frozen', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');
    stripeClient.transfers.retrieve.mockResolvedValueOnce({
      id:'tr_exact',amount:8300,currency:'usd',destination:'acct_worker',
      reversed:false,amount_reversed:0,
      metadata:{ escrow_id:'escrow-1',task_id:'task-1',worker_id:'worker-1' },
    });

    const result = await StripeService.readTransferWitness('tr_exact');

    expect(result).toEqual({
      success:true,
      data:{
        provider:'STRIPE',transferId:'tr_exact',amountCents:8300,currency:'usd',
        destinationAccountId:'acct_worker',reversed:false,amountReversedCents:0,
        escrowId:'escrow-1',taskId:'task-1',payoutRecipientUserId:'worker-1',
      },
    });
    expect(stripeClient.transfers.retrieve).toHaveBeenCalledWith('tr_exact');
  });

  it('fails closed when current transfer evidence cannot be read', async () => {
    stripeClient.transfers.retrieve.mockRejectedValueOnce(new Error('unavailable'));
    const result = await StripeService.readTransferWitness('tr_missing');
    expect(result).toMatchObject({
      success:false,
      error:{ code:'STRIPE_TRANSFER_EVIDENCE_UNAVAILABLE' },
    });
  });
});

describe('StripeService (configured client) — createPaymentIntent', () => {
  it('fails closed in production before creating an escrow PaymentIntent', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');

    const r = await StripeService.createPaymentIntent({
      taskId: 't-frozen', posterId: 'p-frozen', escrowId: 'e-frozen', amount: 5000,
    });

    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('PAYMENT_CREATION_FROZEN');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('creates a PI and returns id/clientSecret/amount on success', async () => {
    stripeClient.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_1', client_secret: 'cs_1', amount: 5000 });
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
  it('fails closed in production before creating an XP-tax PaymentIntent', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');

    const r = await StripeService.createTaxPaymentIntent('u-frozen', 1200, 1700000000000);

    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('PAYMENT_CREATION_FROZEN');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

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
  it.each(HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7)(
    'rejects $name before a transfer call',
    async ({ env }) => {
      stubPaymentCreationEnvironmentV7(env);
      const result = await StripeService.createTransfer({
        escrowId: 'e-frozen', taskId: 't-frozen', workerId: 'w-frozen',
        workerStripeAccountId: 'acct_FORBIDDEN', amount: 4250,
      });
      expect(result).toMatchObject({
        success: false,
        error: { code: 'PAYMENT_CREATION_FROZEN' },
      });
      expect(stripeClient.transfers.create).not.toHaveBeenCalled();
    },
  );

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

  it('preserves a nonretryable provider restriction code for financial containment', async () => {
    stripeClient.transfers.create.mockRejectedValueOnce(Object.assign(
      new Error('connected account closed'),
      { code: 'account_closed' },
    ));
    const r = await StripeService.createTransfer({
      escrowId: 'e-restricted', taskId: 't', workerId: 'w',
      workerStripeAccountId: 'acct_closed', amount: 100,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('account_closed');
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
  it('uses the immutable claim key for provider idempotency and discovery metadata', async () => {
    stripeClient.refunds.create.mockResolvedValueOnce({ id:'re_claim' });
    stripeClient.refunds.retrieve.mockResolvedValueOnce({
      id:'re_claim',amount:5000,status:'succeeded',currency:'usd',
      payment_intent:'pi_claim',charge:'ch_claim',
      metadata:{
        escrow_id:'escrow-claim',
        payment_intent_id:'pi_claim',
        refund_claim_key:'refund-provider-create-claim-v1:escrow-claim:7',
        refund_provider_key:'hx-refund-claim-v1:escrow-claim:7',
      },
    });

    const result = await StripeService.createRefund({
      paymentIntentId:'pi_claim',
      escrowId:'escrow-claim',
      amount:5000,
      reason:'requested_by_customer',
      providerIdempotencyKey:'hx-refund-claim-v1:escrow-claim:7',
      refundClaimKey:'refund-provider-create-claim-v1:escrow-claim:7',
    });

    expect(result).toMatchObject({ success:true,data:{ refundId:'re_claim' } });
    const [params,requestOptions] = stripeClient.refunds.create.mock.calls[0];
    expect(requestOptions).toEqual({
      idempotencyKey:'hx-refund-claim-v1:escrow-claim:7',
    });
    expect(params.metadata).toEqual({
      escrow_id:'escrow-claim',
      payment_intent_id:'pi_claim',
      refund_claim_key:'refund-provider-create-claim-v1:escrow-claim:7',
      refund_provider_key:'hx-refund-claim-v1:escrow-claim:7',
    });
  });

  it('fails closed on provider claim-metadata drift without issuing a second create', async () => {
    stripeClient.refunds.create.mockResolvedValueOnce({ id:'re_claim_drift' });
    stripeClient.refunds.retrieve.mockResolvedValueOnce({
      id:'re_claim_drift',amount:5000,status:'succeeded',currency:'usd',
      payment_intent:'pi_claim',charge:'ch_claim',
      metadata:{
        escrow_id:'escrow-other',
        payment_intent_id:'pi_claim',
        refund_claim_key:'refund-provider-create-claim-v1:escrow-claim:7',
        refund_provider_key:'hx-refund-claim-v1:escrow-claim:7',
      },
    });

    const result = await StripeService.createRefund({
      paymentIntentId:'pi_claim',
      escrowId:'escrow-claim',
      amount:5000,
      providerIdempotencyKey:'hx-refund-claim-v1:escrow-claim:7',
      refundClaimKey:'refund-provider-create-claim-v1:escrow-claim:7',
    });

    expect(result).toMatchObject({
      success:false,error:{ code:'STRIPE_REFUND_CLAIM_MISMATCH' },
    });
    expect(stripeClient.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripeClient.refunds.retrieve).toHaveBeenCalledTimes(1);
  });

  it('creates a partial refund with a suffix-scoped key', async () => {
    stripeClient.refunds.create.mockResolvedValueOnce({
      id: 're_1', amount: 2000, status: 'pending', currency: 'usd',
      payment_intent: 'pi_1', charge: 'ch_1',
    });
    stripeClient.refunds.retrieve.mockResolvedValueOnce({
      id: 're_1', amount: 2000, status: 'succeeded', currency: 'usd',
      payment_intent: 'pi_1', charge: 'ch_1',
    });
    const r = await StripeService.createRefund({ paymentIntentId: 'pi_1', escrowId: 'e1', amount: 2000, reason: 'requested_by_customer', idempotencyKeySuffix: 'svc_partial_refund' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({
        refundId: 're_1', amount: 2000, status: 'succeeded', currency: 'usd',
        paymentIntentId: 'pi_1', chargeId: 'ch_1',
      });
    }
    expect(stripeClient.refunds.retrieve).toHaveBeenCalledWith('re_1');
    const opts = stripeClient.refunds.create.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe('re_create_pi_1_2000_svc_partial_refund');
  });

  it('builds a "full" key when amount is undefined', async () => {
    stripeClient.refunds.create.mockResolvedValueOnce({ id: 're_2' });
    stripeClient.refunds.retrieve.mockResolvedValueOnce({
      id: 're_2', amount: 5000, status: 'pending', currency: 'usd',
      payment_intent: 'pi_2', charge: 'ch_2',
    });
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

describe('StripeService (configured) — discoverRefundByClaim', () => {
  function refund(overrides: Record<string, unknown> = {}) {
    return {
      id:'re_claim',
      amount:5000,
      status:'succeeded',
      currency:'usd',
      payment_intent:'pi_claim',
      charge:'ch_claim',
      metadata:{
        escrow_id:'escrow-claim',
        payment_intent_id:'pi_claim',
        refund_claim_key:'refund-provider-create-claim-v1:escrow-claim:7',
        refund_provider_key:'hx-refund-claim-v1:escrow-claim:7',
      },
      ...overrides,
    };
  }

  const discovery = {
    paymentIntentId:'pi_claim',
    escrowId:'escrow-claim',
    expectedAmountCents:5000,
    refundClaimKey:'refund-provider-create-claim-v1:escrow-claim:7',
    providerIdempotencyKey:'hx-refund-claim-v1:escrow-claim:7',
  };

  it('returns one current exact succeeded refund from an exhaustive claim query', async () => {
    stripeClient.refunds.list.mockResolvedValueOnce({ data:[refund()],has_more:false });
    stripeClient.refunds.retrieve.mockResolvedValueOnce(refund());

    const result = await StripeService.discoverRefundByClaim(discovery);

    expect(result).toEqual({
      success:true,
      data:{
        refundId:'re_claim',amount:5000,status:'succeeded',currency:'usd',
        paymentIntentId:'pi_claim',chargeId:'ch_claim',
      },
    });
    expect(stripeClient.refunds.list).toHaveBeenCalledWith({
      payment_intent:'pi_claim',limit:100,
    });
    expect(stripeClient.refunds.retrieve).toHaveBeenCalledWith('re_claim');
  });

  it('fails closed on a non-exhaustive provider page', async () => {
    stripeClient.refunds.list.mockResolvedValueOnce({ data:[refund()],has_more:true });

    const result = await StripeService.discoverRefundByClaim(discovery);

    expect(result).toMatchObject({
      success:false,error:{ code:'STRIPE_REFUND_DISCOVERY_PAGINATION' },
    });
    expect(stripeClient.refunds.retrieve).not.toHaveBeenCalled();
  });

  it('fails closed when multiple refunds carry the exact immutable claim', async () => {
    stripeClient.refunds.list.mockResolvedValueOnce({
      data:[refund(),refund({ id:'re_duplicate' })],has_more:false,
    });

    const result = await StripeService.discoverRefundByClaim(discovery);

    expect(result).toMatchObject({
      success:false,error:{ code:'STRIPE_REFUND_AMBIGUOUS' },
    });
    expect(stripeClient.refunds.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ['pending status',{ status:'pending' },'STRIPE_REFUND_PENDING'],
    ['amount mismatch',{ amount:4999 },'STRIPE_REFUND_DISCOVERY_MISMATCH'],
    ['payment-intent mismatch',{ payment_intent:'pi_other' },'STRIPE_REFUND_DISCOVERY_MISMATCH'],
    ['metadata mismatch',{
      metadata:{
        escrow_id:'escrow-other',
        payment_intent_id:'pi_claim',
        refund_claim_key:'refund-provider-create-claim-v1:escrow-claim:7',
        refund_provider_key:'hx-refund-claim-v1:escrow-claim:7',
      },
    },'STRIPE_REFUND_DISCOVERY_MISMATCH'],
  ])('fails closed on %s after exact list discovery', async (_name, current, code) => {
    stripeClient.refunds.list.mockResolvedValueOnce({ data:[refund()],has_more:false });
    stripeClient.refunds.retrieve.mockResolvedValueOnce(refund(current));

    const result = await StripeService.discoverRefundByClaim(discovery);

    expect(result).toMatchObject({ success:false,error:{ code } });
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
    stripeClient.transfers.createReversal.mockResolvedValueOnce({
      id: 'trr_1', transfer: 'tr_1', currency: 'usd', amount: 5000,
    });
    stripeClient.transfers.retrieve.mockResolvedValueOnce({
      id: 'tr_1', amount: 5000, currency: 'usd', destination: 'acct_worker',
      reversed: true, amount_reversed: 5000,
      metadata: { escrow_id: 'e1', task_id: 'task-1', worker_id: 'worker-1' },
    });
    const r = await StripeService.createTransferReversal('tr_1', 'e1');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toMatchObject({
        reversalId: 'trr_1', reversalAmountCents: 5000,
        transferWitness: {
          transferId: 'tr_1', amountCents: 5000, currency: 'usd',
          reversed: true, amountReversedCents: 5000, escrowId: 'e1',
        },
      });
    }
    const opts = stripeClient.transfers.createReversal.mock.calls[0][2];
    expect(opts.idempotencyKey).toBe('tr_reversal_e1_tr_1');
  });

  it('binds refund-triggered reversal idempotency to escrow, transfer, and refund', async () => {
    stripeClient.transfers.createReversal.mockResolvedValueOnce({
      id: 'trr_refund_1', transfer: 'tr_1', currency: 'usd', amount: 5000,
    });
    stripeClient.transfers.retrieve.mockResolvedValueOnce({
      id: 'tr_1', amount: 5000, currency: 'usd', destination: 'acct_worker',
      reversed: true, amount_reversed: 5000,
      metadata: { escrow_id: 'e1', task_id: 'task-1', worker_id: 'worker-1' },
    });
    const r = await StripeService.createTransferReversal('tr_1', 'e1', 're_1');
    expect(r.success).toBe(true);
    const opts = stripeClient.transfers.createReversal.mock.calls[0][2];
    expect(opts.idempotencyKey).toBe('tr_reversal_e1_tr_1_re_1');
  });

  it('treats resource_already_exists as success only with current transfer evidence', async () => {
    const err = Object.assign(new Error('exists'), { code: 'resource_already_exists' });
    stripeClient.transfers.createReversal.mockRejectedValueOnce(err);
    stripeClient.transfers.retrieve.mockResolvedValueOnce({
      id: 'tr_1', amount: 5000, currency: 'usd', destination: 'acct_worker',
      reversed: true, amount_reversed: 5000,
      metadata: { escrow_id: 'e1', task_id: 'task-1', worker_id: 'worker-1' },
    });
    const r = await StripeService.createTransferReversal('tr_1', 'e1');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toMatchObject({
        reversalId: null, reversalAmountCents: null,
        transferWitness: { transferId: 'tr_1', reversed: true, amountReversedCents: 5000 },
      });
    }
  });

  it('fails resource_already_exists when current transfer evidence is unavailable', async () => {
    const err = Object.assign(new Error('exists'), { code: 'resource_already_exists' });
    stripeClient.transfers.createReversal.mockRejectedValueOnce(err);
    stripeClient.transfers.retrieve.mockRejectedValueOnce(new Error('read unavailable'));
    const r = await StripeService.createTransferReversal('tr_1', 'e1');
    expect(r).toMatchObject({
      success: false,
      error: { code: 'STRIPE_TRANSFER_REVERSAL_EVIDENCE_UNAVAILABLE' },
    });
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
