import { TRPCError } from '@trpc/server';
import Stripe from 'stripe';
import { config } from '../config.js';

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripe) {
    if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payment processing is not configured' });
    }
    stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });
  }
  return stripe;
}
