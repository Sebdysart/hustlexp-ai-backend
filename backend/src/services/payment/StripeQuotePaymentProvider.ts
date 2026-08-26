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

function reconciliationRequired(message: string): ReturnType<typeof recoveryFailure> {
  return recoveryFailure('PAYMENT_REFUND_RECONCILIATION_REQUIRED', message);
}

function resourceId(
  resource: string | { id?: string } | null | undefined,
): string | null {
  if (typeof resource === 'string') return resource;
  if (resource && typeof resource.id === 'string') return resource.id;
  return null;
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

function validateSucceededPaymentFacts(
  paymentIntent: {
    amount_received: number;
    currency: string;
    latest_charge?: string | { id?: string } | null;
  },
  input: RecoverQuotePaymentInput,
): { success: true; chargeId: string } | ReturnType<typeof recoveryFailure> {
  if (paymentIntent.amount_received !== input.amountCents) {
    return reconciliationRequired(
      'Payment amount received does not prove the exact quote payment amount',
    );
  }
  if (paymentIntent.currency !== 'usd') {
    return reconciliationRequired('Quote payment recovery requires USD processor facts');
  }
  const chargeId = resourceId(paymentIntent.latest_charge);
  if (!chargeId) {
    return reconciliationRequired('Payment does not identify one charge for refund reconciliation');
  }
  return { success: true, chargeId };
}

function terminalRefundResult(
  refund: {
    id: string;
    amount: number;
    status: string | null;
    currency: string;
    payment_intent?: string | { id?: string } | null;
    charge?: string | { id?: string } | null;
    metadata?: Record<string, string> | null;
  },
  paymentIntentId: string,
  chargeId: string,
  amountCents: number,
  expectedRecoveryKey?: string,
): { success: true; data: RecoverQuotePaymentResult } | ReturnType<typeof recoveryFailure> {
  if (refund.status !== 'succeeded') {
    if (refund.status === 'failed' || refund.status === 'canceled') {
      return reconciliationRequired('Recovery-key refund terminated without succeeding');
    }
    return recoveryFailure(
      'PAYMENT_REFUND_PENDING',
      'Refund has not reached a terminal successful state',
    );
  }
  if (
    refund.amount !== amountCents
    || refund.currency !== 'usd'
    || resourceId(refund.payment_intent) !== paymentIntentId
    || resourceId(refund.charge) !== chargeId
    || (
      expectedRecoveryKey !== undefined
      && refund.metadata?.hx_quote_recovery_key !== expectedRecoveryKey
    )
  ) {
    return reconciliationRequired(
      'Refund does not prove one exact full USD refund for the payment and charge',
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
        const paymentFacts = validateSucceededPaymentFacts(paymentIntent, input);
        if (!paymentFacts.success) return paymentFacts;

        const existingRefunds = await stripeBreaker.execute(() =>
          stripe.refunds.list({ payment_intent: paymentIntent.id, limit: 100 }),
        );
        if (existingRefunds.has_more) {
          return recoveryFailure(
            'PAYMENT_REFUND_RECONCILIATION_INCOMPLETE',
            'Refund history exceeds the bounded reconciliation window',
          );
        }
        const recoveryRefunds = existingRefunds.data.filter(
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
        if (recoveryRefunds.length > 1) {
          return reconciliationRequired('Multiple refunds claim the same recovery key');
        }
        const recoveryRefund = recoveryRefunds[0];
        if (
          recoveryRefund
          && (recoveryRefund.status === 'failed' || recoveryRefund.status === 'canceled')
        ) {
          return reconciliationRequired('Recovery-key refund terminated without succeeding');
        }

        if (existingRefunds.data.length > 0) {
          const succeededRefunds = existingRefunds.data.filter(
            (refund) => refund.status === 'succeeded',
          );
          if (succeededRefunds.length !== 1) {
            return reconciliationRequired(
              'Refund history does not contain one authoritative successful refund',
            );
          }
          const succeededRefund = succeededRefunds[0]!;
          if (recoveryRefund && recoveryRefund.id !== succeededRefund.id) {
            return reconciliationRequired(
              'Recovery-key refund conflicts with a different successful refund',
            );
          }
          return terminalRefundResult(
            succeededRefund,
            paymentIntent.id,
            paymentFacts.chargeId,
            input.amountCents,
            recoveryRefund ? input.recoveryKey : undefined,
          );
        }

        const refund = await stripeBreaker.execute(() =>
          stripe.refunds.create(
            {
              payment_intent: paymentIntent.id,
              amount: input.amountCents,
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
        return terminalRefundResult(
          refund,
          paymentIntent.id,
          paymentFacts.chargeId,
          input.amountCents,
          input.recoveryKey,
        );
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
