import type { PaymentProvider } from './PaymentProvider.js';
import { TRPCError } from '@trpc/server';
import { StripePaymentProvider } from './StripePaymentProvider.js';
import { LocalCertificationPaymentProviderAdapter } from './LocalCertificationPaymentProviderAdapter.js';

export type PaymentProviderName = 'stripe' | 'stax' | 'local_test';

export function resolvePaymentProvider(
  provider: PaymentProviderName,
): PaymentProvider {
  switch (provider) {
    case 'stripe':
      return StripePaymentProvider;
    case 'stax':
      // The generic task/escrow adapter cannot create or verify a Stax intent.
      // The separate quote and assessment chargers do not make this rail usable.
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Stax task payment is not available.' });

    case 'local_test':
      return LocalCertificationPaymentProviderAdapter;
    default:
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No supported task payment provider is configured.' });
  }
}
