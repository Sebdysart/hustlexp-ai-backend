import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { TaskService } from '../services/TaskService.js';
import { RevenueService } from '../services/RevenueService.js';
import { XPService } from '../services/XPService.js';
import { sendPushNotification } from '../services/PushNotificationService.js';
import { workerLogger } from '../logger.js';
import { verifyJobSignature } from './queues.js';
import { config } from '../config.js';
import type { Job } from 'bullmq';
import type Stripe from 'stripe';
import type { QueryFn } from '../db.js';

const log = workerLogger.child({ worker: 'payment' });

interface StripeEventReceivedPayload {
  stripeEventId: string;
  eventType: string;
  eventCreated: string;
}

interface PaymentJobData {
  payload: StripeEventReceivedPayload;
}

export async function processPaymentJob(job: Job<PaymentJobData>): Promise<void> {
  const { stripeEventId, eventType } = job.data.payload;

  const payload = job.data.payload as unknown as Record<string, unknown>;
  if ('_sig' in payload) {
    const { _sig, ...payloadWithoutSig } = payload;
    if (!verifyJobSignature(payloadWithoutSig, _sig as string)) {
      log.error({ jobId: job.id, eventType }, 'Job signature verification failed');
      throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
    }
  }

  try {
    const claimResult = await db.query<{
      stripe_event_id: string;
      type: string;
      payload_json: Stripe.Event;
    }>(
      `UPDATE stripe_events
       SET claimed_at = NOW(), result = 'processing', error_message = NULL
       WHERE stripe_event_id = $1 AND claimed_at IS NULL AND processed_at IS NULL
       RETURNING stripe_event_id, type, payload_json`,
      [stripeEventId]
    );

    if (claimResult.rowCount === 0) {
      const existingResult = await db.query<{ result: string | null }>(
        `SELECT result FROM stripe_events WHERE stripe_event_id = $1`,
        [stripeEventId]
      );
      if (existingResult.rowCount === 0) throw new Error(`Stripe event ${stripeEventId} not found`);
      log.info({ stripeEventId, result: existingResult.rows[0].result }, 'Stripe event already claimed/processed, skipping');
      return;
    }

    const stripeEvent = claimResult.rows[0];
    const eventObject = stripeEvent.payload_json.data.object;

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
        await db.query(
          `UPDATE stripe_events SET processed_at = NOW(), result = 'skipped', error_message = $1 WHERE stripe_event_id = $2`,
          [`Unknown event type: ${eventType}`, stripeEventId]
        );
        log.warn({ stripeEventId, eventType }, 'Stripe event skipped (unknown type)');
        return;
    }

    await db.query(
      `UPDATE stripe_events SET processed_at = NOW(), result = 'success' WHERE stripe_event_id = $1`,
      [stripeEventId]
    );
    log.info({ stripeEventId, eventType }, 'Stripe event processed successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await db.query(
      `UPDATE stripe_events SET result = 'failed', claimed_at = NULL, error_message = $1 WHERE stripe_event_id = $2`,
      [errorMessage, stripeEventId]
    );
    log.error({ stripeEventId, eventType, err: errorMessage }, 'Stripe event processing failed');
    throw error;
  }
}

