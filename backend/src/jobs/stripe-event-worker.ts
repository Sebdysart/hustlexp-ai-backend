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
import { workerLogger } from '../logger';
const log = workerLogger.child({ worker: 'stripe-event' });

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
    log.info({ stripeEventId }, 'Stripe event already processed, skipping');
    return;
  }

  const { payload_json, type } = claim.rows[0];
  const event = payload_json as unknown as StripeEventEnvelope;

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

      case 'account.updated':
        await handleAccountUpdated(event);
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
        log.warn({ type }, 'Unhandled Stripe event type');
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

    log.info({ type, stripeEventId }, 'Stripe event processed');
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

    log.error({ type, stripeEventId, err: errorMessage }, 'Stripe event failed');
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
  log.info({ stripeEventId }, 'checkout.session.completed without expanded subscription, waiting for customer.subscription.* events');
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

async function handleAccountUpdated(event: StripeEventEnvelope): Promise<void> {
  const account = getEventObject<Record<string, any>>(event);
  if (!account) throw new Error('account.updated missing account object');

  const accountId = account.id as string;
  if (!accountId) throw new Error('account.updated missing account.id');

  // Look up user by stripe_connect_account_id
  const userResult = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE stripe_connect_account_id = $1',
    [accountId]
  );

  if (userResult.rows.length === 0) {
    log.warn({ accountId }, 'No user found for Stripe Connect account');
    return;
  }

  const userId = userResult.rows[0].id;
  const detailsSubmitted = account.details_submitted as boolean;
  const payoutsEnabled = account.payouts_enabled as boolean;
  const chargesEnabled = account.charges_enabled as boolean;

  // Determine connect status
  let connectStatus = 'not_started';
  if (detailsSubmitted && payoutsEnabled && chargesEnabled) {
    connectStatus = 'active';
  } else if (detailsSubmitted) {
    connectStatus = 'pending_verification';
  } else {
    connectStatus = 'onboarding';
  }

  // Sync status to DB
  await db.query(
    `UPDATE users SET
       stripe_connect_status = $1,
       payouts_enabled = $2,
       charges_enabled = $3,
       updated_at = NOW()
     WHERE id = $4`,
    [connectStatus, payoutsEnabled, chargesEnabled, userId]
  );

  // Check if requirements became past_due
  const requirements = account.requirements as Record<string, any> | undefined;
  if (requirements?.currently_due?.length > 0) {
    const { NotificationService } = await import('../services/NotificationService');
    await NotificationService.createNotification({
      userId,
      category: 'security_alert',
      title: 'Action Required: Stripe Connect',
      body: 'Your Stripe Connect account requires additional information. Please update your details to continue receiving payments.',
      deepLink: 'app://settings/payments',
      channels: ['in_app', 'push'],
      priority: 'HIGH',
    }).catch(err => log.error({ err: err instanceof Error ? err.message : String(err), userId }, 'Failed to send Stripe requirements notification'));
  }

  log.info({ userId, accountId, connectStatus, payoutsEnabled, chargesEnabled }, 'Stripe Connect status synced');
}
