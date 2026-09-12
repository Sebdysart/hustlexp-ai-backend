import type { PaymentProvider } from './PaymentProvider.js';
import { StripePaymentProvider } from './StripePaymentProvider.js';
import { LocalCertificationPaymentProviderAdapter } from './LocalCertificationPaymentProviderAdapter.js';
import { StaxPaymentProvider } from './StaxPaymentProvider.js';

export type PaymentProviderName = 'stripe' | 'stax' | 'local_test';

export function resolvePaymentProvider(
  provider: PaymentProviderName,
): PaymentProvider {
  switch (provider) {
    case 'stripe':
      return StripePaymentProvider;
    case 'stax':
      return StaxPaymentProvider;

    case 'local_test':
      return LocalCertificationPaymentProviderAdapter;
    default:
        throw new Error(`Unsupported payment provider: ${provider}`);
  }
}