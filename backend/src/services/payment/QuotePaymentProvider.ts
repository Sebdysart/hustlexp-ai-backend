import type { ServiceResult } from '../../types.js';

export interface CreateQuotePaymentInput {
  localPaymentId: string;
  taskDraftId: string;
  organizationId: string;
  merchantAccountId: string;
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  amountCents: number;
  platformFeeCents: number;
  description?: string;
}

export interface VerifyQuotePaymentInput {
  localPaymentId: string;
  taskDraftId: string;
  organizationId: string;
  merchantAccountId: string;
  platformFeeCents: number;
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
    status?: string;
  }>>;

  verifySucceededPayment(
    input: VerifyQuotePaymentInput,
  ): Promise<ServiceResult<void>>;
}
