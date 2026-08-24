import type {
  QuotePaymentProvider,
  CreateQuotePaymentInput,
  RecoverQuotePaymentInput,
  RecoverQuotePaymentResult,
  VerifyQuotePaymentInput,
} from './QuotePaymentProvider.js';

import { StripeService } from '../StripeService.js';
import { stripeBreaker } from '../../middleware/circuit-breaker.js';
import { getStripe } from '../../routers/escrow-common.js';

function recoveryFailure(
  code: string,
  message: string,
): { success: false; error: { code: string; message: string } } {
  return { success: false, error: { code, message } };
}

function validatePaymentIdentity(
  paymentIntent: {
    amount: number;
    metadata?: Record<string, string> | null;
  },
  input: RecoverQuotePaymentInput,
): ReturnType<typeof recoveryFailure> | null {
  if (paymentIntent.amount !== input.amountCents) {
    return recoveryFailure('PAYMENT_AMOUNT_MISMATCH', 'Payment amount does not match quote amount');
  }
  if (paymentIntent.metadata?.quote_id !== input.quoteId) {
    return recoveryFailure('PAYMENT_QUOTE_MISMATCH', 'Payment was not created for this quote');
  }
  if (paymentIntent.metadata?.quote_version_id !== input.quoteVersionId) {
    return recoveryFailure(
      'PAYMENT_QUOTE_VERSION_MISMATCH',
      'Payment was not created for this quote version',
    );
  }
  if (paymentIntent.metadata?.poster_id !== input.posterId) {
    return recoveryFailure('PAYMENT_POSTER_MISMATCH', 'Payment does not belong to this poster');
  }
  return null;
}

function terminalRefundResult(
  refund: { id: string; amount: number; status: string | null },
  amountCents: number,
): { success: true; data: RecoverQuotePaymentResult } | ReturnType<typeof recoveryFailure> {
  if (refund.amount !== amountCents) {
    return recoveryFailure('PAYMENT_REFUND_AMOUNT_MISMATCH', 'Refund amount does not match quote amount');
  }
  if (refund.status !== 'succeeded') {
    return recoveryFailure(
      refund.status === 'failed' || refund.status === 'canceled'
        ? 'PAYMENT_REFUND_FAILED'
        : 'PAYMENT_REFUND_PENDING',
      'Refund has not reached a terminal successful state',
    );
  }
  return {
    success: true,
    data: {
      disposition: 'REFUNDED',
      providerStatus: refund.status,
      providerOperationId: refund.id,
    },
  };
}

