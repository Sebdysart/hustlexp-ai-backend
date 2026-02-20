/**
 * Payment Worker v1.0.0
 * 
 * Phase D: Authoritative interpreter of Stripe events → Escrow state transitions
 * 
 * Processes payment.stripe_event_received events from critical_payments queue.
 * Updates escrow state based on Stripe event type.
 * 
 * Event mapping:
 * - payment_intent.succeeded → escrow PENDING → FUNDED
 * - transfer.created → escrow FUNDED|LOCKED_DISPUTE → RELEASED
 * - charge.refunded → escrow PENDING|FUNDED|LOCKED_DISPUTE → REFUNDED
 * 
 * CRITICAL RULES:
 * - All state transitions must check version (optimistic locking)
 * - All state transitions must increment version
 * - Terminal states cannot transition (enforced by DB trigger)
 * - Illegal transitions fail and are recorded as failed
 * 
 * @see ARCHITECTURE.md §2.4
 */

import { db } from '../db';
import { writeToOutbox } from './outbox-helpers';
import { TaskService } from '../services/TaskService';
import { workerLogger } from '../logger';
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
  const idempotencyKey = job.id || `payment:${stripeEventId}`;

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
    
    // Mark event as failed - set processed_at = NOW() to finalize
    // Retry mechanism is BullMQ (will create new job if needed)
    await db.query(
      `UPDATE stripe_events
       SET processed_at = NOW(),
           result = 'failed',
           error_message = $1
       WHERE stripe_event_id = $2`,
      [errorMessage, stripeEventId]
    );
    
    log.error({ stripeEventId, eventType, err: errorMessage }, 'Stripe event processing failed');
    
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

  // Extract refund ID from charge.refunds (first refund)
  const refundId = charge.refunds?.data?.[0]?.id;
  if (!refundId) {
    throw new Error(`Charge ${charge.id} missing refund ID`);
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
