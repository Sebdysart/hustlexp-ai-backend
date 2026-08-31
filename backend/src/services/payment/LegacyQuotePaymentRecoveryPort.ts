import type { ServiceResult } from '../../types.js';

export type QuotePaymentRecoveryReason =
  | 'UNDERWRITING_CONTAINMENT'
  | 'POSTER_REQUESTED_CANCELLATION';

export interface RecoverLegacyQuoteFinancialSecurityInput {
  /** Opaque historical provider reference; interpreted only by its adapter. */
  externalReference: string;
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  amountCents: number;
  recoveryKey: string;
  reasonCode: QuotePaymentRecoveryReason;
}

export interface RecoverLegacyQuoteFinancialSecurityResult {
  disposition: 'VOIDED' | 'REFUNDED';
  providerStatus: string;
  providerOperationId: string;
}

/**
 * Negative-effect-only compatibility port for quote payments recorded before
 * Universal V1. It intentionally has no create, confirm, verify, or capture
 * operation.
 */
export interface LegacyQuotePaymentRecoveryPort {
  readonly persistedProvider: string;
  recoverOrphanPayment(
    input: RecoverLegacyQuoteFinancialSecurityInput
  ): Promise<ServiceResult<RecoverLegacyQuoteFinancialSecurityResult>>;
}
