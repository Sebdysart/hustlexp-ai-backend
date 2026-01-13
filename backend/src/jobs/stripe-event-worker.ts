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
import type { Job } from 'bullmq';

// ============================================================================
// TYPES
// ============================================================================

interface StripeEventJobData {
  stripeEventId: string;
  type: string;
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

  try {
    // Dispatch by type (SKELETON ONLY - no business logic here)
    switch (type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await processSubscriptionEvent(payload_json, stripeEventId);
        break;

      case 'checkout.session.completed':
        // SKELETON: Handler not implemented - pending approval
        throw new Error(
          `Stripe event ${type} received, but handler not implemented. ` +
          'Implementation pending approval.'
        );

      case 'payment_intent.succeeded':
        // SKELETON: Handler not implemented - pending approval
        // Note: Phase D handles escrow funding for payment_intent.succeeded
        // This handler is for per-task entitlements (Step 9-D) - separate concern
        throw new Error(
          `Stripe event ${type} received, but entitlement handler not implemented. ` +
          'Implementation pending approval.'
        );

      case 'invoice.payment_failed':
        // SKELETON: Handler not implemented - pending approval
        throw new Error(
          `Stripe event ${type} received, but handler not implemented. ` +
          'Implementation pending approval.'
        );

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
