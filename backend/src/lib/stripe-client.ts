/**
 * stripe-client.ts — shared, lazily-initialized Stripe SDK instance.
 *
 * AUDIT FIX M5 (2026-06-11): featured/escrow/subscription routers each ran
 * `new Stripe(...)` inline (some per-request) and called the SDK with no
 * circuit breaker. One shared client; ALL calls must be wrapped in
 * `stripeBreaker.execute(...)` at the call site.
 */

import Stripe from 'stripe';
import { config } from '../config.js';

let client: Stripe | null = null;

/** Shared Stripe client, or null when Stripe is not configured. */
export function getSharedStripe(): Stripe | null {
  if (!client && config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
    client = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });
  }
  return client;
}
