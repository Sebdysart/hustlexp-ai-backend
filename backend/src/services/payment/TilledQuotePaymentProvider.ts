import type { ServiceResult } from '../../types.js';
import type { CreateQuotePaymentInput, QuotePaymentProvider, VerifyQuotePaymentInput } from './QuotePaymentProvider.js';
import { TilledClient, TilledApiError, type TilledPaymentIntent } from './TilledClient.js';
import { loadTilledConfig } from './TilledConfig.js';

export type NormalizedTilledStatus =
  | 'requires_payment_method' | 'requires_confirmation' | 'requires_action'
  | 'processing' | 'requires_capture' | 'succeeded' | 'canceled' | 'unknown';

export function normalizeTilledStatus(status: string): NormalizedTilledStatus {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
    case 'requires_capture':
    case 'succeeded':
    case 'canceled':
      return status;
    default:
      return 'unknown';
  }
}

function failure(code: string, message: string): Extract<ServiceResult<void>, { success: false }> {
  return { success: false, error: { code, message } };
}

export function validateTilledIntentBinding(
  intent: TilledPaymentIntent,
  input: VerifyQuotePaymentInput,
  requireSucceeded: boolean,
): ServiceResult<void> {
  if (intent.id !== input.paymentIntentId) return failure('PAYMENT_ID_MISMATCH', 'Payment identity does not match.');
  if (intent.account_id !== input.merchantAccountId) return failure('PAYMENT_ACCOUNT_MISMATCH', 'Payment merchant account does not match.');
  if (intent.amount !== input.amountCents) return failure('PAYMENT_AMOUNT_MISMATCH', 'Payment amount does not match the quote.');
  if (intent.currency !== 'usd') return failure('PAYMENT_CURRENCY_MISMATCH', 'Payment currency does not match.');
  if (intent.capture_method !== 'automatic') return failure('PAYMENT_CAPTURE_MISMATCH', 'Payment capture mode does not match.');
  if (intent.platform_fee_amount !== input.platformFeeCents) return failure('PAYMENT_FEE_MISMATCH', 'Payment fee does not match.');
  const expectedMetadata: Record<string, string> = {
    hustlexp_payment_id: input.localPaymentId,
    quote_id: input.quoteId,
    quote_version_id: input.quoteVersionId,
    task_draft_id: input.taskDraftId,
    organization_id: input.organizationId,
  };
  for (const [key, value] of Object.entries(expectedMetadata)) {
    if (intent.metadata?.[key] !== value) return failure('PAYMENT_METADATA_MISMATCH', 'Payment context does not match.');
  }
  const status = normalizeTilledStatus(intent.status);
  if (status === 'unknown') return failure('PAYMENT_STATUS_UNKNOWN', 'Payment status could not be verified.');
  if (requireSucceeded && status !== 'succeeded') {
    return failure('PAYMENT_NOT_SUCCEEDED', 'Payment has not completed.');
  }
  if (requireSucceeded && intent.amount_received !== input.amountCents) {
    return failure('PAYMENT_RECEIVED_MISMATCH', 'Payment received amount does not match.');
  }
  return { success: true, data: undefined };
}

export function tilledClient(): TilledClient {
  return new TilledClient(loadTilledConfig());
}

export const TilledQuotePaymentProvider: QuotePaymentProvider = {
  async createPaymentIntent(input: CreateQuotePaymentInput) {
    try {
      const intent = await tilledClient().createPaymentIntent({
        accountId: input.merchantAccountId,
        amountCents: input.amountCents,
        platformFeeCents: input.platformFeeCents,
        metadata: {
          hustlexp_payment_id: input.localPaymentId,
          quote_id: input.quoteId,
          quote_version_id: input.quoteVersionId,
          task_draft_id: input.taskDraftId,
          organization_id: input.organizationId,
        },
      });
      const bound = validateTilledIntentBinding(intent, {
        ...input, paymentIntentId: intent.id,
      }, false);
      if (!bound.success) return bound;
      if (!intent.client_secret) return failure('PAYMENT_CLIENT_SECRET_MISSING', 'Payment checkout is unavailable.');
      return { success: true, data: {
        paymentIntentId: intent.id,
        clientSecret: intent.client_secret,
        amountCents: intent.amount,
        status: intent.status,
      } };
    } catch (error) {
      return failure(error instanceof TilledApiError ? error.code : 'PAYMENT_CREATION_FAILED',
        'Payment checkout could not be started. Please retry later.');
    }
  },

  async verifySucceededPayment(input: VerifyQuotePaymentInput) {
    try {
      const intent = await tilledClient().getPaymentIntent(input.merchantAccountId, input.paymentIntentId);
      return validateTilledIntentBinding(intent, input, true);
    } catch (error) {
      return failure(error instanceof TilledApiError ? error.code : 'PAYMENT_VERIFICATION_FAILED',
        'Payment status could not be verified. Please retry later.');
    }
  },
};
