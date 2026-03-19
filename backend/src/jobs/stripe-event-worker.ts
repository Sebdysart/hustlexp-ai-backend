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

import { db } from '../db.js';
import { processSubscriptionEvent } from '../services/StripeSubscriptionProcessor.js';
import { processEntitlementPurchase } from '../services/StripeEntitlementProcessor.js';
import { EscrowService } from '../services/EscrowService.js';
import { RevenueService } from '../services/RevenueService.js';
import { ChargebackService } from '../services/ChargebackService.js';
import { verifyJobSignature } from './queues.js';
import type { Job } from 'bullmq';
import { workerLogger } from '../logger.js';
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

  // HMAC signature verification (Attack 12 — Redis injection defence)
  // stripe.event_received jobs dispatched via the outbox carry a _sig field inside
  // job.data.payload. Verify it when present; direct-dispatch jobs (without _sig) are
  // allowed through so that legacy callers are not broken.
  const outerPayload = (job.data as Record<string, unknown>).payload;
  if (outerPayload && typeof outerPayload === 'object') {
    const p = outerPayload as Record<string, unknown>;
    if ('_sig' in p) {
      const { _sig, ...payloadWithoutSig } = p;
      if (!verifyJobSignature(payloadWithoutSig, _sig as string)) {
        log.error(
          { jobId: job.id, stripeEventId },
          'Job signature verification failed — possible Redis injection attack',
        );
        throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
      }
    }
  }

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
        // Step 1: Process per-task entitlements (Step 9-D)
        await processEntitlementPurchase(event, stripeEventId);
        // Step 2: Fund escrow — PENDING → FUNDED (idempotent: state='PENDING' guard)
        await fundEscrowForPaymentIntent(event);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(event);
        break;

      case 'charge.dispute.created':
        await handleChargeDisputeCreated(event, stripeEventId);
        break;

      case 'charge.dispute.updated':
        await handleChargeDisputeUpdated(event, stripeEventId);
        break;

      case 'charge.dispute.closed':
        await handleChargeDisputeClosed(event, stripeEventId);
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

    // Release the claim so BullMQ retries can re-claim this event.
    // CRITICAL: Do NOT set processed_at here — that would prevent all retries.
    // processed_at is a terminal tombstone and must only be set on success or
    // after BullMQ exhausts all retry attempts.
    await db.query(
      `
      UPDATE stripe_events
      SET result = 'failed',
          claimed_at = NULL,
          error_message = $2
      WHERE stripe_event_id = $1
      `,
      [stripeEventId, errorMessage]
    );

    log.error({ type, stripeEventId, err: errorMessage }, 'Stripe event failed — claim released for retry');
    throw error; // Re-throw for BullMQ retry logic
  }
}

function getEventObject<T = Record<string, unknown>>(event: StripeEventEnvelope): T | null {
  return (event?.data?.object as T) || null;
}

/**
 * Fund any PENDING escrow linked to this payment intent.
 *
 * This is the critical PENDING → FUNDED transition that was previously missing.
 * It is idempotent: the WHERE state = 'PENDING' guard ensures we only act once;
 * subsequent webhook deliveries for the same event are safe no-ops.
 */
async function fundEscrowForPaymentIntent(event: StripeEventEnvelope): Promise<void> {
  const paymentIntent = getEventObject<{ id: string }>(event);
  if (!paymentIntent?.id) {
    log.warn({ eventId: event.id }, 'payment_intent.succeeded: missing payment intent id, skipping escrow funding');
    return;
  }

  const paymentIntentId = paymentIntent.id;

  // Look up a PENDING escrow for this payment intent
  const escrowResult = await db.query<{ id: string }>(
    `SELECT id FROM escrows WHERE stripe_payment_intent_id = $1 AND state = 'PENDING'`,
    [paymentIntentId]
  );

  if (escrowResult.rows.length === 0) {
    // No PENDING escrow — either there is no escrow for this payment intent
    // (entitlement-only payment) or it was already funded (idempotent replay).
    log.info({ paymentIntentId }, 'payment_intent.succeeded: no PENDING escrow found, skipping escrow funding');
    return;
  }

  const escrowId = escrowResult.rows[0].id;
  const result = await EscrowService.fund({ escrowId, stripePaymentIntentId: paymentIntentId });

  if (!result.success) {
    throw new Error(`Failed to fund escrow ${escrowId} for payment_intent ${paymentIntentId}: ${result.error.message}`);
  }

  log.info({ escrowId, paymentIntentId }, 'Escrow funded via payment_intent.succeeded (PENDING → FUNDED)');
}

