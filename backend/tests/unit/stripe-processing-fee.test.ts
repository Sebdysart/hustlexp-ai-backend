import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStripe } = vi.hoisted(() => ({
  mockStripe: {
    paymentIntents: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
    balanceTransactions: { retrieve: vi.fn() },
  },
}));

vi.mock('stripe', () => ({
  default: vi.fn(function StripeConstructor() { return mockStripe; }),
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: 'sk_test_processing_fee',
      webhookSecret: 'whsec_test',
      minimumTaskValueCents: 500,
      platformFeePercent: 15,
    },
  },
}));

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  stripeBreaker: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
  CircuitBreaker: vi.fn(),
  CircuitOpenError: class CircuitOpenError extends Error { retryAfterMs = 0; },
}));

import { StripeService } from '../../src/services/StripeService.js';

describe('StripeService.getPaymentIntentProcessingFee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the actual fee from an expanded charge balance transaction', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_fee',
      latest_charge: {
        id: 'ch_fee',
        balance_transaction: {
          id: 'txn_fee',
          fee: 320,
          currency: 'usd',
        },
      },
    });

    await expect(StripeService.getPaymentIntentProcessingFee('pi_fee')).resolves.toEqual({
      success: true,
      data: {
        paymentIntentId: 'pi_fee',
        chargeId: 'ch_fee',
        balanceTransactionId: 'txn_fee',
        feeCents: 320,
        currency: 'usd',
      },
    });
    expect(mockStripe.charges.retrieve).not.toHaveBeenCalled();
    expect(mockStripe.balanceTransactions.retrieve).not.toHaveBeenCalled();
  });

  it('resolves unexpanded charge and balance transaction references', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_refs',
      latest_charge: 'ch_refs',
    });
    mockStripe.charges.retrieve.mockResolvedValueOnce({
      id: 'ch_refs',
      balance_transaction: 'txn_refs',
    });
    mockStripe.balanceTransactions.retrieve.mockResolvedValueOnce({
      id: 'txn_refs',
      fee: 145,
      currency: 'usd',
    });

    const result = await StripeService.getPaymentIntentProcessingFee('pi_refs');
    expect(result).toMatchObject({ success: true, data: { feeCents: 145 } });
    expect(mockStripe.charges.retrieve).toHaveBeenCalledWith(
      'ch_refs',
      { expand: ['balance_transaction'] },
    );
    expect(mockStripe.balanceTransactions.retrieve).toHaveBeenCalledWith('txn_refs');
  });

  it('fails closed when the PaymentIntent has no charge', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_open', latest_charge: null });

    const result = await StripeService.getPaymentIntentProcessingFee('pi_open');
    expect(result).toMatchObject({
      success: false,
      error: { code: 'STRIPE_FEE_UNAVAILABLE' },
    });
  });

  it('fails closed when Stripe has not settled the fee', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_unsettled',
      latest_charge: { id: 'ch_unsettled', balance_transaction: null },
    });

    const result = await StripeService.getPaymentIntentProcessingFee('pi_unsettled');
    expect(result).toMatchObject({
      success: false,
      error: { code: 'STRIPE_FEE_UNAVAILABLE' },
    });
  });

  it('accepts a settled zero-cent processing fee as valid provider evidence', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_zero_fee',
      latest_charge: {
        id: 'ch_zero_fee',
        balance_transaction: { id: 'txn_zero_fee', fee: 0, currency: 'usd' },
      },
    });

    await expect(StripeService.getPaymentIntentProcessingFee('pi_zero_fee')).resolves.toMatchObject({
      success: true,
      data: { feeCents: 0, chargeId: 'ch_zero_fee', balanceTransactionId: 'txn_zero_fee' },
    });
  });

  it('fails closed on negative settled-fee evidence', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_negative_fee',
      latest_charge: {
        id: 'ch_negative_fee',
        balance_transaction: { id: 'txn_negative_fee', fee: -1, currency: 'usd' },
      },
    });

    await expect(StripeService.getPaymentIntentProcessingFee('pi_negative_fee')).resolves.toMatchObject({
      success: false,
      error: { code: 'STRIPE_FEE_UNAVAILABLE' },
    });
  });

  it('returns a provider error without fabricating a fee', async () => {
    mockStripe.paymentIntents.retrieve.mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await StripeService.getPaymentIntentProcessingFee('pi_error');
    expect(result).toEqual({
      success: false,
      error: { code: 'STRIPE_ERROR', message: 'provider unavailable' },
    });
  });

  it('fails closed when Stripe is not configured', async () => {
    vi.resetModules();
    vi.doMock('../../src/config', () => ({
      config: {
        stripe: {
          secretKey: '',
          webhookSecret: '',
          minimumTaskValueCents: 500,
          platformFeePercent: 15,
        },
      },
    }));
    const { StripeService: unconfiguredService } = await import('../../src/services/StripeService.js');

    await expect(unconfiguredService.getPaymentIntentProcessingFee('pi_unconfigured')).resolves.toEqual({
      success: false,
      error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
    });
  });
});
