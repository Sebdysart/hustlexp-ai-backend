import { describe, expect, it } from 'vitest';

import {
  isSupportedLegacyQuotePaymentProvider,
  resolveQuotePaymentRecoveryProvider,
} from '../../src/services/payment/QuotePaymentRecoveryProviderResolver.js';

describe('legacy quote payment recovery provider resolver', () => {
  it('resolves only the exact persisted historical Stripe key', () => {
    expect(isSupportedLegacyQuotePaymentProvider('stripe')).toBe(true);
    const provider = resolveQuotePaymentRecoveryProvider('stripe');
    expect(provider.persistedProvider).toBe('stripe');
    expect(provider.recoverOrphanPayment).toEqual(expect.any(Function));
    expect(provider).not.toHaveProperty('createPaymentIntent');
    expect(provider).not.toHaveProperty('verifySucceededPayment');
  });

  it.each(['STRIPE', 'fake', 'external', '', ' stripe '])(
    'fails closed for unsupported persisted provider %j',
    (persistedProvider) => {
      expect(isSupportedLegacyQuotePaymentProvider(persistedProvider)).toBe(false);
      expect(() => resolveQuotePaymentRecoveryProvider(persistedProvider)).toThrow(
        'LEGACY_QUOTE_PAYMENT_PROVIDER_UNSUPPORTED'
      );
    }
  );
});
