import type {
  QuotePaymentProvider,
  CreateQuotePaymentInput,
  VerifyQuotePaymentInput,
} from './QuotePaymentProvider.js';

import { StripeService } from '../StripeService.js';
import { stripeBreaker } from '../../middleware/circuit-breaker.js';
import { getStripe } from '../../routers/escrow-common.js';

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
};