import type { PaymentProvider } from './PaymentProvider.js';
import { StripePaymentProvider } from './StripePaymentProvider.js';
import { LocalCertificationPaymentProviderAdapter } from './LocalCertificationPaymentProviderAdapter.js';

export type PaymentProviderName = 'stripe' | 'local_test';

export function resolvePaymentProvider(
  provider: PaymentProviderName,
): PaymentProvider {
  switch (provider) {
    case 'stripe':
      return StripePaymentProvider;

    case 'local_test':
      return LocalCertificationPaymentProviderAdapter;
    default:
        throw new Error(`Unsupported payment provider: ${provider}`);
  }
}