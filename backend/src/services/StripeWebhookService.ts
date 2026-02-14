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

import { db } from '../db';
import { writeToOutbox } from '../jobs/outbox-helpers';
import Stripe from 'stripe';
import { config } from '../config';

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

function getStripeClient(): Stripe {
  if (!stripe) {
    if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
      throw new Error('Stripe not configured');
    }
    stripe = new Stripe(config.stripe.secretKey, {
      apiVersion: '2025-12-15.clover',
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

  if (!config.stripe.webhookSecret || config.stripe.webhookSecret.includes('placeholder')) {
    return {
      success: false,
      error: {
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe webhook secret not configured',
      },
    };
  }

  let event: Stripe.Event;
  try {
    const stripeClient = getStripeClient();
    event = stripeClient.webhooks.constructEvent(
      rawBody,
      signature,
      config.stripe.webhookSecret
    );
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'WEBHOOK_VERIFICATION_FAILED',
        message: error instanceof Error ? error.message : 'Webhook verification failed',
      },
    };
  }

  // Store event and enqueue processing
  return await handleStripeWebhook(event);
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
      // Note: writeToOutbox uses db.query directly, which works within transaction
      // TODO: Refactor writeToOutbox to accept transaction parameter for true atomicity
      await writeToOutbox({
        eventType: 'stripe.event_received',
        aggregateType: 'stripe_event',
        aggregateId: stripeEventId,
        eventVersion: 1,
        idempotencyKey: `stripe.event_received:${stripeEventId}`,
        payload: { stripeEventId, type },
        queueName: 'critical_payments',
      });

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
