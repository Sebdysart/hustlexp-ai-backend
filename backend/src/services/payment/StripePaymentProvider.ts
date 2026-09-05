import type {
  PaymentProvider,
  VerifySucceededPaymentInput,
} from './PaymentProvider.js';

import { StripeService } from '../StripeService.js';
import { stripeBreaker } from '../../middleware/circuit-breaker.js';
import { getStripe } from '../../routers/escrow-common.js';

export const StripePaymentProvider: PaymentProvider = {
  async createPaymentIntent(input) {
    const result = await StripeService.createPaymentIntent({
      taskId: input.taskId,
      posterId: input.posterId,
      escrowId: input.escrowId,
      amount: input.amountCents,
      platformFeeCents: input.platformFeeCents,
      description: input.description,
    });

    if (!result.success) {
      return result;
    }

    return {
      success: true,
      data: {
        paymentIntentId: result.data.paymentIntentId,
        clientSecret: result.data.clientSecret,
        amountCents: result.data.amount,
      },
    };
  },

  async verifySucceededPayment(input: VerifySucceededPaymentInput) {
    try {
      const paymentIntent = await stripeBreaker.execute(() =>
        getStripe().paymentIntents.retrieve(
          input.paymentIntentId,
          { expand: ['latest_charge'] },
        ),
      );

      if (paymentIntent.livemode) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_MODE_MISMATCH',
            message: 'Live Stripe payments are not allowed in this environment',
          },
        };
      }

      if (paymentIntent.status !== 'succeeded') {
        return {
          success: false,
          error: {
            code: 'PAYMENT_NOT_SUCCEEDED',
            message: `Payment intent has not succeeded (status: ${paymentIntent.status})`,
          },
        };
      }

      if (paymentIntent.amount !== input.amountCents) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_AMOUNT_MISMATCH',
            message: 'Payment intent amount does not match escrow amount',
          },
        };
      }

      if (paymentIntent.currency !== 'usd') {
        return {
          success: false,
          error: {
            code: 'PAYMENT_CURRENCY_MISMATCH',
            message: 'Payment intent currency does not match escrow currency',
          },
        };
      }

      if (paymentIntent.metadata?.task_id !== input.taskId) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_TASK_MISMATCH',
            message: 'Payment intent was not created for this task',
          },
        };
      }

      if (paymentIntent.metadata?.escrow_id !== input.escrowId) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_ESCROW_MISMATCH',
            message: 'Payment intent was not created for this escrow',
          },
        };
      }

      if (paymentIntent.metadata?.poster_id !== input.posterId) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_POSTER_MISMATCH',
            message: 'Payment intent was not created for this poster',
          },
        };
      }

      const charge = paymentIntent.latest_charge;

      if (
        typeof charge === 'object'
        && charge !== null
        && 'refunded' in charge
        && charge.refunded === true
      ) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_ALREADY_REFUNDED',
            message: 'Payment intent has already been refunded and cannot be reused',
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
          message: 'Payment intent could not be verified',
        },
      };
    }
  }
};