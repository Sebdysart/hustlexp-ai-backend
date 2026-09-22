import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/LocalCertificationPaymentProvider.js', () => ({
  LocalCertificationPaymentProvider: { createIntent: vi.fn(), verifySucceededIntent: vi.fn() },
}));

import { resolvePaymentProvider, type PaymentProviderName } from '../../src/services/payment/PaymentProviderResolver.js';
import { LocalCertificationPaymentProviderAdapter } from '../../src/services/payment/LocalCertificationPaymentProviderAdapter.js';
import { configuredQuotePaymentProvider } from '../../src/services/payment/TilledConfig.js';

describe('supported payment provider selection', () => {
  it('selects the controlled local test adapter for direct escrow payment', () => {
    expect(resolvePaymentProvider('local_test')).toBe(LocalCertificationPaymentProviderAdapter);
  });

  it('requires the quote-bound checkout for live Tilled payments', () => {
    expect(() => resolvePaymentProvider('tilled')).toThrow('Use the accepted quote checkout');
    expect(configuredQuotePaymentProvider({ QUOTE_PAYMENT_PROVIDER: 'tilled' })).toBe('tilled');
  });

  it.each(['stripe', 'stax', 'unknown'])('rejects unsupported provider %s instead of falling back', (provider) => {
    expect(() => resolvePaymentProvider(provider as PaymentProviderName)).toThrow();
    expect(() => configuredQuotePaymentProvider({ QUOTE_PAYMENT_PROVIDER: provider })).toThrow('Unsupported quote payment provider');
  });
});
