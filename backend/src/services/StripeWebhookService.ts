/**
 * StripeWebhookService v1.0.0
 * 
 * Step 9-D - Stripe Integration: Webhook ingestion and idempotency
 * 
 * Responsibility:
 * - Verify Stripe webhook signature
 * - Store Stripe events exactly once (Invariant S-1)
 * - Enqueue async processing via outbox
 * - No business logic (delegated to workers)
 * 
 * Hard rules:
 * - All writes are idempotent (ON CONFLICT DO NOTHING)
 * - Time authority: DB NOW() for processing timestamps
 * - No plan mutations in webhook path
 * 
 * @see STEP_9D_STRIPE_INTEGRATION.md
 * @see backend/tests/invariants/stripe-monetization.test.ts
 */

import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import Stripe from 'stripe';
import { config } from '../config.js';
import {
  STRIPE_WEBHOOK_API_VERSION,
  stripeWebhookEventAllowed,
  type StripeWebhookDestination,
} from './StripeWebhookTopology.js';

// ============================================================================
// TYPES
// ============================================================================

export interface StripeWebhookEvent {
  id: string; // stripe_event_id (evt_xxx)
  type: string; // customer.subscription.created, etc.
  created: number; // Unix timestamp
  data: {
    object: Record<string, unknown>;
  };
}

export interface WebhookResult {
  success: boolean;
  stripeEventId?: string;
  error?: {
    code: string;
    message: string;
  };
}

// ============================================================================
// WEBHOOK SERVICE
// ============================================================================

let stripe: Stripe | null = null;

interface VerifiedStripeEvent {
  destination: StripeWebhookDestination;
  event: Stripe.Event;
}

function usableWebhookSecret(secret: string | undefined): secret is string {
  return Boolean(secret && !secret.includes('placeholder'));
}

function webhookDestinations(): Array<{
  destination: StripeWebhookDestination;
  secret: string;
}> {
  const platformSecret = config.stripe.webhookSecret;
  const connectSecret = config.stripe.connectWebhookSecret;
  if (
    usableWebhookSecret(platformSecret)
    && usableWebhookSecret(connectSecret)
    && platformSecret === connectSecret
  ) {
    return [];
  }
  return [
    ...(usableWebhookSecret(platformSecret)
      ? [{ destination: 'platform' as const, secret: platformSecret }]
      : []),
    ...(usableWebhookSecret(connectSecret)
      ? [{ destination: 'connect' as const, secret: connectSecret }]
      : []),
  ];
}

function eventHasConnectAccount(event: Stripe.Event): boolean {
  return typeof event.account === 'string' && event.account.length > 0;
}

function destinationMatches(
  destination: StripeWebhookDestination,
  event: Stripe.Event,
): boolean {
  const connectScoped = eventHasConnectAccount(event);
  return destination === 'connect' ? connectScoped : !connectScoped;
}

function verifyStripeEvent(
  rawBody: string,
  signature: string,
): VerifiedStripeEvent | { error: string; mismatch: boolean } {
  const destinations = webhookDestinations();
  if (destinations.length === 0) {
    return { error: 'Stripe webhook secrets not configured or are ambiguous', mismatch: false };
  }
  const stripeClient = getStripeClient();
  let firstError: string | null = null;
  for (const candidate of destinations) {
    try {
      const event = stripeClient.webhooks.constructEvent(
        rawBody,
        signature,
        candidate.secret,
      );
      if (
        !destinationMatches(candidate.destination, event)
        || !stripeWebhookEventAllowed(candidate.destination, event.type)
      ) {
        return {
          error: `Stripe ${candidate.destination} webhook received an event outside its authority`,
          mismatch: true,
        };
      }
      return { destination: candidate.destination, event };
    } catch (error) {
      firstError ??= error instanceof Error ? error.message : 'Webhook verification failed';
    }
  }
  return { error: firstError ?? 'Webhook verification failed', mismatch: false };
}

function getStripeClient(): Stripe {
  if (!stripe) {
    if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
      throw new Error('Stripe not configured');
    }
    stripe = new Stripe(config.stripe.secretKey, {
      apiVersion: STRIPE_WEBHOOK_API_VERSION,
    });
  }
  return stripe;
}

/**
 * Process Stripe webhook - verify signature and store event
 * 
 * Invariant S-1: Stripe events are processed at most once
 * - PRIMARY KEY on stripe_event_id enforces single ingestion
 * - ON CONFLICT DO NOTHING makes replay safe
 * 
 * Invariant S-2: Time authority comes from DB NOW(), not app clock
 * - Stripe `created` timestamp is stored for audit
 * - Processing timestamps use DB NOW()
 */
export async function processWebhook(
  rawBody: string,
  signature: string | undefined
): Promise<WebhookResult> {
  // Verify webhook signature
  if (!signature) {
    return {
      success: false,
      error: {
        code: 'WEBHOOK_SECRET_MISSING',
        message: 'Missing stripe-signature header',
      },
    };
  }

  let verified: ReturnType<typeof verifyStripeEvent>;
  try {
    verified = verifyStripeEvent(rawBody, signature);
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'WEBHOOK_VERIFICATION_FAILED',
        message: error instanceof Error ? error.message : 'Webhook verification failed',
      },
    };
  }
  if ('error' in verified) {
    return {
      success: false,
      error: {
        code: verified.mismatch
          ? 'WEBHOOK_DESTINATION_MISMATCH'
          : webhookDestinations().length === 0
            ? 'STRIPE_NOT_CONFIGURED'
            : 'WEBHOOK_VERIFICATION_FAILED',
        message: verified.error,
      },
    };
  }

  // Store event and enqueue processing
  return await handleStripeWebhook(verified.event);
}

/**
 * Handle Stripe webhook event - store and enqueue
 * 
 * Internal function - called after signature verification
 */
async function handleStripeWebhook(event: Stripe.Event): Promise<WebhookResult> {
  const { id: stripeEventId, type, created } = event;

  try {
    // Transaction: Store Stripe event exactly once
    const result = await db.transaction(async (tx) => {
      // Insert Stripe event (idempotent - S-1)
      const insert = await tx<{ stripe_event_id: string }>(
        `
        INSERT INTO stripe_events (
          stripe_event_id,
          type,
          created,
          payload_json
        )
        VALUES ($1, $2, to_timestamp($3), $4::jsonb)
        ON CONFLICT (stripe_event_id) DO NOTHING
        RETURNING stripe_event_id
        `,
        [stripeEventId, type, created, JSON.stringify(event)]
      );

      // Idempotent replay → exit early (S-1)
      if (insert.rowCount === 0) {
        return { stored: false, stripeEventId };
      }

      // Enqueue async processing (NO LOGIC HERE)
      // Processing happens in stripe-event-worker
      // Pass tx to writeToOutbox for true transaction atomicity (same connection)
      await writeToOutbox({
        eventType: 'stripe.event_received',
        aggregateType: 'stripe_event',
        aggregateId: stripeEventId,
        eventVersion: 1,
        idempotencyKey: `stripe.event_received:${stripeEventId}`,
        payload: { stripeEventId, type },
        queueName: 'critical_payments',
      }, tx);

      return { stored: true, stripeEventId };
    });

    return {
      success: true,
      stripeEventId: result.stripeEventId,
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'WEBHOOK_STORAGE_FAILED',
        message: error instanceof Error ? error.message : 'Failed to store webhook event',
      },
    };
  }
}

// Export for backward compatibility
export const StripeWebhookService = {
  processWebhook,
};
