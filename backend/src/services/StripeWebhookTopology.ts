import type Stripe from 'stripe';

export const STRIPE_WEBHOOK_API_VERSION = '2025-11-17.clover' as const;

export const STRIPE_PLATFORM_WEBHOOK_EVENTS = Object.freeze([
  'charge.dispute.closed',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.refunded',
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.deleted',
  'customer.subscription.updated',
  'invoice.paid',
  'invoice.payment_failed',
  'payment_intent.payment_failed',
  'payment_intent.succeeded',
  'transfer.created',
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[]);

export const STRIPE_CONNECT_WEBHOOK_EVENTS = Object.freeze([
  'account.updated',
  'payout.canceled',
  'payout.created',
  'payout.failed',
  'payout.paid',
  'payout.updated',
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[]);

export type StripeWebhookDestination = 'platform' | 'connect';

const PLATFORM_EVENTS = new Set<string>(STRIPE_PLATFORM_WEBHOOK_EVENTS);
const CONNECT_EVENTS = new Set<string>(STRIPE_CONNECT_WEBHOOK_EVENTS);

export function stripeWebhookEventAllowed(
  destination: StripeWebhookDestination,
  eventType: string,
): boolean {
  return destination === 'platform'
    ? PLATFORM_EVENTS.has(eventType)
    : CONNECT_EVENTS.has(eventType);
}