async function handleCheckoutSessionCompleted(
  event: StripeEventEnvelope,
  stripeEventId: string
): Promise<void> {
  const session = getEventObject<Record<string, unknown>>(event);

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
  const invoice = getEventObject<Record<string, unknown>>(event);

  if (!invoice) {
    throw new Error('invoice.payment_failed missing invoice object');
  }

  const userId = (invoice.metadata as Record<string, string> | undefined)?.user_id;
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
  const account = getEventObject<Record<string, unknown>>(event);
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
  const requirements = account.requirements as Record<string, unknown> | undefined;
  const currentlyDue = requirements?.currently_due as unknown[] | undefined;
  if (currentlyDue && currentlyDue.length > 0) {
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

async function handleInvoicePaid(event: StripeEventEnvelope): Promise<void> {
  const invoice = getEventObject<Record<string, unknown>>(event);

  if (!invoice) {
    throw new Error('invoice.paid missing invoice object');
  }

  let userId = (invoice.metadata as Record<string, string> | undefined)?.user_id;
  const amountPaid = invoice.amount_paid as number | undefined;
  const customerId = invoice.customer as string | null | undefined;

  // If user_id is not in metadata (subscription created before metadata was
  // added, or metadata was stripped), attempt to resolve via stripe_customer_id.
  if (!userId && customerId) {
    const userResult = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );
    userId = userResult.rows[0]?.id;
  }

  if (!(amountPaid && amountPaid > 0)) {
    return;
  }

  if (userId) {
    await RevenueService.logEvent({
      eventType: 'subscription',
      userId,
      amountCents: amountPaid,
      stripeEventId: event.id,
    });
  } else {
    // Could not resolve user — log with 'system' so revenue is still captured
    // and ops can reconcile via customer_id in metadata.
    log.warn(
      { invoiceId: event.id, amountPaid, customerId: customerId ?? null },
      'invoice.paid: could not resolve user_id, logging revenue with system'
    );
    await RevenueService.logEvent({
      eventType: 'subscription',
      userId: 'system',
      amountCents: amountPaid,
      stripeEventId: event.id,
      metadata: { customer_id: customerId ?? null, unresolved_user: true },
    });
  }
}

async function handleChargeDisputeCreated(
  event: StripeEventEnvelope,
  stripeEventId: string
): Promise<void> {
  const dispute = getEventObject<Record<string, unknown>>(event);
  if (!dispute) throw new Error('charge.dispute.created missing dispute object');

  await ChargebackService.handleDisputeCreated({
    stripeDisputeId: dispute.id as string,
    stripeChargeId: dispute.charge as string,
    stripePaymentIntentId: (dispute.payment_intent as string | null) ?? null,
    stripeEventId,
    amountCents: dispute.amount as number,
    currency: (dispute.currency as string) || 'usd',
    reason: (dispute.reason as string | null) ?? null,
  });
}

async function handleChargeDisputeUpdated(
  event: StripeEventEnvelope,
  stripeEventId: string
): Promise<void> {
  const dispute = getEventObject<Record<string, unknown>>(event);
  if (!dispute) throw new Error('charge.dispute.updated missing dispute object');

  await ChargebackService.handleDisputeUpdated({
    stripeDisputeId: dispute.id as string,
    stripeEventId,
    status: dispute.status as string,
    reason: (dispute.reason as string | null) ?? null,
  });
}

async function handleChargeDisputeClosed(
  event: StripeEventEnvelope,
  stripeEventId: string
): Promise<void> {
  const dispute = getEventObject<Record<string, unknown>>(event);
  if (!dispute) throw new Error('charge.dispute.closed missing dispute object');

  const rawStatus = dispute.status as string;
  const status: 'won' | 'lost' = rawStatus === 'won' ? 'won' : 'lost';

  await ChargebackService.handleDisputeClosed({
    stripeDisputeId: dispute.id as string,
    stripeEventId,
    status,
    reason: (dispute.reason as string | null) ?? null,
  });
}
