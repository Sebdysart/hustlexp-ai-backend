import type { ServiceResult } from '../../types.js';

export interface CreatePaymentIntentInput {
  taskId: string;
  posterId: string;
  escrowId: string;
  amountCents: number;
  platformFeeCents?: number | null;
  description?: string;
}

export interface PaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
  amountCents: number;
}

export interface VerifySucceededPaymentInput {
  paymentIntentId: string;
  escrowId: string;
  taskId: string;
  posterId: string;
  amountCents: number;
}

export interface PaymentProvider {
  createPaymentIntent(
    input: CreatePaymentIntentInput,
  ): Promise<ServiceResult<PaymentIntentResult>>;

  verifySucceededPayment(
    input: VerifySucceededPaymentInput,
  ): Promise<ServiceResult<void>>;
}