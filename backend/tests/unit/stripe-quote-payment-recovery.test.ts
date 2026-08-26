import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  cancel: vi.fn(),
  listRefunds: vi.fn(),
  createRefund: vi.fn(),
}));

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: {
    createQuotePaymentIntent: vi.fn(),
  },
}));

vi.mock('../../src/middleware/circuit-breaker.js', () => ({
  stripeBreaker: {
    execute: vi.fn(async (work: () => Promise<unknown>) => work()),
  },
}));

vi.mock('../../src/routers/escrow-common.js', () => ({
  getStripe: () => ({
    paymentIntents: {
      retrieve: mocks.retrieve,
      cancel: mocks.cancel,
    },
    refunds: {
      list: mocks.listRefunds,
      create: mocks.createRefund,
    },
  }),
}));

const { StripeQuotePaymentProvider } = await import(
  '../../src/services/payment/StripeQuotePaymentProvider.js'
);

const input = {
  quoteId: '10000000-0000-4000-8000-000000000001',
  quoteVersionId: '10000000-0000-4000-8000-000000000002',
  posterId: '10000000-0000-4000-8000-000000000003',
  paymentIntentId: 'pi_orphan_quote_payment_123',
  amountCents: 12_500,
  recoveryKey: '10000000-0000-4000-8000-000000000004',
  reasonCode: 'UNDERWRITING_CONTAINMENT' as const,
};

const chargeId = 'ch_orphan_quote_payment_123';

function payment(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: input.paymentIntentId,
    status,
    amount: input.amountCents,
    amount_received: status === 'succeeded' ? input.amountCents : 0,
    currency: 'usd',
    latest_charge: status === 'succeeded' ? chargeId : null,
    metadata: {
      quote_id: input.quoteId,
      quote_version_id: input.quoteVersionId,
      poster_id: input.posterId,
    },
    ...overrides,
  };
}

