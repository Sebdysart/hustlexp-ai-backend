import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  cancel: vi.fn(),
  breaker: vi.fn((operation: () => Promise<unknown>) => operation()),
  error: vi.fn(),
  config: { stripe: { secretKey: 'sk_test_controlled' } },
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = { retrieve: mocks.retrieve, cancel: mocks.cancel };
  },
}));
vi.mock('../../src/config', () => ({
  config: mocks.config,
}));
vi.mock('../../src/middleware/circuit-breaker', () => ({
  stripeBreaker: { execute: mocks.breaker },
}));
vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: mocks.error },
}));

import { StripePaymentIntentCancellationService } from '../../src/services/StripePaymentIntentCancellationService';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.stripe.secretKey = 'sk_test_controlled';
});

describe('StripePaymentIntentCancellationService', () => {
  it('cancels an unconfirmed PaymentIntent', async () => {
    mocks.retrieve.mockResolvedValueOnce({ id: 'pi_1', status: 'requires_payment_method' });
    mocks.cancel.mockResolvedValueOnce({ id: 'pi_1', status: 'canceled' });
    await expect(StripePaymentIntentCancellationService.cancel('pi_1')).resolves.toEqual({
      success: true,
      data: { paymentIntentId: 'pi_1', status: 'canceled', canceled: true, idempotencyReplayed: false },
    });
  });

  it('replays an already-canceled PaymentIntent without a second provider write', async () => {
    mocks.retrieve.mockResolvedValueOnce({ id: 'pi_1', status: 'canceled' });
    await expect(StripePaymentIntentCancellationService.cancel('pi_1')).resolves.toMatchObject({
      success: true,
      data: { canceled: true, idempotencyReplayed: true },
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('returns succeeded truth for automatic refund escalation', async () => {
    mocks.retrieve.mockResolvedValueOnce({ id: 'pi_1', status: 'succeeded' });
    await expect(StripePaymentIntentCancellationService.cancel('pi_1')).resolves.toMatchObject({
      success: true,
      data: { status: 'succeeded', canceled: false, idempotencyReplayed: false },
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('fails loud when the provider cannot read or cancel the PaymentIntent', async () => {
    mocks.retrieve.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(StripePaymentIntentCancellationService.cancel('pi_1')).resolves.toMatchObject({
      success: false,
      error: { code: 'STRIPE_ERROR', message: 'provider unavailable' },
    });
    expect(mocks.error).toHaveBeenCalled();
  });

  it('fails closed before provider access when Stripe is not configured', async () => {
    mocks.config.stripe.secretKey = 'placeholder';
    await expect(StripePaymentIntentCancellationService.cancel('pi_1')).resolves.toEqual({
      success: false,
      error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
    });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