async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent, stripeEventId: string): Promise<void> {
  const paymentIntentId = paymentIntent.id;

  const { updatedEscrow, escrowId, amount } = await db.transaction(async (trx: QueryFn) => {
    const escrowResult = await trx<{ id: string; state: string; version: number; amount: number }>(
      `SELECT id, state, version, amount FROM escrows WHERE stripe_payment_intent_id = $1 FOR UPDATE`,
      [paymentIntentId]
    );
    if (escrowResult.rows.length === 0) throw new Error(`Escrow not found for payment_intent ${paymentIntentId}`);

    const escrow = escrowResult.rows[0];

    if (['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(escrow.state)) {
      await trx(
        `UPDATE stripe_events SET processed_at = NOW(), result = 'skipped', error_message = $1 WHERE stripe_event_id = $2`,
        [`Escrow ${escrow.id} already terminal (${escrow.state})`, stripeEventId]
      );
      return { updatedEscrow: null, escrowId: escrow.id, amount: escrow.amount };
    }

    if (escrow.state !== 'PENDING') throw new Error(`Cannot fund escrow ${escrow.id}: state is ${escrow.state}, expected PENDING`);
    if (paymentIntent.amount !== escrow.amount) throw new Error(`PI amount (${paymentIntent.amount}) != escrow amount (${escrow.amount})`);

    const updateResult = await trx<{ id: string; state: string; version: number }>(
      `UPDATE escrows SET state = 'FUNDED', funded_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $1 AND state = 'PENDING' AND version = $2 RETURNING id, state, version`,
      [escrow.id, escrow.version]
    );
    if (updateResult.rowCount === 0) throw new Error(`Escrow ${escrow.id} state/version changed during update`);

    return { updatedEscrow: updateResult.rows[0], escrowId: escrow.id, amount: escrow.amount };
  });

  if (!updatedEscrow) return;

  await writeToOutbox({
    eventType: 'escrow.funded',
    aggregateType: 'escrow',
    aggregateId: escrowId,
    eventVersion: updatedEscrow.version,
    payload: { escrowId, paymentIntentId, amount, version: updatedEscrow.version },
    queueName: 'user_notifications',
    idempotencyKey: `escrow.funded:${escrowId}:${updatedEscrow.version}`,
  });
  log.info({ escrowId, version: updatedEscrow.version }, 'Escrow funded (PENDING → FUNDED)');
}

async function handleTransferCreated(transfer: Stripe.Transfer, stripeEventId: string): Promise<void> {
  const transferId = transfer.id;
  const escrowId = transfer.metadata?.escrow_id;
  if (!escrowId) throw new Error(`Transfer ${transferId} missing escrow_id metadata`);

  const { updatedEscrow, taskId, skipped } = await db.transaction(async (trx: QueryFn) => {
    const escrowResult = await trx<{ id: string; task_id: string; state: string; version: number; stripe_transfer_id: string | null }>(
      `SELECT id, task_id, state, version, stripe_transfer_id FROM escrows WHERE id = $1 FOR UPDATE`,
      [escrowId]
    );
    if (escrowResult.rows.length === 0) throw new Error(`Escrow ${escrowId} not found`);

    const escrow = escrowResult.rows[0];

    if (['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(escrow.state)) {
      await trx(
        `UPDATE stripe_events SET processed_at = NOW(), result = 'skipped', error_message = $1 WHERE stripe_event_id = $2`,
        [`Escrow ${escrowId} already terminal (${escrow.state})`, stripeEventId]
      );
      return { updatedEscrow: null, taskId: escrow.task_id, skipped: true };
    }

    if (escrow.state === 'RELEASED' && escrow.stripe_transfer_id === transferId) {
      return { updatedEscrow: null, taskId: escrow.task_id, skipped: true };
    }

    if (escrow.state !== 'FUNDED' && escrow.state !== 'LOCKED_DISPUTE') {
      throw new Error(`Cannot release escrow ${escrowId}: state is ${escrow.state}, expected FUNDED or LOCKED_DISPUTE`);
    }

    const updateResult = await trx<{ id: string; state: string; version: number }>(
      `UPDATE escrows SET state = 'RELEASED', stripe_transfer_id = $1, released_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $2 AND state IN ('FUNDED', 'LOCKED_DISPUTE') AND version = $3 RETURNING id, state, version`,
      [transferId, escrowId, escrow.version]
    );
    if (updateResult.rowCount === 0) throw new Error(`Escrow ${escrowId} state/version changed during update`);

    return { updatedEscrow: updateResult.rows[0], taskId: escrow.task_id, skipped: false };
  });

  if (skipped || !updatedEscrow) return;

  await TaskService.advanceProgress({ taskId, to: 'CLOSED', actor: { type: 'system' } });

  await writeToOutbox({
    eventType: 'escrow.released',
    aggregateType: 'escrow',
    aggregateId: escrowId,
    eventVersion: updatedEscrow.version,
    payload: { escrowId, transferId, version: updatedEscrow.version },
    queueName: 'critical_payments',
    idempotencyKey: `escrow.released:${escrowId}:${updatedEscrow.version}`,
  });
  log.info({ escrowId, version: updatedEscrow.version }, 'Escrow released (→ RELEASED)');
}

async function handleChargeRefunded(charge: Stripe.Charge, stripeEventId: string): Promise<void> {
  const escrowId = charge.metadata?.escrow_id;
  const refundId = charge.refunds?.data?.[0]?.id;
  if (!refundId) throw new Error(`Charge ${charge.id} missing refund ID`);

  const { updatedEscrow, escrow, skipped } = await db.transaction(async (trx: QueryFn) => {
    let escrowResult;
    if (escrowId) {
      escrowResult = await trx<{ id: string; task_id: string; state: string; version: number; amount: number; stripe_refund_id: string | null }>(
        `SELECT id, task_id, state, version, amount, stripe_refund_id FROM escrows WHERE id = $1 FOR UPDATE`,
        [escrowId]
      );
    } else {
      const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      if (!paymentIntentId) throw new Error(`Charge ${charge.id} missing payment_intent and escrow_id metadata`);
      escrowResult = await trx<{ id: string; task_id: string; state: string; version: number; amount: number; stripe_refund_id: string | null }>(
        `SELECT id, task_id, state, version, amount, stripe_refund_id FROM escrows WHERE stripe_payment_intent_id = $1 FOR UPDATE`,
        [paymentIntentId]
      );
    }

    if (escrowResult.rows.length === 0) throw new Error(`Escrow not found for refund ${refundId}`);
    const escrow = escrowResult.rows[0];

    if (['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(escrow.state)) {
      await trx(
        `UPDATE stripe_events SET processed_at = NOW(), result = 'skipped', error_message = $1 WHERE stripe_event_id = $2`,
        [`Escrow ${escrow.id} already terminal (${escrow.state})`, stripeEventId]
      );
      return { updatedEscrow: null, escrow, skipped: true };
    }

    if (!['PENDING', 'FUNDED', 'LOCKED_DISPUTE'].includes(escrow.state)) {
      throw new Error(`Cannot refund escrow ${escrow.id}: state is ${escrow.state}`);
    }

    if (escrow.state === 'REFUNDED' && escrow.stripe_refund_id === refundId) {
      return { updatedEscrow: null, escrow, skipped: true };
    }

    const updateResult = await trx<{ id: string; state: string; version: number }>(
      `UPDATE escrows SET state = 'REFUNDED', stripe_refund_id = $1, refunded_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $2 AND state IN ('PENDING', 'FUNDED', 'LOCKED_DISPUTE') AND version = $3 RETURNING id, state, version`,
      [refundId, escrow.id, escrow.version]
    );
    if (updateResult.rowCount === 0) throw new Error(`Escrow ${escrow.id} state/version changed during update`);

    return { updatedEscrow: updateResult.rows[0], escrow, skipped: false };
  });

  if (skipped || !updatedEscrow) return;

  await TaskService.advanceProgress({ taskId: escrow.task_id, to: 'CLOSED', actor: { type: 'system' } });

  // GAP-2 FIX: Added fee clamp Math.min(100, Math.max(0, ...)) to match EscrowService.release()
  const platformFeePercent = Math.min(100, Math.max(0, config.stripe.platformFeePercent ?? 15));
  const platformFeeCents = Math.round(escrow.amount * (platformFeePercent / 100));
  await RevenueService.logEvent({
    eventType: 'platform_fee_reversal',
    userId: 'system',
    amountCents: -platformFeeCents,
    escrowId: escrow.id,
    stripeEventId,
    stripeChargeId: charge.id,
    metadata: {
      reason: 'charge_refunded',
      escrow_amount_cents: escrow.amount,
      platform_fee_percent: platformFeePercent,
      refund_id: refundId,
    },
  });

  // GAP-4 FIX: Clawback XP when a charge is refunded via Stripe webhook.
  // Previously this path (Stripe-driven charge.refunded) did not clawback XP,
  // unlike EscrowService.refund() which does. A Stripe dashboard refund would
  // leave the worker with XP for a refunded task.
  try {
    const taskResult = await db.query<{ worker_id: string | null }>(
      'SELECT worker_id FROM tasks WHERE id = $1',
      [escrow.task_id]
    );
    const workerId = taskResult.rows[0]?.worker_id;
    if (workerId) {
      await XPService.clawbackXP(workerId, escrow.id, 'charge_refunded');
    }
  } catch (clawbackError) {
    log.error(
      { err: clawbackError instanceof Error ? clawbackError.message : String(clawbackError), escrowId: escrow.id },
      'XP clawback failed during charge.refunded — refund proceeds'
    );
  }

  await writeToOutbox({
    eventType: 'escrow.refunded',
    aggregateType: 'escrow',
    aggregateId: escrow.id,
    eventVersion: updatedEscrow.version,
    payload: { escrowId: escrow.id, refundId, version: updatedEscrow.version },
    queueName: 'user_notifications',
    idempotencyKey: `escrow.refunded:${escrow.id}:${updatedEscrow.version}`,
  });

  log.info({ escrowId: escrow.id, prevState: escrow.state, version: updatedEscrow.version }, 'Escrow refunded (→ REFUNDED)');
}

async function handleTransferFailed(transfer: Stripe.Transfer, stripeEventId: string): Promise<void> {
  const transferId = transfer.id;

  const { escrow, revertedVersion, revertError, workerId } = await db.transaction(async (trx: QueryFn) => {
    const escrowResult = await trx<{ id: string; task_id: string; state: string; version: number; amount: number }>(
      `SELECT e.id, e.task_id, e.state, e.version, e.amount FROM escrows e WHERE e.stripe_transfer_id = $1 FOR UPDATE`,
      [transferId]
    );
    if (escrowResult.rows.length === 0) {
      log.warn({ transferId, stripeEventId }, 'transfer.failed: no escrow found, skipping');
      return { escrow: null, revertedVersion: null, revertError: null, workerId: null };
    }

    const escrow = escrowResult.rows[0];
    log.error({ transferId, escrowId: escrow.id, escrowState: escrow.state, stripeEventId }, 'CRITICAL: Stripe transfer.failed');

    if (escrow.state !== 'RELEASED') {
      log.warn({ transferId, escrowId: escrow.id, state: escrow.state }, 'transfer.failed: escrow not RELEASED, skipping revert');
      const taskResult = await trx<{ worker_id: string | null }>(`SELECT worker_id FROM tasks WHERE id = $1`, [escrow.task_id]);
      return { escrow, revertedVersion: null, revertError: null, workerId: taskResult.rows[0]?.worker_id ?? null };
    }

    const updateResult = await trx<{ id: string; state: string; version: number }>(
      `UPDATE escrows SET state = 'LOCKED_DISPUTE', version = version + 1, updated_at = NOW()
       WHERE id = $1 AND state = 'RELEASED' AND version = $2 RETURNING id, state, version`,
      [escrow.id, escrow.version]
    );

    const taskResult = await trx<{ worker_id: string | null }>(`SELECT worker_id FROM tasks WHERE id = $1`, [escrow.task_id]);
    const workerId = taskResult.rows[0]?.worker_id ?? null;

    if (updateResult.rowCount === 0) {
      const revertError = new Error(`Escrow ${escrow.id} optimistic lock failure during transfer.failed revert`);
      return { escrow, revertedVersion: null, revertError, workerId };
    }

    await trx(
      `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
       VALUES ($1, 'RELEASED', 'LOCKED_DISPUTE', NULL, 'system', $2)`,
      [escrow.id, JSON.stringify({ reason: 'transfer_failed', stripe_transfer_id: transferId, stripe_event_id: stripeEventId })]
    );

    return { escrow, revertedVersion: updateResult.rows[0].version, revertError: null, workerId };
  });

  if (!escrow) return;

  await RevenueService.logEvent({
    eventType: 'failed_transfer',
    userId: 'system',
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

  if (workerId) {
    await sendPushNotification(
      workerId,
      'Payment Transfer Failed',
      'Your payment transfer failed. Our team has been alerted and will resolve this urgently.',
      { screen: 'earnings', escrow_id: escrow.id, type: 'transfer_failed' }
    );
  }

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

  if (revertError) throw revertError;
}

async function handlePaymentIntentPaymentFailed(paymentIntent: Stripe.PaymentIntent, stripeEventId: string): Promise<void> {
  const paymentIntentId = paymentIntent.id;

  const { updatedEscrow, escrow, posterId, skipped } = await db.transaction(async (trx: QueryFn) => {
    const escrowResult = await trx<{ id: string; task_id: string; state: string; version: number; amount: number }>(
      `SELECT e.id, e.task_id, e.state, e.version, e.amount FROM escrows e WHERE e.stripe_payment_intent_id = $1 FOR UPDATE`,
      [paymentIntentId]
    );
    if (escrowResult.rows.length === 0) {
      log.warn({ paymentIntentId, stripeEventId }, 'payment_intent.payment_failed: no escrow found, skipping');
      return { updatedEscrow: null, escrow: null, posterId: null, skipped: true };
    }

    const escrow = escrowResult.rows[0];

    if (['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(escrow.state)) {
      await trx(
        `UPDATE stripe_events SET processed_at = NOW(), result = 'skipped', error_message = $1 WHERE stripe_event_id = $2`,
        [`Escrow ${escrow.id} already terminal (${escrow.state})`, stripeEventId]
      );
      return { updatedEscrow: null, escrow, posterId: null, skipped: true };
    }

    if (escrow.state !== 'PENDING') {
      throw new Error(`payment_intent.payment_failed: escrow ${escrow.id} is ${escrow.state}, expected PENDING`);
    }

    const updateResult = await trx<{ id: string; state: string; version: number }>(
      `UPDATE escrows SET state = 'REFUNDED', refunded_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $1 AND state = 'PENDING' AND version = $2 RETURNING id, state, version`,
      [escrow.id, escrow.version]
    );
    if (updateResult.rowCount === 0) throw new Error(`Escrow ${escrow.id} state/version changed during update`);

    await trx(
      `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
       VALUES ($1, 'PENDING', 'REFUNDED', NULL, 'system', $2)`,
      [escrow.id, JSON.stringify({ reason: 'payment_failed', stripe_payment_intent_id: paymentIntentId, stripe_event_id: stripeEventId })]
    );

    try {
      await trx(
        `UPDATE tasks SET state = 'OPEN', updated_at = NOW() WHERE id = $1 AND state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')`,
        [escrow.task_id]
      );
    } catch (taskError) {
      log.error({ escrowId: escrow.id, taskId: escrow.task_id, err: taskError instanceof Error ? taskError.message : String(taskError) }, 'Failed to revert task to OPEN');
      throw taskError;
    }

    const taskResult = await trx<{ poster_id: string | null }>(`SELECT poster_id FROM tasks WHERE id = $1`, [escrow.task_id]);
    return { updatedEscrow: updateResult.rows[0], escrow, posterId: taskResult.rows[0]?.poster_id ?? null, skipped: false };
  });

  if (skipped || !updatedEscrow || !escrow) return;

  if (posterId) {
    await sendPushNotification(
      posterId,
      'Payment Failed',
      'Your payment could not be processed. Please update your payment method and try again.',
      { screen: 'task_detail', task_id: escrow.task_id, type: 'payment_failed' }
    );
  }

  await writeToOutbox({
    eventType: 'escrow.payment_failed',
    aggregateType: 'escrow',
    aggregateId: escrow.id,
    eventVersion: updatedEscrow.version,
    payload: { escrowId: escrow.id, paymentIntentId, taskId: escrow.task_id, posterId: posterId ?? null, version: updatedEscrow.version },
    queueName: 'user_notifications',
    idempotencyKey: `escrow.payment_failed:${escrow.id}:${updatedEscrow.version}`,
  });

  log.info({ escrowId: escrow.id, taskId: escrow.task_id, paymentIntentId, version: updatedEscrow.version }, 'Escrow cancelled after payment_intent.payment_failed');
}

async function handlePayoutFailed(payout: Stripe.Payout, stripeEventId: string): Promise<void> {
  const payoutId = payout.id;
  const payoutAmount = payout.amount;
  const connectAccountId: string | null = (payout.metadata?.connect_account_id as string | undefined) ?? null;

  log.error({ payoutId, payoutAmount, connectAccountId, stripeEventId }, 'CRITICAL: Stripe payout.failed');

  let userId: string | null = null;
  if (connectAccountId) {
    const userResult = await db.query<{ id: string }>(`SELECT id FROM users WHERE stripe_connect_id = $1 LIMIT 1`, [connectAccountId]);
    userId = userResult.rows[0]?.id ?? null;
  }

  if (userId) {
    await sendPushNotification(userId, 'Bank Transfer Failed', 'Your bank transfer failed. Please update your bank details.', { screen: 'payout_settings', type: 'payout_failed' });
  }

  await RevenueService.logEvent({
    eventType: 'failed_payout',
    userId: userId ?? 'system',
    amountCents: -payoutAmount,
    stripeEventId,
    metadata: { payout_id: payoutId, connect_account_id: connectAccountId, payout_status: payout.status, failure_code: payout.failure_code, failure_message: payout.failure_message },
  });
}