export const StripeQuotePaymentProvider: QuotePaymentProvider = {
  async createPaymentIntent(input: CreateQuotePaymentInput) {
    return StripeService.createQuotePaymentIntent(input);
  },

  async verifySucceededPayment(input: VerifyQuotePaymentInput) {
    try {
      const paymentIntent = await stripeBreaker.execute(() =>
        getStripe().paymentIntents.retrieve(
          input.paymentIntentId,
        ),
      );

      if (paymentIntent.status !== 'succeeded') {
        return {
          success: false,
          error: {
            code: 'PAYMENT_NOT_SUCCEEDED',
            message:
              `Payment intent has not succeeded (status: ${paymentIntent.status})`,
          },
        };
      }

      if (paymentIntent.amount !== input.amountCents) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_AMOUNT_MISMATCH',
            message: 'Payment amount does not match quote amount',
          },
        };
      }

      if (paymentIntent.metadata?.quote_id !== input.quoteId) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_QUOTE_MISMATCH',
            message: 'Payment was not created for this quote',
          },
        };
      }

      if (
        paymentIntent.metadata?.quote_version_id
        !== input.quoteVersionId
      ) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_QUOTE_VERSION_MISMATCH',
            message: 'Payment was not created for this quote version',
          },
        };
      }

      if (paymentIntent.metadata?.poster_id !== input.posterId) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_POSTER_MISMATCH',
            message: 'Payment does not belong to this poster',
          },
        };
      }

      return {
        success: true,
        data: undefined,
      };
    } catch {
      return {
        success: false,
        error: {
          code: 'PAYMENT_VERIFICATION_FAILED',
          message: 'Payment could not be verified',
        },
      };
    }
  },

  async recoverOrphanPayment(input: RecoverQuotePaymentInput) {
    try {
      const stripe = getStripe();
      const paymentIntent = await stripeBreaker.execute(() =>
        stripe.paymentIntents.retrieve(input.paymentIntentId),
      );
      const identityFailure = validatePaymentIdentity(paymentIntent, input);
      if (identityFailure) return identityFailure;

      if (paymentIntent.status === 'canceled') {
        return {
          success: true,
          data: {
            disposition: 'VOIDED',
            providerStatus: paymentIntent.status,
            providerOperationId: paymentIntent.id,
          },
        };
      }

      if (paymentIntent.status === 'succeeded') {
        const existingRefunds = await stripeBreaker.execute(() =>
          stripe.refunds.list({ payment_intent: paymentIntent.id, limit: 100 }),
        );
        if (existingRefunds.has_more) {
          return recoveryFailure(
            'PAYMENT_REFUND_RECONCILIATION_INCOMPLETE',
            'Refund history exceeds the bounded reconciliation window',
          );
        }
        const existingRefund = existingRefunds.data.find(
          (refund) => refund.metadata?.hx_quote_recovery_key === input.recoveryKey,
        );
        if (existingRefunds.data.some(
          (refund) => !['succeeded', 'failed', 'canceled'].includes(refund.status ?? ''),
        )) {
          return recoveryFailure(
            'PAYMENT_REFUND_PENDING',
            'An existing refund has not reached a terminal state',
          );
        }
        const refundedAmount = existingRefunds.data
          .filter((refund) => refund.status === 'succeeded')
          .reduce((sum, refund) => sum + refund.amount, 0);
        if (refundedAmount > input.amountCents) {
          return recoveryFailure(
            'PAYMENT_REFUND_AMOUNT_MISMATCH',
            'Recorded refunds exceed the quote payment amount',
          );
        }
        if (refundedAmount === input.amountCents) {
          const reconciledRefund = existingRefund ?? existingRefunds.data.find(
            (refund) => refund.status === 'succeeded',
          );
          if (!reconciledRefund) {
            return recoveryFailure('PAYMENT_RECOVERY_FAILED', 'Refund reconciliation failed');
          }
          return {
            success: true,
            data: {
              disposition: 'REFUNDED',
              providerStatus: 'succeeded',
              providerOperationId: reconciledRefund.id,
            },
          };
        }
        if (existingRefund) {
          return recoveryFailure(
            existingRefund.status === 'succeeded'
              ? 'PAYMENT_REFUND_AMOUNT_MISMATCH'
              : 'PAYMENT_REFUND_FAILED',
            'Existing recovery refund does not prove a complete refund',
          );
        }
        const remainingAmount = input.amountCents - refundedAmount;

        const refund = await stripeBreaker.execute(() =>
          stripe.refunds.create(
            {
              payment_intent: paymentIntent.id,
              amount: remainingAmount,
              reason: 'requested_by_customer',
              metadata: {
                hx_quote_recovery_key: input.recoveryKey,
                quote_id: input.quoteId,
                quote_version_id: input.quoteVersionId,
                poster_id: input.posterId,
                reason_code: input.reasonCode,
              },
            },
            { idempotencyKey: `quote_recovery_refund_${input.recoveryKey}` },
          ),
        );
        return terminalRefundResult(refund, remainingAmount);
      }

      const canceled = await stripeBreaker.execute(() =>
        stripe.paymentIntents.cancel(
          paymentIntent.id,
          { cancellation_reason: 'requested_by_customer' },
          { idempotencyKey: `quote_recovery_void_${input.recoveryKey}` },
        ),
      );
      if (canceled.status !== 'canceled') {
        return recoveryFailure(
          'PAYMENT_VOID_NOT_TERMINAL',
          'Payment cancellation has not reached a terminal state',
        );
      }
      return {
        success: true,
        data: {
          disposition: 'VOIDED',
          providerStatus: canceled.status,
          providerOperationId: canceled.id,
        },
      };
    } catch {
      return recoveryFailure('PAYMENT_RECOVERY_FAILED', 'Payment recovery could not be completed');
    }
  },
};
