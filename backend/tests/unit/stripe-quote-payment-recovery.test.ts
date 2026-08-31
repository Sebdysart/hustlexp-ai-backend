import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  cancel: vi.fn(),
  listRefunds: vi.fn(),
  createRefund: vi.fn(),
}));

vi.mock('../../src/middleware/circuit-breaker.js', () => ({
  stripeBreaker: {
    execute: vi.fn(async (work: () => Promise<unknown>) => work()),
  },
}));

vi.mock('../../src/lib/stripe-client.js', () => ({
  getSharedStripe: () => ({
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

const { StripeQuotePaymentProvider } =
  await import('../../src/services/payment/StripeQuotePaymentProvider.js');

const input = {
  quoteId: '10000000-0000-4000-8000-000000000001',
  quoteVersionId: '10000000-0000-4000-8000-000000000002',
  posterId: '10000000-0000-4000-8000-000000000003',
  externalReference: 'pi_orphan_quote_payment_123',
  paymentIntentId: 'pi_orphan_quote_payment_123',
  amountCents: 12_500,
  recoveryKey: '10000000-0000-4000-8000-000000000004',
  reasonCode: 'UNDERWRITING_CONTAINMENT' as const,
};

function payment(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: input.paymentIntentId,
    status,
    amount: input.amountCents,
    metadata: {
      quote_id: input.quoteId,
      quote_version_id: input.quoteVersionId,
      poster_id: input.posterId,
    },
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
      { idempotencyKey: `quote_recovery_void_${input.recoveryKey}` }
    );
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('refunds a succeeded intent with exact normalized metadata', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({ data: [] });
    mocks.createRefund.mockResolvedValueOnce({
      id: 're_quote_recovery_123',
      amount: input.amountCents,
      status: 'succeeded',
      metadata: { hx_quote_recovery_key: input.recoveryKey },
    });

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
      { idempotencyKey: `quote_recovery_refund_${input.recoveryKey}` }
    );
  });

  it('reconciles an existing terminal refund before attempting another write', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({
      data: [
        {
          id: 're_existing',
          amount: input.amountCents,
          status: 'succeeded',
          metadata: { hx_quote_recovery_key: input.recoveryKey },
        },
      ],
    });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: true,
      data: { disposition: 'REFUNDED', providerOperationId: 're_existing' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('reconciles a manual full refund without issuing a duplicate refund', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({
      data: [
        {
          id: 're_manual_full',
          amount: input.amountCents,
          status: 'succeeded',
          metadata: {},
        },
      ],
    });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: true,
      data: { disposition: 'REFUNDED', providerOperationId: 're_manual_full' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('refunds only the remaining amount after a terminal partial refund', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({
      data: [
        {
          id: 're_manual_partial',
          amount: 2_500,
          status: 'succeeded',
          metadata: {},
        },
      ],
    });
    mocks.createRefund.mockResolvedValueOnce({
      id: 're_remaining',
      amount: 10_000,
      status: 'succeeded',
      metadata: { hx_quote_recovery_key: input.recoveryKey },
    });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: true,
      data: { disposition: 'REFUNDED', providerOperationId: 're_remaining' },
    });
    expect(mocks.createRefund.mock.calls[0]?.[0]).toMatchObject({ amount: 10_000 });
  });

  it('reconciles a retried remainder refund against the complete refund total', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({
      data: [
        {
          id: 're_remaining',
          amount: 10_000,
          status: 'succeeded',
          metadata: { hx_quote_recovery_key: input.recoveryKey },
        },
        {
          id: 're_manual_partial',
          amount: 2_500,
          status: 'succeeded',
          metadata: {},
        },
      ],
    });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: true,
      data: { disposition: 'REFUNDED', providerOperationId: 're_remaining' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('keeps canonical state unchanged for a nonterminal refund', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({
      data: [
        {
          id: 're_pending',
          amount: input.amountCents,
          status: 'pending',
          metadata: { hx_quote_recovery_key: input.recoveryKey },
        },
      ],
    });

    const result = await StripeQuotePaymentProvider.recoverOrphanPayment(input);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PAYMENT_REFUND_PENDING' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('does not overlap an unrelated nonterminal refund', async () => {
    mocks.retrieve.mockResolvedValueOnce(payment('succeeded'));
    mocks.listRefunds.mockResolvedValueOnce({
      data: [
        {
          id: 're_manual_pending',
          amount: 2_500,
          status: 'pending',
          metadata: {},
        },
      ],
    });

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
    [
      { metadata: { quote_id: input.quoteId, quote_version_id: 'wrong' } },
      'PAYMENT_QUOTE_VERSION_MISMATCH',
    ],
    [
      {
        metadata: {
          quote_id: input.quoteId,
          quote_version_id: input.quoteVersionId,
          poster_id: 'wrong',
        },
      },
      'PAYMENT_POSTER_MISMATCH',
    ],
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