function refund(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    amount: input.amountCents,
    status: 'succeeded',
    currency: 'usd',
    payment_intent: input.paymentIntentId,
    charge: chargeId,
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Stripe quote payment recovery adapter', () => {
  it('replays an already canceled intent without a processor write', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('canceled'));

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toEqual({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('cancels a non-succeeded intent with a deterministic idempotency key', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('requires_confirmation'));
    mocks.cancel.mockResolvedValueOnce(payment('canceled'));

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result.success).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledWith(
      input.paymentIntentId,
      { cancellation_reason: 'requested_by_customer' },
      { idempotencyKey: `quote_recovery_void_${input.recoveryKey}` },
    );
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('refunds a succeeded intent with exact normalized metadata', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [] });
    mocks.createRefund.mockResolvedValueOnce(refund('re_quote_recovery_123', {
      metadata: { hx_quote_recovery_key: input.recoveryKey },
    }));

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toEqual({
      success: true,
      data: {
        disposition: 'REFUNDED',
        providerStatus: 'succeeded',
        providerOperationId: 're_quote_recovery_123',
      },
    });
    expect(mocks.createRefund).toHaveBeenCalledWith(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountCents,
        reason: 'requested_by_customer',
        metadata: {
          hx_quote_recovery_key: input.recoveryKey,
          quote_id: input.quoteId,
          quote_version_id: input.quoteVersionId,
          poster_id: input.posterId,
          reason_code: input.reasonCode,
        },
      },
      { idempotencyKey: `quote_recovery_refund_${input.recoveryKey}` },
    );
  });

  it('reconciles an existing terminal refund before attempting another write', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [refund('re_existing', {
      metadata: { hx_quote_recovery_key: input.recoveryKey },
    })] });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: true,
      data: { disposition: 'REFUNDED', providerOperationId: 're_existing' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('reconciles a manual full refund without issuing a duplicate refund', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [refund('re_manual_full')] });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: true,
      data: { disposition: 'REFUNDED', providerOperationId: 're_manual_full' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('requires reconciliation instead of creating a remainder after a partial refund', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [refund('re_manual_partial', {
      amount: 2_500,
    })] });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('requires reconciliation when multiple partial refunds add up to the full amount', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [
      refund('re_partial_1', {
        amount: 10_000,
        metadata: { hx_quote_recovery_key: input.recoveryKey },
      }),
      refund('re_partial_2', {
        amount: 2_500,
      }),
    ] });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it.each(['failed', 'canceled'])(
    'does not mislabel a %s recovery-key refund when an unrelated full refund succeeded',
    async (status) => {
      mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
      mocks.listRefunds.mockResolvedValueOnce({ data: [
        refund('re_keyed_terminal_failure', {
          status,
          metadata: { hx_quote_recovery_key: input.recoveryKey },
        }),
        refund('re_unrelated_full_success'),
      ] });

      const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

      expect(result).toMatchObject({
        success: false,
        error: { code: 'PAYMENT_REFUND_RECONCILIATION_REQUIRED' },
      });
      expect(mocks.createRefund).not.toHaveBeenCalled();
    },
  );

  it.each(['failed', 'canceled'])(
    'requires reconciliation when a newly returned recovery refund is %s',
    async (status) => {
      mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
      mocks.listRefunds.mockResolvedValueOnce({ data: [] });
      mocks.createRefund.mockResolvedValueOnce(refund('re_keyed_terminal_failure', {
        status,
        metadata: { hx_quote_recovery_key: input.recoveryKey },
      }));

      const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

      expect(result).toMatchObject({
        success: false,
        error: { code: 'PAYMENT_REFUND_RECONCILIATION_REQUIRED' },
      });
    },
  );

  it('rejects a newly returned refund that is not bound to the recovery key', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [] });
    mocks.createRefund.mockResolvedValueOnce(refund('re_wrong_recovery_key', {
      metadata: { hx_quote_recovery_key: 'different-recovery-key' },
    }));

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_RECONCILIATION_REQUIRED' },
    });
  });

  it.each([
    ['wrong amount received', { amount_received: input.amountCents - 1 }],
    ['wrong currency', { currency: 'cad' }],
    ['missing charge identity', { latest_charge: null }],
  ])('rejects succeeded payment facts with %s before refund effects', async (_label, override) => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded', override));

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(mocks.listRefunds).not.toHaveBeenCalled();
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong amount', { amount: input.amountCents - 1 }],
    ['wrong currency', { currency: 'cad' }],
    ['wrong payment intent', { payment_intent: 'pi_other' }],
    ['wrong charge identity', { charge: 'ch_other' }],
  ])('rejects an otherwise successful refund with %s', async (_label, override) => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [refund('re_mismatched', {
      ...override,
      metadata: { hx_quote_recovery_key: input.recoveryKey },
    })] });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('keeps canonical state unchanged for a nonterminal refund', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [{
      id: 're_pending',
      amount: input.amountCents,
      status: 'pending',
      metadata: { hx_quote_recovery_key: input.recoveryKey },
    }] });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_PENDING' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('does not overlap an unrelated nonterminal refund', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [{
      id: 're_manual_pending',
      amount: 2_500,
      status: 'pending',
      metadata: {},
    }] });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_PENDING' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('fails closed when the refund history exceeds the bounded reconciliation page', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [], has_more: true });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_RECONCILIATION_INCOMPLETE' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it.each([
    [{ amount: 1 }, 'PAYMENT_AMOUNT_MISMATCH'],
    [{ metadata: { quote_id: 'wrong' } }, 'PAYMENT_QUOTE_MISMATCH'],
    [{ metadata: { quote_id: input.quoteId, quote_version_id: 'wrong' } }, 'PAYMENT_QUOTE_VERSION_MISMATCH'],
    [{ metadata: {
      quote_id: input.quoteId,
      quote_version_id: input.quoteVersionId,
      poster_id: 'wrong',
    } }, 'PAYMENT_POSTER_MISMATCH'],
  ])('rejects processor identity mismatch before cancel or refund', async (override, code) => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded', override));

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({ success: false, error: { code } });
    expect(mocks.listRefunds).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('fails closed on a provider exception', async () => {
    mocks.retrieve.mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'PAYMENT_RECOVERY_FAILED',
        message: 'Payment recovery could not be completed',
      },
    });
  });
});
