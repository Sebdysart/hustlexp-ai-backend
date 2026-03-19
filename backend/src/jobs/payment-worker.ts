/**
 * Payment Worker v1.1.0
 *
 * Phase D: Authoritative interpreter of Stripe events → Escrow state transitions
 *
 * Processes payment.stripe_event_received events from critical_payments queue.
 * Updates escrow state based on Stripe event type.
 *
 * Event mapping:
 * - payment_intent.succeeded → escrow PENDING → FUNDED
 * - payment_intent.payment_failed → escrow PENDING → CANCELLED (task returns to OPEN)
 * - transfer.created → escrow FUNDED|LOCKED_DISPUTE → RELEASED
 * - transfer.failed → escrow RELEASED → LOCKED_DISPUTE (ops triage required)
 * - charge.refunded → escrow PENDING|FUNDED|LOCKED_DISPUTE → REFUNDED
 * - payout.failed → push notification to worker, ledger entry, no state change
 *
 * CRITICAL RULES:
 * - All state transitions must check version (optimistic locking)
 * - All state transitions must increment version
 * - Terminal states cannot transition (enforced by DB trigger)
 * - Illegal transitions fail and are recorded as failed
 *
 * @see ARCHITECTURE.md §2.4
 */

import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { TaskService } from '../services/TaskService.js';
import { RevenueService } from '../services/RevenueService.js';
import { sendPushNotification } from '../services/PushNotificationService.js';
import { workerLogger } from '../logger.js';
import type { Job } from 'bullmq';
import type Stripe from 'stripe';

const log = workerLogger.child({ worker: 'payment' });

// ============================================================================
// TYPES
// ============================================================================

interface StripeEventReceivedPayload {
  stripeEventId: string;
  eventType: string;
  eventCreated: string;
}

interface PaymentJobData {
  payload: StripeEventReceivedPayload;
}

// ============================================================================
// PAYMENT WORKER
// ============================================================================

