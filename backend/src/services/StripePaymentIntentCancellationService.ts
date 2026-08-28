import Stripe from 'stripe';
import { config } from '../config.js';
import { stripeLogger } from '../logger.js';
import { stripeBreaker } from '../middleware/circuit-breaker.js';
import type { ServiceResult } from '../types.js';

export interface PaymentIntentCancellationResult {
  paymentIntentId: string;
  status: string;
  canceled: boolean;
  idempotencyReplayed: boolean;
}

export type PaymentIntentCancellationPlan = 'NO_PROVIDER_WRITE' | 'CANCEL' | 'REFUND';

export function classifyPaymentIntentCancellation(status: string): PaymentIntentCancellationPlan {
  if (status === 'canceled') return 'NO_PROVIDER_WRITE';
  if (status === 'succeeded') return 'REFUND';
  return 'CANCEL';
}

function stripeClient(): Stripe | null {
  const secret = config.stripe.secretKey;
  if (!secret || secret.includes('placeholder')) return null;
  return new Stripe(secret, { apiVersion: '2025-11-17.clover' });
}

function providerFailure(error: unknown): ServiceResult<PaymentIntentCancellationResult> {
  return {
    success: false,
    error: {
      code: 'STRIPE_ERROR',
      message: error instanceof Error ? error.message : 'Unknown Stripe error',
    },
  };
}

export const StripePaymentIntentCancellationService = {
  cancel: async (paymentIntentId: string): Promise<ServiceResult<PaymentIntentCancellationResult>> => {
    const stripe = stripeClient();
    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }
    try {
      const current = await stripeBreaker.execute(() => stripe.paymentIntents.retrieve(paymentIntentId));
      const plan = classifyPaymentIntentCancellation(current.status);
      if (plan !== 'CANCEL') {
        return {
          success: true,
          data: {
            paymentIntentId: current.id,
            status: current.status,
            canceled: plan === 'NO_PROVIDER_WRITE',
            idempotencyReplayed: plan === 'NO_PROVIDER_WRITE',
          },
        };
      }
      const canceled = await stripeBreaker.execute(() => stripe.paymentIntents.cancel(paymentIntentId));
      return {
        success: true,
        data: {
          paymentIntentId: canceled.id,
          status: canceled.status,
          canceled: canceled.status === 'canceled',
          idempotencyReplayed: false,
        },
      };
    } catch (error) {
      stripeLogger.error({ paymentIntentId, err: error }, 'PaymentIntent cancellation failed');
      return providerFailure(error);
    }
  },
};

export default StripePaymentIntentCancellationService;
