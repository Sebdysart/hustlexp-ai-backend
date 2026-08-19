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
}