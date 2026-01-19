/**
 * Stripe Event Worker v1.0.0
 * 
 * Step 9-D - Stripe Integration: Process Stripe events from outbox
 * 
 * Responsibility:
 * - Claim and process Stripe events atomically
 * - Dispatch to appropriate processors
 * - Update processing status
 * 
 * Hard rules:
 * - Atomic claim prevents double processing (S-1)
 * - DB NOW() is authoritative for timestamps (S-2)
 * - All mutations are idempotent
 * 
 * @see STEP_9D_STRIPE_INTEGRATION.md
 */

import { db } from '../db';
import { processSubscriptionEvent } from '../services/StripeSubscriptionProcessor';
import { processEntitlementPurchase } from '../services/StripeEntitlementProcessor';
import type { Job } from 'bullmq';

// ============================================================================
// TYPES
// ============================================================================

interface StripeEventJobData {
  stripeEventId: string;
  type: string;
}

interface StripeEventEnvelope {
  id: string;
  data?: {
    object?: Record<string, unknown>;
  };
}

// ============================================================================
// WORKER
// ============================================================================

/**
 * Process Stripe event job
 * 
 * Invariant S-1: Atomic claim prevents double processing
 * - UPDATE with WHERE claimed_at IS NULL ensures single claim
 * - If already claimed/processed, returns early (no-op)
 * 
 * Invariant S-2: DB NOW() is authoritative
 * - claimed_at and processed_at use DB NOW()
 * - Not application Date.now()
 */
export async function processStripeEventJob(job: Job<StripeEventJobData>): Promise<void> {
  const { stripeEventId } = job.data;

  // Atomic claim (prevents double processing - S-1)
  const claim = await db.query<{
    payload_json: Record<string, unknown>;
    type: string;
  }>(
    `
    UPDATE stripe_events
    SET claimed_at = NOW(),
        result = 'processing',
        error_message = NULL
    WHERE stripe_event_id = $1
      AND claimed_at IS NULL
      AND processed_at IS NULL
    RETURNING payload_json, type
    `,
    [stripeEventId]
  );

  // Already claimed or processed → NO-OP (S-1)
  if (claim.rowCount === 0) {
    console.log(`ℹ️  Stripe event ${stripeEventId} already processed, skipping`);
    return;
  }

  const { payload_json, type } = claim.rows[0];
  const event = payload_json as StripeEventEnvelope;

  try {
    // Dispatch by type (SKELETON ONLY - no business logic here)
    switch (type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await processSubscriptionEvent(payload_json, stripeEventId);
        break;

      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event, stripeEventId);
        break;

      case 'payment_intent.succeeded':
        // Note: Phase D handles escrow funding for payment_intent.succeeded
        // This handler is for per-task entitlements (Step 9-D) - separate concern
        await processEntitlementPurchase(event, stripeEventId);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event);
        break;

      default:
        // Unknown events are explicitly skipped (not an error)
        await db.query(
          `
          UPDATE stripe_events
          SET result = 'skipped',
              processed_at = NOW(),
              error_message = 'Unhandled event type'
          WHERE stripe_event_id = $1
          `,
          [stripeEventId]
        );
        console.log(`ℹ️  Unhandled Stripe event type: ${type}`);
        return;
    }

    // Mark as successful (S-2: DB NOW() is authoritative)
    await db.query(
      `
      UPDATE stripe_events
      SET result = 'success',
          processed_at = NOW()
      WHERE stripe_event_id = $1
      `,
      [stripeEventId]
    );

    console.log(`✅ Stripe event processed: ${type} (${stripeEventId})`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Mark as failed (S-2: DB NOW() is authoritative)
    await db.query(
      `
      UPDATE stripe_events
      SET result = 'failed',
          processed_at = NOW(),
          error_message = $2
      WHERE stripe_event_id = $1
      `,
      [stripeEventId, errorMessage]
    );

    console.error(`❌ Stripe event failed: ${type} (${stripeEventId}): ${errorMessage}`);
    throw error; // Re-throw for BullMQ retry logic
  }
}

function getEventObject<T = Record<string, unknown>>(event: StripeEventEnvelope): T | null {
  return (event?.data?.object as T) || null;
}

async function handleCheckoutSessionCompleted(
  event: StripeEventEnvelope,
  stripeEventId: string
): Promise<void> {
  const session = getEventObject<Record<string, any>>(event);

  if (!session) {
    throw new Error('checkout.session.completed missing session object');
  }

  // If subscription is expanded in the session payload, process it directly.
  const subscription = session.subscription;
  if (subscription && typeof subscription === 'object') {
    await processSubscriptionEvent(subscription, stripeEventId);
    return;
  }

  // No subscription object available; rely on customer.subscription.* events.
  console.log(
    `ℹ️  checkout.session.completed received without expanded subscription; ` +
    `waiting for customer.subscription.* events (event: ${stripeEventId})`
  );
}

async function handleInvoicePaymentFailed(event: StripeEventEnvelope): Promise<void> {
  const invoice = getEventObject<Record<string, any>>(event);

  if (!invoice) {
    throw new Error('invoice.payment_failed missing invoice object');
  }

  const userId = invoice.metadata?.user_id;
  if (!userId) {
    throw new Error('invoice.payment_failed missing user_id metadata');
  }

  // Soft-expire: set plan_expires_at with 24h grace, but never shorten existing expiry.
  await db.query(
    `
    UPDATE users
    SET plan_expires_at = GREATEST(
      COALESCE(plan_expires_at, NOW()),
      NOW() + INTERVAL '24 hours'
    )
    WHERE id = $1
      AND plan IN ('premium', 'pro')
    `,
    [userId]
  );
}