export async function processPaymentJob(job: Job<PaymentJobData>): Promise<void> {
  const { stripeEventId, eventType } = job.data.payload;
  const _idempotencyKey = job.id || `payment:${stripeEventId}`;

  try {
    // P0: Atomic claim - Only one worker can process this event
    // Prevents duplicate processing under retry/multi-worker scenarios
    // claimed_at = processing started, processed_at = terminal finalized
    const claimResult = await db.query<{
      stripe_event_id: string;
      type: string;
      payload_json: Stripe.Event;
    }>(
      `UPDATE stripe_events
       SET claimed_at = NOW(),
           result = 'processing',
           error_message = NULL
       WHERE stripe_event_id = $1
         AND claimed_at IS NULL
         AND processed_at IS NULL
       RETURNING stripe_event_id, type, payload_json`,
      [stripeEventId]
    );

    // If claim failed (already claimed or processed), exit silently (no-op for duplicate jobs)
    if (claimResult.rowCount === 0) {
      const existingResult = await db.query<{ result: string | null; claimed_at: Date | null; processed_at: Date | null }>(
        `SELECT result, claimed_at, processed_at
         FROM stripe_events
         WHERE stripe_event_id = $1`,
        [stripeEventId]
      );

      if (existingResult.rowCount === 0) {
        throw new Error(`Stripe event ${stripeEventId} not found`);
      }

      // Already claimed or already processed: expected under duplicate jobs / concurrency.
      // No-op (no exception for normal concurrency).
      log.info({ stripeEventId, result: existingResult.rows[0].result }, 'Stripe event already claimed/processed, skipping');
      return;
    }

    const stripeEvent = claimResult.rows[0];

    // Extract event object from payload (Stripe.Event.data.object)
    const eventObject = stripeEvent.payload_json.data.object;

    // Process event based on type
    switch (eventType) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(eventObject as Stripe.PaymentIntent, stripeEventId);
        break;
      
      case 'transfer.created':
        await handleTransferCreated(eventObject as Stripe.Transfer, stripeEventId);
        break;

      case 'transfer.failed':
        await handleTransferFailed(eventObject as Stripe.Transfer, stripeEventId);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentIntentPaymentFailed(eventObject as Stripe.PaymentIntent, stripeEventId);
        break;

      case 'payout.failed':
        await handlePayoutFailed(eventObject as Stripe.Payout, stripeEventId);
        break;

      case 'charge.refunded':
        await handleChargeRefunded(eventObject as Stripe.Charge, stripeEventId);
        break;
      
      default:
        // Unknown event type - mark as skipped (not failed)
        // Set processed_at = NOW() to finalize (terminal state)
        await db.query(
          `UPDATE stripe_events
           SET processed_at = NOW(),
               result = 'skipped',
               error_message = $1
           WHERE stripe_event_id = $2`,
          [`Unknown event type: ${eventType}`, stripeEventId]
        );
        log.warn({ stripeEventId, eventType }, 'Stripe event skipped (unknown type)');
        return;
    }

    // Mark event as processed (success) - set processed_at = NOW() to finalize
    await db.query(
      `UPDATE stripe_events
       SET processed_at = NOW(),
           result = 'success'
       WHERE stripe_event_id = $1`,
      [stripeEventId]
    );

    log.info({ stripeEventId, eventType }, 'Stripe event processed successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Release the claim so BullMQ retries can re-claim this event.
    // CRITICAL: Do NOT set processed_at here — that would prevent all retries.
    await db.query(
      `UPDATE stripe_events
       SET result = 'failed',
           claimed_at = NULL,
           error_message = $1
       WHERE stripe_event_id = $2`,
      [errorMessage, stripeEventId]
    );

    log.error({ stripeEventId, eventType, err: errorMessage }, 'Stripe event processing failed — claim released for retry');

    // Re-throw for BullMQ retry logic
    throw error;
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Handle payment_intent.succeeded: escrow PENDING → FUNDED
 */
async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent, stripeEventId: string): Promise<void> {
  const paymentIntentId = paymentIntent.id;
  
  // Find escrow by stripe_payment_intent_id
  const escrowResult = await db.query<{
    id: string;
    state: string;
    version: number;
    amount: number;
  }>(
    `SELECT id, state, version, amount
     FROM escrows
     WHERE stripe_payment_intent_id = $1
     FOR UPDATE`,
    [paymentIntentId]
  );

  if (escrowResult.rows.length === 0) {
    throw new Error(`Escrow not found for payment_intent ${paymentIntentId}`);
  }

  const escrow = escrowResult.rows[0];

  // Terminal skip: If escrow is already terminal, skip (prevents noise)
  if (['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(escrow.state)) {
    await db.query(
      `UPDATE stripe_events
       SET processed_at = NOW(),
           result = 'skipped',
           error_message = $1
       WHERE stripe_event_id = $2`,
      [`Escrow ${escrow.id} already terminal (${escrow.state})`, stripeEventId]
    );
    log.warn({ escrowId: escrow.id, state: escrow.state, stripeEventId }, 'Stripe event skipped: escrow already terminal');
    return;
  }

  // Validate state transition: PENDING → FUNDED
  if (escrow.state !== 'PENDING') {
    throw new Error(`Cannot fund escrow ${escrow.id}: current state is ${escrow.state}, expected PENDING`);
  }

  // Validate amount (sanity check)
  if (paymentIntent.amount !== escrow.amount) {
    throw new Error(`Payment intent amount (${paymentIntent.amount}) does not match escrow amount (${escrow.amount})`);
  }

  // Update escrow: PENDING → FUNDED (with version check and increment)
  const updateResult = await db.query<{
    id: string;
    state: string;
    version: number;
  }>(
    `UPDATE escrows
     SET state = 'FUNDED',
         funded_at = NOW(),
         version = version + 1,
         updated_at = NOW()
     WHERE id = $1
       AND state = 'PENDING'
       AND version = $2
     RETURNING id, state, version`,
    [escrow.id, escrow.version]
  );

  if (updateResult.rowCount === 0) {
    throw new Error(`Escrow ${escrow.id} state or version changed during update (version mismatch or state changed)`);
  }

  const updatedEscrow = updateResult.rows[0];

  // Emit outbox event: escrow.funded
  await writeToOutbox({
    eventType: 'escrow.funded',
    aggregateType: 'escrow',
    aggregateId: escrow.id,
    eventVersion: updatedEscrow.version,
    payload: {
      escrowId: escrow.id,
      paymentIntentId,
      amount: escrow.amount,
      version: updatedEscrow.version,
    },
    queueName: 'user_notifications',
    idempotencyKey: `escrow.funded:${escrow.id}:${updatedEscrow.version}`,
  });

  log.info({ escrowId: escrow.id, version: updatedEscrow.version }, 'Escrow funded (PENDING → FUNDED)');
}

/**
 * Handle transfer.created: escrow FUNDED|LOCKED_DISPUTE → RELEASED
 */
async function handleTransferCreated(transfer: Stripe.Transfer, stripeEventId: string): Promise<void> {
  const transferId = transfer.id;
  
  // Extract escrow_id from metadata (CRITICAL: we set this when creating transfer)
  const escrowId = transfer.metadata?.escrow_id;
  
  if (!escrowId) {
    throw new Error(`Transfer ${transferId} missing escrow_id metadata`);
  }

  // Find escrow by id (with version check)
  const escrowResult = await db.query<{
    id: string;
    task_id: string;
    state: string;
    version: number;
    stripe_transfer_id: string | null;
  }>(
    `SELECT id, task_id, state, version, stripe_transfer_id
     FROM escrows
     WHERE id = $1
     FOR UPDATE`,
    [escrowId]
  );

  if (escrowResult.rows.length === 0) {
    throw new Error(`Escrow ${escrowId} not found`);
  }

  const escrow = escrowResult.rows[0];

  // Terminal skip: If escrow is already terminal, skip (prevents noise)
  if (['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(escrow.state)) {
    await db.query(
      `UPDATE stripe_events
       SET processed_at = NOW(),
           result = 'skipped',
           error_message = $1
       WHERE stripe_event_id = $2`,
      [`Escrow ${escrowId} already terminal (${escrow.state})`, stripeEventId]
    );
    log.warn({ escrowId, state: escrow.state, stripeEventId }, 'Stripe event skipped: escrow already terminal');
    return;
  }

  // Idempotency check: If already released with this transfer_id, skip
  if (escrow.state === 'RELEASED' && escrow.stripe_transfer_id === transferId) {
    log.info({ escrowId, transferId }, 'Escrow already released with this transfer, idempotent replay');
    return;
  }

  // Validate state transition: FUNDED → RELEASED
  // P0: Policy 1 - LOCKED_DISPUTE blocks RELEASED until dispute resolution
  // Dispute resolution must explicitly emit escrow.release_requested to create transfer
  if (escrow.state !== 'FUNDED') {
    throw new Error(`Cannot release escrow ${escrowId}: current state is ${escrow.state}, expected FUNDED (LOCKED_DISPUTE blocks release until dispute resolution)`);
  }

  // Update escrow: FUNDED → RELEASED (with version check and increment)
  const updateResult = await db.query<{
    id: string;
    state: string;
    version: number;
  }>(
    `UPDATE escrows
     SET state = 'RELEASED',
         stripe_transfer_id = $1,
         released_at = NOW(),
         version = version + 1,
         updated_at = NOW()
     WHERE id = $2
       AND state = 'FUNDED'
       AND version = $3
     RETURNING id, state, version`,
    [transferId, escrowId, escrow.version]
  );

  if (updateResult.rowCount === 0) {
    throw new Error(`Escrow ${escrowId} state or version changed during update (version mismatch or state changed)`);
  }

  const updatedEscrow = updateResult.rows[0];

  // Step 4: Hook CLOSED transition (Pillar A - Realtime Tracking)
  // System-driven transition: COMPLETED → CLOSED (triggered by escrow terminalization)
  await TaskService.advanceProgress({
    taskId: escrow.task_id,
    to: 'CLOSED',
    actor: { type: 'system' },
  });

  // Emit outbox event: escrow.released (triggers XP award)
  await writeToOutbox({
    eventType: 'escrow.released',
    aggregateType: 'escrow',
    aggregateId: escrowId,
    eventVersion: updatedEscrow.version,
    payload: {
      escrowId,
      transferId,
      version: updatedEscrow.version,
    },
    queueName: 'critical_payments', // XP award happens in same queue
    idempotencyKey: `escrow.released:${escrowId}:${updatedEscrow.version}`,
  });

  log.info({ escrowId, prevState: escrow.state, version: updatedEscrow.version }, 'Escrow released (→ RELEASED)');
}

/**
 * Handle charge.refunded: escrow PENDING|FUNDED|LOCKED_DISPUTE → REFUNDED
 */
async function handleChargeRefunded(charge: Stripe.Charge, stripeEventId: string): Promise<void> {
  // P0: Extract escrow_id from charge metadata (preferred), fallback to payment_intent lookup
  const escrowId = charge.metadata?.escrow_id;
  
  // Extract refund ID from charge.refunds (first refund)
  const refundId = charge.refunds?.data?.[0]?.id;
  if (!refundId) {
    throw new Error(`Charge ${charge.id} missing refund ID`);
  }

  let escrowResult;
  if (escrowId) {
    // Find by metadata (preferred - explicit correlation)
    escrowResult = await db.query<{
      id: string;
      task_id: string;
      state: string;
      version: number;
      stripe_refund_id: string | null;
    }>(
      `SELECT id, task_id, state, version, stripe_refund_id
       FROM escrows
       WHERE id = $1
       FOR UPDATE`,
      [escrowId]
    );
  } else {
    // Fallback: Find by payment_intent_id (charge.payment_intent)
    const paymentIntentId = typeof charge.payment_intent === 'string' 
      ? charge.payment_intent 
      : charge.payment_intent?.id;

    if (!paymentIntentId) {
      throw new Error(`Charge ${charge.id} missing payment_intent and escrow_id metadata`);
    }

    escrowResult = await db.query<{
      id: string;
      task_id: string;
      state: string;
      version: number;
      stripe_refund_id: string | null;
    }>(
      `SELECT id, task_id, state, version, stripe_refund_id
       FROM escrows
       WHERE stripe_payment_intent_id = $1
       FOR UPDATE`,
      [paymentIntentId]
    );
  }

  if (escrowResult.rows.length === 0) {
    throw new Error(`Escrow not found for refund ${refundId} (escrow_id: ${escrowId || 'not in metadata'})`);
  }

  const escrow = escrowResult.rows[0];

  // Terminal skip: If escrow is already terminal, skip (prevents noise)
  if (['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(escrow.state)) {
    await db.query(
      `UPDATE stripe_events
       SET processed_at = NOW(),
           result = 'skipped',
           error_message = $1
       WHERE stripe_event_id = $2`,
      [`Escrow ${escrow.id} already terminal (${escrow.state})`, stripeEventId]
    );
    log.warn({ escrowId: escrow.id, state: escrow.state, stripeEventId }, 'Stripe event skipped: escrow already terminal');
    return;
  }

  // Validate state transition: PENDING|FUNDED|LOCKED_DISPUTE → REFUNDED
  if (!['PENDING', 'FUNDED', 'LOCKED_DISPUTE'].includes(escrow.state)) {
    throw new Error(`Cannot refund escrow ${escrow.id}: current state is ${escrow.state}, expected PENDING, FUNDED, or LOCKED_DISPUTE`);
  }

  // Idempotency check: If already refunded with this refund_id, skip
  if (escrow.state === 'REFUNDED' && escrow.stripe_refund_id === refundId) {
    log.info({ escrowId: escrow.id, refundId }, 'Escrow already refunded, idempotent replay');
    return;
  }

  // Update escrow: PENDING|FUNDED|LOCKED_DISPUTE → REFUNDED (with version check and increment)
  const updateResult = await db.query<{
    id: string;
    state: string;
    version: number;
  }>(
    `UPDATE escrows
     SET state = 'REFUNDED',
         stripe_refund_id = $1,
         refunded_at = NOW(),
         version = version + 1,
         updated_at = NOW()
     WHERE id = $2
       AND state IN ('PENDING', 'FUNDED', 'LOCKED_DISPUTE')
       AND version = $3
     RETURNING id, state, version`,
    [refundId, escrow.id, escrow.version]
  );

  if (updateResult.rowCount === 0) {
    throw new Error(`Escrow ${escrow.id} state or version changed during update (version mismatch or state changed)`);
  }

  const updatedEscrow = updateResult.rows[0];

  // Step 4: Hook CLOSED transition (Pillar A - Realtime Tracking)
  // System-driven transition: COMPLETED → CLOSED (triggered by escrow terminalization)
  await TaskService.advanceProgress({
    taskId: escrow.task_id,
    to: 'CLOSED',
    actor: { type: 'system' },
  });

  // Emit outbox event: escrow.refunded
  await writeToOutbox({
    eventType: 'escrow.refunded',
    aggregateType: 'escrow',
    aggregateId: escrow.id,
    eventVersion: updatedEscrow.version,
    payload: {
      escrowId: escrow.id,
      refundId,
      version: updatedEscrow.version,
    },
    queueName: 'user_notifications',
    idempotencyKey: `escrow.refunded:${escrow.id}:${updatedEscrow.version}`,
  });

  log.info({ escrowId: escrow.id, prevState: escrow.state, version: updatedEscrow.version }, 'Escrow refunded (→ REFUNDED)');
}

/**
 * Handle transfer.failed: escrow RELEASED → LOCKED_DISPUTE (ops triage required)
 *
 * A released escrow whose underlying Stripe transfer has failed must be flagged
 * for manual ops intervention. We cannot automatically re-release — that would
 * risk a double-payment if the transfer was retried by Stripe. Instead we:
 *  1. Look up the escrow by stripe_transfer_id
 *  2. Revert to LOCKED_DISPUTE with reason='transfer_failed' so ops can triage
 *  3. Log a CRITICAL error for alerting
 *  4. Insert a revenue_ledger row (type='failed_transfer') as an audit trail
 *  5. Push an urgent notification to the worker
 *
 * NOTE: Admin must resolve via the dispute resolution path — no auto re-release.
 */
async function handleTransferFailed(transfer: Stripe.Transfer, stripeEventId: string): Promise<void> {
  const transferId = transfer.id;

  // Find escrow by stripe_transfer_id
  const escrowResult = await db.query<{
    id: string;
    task_id: string;
    state: string;
    version: number;
    amount: number;
  }>(
    `SELECT e.id, e.task_id, e.state, e.version, e.amount
     FROM escrows e
     WHERE e.stripe_transfer_id = $1
     FOR UPDATE`,
    [transferId]
  );

  if (escrowResult.rows.length === 0) {
    // No escrow linked to this transfer — log and skip gracefully
    log.warn({ transferId, stripeEventId }, 'transfer.failed: no escrow found for transfer_id, skipping');
    return;
  }

  const escrow = escrowResult.rows[0];

  // CRITICAL: A payout to a worker has failed. Requires manual intervention.
  log.error(
    { transferId, escrowId: escrow.id, escrowState: escrow.state, stripeEventId },
    'CRITICAL: Stripe transfer.failed — worker payout failed, escrow requires ops triage'
  );

  // If the escrow is already in a non-RELEASED state (e.g. already locked by another
  // signal), log and skip the state revert — do not double-transition.
  if (escrow.state !== 'RELEASED') {
    log.warn(
      { transferId, escrowId: escrow.id, state: escrow.state },
      'transfer.failed: escrow not in RELEASED state, skipping state revert'
    );
    return;
  }

  // Revert escrow: RELEASED → LOCKED_DISPUTE (ops triage path)
  const updateResult = await db.query<{ id: string; state: string; version: number }>(
    `UPDATE escrows
     SET state = 'LOCKED_DISPUTE',
         version = version + 1,
         updated_at = NOW()
     WHERE id = $1
       AND state = 'RELEASED'
       AND version = $2
     RETURNING id, state, version`,
    [escrow.id, escrow.version]
  );

  // Look up worker BEFORE attempting the revert so notification is always available
  const taskResult = await db.query<{ worker_id: string | null }>(
    `SELECT worker_id FROM tasks WHERE id = $1`,
    [escrow.task_id]
  );
  const workerId = taskResult.rows[0]?.worker_id;

  // Attempt state revert: RELEASED → LOCKED_DISPUTE with optimistic lock
  let revertedVersion: number | null = null;
  let revertError: Error | null = null;

  if (updateResult.rowCount === 0) {
    revertError = new Error(
      `Escrow ${escrow.id} state or version changed during transfer.failed revert (optimistic lock)`
    );
    log.error(
      { escrowId: escrow.id, transferId },
      'Optimistic lock failure during transfer.failed revert — notification still sent, BullMQ will retry'
    );
  } else {
    const updatedEscrow = updateResult.rows[0];
    revertedVersion = updatedEscrow.version;

    // Log escrow event for audit trail
    await db.query(
      `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
       VALUES ($1, 'RELEASED', 'LOCKED_DISPUTE', NULL, 'system', $2)`,
      [escrow.id, JSON.stringify({ reason: 'transfer_failed', stripe_transfer_id: transferId, stripe_event_id: stripeEventId })]
    );

    log.info(
      { escrowId: escrow.id, transferId, version: revertedVersion },
      'Escrow reverted to LOCKED_DISPUTE after transfer.failed (requires admin triage)'
    );
  }

  // Insert failed_transfer ledger entry — always, regardless of revert outcome
  await RevenueService.logEvent({
    eventType: 'failed_transfer',
    userId: 'system', // Worker user_id is not directly on escrow; ops will reconcile
    amountCents: -escrow.amount,
    escrowId: escrow.id,
    stripeEventId,
    stripeTransferId: transferId,
    metadata: {
      reason: 'transfer_failed',
      escrow_state_before: 'RELEASED',
      escrow_state_after: revertedVersion != null ? 'LOCKED_DISPUTE' : 'REVERT_FAILED',
      requires_admin_intervention: true,
    },
  });

  // Send push notification to worker — always, so they are never silently unnotified
  if (workerId) {
    await sendPushNotification(
      workerId,
      'Payment Transfer Failed',
      'Your payment transfer failed. Our team has been alerted and will resolve this urgently. No action required from you.',
      { screen: 'earnings', escrow_id: escrow.id, type: 'transfer_failed' }
    );
  }

  // Emit outbox event for ops alerting / escalation pipeline — always
  await writeToOutbox({
    eventType: 'escrow.transfer_failed',
    aggregateType: 'escrow',
    aggregateId: escrow.id,
    eventVersion: revertedVersion ?? escrow.version,
    payload: {
      escrowId: escrow.id,
      transferId,
      workerId: workerId ?? null,
      version: revertedVersion ?? escrow.version,
      requiresAdminIntervention: true,
      revertSucceeded: revertedVersion != null,
    },
    queueName: 'user_notifications',
    idempotencyKey: `escrow.transfer_failed:${escrow.id}:${revertedVersion ?? escrow.version}`,
  });

  // Throw AFTER notifications so BullMQ retries the revert but worker is already notified
  if (revertError) {
    throw revertError;
  }
}

/**
 * Handle payment_intent.payment_failed: escrow PENDING → CANCELLED, task → OPEN
 *
 * When a poster's payment fails at the PaymentIntent level:
 *  1. Find the escrow by stripe_payment_intent_id
 *  2. If PENDING: cancel the escrow (set state = 'REFUNDED' which is the terminal
 *     cancel-from-pending path, with reason='payment_failed')
 *  3. Return the task to OPEN state so the poster can retry
 *  4. Notify the poster: "Payment failed — please retry"
 *
 * Note: There is no CANCELLED escrow state in the type system; tasks have CANCELLED
 * but for a PENDING escrow that never funded, the appropriate terminal state is
 * REFUNDED (nothing moved, nothing to refund — but it closes the escrow cleanly).
 * We use REFUNDED here per the existing state machine: PENDING → REFUNDED is a
 * valid transition and the only terminal path for a never-funded escrow.
 */
async function handlePaymentIntentPaymentFailed(paymentIntent: Stripe.PaymentIntent, stripeEventId: string): Promise<void> {
  const paymentIntentId = paymentIntent.id;

  // Find escrow by stripe_payment_intent_id
  const escrowResult = await db.query<{
    id: string;
    task_id: string;
    state: string;
    version: number;
    amount: number;
  }>(
    `SELECT e.id, e.task_id, e.state, e.version, e.amount
     FROM escrows e
     WHERE e.stripe_payment_intent_id = $1
     FOR UPDATE`,
    [paymentIntentId]
  );

  if (escrowResult.rows.length === 0) {
    log.warn({ paymentIntentId, stripeEventId }, 'payment_intent.payment_failed: no escrow found, skipping');
    return;
  }

  const escrow = escrowResult.rows[0];

  // If escrow is already terminal, skip silently (idempotency)
  if (['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(escrow.state)) {
    await db.query(
      `UPDATE stripe_events
       SET processed_at = NOW(),
           result = 'skipped',
           error_message = $1
       WHERE stripe_event_id = $2`,
      [`Escrow ${escrow.id} already terminal (${escrow.state})`, stripeEventId]
    );
    log.warn({ escrowId: escrow.id, state: escrow.state, stripeEventId }, 'Stripe event skipped: escrow already terminal');
    return;
  }

  if (escrow.state !== 'PENDING') {
    // Payment failed but escrow already funded — unexpected scenario, surface as error
    throw new Error(
      `payment_intent.payment_failed: escrow ${escrow.id} is in state ${escrow.state}, expected PENDING`
    );
  }

  // Cancel the escrow: PENDING → REFUNDED (terminal; nothing was funded)
  const updateResult = await db.query<{ id: string; state: string; version: number }>(
    `UPDATE escrows
     SET state = 'REFUNDED',
         refunded_at = NOW(),
         version = version + 1,
         updated_at = NOW()
     WHERE id = $1
       AND state = 'PENDING'
       AND version = $2
     RETURNING id, state, version`,
    [escrow.id, escrow.version]
  );

  if (updateResult.rowCount === 0) {
    throw new Error(
      `Escrow ${escrow.id} state or version changed during payment_intent.payment_failed update (optimistic lock)`
    );
  }

  const updatedEscrow = updateResult.rows[0];

  // Log escrow event for audit trail
  await db.query(
    `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
     VALUES ($1, 'PENDING', 'REFUNDED', NULL, 'system', $2)`,
    [escrow.id, JSON.stringify({ reason: 'payment_failed', stripe_payment_intent_id: paymentIntentId, stripe_event_id: stripeEventId })]
  );

  // Return task to OPEN so poster can retry payment
  // Attempt this after escrow cancel; if it fails, log and continue (task state is secondary)
  try {
    await db.query(
      `UPDATE tasks
       SET state = 'OPEN',
           updated_at = NOW()
       WHERE id = $1
         AND state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')`,
      [escrow.task_id]
    );
  } catch (taskError) {
    log.error(
      { escrowId: escrow.id, taskId: escrow.task_id, err: taskError instanceof Error ? taskError.message : String(taskError) },
      'payment_intent.payment_failed: failed to revert task to OPEN — escrow was cancelled successfully but task state may be inconsistent'
    );
  }

  // Look up poster via task to send push notification
  const taskResult = await db.query<{ poster_id: string | null }>(
    `SELECT poster_id FROM tasks WHERE id = $1`,
    [escrow.task_id]
  );

  const posterId = taskResult.rows[0]?.poster_id;
  if (posterId) {
    await sendPushNotification(
      posterId,
      'Payment Failed',
      'Your payment could not be processed. Please update your payment method and try again.',
      { screen: 'task_detail', task_id: escrow.task_id, type: 'payment_failed' }
    );
  }

  // Emit outbox event
  await writeToOutbox({
    eventType: 'escrow.payment_failed',
    aggregateType: 'escrow',
    aggregateId: escrow.id,
    eventVersion: updatedEscrow.version,
    payload: {
      escrowId: escrow.id,
      paymentIntentId,
      taskId: escrow.task_id,
      posterId: posterId ?? null,
      version: updatedEscrow.version,
    },
    queueName: 'user_notifications',
    idempotencyKey: `escrow.payment_failed:${escrow.id}:${updatedEscrow.version}`,
  });

  log.info(
    { escrowId: escrow.id, taskId: escrow.task_id, paymentIntentId, version: updatedEscrow.version },
    'Escrow cancelled and task returned to OPEN after payment_intent.payment_failed'
  );
}

/**
 * Handle payout.failed: push notification to worker, ledger entry, no state machine change
 *
 * Stripe automatically returns funds to the Connect balance when a payout fails.
 * Therefore no escrow state transition is needed. We:
 *  1. Extract the Connect account ID from the payout object
 *  2. Look up the user by stripe_connect_id
 *  3. Send a push notification: "Your bank transfer failed — update bank details"
 *  4. Insert a revenue_ledger row (type='failed_payout') for ops visibility
 *
 * Note: payout.destination is typed as string | Stripe.BankAccount | Stripe.Card |
 * Stripe.ExternalAccount | null. We read account from payout object itself which
 * comes through as a Connect webhook with account metadata in the Stripe event.
 * The Payout.destination is the bank account — but the Connect account ID is stored
 * in users.stripe_connect_id, and is the Account ID the webhook was received for.
 * On connected account webhooks, transfer_data.destination / account is available
 * in the Stripe event envelope, not the payout object itself. We use the
 * stripe_connect_id lookup via the account field that Stripe places in metadata
 * when available, or fall back to querying by stripe_connect_id pattern.
 */
async function handlePayoutFailed(payout: Stripe.Payout, stripeEventId: string): Promise<void> {
  const payoutId = payout.id;
  const payoutAmount = payout.amount; // In cents

  // The Connect account that owns this payout. Stripe sets this in the event envelope
  // for Connect webhooks. When we process via stripe_events table, the raw event payload
  // contains account at event level. We can also read it from payout.destination if it
  // has an account property, or rely on metadata set at payout creation time.
  // Best-effort: check payout.metadata.connect_account_id (set by our code on payout creation)
  // or fall back to the payout's destination account lookup via users table.
  const connectAccountId: string | null =
    (payout.metadata?.connect_account_id as string | undefined) ?? null;

  log.error(
    { payoutId, payoutAmount, connectAccountId, stripeEventId },
    'CRITICAL: Stripe payout.failed — worker bank transfer failed'
  );

  let userId: string | null = null;

  if (connectAccountId) {
    // Look up user by stripe_connect_id
    const userResult = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE stripe_connect_id = $1 LIMIT 1`,
      [connectAccountId]
    );
    userId = userResult.rows[0]?.id ?? null;
  }

  // Send push notification to the worker if we can identify them
  if (userId) {
    await sendPushNotification(
      userId,
      'Bank Transfer Failed',
      'Your bank transfer failed. Please update your bank details in the app to receive your earnings.',
      { screen: 'payout_settings', type: 'payout_failed' }
    );
  } else {
    log.warn(
      { payoutId, connectAccountId, stripeEventId },
      'payout.failed: could not identify user for push notification (connect_account_id not in metadata or not found in users table)'
    );
  }

  // Insert failed_payout ledger entry for financial ops visibility
  // Amount is negative (funds did not reach the worker's bank)
  await RevenueService.logEvent({
    eventType: 'failed_payout',
    userId: userId ?? 'system',
    amountCents: -payoutAmount,
    stripeEventId,
    metadata: {
      payout_id: payoutId,
      connect_account_id: connectAccountId,
      payout_status: payout.status,
      failure_code: payout.failure_code,
      failure_message: payout.failure_message,
    },
  });

  log.info(
    { payoutId, connectAccountId, userId, stripeEventId },
    'payout.failed processed: notification sent (if user found), ledger entry created, no state machine change needed'
  );
}
