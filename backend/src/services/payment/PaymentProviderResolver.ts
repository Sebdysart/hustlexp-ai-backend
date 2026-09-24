import type { PaymentProvider } from './PaymentProvider.js';
import { TRPCError } from '@trpc/server';
import { LocalCertificationPaymentProviderAdapter } from './LocalCertificationPaymentProviderAdapter.js';

export type PaymentProviderName = 'tilled' | 'local_test';

/** Live marketplace checkout is quote-bound. Direct escrow funding is test-only. */
export function resolvePaymentProvider(provider: PaymentProviderName): PaymentProvider {
  if (provider === 'local_test') return LocalCertificationPaymentProviderAdapter;
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Direct task payment is unavailable. Use the accepted quote checkout.' });
}
