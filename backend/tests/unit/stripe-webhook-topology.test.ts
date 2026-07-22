import { describe, expect, it } from 'vitest';
import { stripeEventDestination } from '../../src/jobs/stripe-event-dispatcher';
import {
  STRIPE_CONNECT_WEBHOOK_EVENTS,
  STRIPE_PLATFORM_WEBHOOK_EVENTS,
  STRIPE_WEBHOOK_API_VERSION,
  stripeWebhookEventAllowed,
} from '../../src/services/StripeWebhookTopology';

describe('Stripe webhook destination topology', () => {
  it('pins the event payload version to the runtime Stripe contract', () => {
    expect(STRIPE_WEBHOOK_API_VERSION).toBe('2025-11-17.clover');
  });

  it('keeps platform and Connect event subscriptions disjoint', () => {
    const platform = new Set(STRIPE_PLATFORM_WEBHOOK_EVENTS);
    expect(STRIPE_CONNECT_WEBHOOK_EVENTS.filter((type) => platform.has(type as never))).toEqual([]);
  });

  it('routes every declared event to an implemented worker authority', () => {
    for (const eventType of STRIPE_PLATFORM_WEBHOOK_EVENTS) {
      expect(['payment', 'stripe']).toContain(stripeEventDestination(eventType));
      expect(stripeWebhookEventAllowed('platform', eventType)).toBe(true);
      expect(stripeWebhookEventAllowed('connect', eventType)).toBe(false);
    }
    for (const eventType of STRIPE_CONNECT_WEBHOOK_EVENTS) {
      expect(['payout', 'stripe']).toContain(stripeEventDestination(eventType));
      expect(stripeWebhookEventAllowed('connect', eventType)).toBe(true);
      expect(stripeWebhookEventAllowed('platform', eventType)).toBe(false);
    }
  });
});
