import type { LegacyQuotePaymentRecoveryPort } from './LegacyQuotePaymentRecoveryPort.js';
import { StripeQuotePaymentRecoveryProvider } from './StripeQuotePaymentProvider.js';

export type SupportedLegacyQuotePaymentProvider = 'stripe';

export function isSupportedLegacyQuotePaymentProvider(
  persistedProvider: string
): persistedProvider is SupportedLegacyQuotePaymentProvider {
  return persistedProvider === 'stripe';
}

/**
 * Resolve only from the exact persisted quote_payments.provider value. Caller
 * input and environment variables are deliberately not accepted here.
 */
export function resolveQuotePaymentRecoveryProvider(
  persistedProvider: string
): LegacyQuotePaymentRecoveryPort {
  if (persistedProvider === 'stripe') return StripeQuotePaymentRecoveryProvider;
  throw new Error('LEGACY_QUOTE_PAYMENT_PROVIDER_UNSUPPORTED');
}
