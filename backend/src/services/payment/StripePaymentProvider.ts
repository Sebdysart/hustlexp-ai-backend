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

      if (paymentIntent.metadata?.task_id !== input.taskId) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_TASK_MISMATCH',
            message: 'Payment intent was not created for this task',
          },
        };
      }

      const charge = paymentIntent.latest_charge;

      if (
        typeof charge === 'object' &&
        charge !== null &&
        'refunded' in charge &&
        charge.refunded === true
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
  },
};