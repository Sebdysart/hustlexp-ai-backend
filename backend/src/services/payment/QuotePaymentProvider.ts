import type { ServiceResult } from '../../types.js';

export interface CreateQuotePaymentInput {
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  amountCents: number;
  platformFeeCents?: number | null;
  description?: string;
}

export interface VerifyQuotePaymentInput {
  paymentIntentId: string;
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  amountCents: number;
}

export type QuotePaymentRecoveryReason =
  | 'UNDERWRITING_CONTAINMENT'
  | 'POSTER_REQUESTED_CANCELLATION';

export interface RecoverQuotePaymentInput extends VerifyQuotePaymentInput {
  recoveryKey: string;
  reasonCode: QuotePaymentRecoveryReason;
}

export interface RecoverQuotePaymentResult {
  disposition: 'VOIDED' | 'REFUNDED';
  providerStatus: string;
  providerOperationId: string;
}

export interface QuotePaymentProvider {
  createPaymentIntent(
    input: CreateQuotePaymentInput,
  ): Promise<ServiceResult<{
    paymentIntentId: string;
    clientSecret: string;
    amountCents: number;
  }>>;

  verifySucceededPayment(
    input: VerifyQuotePaymentInput,
  ): Promise<ServiceResult<void>>;

  recoverOrphanPayment(
    input: RecoverQuotePaymentInput,
  ): Promise<ServiceResult<RecoverQuotePaymentResult>>;
}
