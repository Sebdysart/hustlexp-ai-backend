/**
 * Payment Worker v1.2.0
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
 * - payout.failed → audited multi-channel notification to worker, ledger entry, no state change
 *
 * CRITICAL RULES:
 * - All state transitions must check version (optimistic locking)
 * - All state transitions must increment version
 * - Terminal states cannot transition (enforced by DB trigger)
 * - Illegal transitions fail and are recorded as failed
 * - SELECT ... FOR UPDATE MUST be inside db.transaction() — bare db.query() releases
 *   the row lock when the connection is returned to the pool.
 *
 * @see ARCHITECTURE.md §2.4
 */

import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { TaskService } from '../services/TaskService.js';
import { RevenueService } from '../services/RevenueService.js';
import { StripeService } from '../services/StripeService.js';
import { EscrowService } from '../services/EscrowService.js';
import { NotificationService } from '../services/NotificationService.js';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';
import { workerLogger } from '../logger.js';
import { verifyJobSignature } from './queues.js';
import { config } from '../config.js';
import {
  clampFeePercent,
  computeFeeBreakdown,
  feeBasisPoints,
  resolvePlatformFeeCents,
} from '../lib/money.js';
import type { Job } from 'bullmq';
import type Stripe from 'stripe';
import type { QueryFn } from '../db.js';
import { ErrorCodes } from '../types.js';
import { newPaymentCreationMode } from '../services/NewPaymentCreationGuard.js';
import { loadCurrentTaskPayoutDestination } from '../services/TaskPayoutDestinationService.js';
import { EscrowReleaseReconciliationService } from '../services/EscrowReleaseReconciliationService.js';
import { XPService } from '../services/XPService.js';
import {
  persistExactFullTransferReversalWitness,
  requireExactFullTransferReversal,
} from '../services/EscrowRefundService.js';
import type { ExactFullTransferReversalBinding } from '../services/EscrowRefundService.js';
import {
  exactSucceededRefundWitness,
  persistExactSucceededRefundWitness,
} from '../services/EscrowRefundProviderWitness.js';
import {
  claimStripeEventInbox,
  finalizeStripeEventInboxClaim,
  isStripeEventInboxClaimLost,
  releaseStripeEventInboxClaim,
  requireExactStripeEventOutboxKey,
} from './StripeEventInboxLease.js';
import { markStripeEventOutboxesProcessed } from './outbox-worker.js';

const log = workerLogger.child({ worker: 'payment' });

// ============================================================================
// TYPES
// ============================================================================

interface StripeEventReceivedPayload {
  stripeEventId: string;
  eventType?: string;
  type?: string;
  eventCreated?: string;
  _sig: string;
}

interface PaymentJobData {
  payload: StripeEventReceivedPayload;
}

const STRIPE_EVENT_TYPE_MISMATCH = 'STRIPE_EVENT_TYPE_MISMATCH';

function stripeEventTypeMismatch(input: {
  stripeEventId: string;
  claimedType: string;
  signedEventType: string | null;
  signedType: string | null;
}): Error & { paymentWorkerDisposition: 'quarantine' } {
  return Object.assign(new Error(
    `${STRIPE_EVENT_TYPE_MISMATCH}: signed queue type does not match claimed Stripe event ${input.stripeEventId} (${JSON.stringify({
      claimedType: input.claimedType,
      signedEventType: input.signedEventType,
      signedType: input.signedType,
    })})`,
  ), { paymentWorkerDisposition: 'quarantine' as const });
}

// ============================================================================
// PAYMENT WORKER
// ============================================================================

export async function processPaymentJob(job: Job<PaymentJobData>): Promise<void> {
  // HMAC signature verification (Attack 12 — Redis injection defence)
  // payment.stripe_event_received jobs are signed via FINANCIAL_EVENT_TYPES in outbox-worker.
  // Every financial job must retain the exact signed outbox payload. The
  // canonical Stripe route uses `type`; the legacy payment route used
  // `eventType`, so both are accepted without mutating the signed envelope.
  const payload = job.data?.payload as unknown as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') {
    throw new Error('JOB_SCHEMA_INVALID: Missing payment payload');
  }
  const stripeEventId = typeof payload.stripeEventId === 'string' ? payload.stripeEventId : '';
  const signedEventType = typeof payload.eventType === 'string' ? payload.eventType : null;
  const signedType = typeof payload.type === 'string' ? payload.type : null;
  const eventType = signedEventType ?? signedType ?? '';
  const signature = payload._sig;
  if (!stripeEventId || !eventType) {
    throw new Error('JOB_SCHEMA_INVALID: stripeEventId and event type are required');
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    log.error({ jobId: job.id, eventType }, 'Missing job signature — possible Redis injection attack');
    throw new Error('JOB_SIGNATURE_REQUIRED: Payment jobs must be signed');
  }
  const { _sig: _signature, ...payloadWithoutSig } = payload;
  if (!verifyJobSignature(payloadWithoutSig, signature)) {
    log.error(
      { jobId: job.id, eventType },
      'Job signature verification failed — possible Redis injection attack',
    );
    throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
  }
  const outboxKey = requireExactStripeEventOutboxKey(job, payloadWithoutSig, stripeEventId);

  const _idempotencyKey = job.id || `payment:${stripeEventId}`;

  // P0: one exact lease owner may process or acknowledge this provider fact.
  // An expired hard-crash lease can be rotated by the signed recovery job.
  const stripeEvent = await claimStripeEventInbox<Stripe.Event>(stripeEventId);
  if (!stripeEvent) {
    const existingResult = await db.query<{
      result: string | null;
      claimed_at: Date | null;
      processed_at: Date | null;
    }>(
      `SELECT result,claimed_at,processed_at
       FROM stripe_events
       WHERE stripe_event_id=$1`,
      [stripeEventId],
    );
    if (existingResult.rowCount === 0) {
      throw new Error(`Stripe event ${stripeEventId} not found`);
    }
    if (existingResult.rows[0].processed_at !== null) {
      await markStripeEventOutboxesProcessed({ idempotencyKey: outboxKey, stripeEventId });
    }
    log.info(
      { stripeEventId, result: existingResult.rows[0].result },
      'Stripe event already claimed/processed, skipping',
    );
    return;
  }

  const { claimToken } = stripeEvent;
  try {
    if (
      stripeEvent.type !== eventType
      || (signedEventType !== null && signedEventType !== stripeEvent.type)
      || (signedType !== null && signedType !== stripeEvent.type)
    ) {
      throw stripeEventTypeMismatch({
        stripeEventId,
        claimedType: stripeEvent.type,
        signedEventType,
        signedType,
      });
    }

    if (eventType === 'payment_intent.succeeded' && newPaymentCreationMode() === 'frozen') {
      await finalizeStripeEventInboxClaim({
        stripeEventId,
        claimToken,
        result: 'skipped',
        errorMessage: 'PAYMENT_CREATION_FROZEN: positive processor fact retained for reconciliation; escrow funding suppressed',
      });
      await markStripeEventOutboxesProcessed({ idempotencyKey: outboxKey, stripeEventId });
      log.warn({ stripeEventId, eventType }, 'Frozen payment event retained without escrow funding');
      return;
    }

    // Extract event object from payload (Stripe.Event.data.object)
    const eventObject = stripeEvent.payload_json.data.object;

    // Process event based on type
    switch (eventType) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(eventObject as Stripe.PaymentIntent, stripeEventId);
        break;

      case 'transfer.created':
        await handleTransferCreated(eventObject as Stripe.Transfer);
        break;

      case 'transfer.reversed':
        if (await handleTransferReversed(
          eventObject as Stripe.Transfer,
          stripeEventId,
          claimToken,
        )) {
          await markStripeEventOutboxesProcessed({ idempotencyKey: outboxKey, stripeEventId });
          return;
        }
        break;

      case 'transfer.failed':
        await handleTransferFailed(eventObject as Stripe.Transfer, stripeEventId);
        break;

      case 'payment_intent.payment_failed':
        if (await handlePaymentIntentPaymentFailed(
          eventObject as Stripe.PaymentIntent,
          stripeEventId,
          claimToken,
        )) {
          await markStripeEventOutboxesProcessed({ idempotencyKey: outboxKey, stripeEventId });
          return;
        }
        break;

      case 'payout.failed':
        await handlePayoutFailed(eventObject as Stripe.Payout, stripeEventId);
        break;

      case 'charge.refunded':
        if (await handleChargeRefunded(
          eventObject as Stripe.Charge,
          stripeEventId,
          claimToken,
        )) {
          await markStripeEventOutboxesProcessed({ idempotencyKey: outboxKey, stripeEventId });
          return;
        }
        break;

      default:
        // Unknown event type - mark as skipped (not failed)
        // Set processed_at = NOW() to finalize (terminal state)
        await finalizeStripeEventInboxClaim({
          stripeEventId,
          claimToken,
          result: 'skipped',
          errorMessage: `Unknown event type: ${eventType}`,
        });
        await markStripeEventOutboxesProcessed({ idempotencyKey: outboxKey, stripeEventId });
        log.warn({ stripeEventId, eventType }, 'Stripe event skipped (unknown type)');
        return;
    }

    // Mark event as processed (success) - set processed_at = NOW() to finalize
    await finalizeStripeEventInboxClaim({ stripeEventId, claimToken, result: 'success' });
    await markStripeEventOutboxesProcessed({ idempotencyKey: outboxKey, stripeEventId });

    log.info({ stripeEventId, eventType }, 'Stripe event processed successfully');
  } catch (error) {
    if (isStripeEventInboxClaimLost(error)) throw error;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const quarantine = error instanceof Error
      && (error as Error & { paymentWorkerDisposition?: unknown }).paymentWorkerDisposition
        === 'quarantine';

    if (quarantine) {
      // A signed queue/claimed-row type mismatch is not transient. Tombstone the
      // exact claimed event so a forged routing envelope cannot retry under a
      // different handler and dispatch the stored provider object incorrectly.
      await finalizeStripeEventInboxClaim({
        stripeEventId,
        claimToken,
        result: 'failed',
        errorMessage,
      });
    } else {
      // Release the claim so BullMQ retries can re-claim this event.
      // CRITICAL: Do NOT set processed_at here — that would prevent all retries.
      await releaseStripeEventInboxClaim({ stripeEventId, claimToken, errorMessage });
    }

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
 *
 * The SELECT ... FOR UPDATE and the subsequent UPDATE run inside a single
 * db.transaction() so the row lock is held for the entire critical section.
 * writeToOutbox is intentionally outside the transaction — it calls an
 * external helper that manages its own connection.
 */
async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent, stripeEventId: string): Promise<void> {
  const paymentIntentId = paymentIntent.id;

  // -------------------------------------------------------------------------
  // Critical section: lock escrow row, validate state, update atomically
  // -------------------------------------------------------------------------
  const { updatedEscrow, escrowId, amount } = await db.transaction(async (trx: QueryFn) => {
    // Find escrow by stripe_payment_intent_id — FOR UPDATE holds the lock
    const escrowResult = await trx<{
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
      // Mark the stripe_event as skipped inside the transaction so that the
      // terminal-skip path is also atomic with the lock.
      log.warn(
        { escrowId: escrow.id, state: escrow.state, stripeEventId },
        'Refund state already terminal; replaying idempotent post-effects before event success',
      );
      // Signal the outer function to return early by returning a sentinel
      return { updatedEscrow: null, escrowId: escrow.id, amount: escrow.amount };
    }

    // Validate state transition: PENDING → FUNDED
    if (escrow.state !== 'PENDING') {
      throw new Error(`Cannot fund escrow ${escrow.id}: current state is ${escrow.state}, expected PENDING`);
    }

    // The canonical PaymentIntent creator authorizes exactly the immutable
    // escrow/customer total; it does not add Stripe Tax or Connect fees. Reject
    // both underpayment and overpayment so a compromised or manually altered PI
    // cannot silently change what the Poster pays.
    if (paymentIntent.amount_received !== escrow.amount) {
      throw new Error(`Payment received (${paymentIntent.amount_received}) does not exactly match escrow amount (${escrow.amount})`);
    }
    if (paymentIntent.amount !== escrow.amount) {
      throw new Error(`Payment intent amount (${paymentIntent.amount}) does not exactly match escrow amount (${escrow.amount})`);
    }

    // Update escrow: PENDING → FUNDED (with version check and increment)
    const updateResult = await trx<{
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

    return { updatedEscrow: updateResult.rows[0], escrowId: escrow.id, amount: escrow.amount };
  });

  // Terminal-skip path: transaction already wrote the skipped status; exit here
  if (!updatedEscrow) {
    return;
  }

  // -------------------------------------------------------------------------
  // Post-transaction side effects (outbox write uses its own connection)
  // -------------------------------------------------------------------------
  await writeToOutbox({
    eventType: 'escrow.funded',
    aggregateType: 'escrow',
    aggregateId: escrowId,
    eventVersion: updatedEscrow.version,
    payload: {
      escrowId,
      paymentIntentId,
      amount,
      version: updatedEscrow.version,
    },
    queueName: 'user_notifications',
    idempotencyKey: `escrow.funded:${escrowId}:${updatedEscrow.version}`,
  });

  log.info({ escrowId, version: updatedEscrow.version }, 'Escrow funded (PENDING → FUNDED)');
}

/**
 * Handle transfer.created: escrow FUNDED|LOCKED_DISPUTE → RELEASED
 *
 * Provider facts are validated under a row lock, then the state transition is
 * delegated to EscrowService.release(), the single audited release path.
 */
async function lockOriginalReleaseTransition(
  query: QueryFn,
  escrowId: string,
  currentState: string,
): Promise<'FUNDED' | 'LOCKED_DISPUTE'> {
  if (currentState === 'FUNDED' || currentState === 'LOCKED_DISPUTE') {
    return currentState;
  }
  const origin = await query<{ from_state:'FUNDED' | 'LOCKED_DISPUTE' }>(
    `SELECT from_state
       FROM escrow_events
      WHERE escrow_id=$1
        AND idempotency_key=$2
        AND from_state IN ('FUNDED','LOCKED_DISPUTE')
        AND to_state='RELEASED'
        AND actor_id IS NULL
        AND actor_type='system'
      FOR UPDATE`,
    [escrowId,`escrow.released:${escrowId}`],
  );
  if (origin.rows.length !== 1) {
    throw new Error(
      `Released escrow ${escrowId} lacks one exact immutable FUNDED/LOCKED_DISPUTE release origin`,
    );
  }
  return origin.rows[0].from_state;
}

async function handleTransferCreated(transfer: Stripe.Transfer): Promise<void> {
  const transferId = transfer.id;
  const witnessResult = await StripeService.readTransferWitness(transferId);
  if (!witnessResult.success) {
    throw new Error(
      `Transfer ${transferId} current provider evidence is unavailable: ${witnessResult.error.message}`,
    );
  }
  const transferWitness = witnessResult.data;
  const escrowId = transferWitness.escrowId;
  if (
    !escrowId
    || transfer.metadata?.escrow_id !== escrowId
    || transfer.metadata?.task_id !== transferWitness.taskId
  ) {
    throw new Error(`Transfer ${transferId} webhook identity does not match current provider metadata`);
  }

  // -------------------------------------------------------------------------
  // Critical section: lock escrow row and validate provider facts. This handler
  // must never terminalize escrow directly; EscrowService owns that mutation.
  // -------------------------------------------------------------------------
  const releaseContext = await db.transaction(async (trx: QueryFn) => {
    // Find escrow by id (with version check) — FOR UPDATE holds the lock
    const escrowResult = await trx<{
      id: string;
      task_id: string;
      state: string;
      version: number;
      amount: number;
      platform_fee_cents: number | null;
      stripe_transfer_id: string | null;
      stripe_payment_intent_id: string | null;
    }>(
      `SELECT id, task_id, state, version, amount, platform_fee_cents, stripe_transfer_id, stripe_payment_intent_id
       FROM escrows
       WHERE id = $1
       FOR UPDATE`,
      [escrowId]
    );

    if (escrowResult.rows.length === 0) {
      throw new Error(`Escrow ${escrowId} not found`);
    }

    const escrow = escrowResult.rows[0];

    if (escrow.state === 'REFUNDED' || escrow.state === 'REFUND_PARTIAL') {
      throw new Error(
        `Transfer ${transferId} cannot settle escrow ${escrowId}: escrow is already ${escrow.state}`,
      );
    }

    // Validate state transition: FUNDED|LOCKED_DISPUTE → RELEASED
    // BUG FIX: When a dispute is resolved in the worker's favour, EscrowService.release()
    // creates a Stripe transfer from LOCKED_DISPUTE state. The resulting transfer.created
    // event must be accepted here too — previously only FUNDED was allowed, causing the
    // worker to throw and retry forever on dispute-won transfers.
    if (escrow.state !== 'FUNDED' && escrow.state !== 'LOCKED_DISPUTE' && escrow.state !== 'RELEASED') {
      throw new Error(`Cannot release escrow ${escrowId}: current state is ${escrow.state}, expected FUNDED or LOCKED_DISPUTE`);
    }
    if (escrow.stripe_transfer_id && escrow.stripe_transfer_id !== transferId) {
      throw new Error(
        `Transfer conflict for escrow ${escrowId}: recorded ${escrow.stripe_transfer_id}, received ${transferId}`,
      );
    }
    if (escrow.state === 'RELEASED' && escrow.stripe_transfer_id !== transferId) {
      throw new Error(
        `Released escrow ${escrowId} is not bound to transfer ${transferId}`,
      );
    }
    const originalFromState = await lockOriginalReleaseTransition(
      trx,
      escrow.id,
      escrow.state,
    );

    // A provider receipt is not settlement evidence unless it proves the exact
    // worker transfer. The immutable quote stores the gross worker share while
    // release withholds the disclosed self-insurance adjustment; both the
    // completion worker and this webhook validator consume the same helper.
    const expectedTransferAmount = computeFeeBreakdown(
      escrow.amount,
      config.stripe.platformFeePercent,
      escrow.platform_fee_cents,
    ).netPayoutCents;
    if (
      !Number.isInteger(transferWitness.amountCents)
      || transferWitness.amountCents !== expectedTransferAmount
    ) {
      throw new Error(
        `Transfer ${transferId} amount (${String(transferWitness.amountCents)}) does not match expected net payout (${expectedTransferAmount}) for escrow ${escrowId}`,
      );
    }

    const taskResult = await trx<{
      worker_id: string | null;
      payout_recipient_user_id: string | null;
    }>(
      `SELECT worker_id, payout_recipient_user_id
       FROM tasks
       WHERE id = $1`,
      [escrow.task_id],
    );
    const task = taskResult.rows[0];
    if (!task?.worker_id) {
      throw new Error(`Transfer ${transferId} has no canonical worker binding for task ${escrow.task_id}`);
    }
    const payoutRecipientUserId = task.payout_recipient_user_id ?? task.worker_id;
    const destination = await loadCurrentTaskPayoutDestination(trx, {
      taskId: escrow.task_id,
      workerId: task.worker_id,
      payoutRecipientUserId,
    });
    if (
      transferWitness.currency !== 'usd'
      || transferWitness.reversed
      || transferWitness.amountReversedCents !== 0
      || !destination.ready
      || transferWitness.destinationAccountId !== destination.stripeConnectId
      || transferWitness.taskId !== escrow.task_id
      || transferWitness.payoutRecipientUserId !== payoutRecipientUserId
    ) {
      throw new Error(
        `Transfer ${transferId} does not match the canonical payout destination and recipient for escrow ${escrowId}`,
      );
    }

    return {
      taskId: escrow.task_id,
      escrowAmount: escrow.amount,
      escrowPlatformFeeCents: escrow.platform_fee_cents,
      stripePaymentIntentId: escrow.stripe_payment_intent_id,
      alreadyReleased: escrow.state === 'RELEASED',
      fromState: originalFromState,
      version: escrow.version,
    };
  });

  let releasedVersion = releaseContext.version;
  if (!releaseContext.alreadyReleased) {
    // Re-read at the canonical transition boundary. The initial witness was
    // used for preflight only; a concurrent reversal between that read and the
    // release transaction must not be accepted from stale provider state.
    const currentWitnessResult = await StripeService.readTransferWitness(transferId);
    if (!currentWitnessResult.success) {
      throw new Error(
        `Transfer ${transferId} current release evidence is unavailable: ${currentWitnessResult.error.message}`,
      );
    }
    const releaseResult = await EscrowService.release({
      escrowId,
      stripeTransferId: transferId,
      stripeTransferWitness: currentWitnessResult.data,
    });
    if (!releaseResult.success) {
      // A concurrent completion worker may win after preflight. Accept only the
      // exact same terminal fact; every other terminal or transfer is a conflict.
      if (
        releaseResult.error.code !== ErrorCodes.ESCROW_TERMINAL
        && releaseResult.error.code !== ErrorCodes.INVALID_STATE
      ) {
        throw new Error(
          `EscrowService.release failed for ${escrowId}: ${releaseResult.error.message}`,
        );
      }
      const current = await EscrowService.getById(escrowId);
      if (
        !current.success
        || current.data.state !== 'RELEASED'
        || current.data.stripe_transfer_id !== transferId
      ) {
        throw new Error(
          `Escrow ${escrowId} changed during release without converging on transfer ${transferId}`,
        );
      }
      releasedVersion = current.data.version;
    } else {
      releasedVersion = releaseResult.data.version;
    }
  }

  // -------------------------------------------------------------------------
  // Post-transaction side effects
  // -------------------------------------------------------------------------

  // Re-read the processor immediately before reconciliation for both first
  // release and already-RELEASED recovery. A webhook receipt or the earlier
  // preflight cannot prove that the transfer was not reversed in between.
  const reconcileWitnessResult = await StripeService.readTransferWitness(transferId);
  if (!reconcileWitnessResult.success) {
    throw new Error(
      `Transfer ${transferId} current reconciliation evidence is unavailable: ${reconcileWitnessResult.error.message}`,
    );
  }
  await db.transaction(async (query) => {
    const currentEscrowResult = await query<{
      id:string;
      task_id:string;
      state:string;
      version:number;
      amount:number;
      platform_fee_cents:number | null;
      stripe_transfer_id:string | null;
      provider_transfer_status:string | null;
    }>(
      `SELECT id,task_id,state,version,amount,platform_fee_cents,
              stripe_transfer_id,provider_transfer_status
         FROM escrows WHERE id=$1 FOR UPDATE`,
      [escrowId],
    );
    const currentEscrow = currentEscrowResult.rows[0];
    if (
      !currentEscrow
      || currentEscrow.state !== 'RELEASED'
      || currentEscrow.version !== releasedVersion
      || currentEscrow.stripe_transfer_id !== transferId
      || !['submitted', 'processing', 'paid'].includes(
        currentEscrow.provider_transfer_status ?? '',
      )
    ) {
      throw new Error(
        `Escrow ${escrowId} changed before exact release reconciliation`,
      );
    }
    const currentTaskResult = await query<{
      worker_id:string | null;
      payout_recipient_user_id:string | null;
    }>(
      `SELECT worker_id,payout_recipient_user_id FROM tasks WHERE id=$1 FOR UPDATE`,
      [currentEscrow.task_id],
    );
    const currentTask = currentTaskResult.rows[0];
    if (!currentTask?.worker_id) {
      throw new Error(`Task ${currentEscrow.task_id} lost its worker before reconciliation`);
    }
    const currentPayoutRecipient =
      currentTask.payout_recipient_user_id ?? currentTask.worker_id;
    const currentDestination = await loadCurrentTaskPayoutDestination(query, {
      taskId:currentEscrow.task_id,
      workerId:currentTask.worker_id,
      payoutRecipientUserId:currentPayoutRecipient,
    });
    const currentExpectedAmount = computeFeeBreakdown(
      currentEscrow.amount,
      config.stripe.platformFeePercent,
      currentEscrow.platform_fee_cents,
    ).netPayoutCents;
    const currentWitness = reconcileWitnessResult.data;
    if (
      !currentDestination.ready
      || currentWitness.provider !== 'STRIPE'
      || currentWitness.transferId !== transferId
      || currentWitness.escrowId !== currentEscrow.id
      || currentWitness.taskId !== currentEscrow.task_id
      || currentWitness.payoutRecipientUserId !== currentPayoutRecipient
      || currentWitness.destinationAccountId !== currentDestination.stripeConnectId
      || currentWitness.currency !== 'usd'
      || currentWitness.amountCents !== currentExpectedAmount
      || currentWitness.reversed
      || currentWitness.amountReversedCents !== 0
    ) {
      throw new Error(
        `Transfer ${transferId} changed before release reconciliation for escrow ${escrowId}`,
      );
    }
  });

  const reconciliation = await EscrowReleaseReconciliationService.reconcile({
    escrowId,
    expectedStripeTransferId: transferId,
    fromState: releaseContext.fromState,
  });
  if (!reconciliation.success) {
    throw new Error(
      `Release-witness convergence failed for escrow ${escrowId}: ${reconciliation.error.message}`,
    );
  }

  log.info({ escrowId, version: releasedVersion }, 'Escrow released through canonical service (→ RELEASED)');
}

async function handleTransferReversed(
  transfer: Stripe.Transfer,
  stripeEventId: string,
  claimToken: string,
): Promise<boolean> {
  const current = await StripeService.readTransferWitness(transfer.id);
  if (!current.success) {
    throw new Error(
      `Transfer reversal ${transfer.id} current provider evidence is unavailable: ${current.error.message}`,
    );
  }
  const witness = current.data;
  const webhookEscrowId = transfer.metadata?.escrow_id ?? null;
  const webhookTaskId = transfer.metadata?.task_id ?? null;
  const escrowId = witness.escrowId;
  if (
    !escrowId
    || webhookEscrowId !== escrowId
    || webhookTaskId !== witness.taskId
    || witness.transferId !== transfer.id
  ) {
    throw new Error(`Transfer reversal ${transfer.id} has conflicting webhook/provider identity`);
  }

  const classification = await db.transaction(async (trx:QueryFn) => {
    const locked = await trx<{
      id:string;
      task_id:string;
      state:string;
      version:number;
      amount:number;
      platform_fee_cents:number | null;
      stripe_transfer_id:string | null;
      provider_transfer_status:string | null;
      worker_id:string | null;
      payout_recipient_user_id:string | null;
    }>(
      `SELECT e.id,e.task_id,e.state,e.version,e.amount,e.platform_fee_cents,
              e.stripe_transfer_id,e.provider_transfer_status,
              t.worker_id,t.payout_recipient_user_id
         FROM escrows e
         JOIN tasks t ON t.id=e.task_id
        WHERE e.id=$1
        FOR UPDATE OF e`,
      [escrowId],
    );
    const escrow = locked.rows[0];
    if (!escrow) throw new Error(`Escrow ${escrowId} not found for transfer reversal`);
    if (!escrow.worker_id) {
      throw new Error(`Task ${escrow.task_id} has no worker for transfer reversal ${transfer.id}`);
    }
    const payoutRecipientUserId = escrow.payout_recipient_user_id ?? escrow.worker_id;
    const destination = await loadCurrentTaskPayoutDestination(trx, {
      taskId:escrow.task_id,
      workerId:escrow.worker_id,
      payoutRecipientUserId,
    });
    const expectedAmount = computeFeeBreakdown(
      escrow.amount,
      config.stripe.platformFeePercent,
      escrow.platform_fee_cents,
    ).netPayoutCents;
    const boundedReversalAmount = Number.isInteger(witness.amountReversedCents)
      && witness.amountReversedCents > 0
      && witness.amountReversedCents <= witness.amountCents;
    const canonicalTransferMatched = escrow.stripe_transfer_id === transfer.id;
    const exactTransferBinding = canonicalTransferMatched
      && witness.provider === 'STRIPE'
      && witness.taskId === escrow.task_id
      && witness.payoutRecipientUserId === payoutRecipientUserId
      && destination.ready
      && witness.destinationAccountId === destination.stripeConnectId
      && witness.currency === 'usd'
      && witness.amountCents === expectedAmount
      && boundedReversalAmount
      && witness.reversed === (witness.amountReversedCents === witness.amountCents);
    const canonicallyExpected = exactTransferBinding
      && witness.reversed
      && witness.amountReversedCents === witness.amountCents
      && escrow.state === 'REFUNDED'
      && escrow.provider_transfer_status === 'reversed';

    let observedProviderTransferStatus = escrow.provider_transfer_status;
    if (
      canonicalTransferMatched
      && !canonicallyExpected
      && escrow.provider_transfer_status !== 'manual_reconciliation'
    ) {
      await authorizeProviderTransferStatusChange({
        query:trx,
        escrowId:escrow.id,
        taskId:escrow.task_id,
        canonicalState:escrow.state,
        canonicalVersion:escrow.version,
        transferId:transfer.id,
        stripeEventId,
        reason:'transfer_reversed_provider_fact',
        statusBefore:escrow.provider_transfer_status,
        statusAfter:'manual_reconciliation',
      });
      const poisoned = await trx<{ version:number }>(
        `UPDATE escrows
            SET provider_transfer_status='manual_reconciliation',
                version=version+1,
                updated_at=NOW()
          WHERE id=$1
            AND version=$2
            AND stripe_transfer_id=$3
            AND provider_transfer_status IS NOT DISTINCT FROM $4
          RETURNING version`,
        [escrow.id,escrow.version,transfer.id,escrow.provider_transfer_status],
      );
      if (poisoned.rowCount !== 1) {
        throw new Error(
          `Escrow ${escrow.id} changed before transfer reversal ${transfer.id} could be quarantined`,
        );
      }
      observedProviderTransferStatus = 'manual_reconciliation';
    }

    const reasonCode = canonicallyExpected
      ? 'CANONICAL_REFUND_TRANSFER_REVERSAL_CONFIRMED'
      : exactTransferBinding
        ? 'UNEXPECTED_TRANSFER_REVERSAL'
        : 'TRANSFER_REVERSAL_BINDING_MISMATCH';
    await ensureExactSystemEscrowEvent({
      query:trx,
      escrowId:escrow.id,
      fromState:escrow.state,
      toState:escrow.state,
      metadata:{
        reason:'transfer_reversed_provider_fact',
        reason_code:reasonCode,
        stripe_event_id:stripeEventId,
        transfer_id:transfer.id,
        task_id:escrow.task_id,
        payout_recipient_user_id:payoutRecipientUserId,
        destination_account_id:witness.destinationAccountId,
        amount_cents:witness.amountCents,
        amount_reversed_cents:witness.amountReversedCents,
        currency:witness.currency,
        provider_reversed:witness.reversed,
        canonical_transfer_id_matched:canonicalTransferMatched,
        exact_transfer_binding:exactTransferBinding,
        canonical_refund_converged:canonicallyExpected,
        provider_transfer_status_before:escrow.provider_transfer_status,
        provider_transfer_status_after:observedProviderTransferStatus,
      },
      idempotencyKey:
        `escrow.transfer-reversed:${escrow.id}:${transfer.id}:${stripeEventId}:${witness.amountReversedCents}`,
    });
    return { escrowId:escrow.id,taskId:escrow.task_id,canonicallyExpected,reasonCode };
  });

  if (classification.canonicallyExpected) return false;

  await finalizeStripeEventInboxClaim({
    stripeEventId,
    claimToken,
    result:'failed',
    errorMessage:`TRANSFER_REVERSAL_RECONCILIATION_REQUIRED: ${classification.reasonCode}`,
  });
  await notifyAdmins({
    title:'transfer.reversed requires reconciliation',
    body:`Transfer ${transfer.id} reversed outside an exact canonical refund for escrow ${classification.escrowId}.`,
    deepLink:`/admin/escrows/${classification.escrowId}`,
    priority:'CRITICAL',
    metadata:{
      stripe_event_id:stripeEventId,
      transfer_id:transfer.id,
      escrow_id:classification.escrowId,
      task_id:classification.taskId,
      reason_code:classification.reasonCode,
    },
  }).catch((error) => log.error({ error }, 'Failed to notify ops about transfer reversal'));
  return true;
}

/**
 * Handle charge.refunded: escrow PENDING|FUNDED|LOCKED_DISPUTE → REFUNDED
 *
 * The SELECT ... FOR UPDATE and the subsequent UPDATE run inside a single
 * db.transaction(). TaskService.advanceProgress and writeToOutbox are
 * intentionally outside.
 */
async function recordRefundReconciliationRequired(
  charge: Stripe.Charge,
  stripeEventId: string,
  claimToken: string,
  reason: string,
  terminalizeEvent = true,
): Promise<void> {
  if (terminalizeEvent) {
    await finalizeStripeEventInboxClaim({
      stripeEventId,
      claimToken,
      result:'failed',
      errorMessage:`REFUND_RECONCILIATION_REQUIRED: ${reason}`,
    });
  }
  await notifyAdmins({
    title: 'charge.refunded requires reconciliation',
    body: `Stripe charge ${charge.id} was retained without a canonical escrow transition: ${reason}`,
    deepLink: `/admin/stripe-events/${stripeEventId}`,
    priority: 'CRITICAL',
    metadata: {
      stripe_event_id: stripeEventId,
      charge_id: charge.id,
      reason_code: 'REFUND_RECONCILIATION_REQUIRED',
    },
  }).catch((error) => log.error({ error }, 'Failed to notify ops about refund reconciliation'));
}

type PlatformFeeReversalWitness = {
  amount_cents: number;
  currency: string;
  task_id: string | null;
  gross_amount_cents: number;
  platform_fee_cents: number;
  net_amount_cents: number;
  fee_basis_points: number | null;
  escrow_id: string | null;
  stripe_event_id: string | null;
  stripe_charge_id: string | null;
  stripe_payment_intent_id: string | null;
  metadata: Record<string, unknown> | null;
};

async function ensureExactSystemEscrowEvent(input: {
  query: QueryFn;
  escrowId: string;
  fromState: string;
  toState: string;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<void> {
  const metadata = JSON.stringify(input.metadata);
  const exact = await input.query<{ id:string }>(
    `WITH attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,$2,$5,NULL,'system',$3,$4)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id
     )
     SELECT id FROM attempted
     UNION ALL
     SELECT id FROM escrow_events
      WHERE escrow_id=$1
        AND from_state=$2
        AND to_state=$5
        AND actor_id IS NULL
        AND actor_type='system'
        AND metadata::jsonb=$3::jsonb
        AND idempotency_key=$4
     LIMIT 1`,
    [input.escrowId,input.fromState,metadata,input.idempotencyKey,input.toState],
  );
  if (exact.rowCount !== 1) {
    throw new Error(
      `Escrow event ${input.idempotencyKey} is missing or conflicts with exact immutable facts`,
    );
  }
}

async function authorizeProviderTransferStatusChange(input: {
  query: QueryFn;
  escrowId: string;
  taskId: string;
  canonicalState: string;
  canonicalVersion: number;
  transferId: string;
  stripeEventId: string;
  reason: string;
  statusBefore: string | null;
  statusAfter: string;
}): Promise<void> {
  await ensureExactSystemEscrowEvent({
    query:input.query,
    escrowId:input.escrowId,
    fromState:input.canonicalState,
    toState:input.canonicalState,
    metadata:{
      event_type:'provider_transfer_status_authority_v1',
      reason:input.reason,
      stripe_event_id:input.stripeEventId,
      escrow_id:input.escrowId,
      task_id:input.taskId,
      canonical_state:input.canonicalState,
      canonical_version:input.canonicalVersion,
      transfer_id:input.transferId,
      provider_transfer_status_before:input.statusBefore,
      provider_transfer_status_after:input.statusAfter,
    },
    idempotencyKey:[
      'provider-transfer-status-authority-v1',
      input.escrowId,
      input.canonicalVersion,
      input.stripeEventId,
      input.statusAfter,
    ].join(':'),
  });
  await input.query(
    `SELECT set_config('hustlexp.provider_transfer_status_authority',$1,true)`,
    [input.escrowId],
  );
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactJson(actualValue: unknown, expected: Record<string, unknown>): boolean {
  const actual = jsonRecord(actualValue);
  if (!actual) return false;
  const keys = Object.keys(expected);
  return Object.keys(actual).length === keys.length
    && keys.every((key) => Object.is(actual[key], expected[key]));
}

async function requireExactOrdinaryLockedRefundBinding(
  query: QueryFn,
  input: {
    escrowId: string;
    taskId: string;
    state: string;
    version: number;
    amount: number;
    paymentIntentId: string | null;
    transferId: string | null;
    storedRefundId: string | null;
    refundId: string;
    chargeId: string;
  },
): Promise<void> {
  const claimVersion = input.version - 1;
  if (
    input.state !== 'LOCKED_DISPUTE'
    || !Number.isSafeInteger(claimVersion)
    || claimVersion < 0
    || !input.paymentIntentId
    || input.transferId !== null
    || input.storedRefundId !== input.refundId
  ) {
    throw new Error(
      `Escrow ${input.escrowId} lacks an exact stored no-transfer refund binding`,
    );
  }
  const claimKey =
    `action-refund-provider-claim-v1:${input.escrowId}:${claimVersion}:${input.amount}`;
  const witnessKey = `exact-succeeded-refund-v1:${input.escrowId}:${input.refundId}`;
  const result = await query<{ exact:boolean }>(
    `SELECT
       (SELECT COUNT(*)=1
          FROM escrow_events claim
         WHERE claim.escrow_id=$1
           AND claim.from_state='LOCKED_DISPUTE'
           AND claim.to_state='LOCKED_DISPUTE'
           AND claim.actor_id IS NULL
           AND claim.actor_type='system'
           AND claim.idempotency_key=$8
           AND jsonb_object_length(claim.metadata)=10
           AND claim.metadata=jsonb_build_object(
             'event_type','action_refund_provider_claim_v1',
             'escrow_id',$1::text,
             'task_id',$2::text,
             'canonical_state','LOCKED_DISPUTE',
             'expected_version',$3::integer,
             'escrow_amount_cents',$4::integer,
             'refund_amount_cents',$4::integer,
             'stripe_payment_intent_id',$5::text,
             'stripe_transfer_id',NULL,
             'stripe_refund_id',NULL
           ))
       AND
       (SELECT COUNT(*)=1
          FROM escrow_events witness
         WHERE witness.escrow_id=$1
           AND witness.from_state='LOCKED_DISPUTE'
           AND witness.to_state='LOCKED_DISPUTE'
           AND witness.actor_id IS NULL
           AND witness.actor_type='system'
           AND witness.idempotency_key=$9
           AND jsonb_object_length(witness.metadata)=10
           AND witness.metadata=jsonb_build_object(
             'event_type','exact_succeeded_refund_witness_v1',
             'escrow_id',$1::text,
             'task_id',$2::text,
             'canonical_state','LOCKED_DISPUTE',
             'payment_intent_id',$5::text,
             'refund_id',$6::text,
             'charge_id',$7::text,
             'amount_cents',$4::integer,
             'currency','usd',
             'status','succeeded'
           )) AS exact`,
    [
      input.escrowId,
      input.taskId,
      claimVersion,
      input.amount,
      input.paymentIntentId,
      input.refundId,
      input.chargeId,
      claimKey,
      witnessKey,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.exact !== true) {
    throw new Error(
      `Escrow ${input.escrowId} lacks one exact no-transfer action claim and provider witness`,
    );
  }
}

async function loadExactReleasedDisputeRefundBinding(
  query: QueryFn,
  escrow: {
    id:string;
    task_id:string;
    amount:number;
    platform_fee_cents:number | null;
    stripe_payment_intent_id:string | null;
    stripe_transfer_id:string | null;
  },
  task: {
    worker_id:string | null;
    payout_recipient_user_id:string | null;
  },
): Promise<ExactFullTransferReversalBinding> {
  if (!escrow.stripe_payment_intent_id || !task.worker_id) {
    throw new Error('Released-dispute refund lacks its PaymentIntent or worker binding');
  }
  const disputes = await query<{
    id:string;
    task_id:string;
    escrow_id:string;
    state:string;
    outcome_escrow_action:string | null;
  }>(
    `SELECT id,task_id,escrow_id,state,outcome_escrow_action
       FROM disputes
      WHERE escrow_id=$1
        AND task_id=$2
        AND state='RESOLVED'
        AND outcome_escrow_action='REFUND'
      FOR UPDATE`,
    [escrow.id,escrow.task_id],
  );
  if (disputes.rows.length !== 1) {
    throw new Error(
      `Escrow ${escrow.id} lacks one exact resolved REFUND dispute authority`,
    );
  }

  const origins = await query<{ metadata:unknown; idempotency_key:string | null }>(
    `SELECT metadata,idempotency_key
       FROM escrow_events
      WHERE escrow_id=$1
        AND from_state='RELEASED'
        AND to_state='LOCKED_DISPUTE'
        AND actor_id IS NULL
        AND actor_type='system'
        AND metadata::jsonb->>'event_type'='dispute_locked_after_release'
      FOR UPDATE`,
    [escrow.id],
  );
  const originMetadata = jsonRecord(origins.rows[0]?.metadata);
  const originalTransferId = originMetadata?.original_transfer_id;
  const originTaskId = originMetadata?.task_id;
  const originInitiatedBy = originMetadata?.initiated_by;
  const originEscrowVersion = originMetadata?.escrow_version;
  if (
    origins.rows.length !== 1
    || typeof originalTransferId !== 'string'
    || (escrow.stripe_transfer_id !== null && escrow.stripe_transfer_id !== originalTransferId)
    || originTaskId !== escrow.task_id
    || typeof originInitiatedBy !== 'string'
    || originInitiatedBy.length === 0
    || !Number.isInteger(originEscrowVersion)
    || Number(originEscrowVersion) < 0
    || origins.rows[0]?.idempotency_key
      !== `released-dispute-origin-v1:${escrow.id}:${String(originEscrowVersion)}`
    || !exactJson(originMetadata, {
      event_type:'dispute_locked_after_release',
      task_id:escrow.task_id,
      initiated_by:originInitiatedBy,
      original_transfer_id:originalTransferId,
      escrow_version:originEscrowVersion,
    })
  ) {
    throw new Error(
      `Escrow ${escrow.id} lacks one exact released-transfer origin witness`,
    );
  }

  const reversals = await query<{ metadata:unknown; idempotency_key:string | null }>(
    `SELECT metadata,idempotency_key
       FROM escrow_events
      WHERE escrow_id=$1
        AND from_state='LOCKED_DISPUTE'
        AND to_state='LOCKED_DISPUTE'
        AND actor_id IS NULL
        AND actor_type='system'
        AND metadata::jsonb->>'event_type'='full_transfer_reversal_witness_v1'
        AND metadata::jsonb->>'stripe_transfer_id'=$2
      FOR UPDATE`,
    [escrow.id,originalTransferId],
  );
  const payoutRecipientUserId = task.payout_recipient_user_id ?? task.worker_id;
  const reversalMetadata = jsonRecord(reversals.rows[0]?.metadata);
  const destinationAccountId = reversalMetadata?.destination_account_id;
  const breakdown = computeFeeBreakdown(
    escrow.amount,
    config.stripe.platformFeePercent,
    escrow.platform_fee_cents,
  );
  const binding: ExactFullTransferReversalBinding = {
    escrowId:escrow.id,
    canonicalState:'LOCKED_DISPUTE',
    taskId:escrow.task_id,
    workerId:task.worker_id,
    payoutRecipientUserId,
    destinationAccountId:typeof destinationAccountId === 'string' ? destinationAccountId : '',
    stripePaymentIntentId:escrow.stripe_payment_intent_id,
    transferId:originalTransferId,
    escrowAmountCents:escrow.amount,
    platformFeeCents:breakdown.platformFeeCents,
    insuranceContributionCents:breakdown.insuranceContributionCents,
    transferAmountCents:breakdown.netPayoutCents,
  };
  const expectedReversal = {
    event_type:'full_transfer_reversal_witness_v1',
    provider:'stripe',
    escrow_id:binding.escrowId,
    canonical_state:binding.canonicalState,
    task_id:binding.taskId,
    worker_id:binding.workerId,
    payout_recipient_user_id:binding.payoutRecipientUserId,
    destination_account_id:binding.destinationAccountId,
    stripe_payment_intent_id:binding.stripePaymentIntentId,
    stripe_transfer_id:binding.transferId,
    escrow_amount_cents:binding.escrowAmountCents,
    platform_fee_cents:binding.platformFeeCents,
    insurance_contribution_cents:binding.insuranceContributionCents,
    transfer_amount_cents:binding.transferAmountCents,
    currency:'usd',
    amount_reversed_cents:binding.transferAmountCents,
    reversed:true,
  };
  if (
    reversals.rows.length !== 1
    || !binding.destinationAccountId
    || reversals.rows[0]?.idempotency_key
      !== `full-transfer-reversal-witness-v1:${binding.escrowId}:${binding.transferId}`
    || !exactJson(reversalMetadata, expectedReversal)
  ) {
    throw new Error(
      `Escrow ${escrow.id} lacks one exact immutable full-reversal witness`,
    );
  }
  return binding;
}

async function loadPlatformFeeReversal(
  stripeEventId: string,
): Promise<PlatformFeeReversalWitness | undefined> {
  const result = await db.query<PlatformFeeReversalWitness>(
    `SELECT amount_cents,currency,task_id,gross_amount_cents,platform_fee_cents,
            net_amount_cents,fee_basis_points,escrow_id,stripe_event_id,
            stripe_charge_id,stripe_payment_intent_id,metadata
       FROM revenue_ledger
      WHERE event_type='platform_fee_reversal' AND stripe_event_id=$1
      LIMIT 1`,
    [stripeEventId],
  );
  return result.rows[0];
}

function exactPlatformFeeReversal(
  row: PlatformFeeReversalWitness | undefined,
  input: {
    escrowId: string;
    stripeEventId: string;
    chargeId: string;
    refundId: string;
    amountCents: number;
    taskId: string;
    grossAmountCents: number;
    paymentIntentId: string;
  },
): boolean {
  const basisPoints = feeBasisPoints(input.grossAmountCents, input.amountCents);
  return Boolean(row)
    && Number(row?.amount_cents) === -input.amountCents
    && row?.currency === 'usd'
    && row?.task_id === input.taskId
    && Number(row?.gross_amount_cents) === input.grossAmountCents
    && Number(row?.platform_fee_cents) === input.amountCents
    && Number(row?.net_amount_cents) === input.grossAmountCents - input.amountCents
    && Number(row?.fee_basis_points) === basisPoints
    && row?.escrow_id === input.escrowId
    && row?.stripe_event_id === input.stripeEventId
    && row?.stripe_charge_id === input.chargeId
    && row?.stripe_payment_intent_id === input.paymentIntentId
    && row?.metadata?.refund_id === input.refundId
    && row?.metadata?.reason === 'charge_refunded_after_release';
}

async function ensurePlatformFeeReversal(input: {
  escrowId: string;
  escrowAmountCents: number;
  escrowPlatformFeeCents: number | null;
  stripeEventId: string;
  chargeId: string;
  refundId: string;
  retryRecovery: boolean;
  taskId: string;
  paymentIntentId: string;
}): Promise<void> {
  const platformFeePercent = clampFeePercent(config.stripe.platformFeePercent);
  const platformFeeCents = resolvePlatformFeeCents(
    input.escrowAmountCents,
    platformFeePercent,
    input.escrowPlatformFeeCents,
  );
  const expected = {
    escrowId: input.escrowId,
    stripeEventId: input.stripeEventId,
    chargeId: input.chargeId,
    refundId: input.refundId,
    amountCents: platformFeeCents,
    taskId: input.taskId,
    grossAmountCents: input.escrowAmountCents,
    paymentIntentId: input.paymentIntentId,
  };
  const existing = await loadPlatformFeeReversal(input.stripeEventId);
  if (platformFeeCents === 0) {
    if (existing) {
      throw new Error(
        `Zero-margin refund ${input.stripeEventId} has a platform-fee reversal witness`,
      );
    }
    return;
  }
  if (existing) {
    if (!exactPlatformFeeReversal(existing, expected)) {
      throw new Error(
        `Platform-fee reversal witness conflicts for Stripe event ${input.stripeEventId}`,
      );
    }
    return;
  }

  const recorded = await RevenueService.logEvent({
    eventType: 'platform_fee_reversal',
    userId: null,
    taskId: input.taskId,
    amountCents: -platformFeeCents,
    grossAmountCents: input.escrowAmountCents,
    platformFeeCents,
    netAmountCents: input.escrowAmountCents - platformFeeCents,
    feeBasisPoints: feeBasisPoints(input.escrowAmountCents, platformFeeCents),
    escrowId: input.escrowId,
    stripeEventId: input.stripeEventId,
    stripeChargeId: input.chargeId,
    stripePaymentIntentId: input.paymentIntentId,
    metadata: {
      reason: 'charge_refunded_after_release',
      escrow_amount_cents: input.escrowAmountCents,
      platform_fee_basis_points: feeBasisPoints(input.escrowAmountCents, platformFeeCents),
      refund_id: input.refundId,
      ...(input.retryRecovery ? { retry_recovery: true } : {}),
    },
  });
  if (recorded.success) {
    const persisted = await loadPlatformFeeReversal(input.stripeEventId);
    if (exactPlatformFeeReversal(persisted, expected)) return;
    throw new Error(
      `Platform-fee reversal write for ${input.stripeEventId} lacks an exact readback`,
    );
  }

  // A previous attempt can commit the immutable ledger row but lose its
  // response. Accept that ambiguity only after an exact readback.
  const raced = await loadPlatformFeeReversal(input.stripeEventId);
  if (exactPlatformFeeReversal(raced, expected)) return;
  throw new Error(`Platform-fee reversal ledger write failed: ${recorded.error.message}`);
}

type RefundXpRow = {
  user_id:string;
  task_id:string;
  escrow_id:string;
  base_xp:number;
  effective_xp:number;
  reason:string;
};

async function ensureExactRefundXpClawback(input: {
  escrowId:string;
  taskId:string;
  workerId:string;
}): Promise<void> {
  await XPService.clawbackXP(
    input.workerId,
    input.escrowId,
    'task_refunded',
  );
  const readback = await db.query<{
    awards:RefundXpRow[];
    clawbacks:RefundXpRow[];
  }>(
    `SELECT
       COALESCE(jsonb_agg(jsonb_build_object(
         'user_id',user_id,'task_id',task_id,'escrow_id',escrow_id,
         'base_xp',base_xp,'effective_xp',effective_xp,'reason',reason)
         ORDER BY awarded_at) FILTER (WHERE reason='task_completion'),'[]'::jsonb) AS awards,
       COALESCE(jsonb_agg(jsonb_build_object(
         'user_id',user_id,'task_id',task_id,'escrow_id',escrow_id,
         'base_xp',base_xp,'effective_xp',effective_xp,'reason',reason)
         ORDER BY awarded_at) FILTER (WHERE reason='task_refunded'),'[]'::jsonb) AS clawbacks
       FROM xp_ledger
      WHERE escrow_id=$1
        AND reason IN ('task_completion','task_refunded')`,
    [input.escrowId],
  );
  const award = readback.rows[0]?.awards?.[0];
  const clawback = readback.rows[0]?.clawbacks?.[0];
  const exact = readback.rows[0]?.awards?.length === 1
    && readback.rows[0]?.clawbacks?.length === 1
    && award?.user_id === input.workerId
    && award?.task_id === input.taskId
    && award?.escrow_id === input.escrowId
    && Number(award?.base_xp) > 0
    && Number(award?.effective_xp) > 0
    && award?.reason === 'task_completion'
    && clawback?.user_id === award.user_id
    && clawback?.task_id === award.task_id
    && clawback?.escrow_id === award.escrow_id
    && Number(clawback?.base_xp) === -Number(award.base_xp)
    && Number(clawback?.effective_xp) === -Number(award.effective_xp)
    && clawback?.reason === 'task_refunded';
  if (!exact) {
    throw new Error(
      `Refund XP clawback witness for escrow ${input.escrowId} is missing or not exact`,
    );
  }
}

async function persistReleasedRefundEconomicsBlock(input: {
  escrowId:string;
  canonicalState:string;
  taskId:string;
  workerId:string;
  providerOrganizationId:string | null;
  refundId:string;
  stripeEventId:string;
  expectedInsuranceContributionCents:number;
  expectedNetPayoutCents:number;
}): Promise<boolean> {
  return db.transaction(async (query) => {
    const insurance = await query<{
      task_id:string;
      hustler_id:string;
      contribution_cents:number;
      contribution_percentage:number;
    }>(
      `SELECT task_id,hustler_id,contribution_cents,contribution_percentage
         FROM insurance_contributions
        WHERE task_id=$1 AND hustler_id=$2
        FOR UPDATE`,
      [input.taskId,input.workerId],
    );
    const earnings = await query<{
      user_id:string;
      task_id:string;
      escrow_id:string;
      net_payout_cents:number;
      cumulative_earnings_before_cents:number;
      cumulative_earnings_after_cents:number;
    }>(
      `SELECT user_id,task_id,escrow_id,net_payout_cents,
              cumulative_earnings_before_cents,cumulative_earnings_after_cents
         FROM verification_earnings_ledger
        WHERE escrow_id=$1
        FOR UPDATE`,
      [input.escrowId],
    );
    const tracking = await query<{
      user_id:string;
      total_net_earnings_cents:number;
      earned_unlock_threshold_cents:number;
      earned_unlock_achieved:boolean;
      completed_task_count:number;
    }>(
      `SELECT user_id,total_net_earnings_cents,earned_unlock_threshold_cents,
              earned_unlock_achieved,completed_task_count
         FROM verification_earnings_tracking
        WHERE user_id=$1
        FOR UPDATE`,
      [input.workerId],
    );
    const insuranceRow = insurance.rows[0];
    const earningsRow = earnings.rows[0];
    const exactInsurance = insurance.rows.length === 1
      && insuranceRow?.task_id === input.taskId
      && insuranceRow?.hustler_id === input.workerId
      && Number(insuranceRow?.contribution_cents)
        === input.expectedInsuranceContributionCents
      && Number(insuranceRow?.contribution_percentage) === 2;
    const exactEarnings = input.providerOrganizationId
      ? earnings.rows.length === 0
      : earnings.rows.length === 1
        && earningsRow?.user_id === input.workerId
        && earningsRow?.task_id === input.taskId
        && earningsRow?.escrow_id === input.escrowId
        && Number(earningsRow?.net_payout_cents) === input.expectedNetPayoutCents;
    const positiveInsurance = exactInsurance
      && Number(insuranceRow?.contribution_cents) > 0;
    const positiveEarnings = exactEarnings
      && Number(earningsRow?.net_payout_cents) > 0;
    const requiresCompensation = !exactInsurance
      || !exactEarnings
      || positiveInsurance
      || positiveEarnings;
    if (!requiresCompensation) return false;

    await ensureExactSystemEscrowEvent({
      query,
      escrowId:input.escrowId,
      fromState:input.canonicalState,
      toState:input.canonicalState,
      metadata:{
        event_type:'released_refund_economics_reconciliation_required_v1',
        escrow_id:input.escrowId,
        task_id:input.taskId,
        worker_id:input.workerId,
        provider_organization_id:input.providerOrganizationId,
        refund_id:input.refundId,
        stripe_event_id:input.stripeEventId,
        expected_insurance_contribution_cents:input.expectedInsuranceContributionCents,
        expected_net_payout_cents:input.expectedNetPayoutCents,
        insurance_witness:insuranceRow ?? null,
        earnings_witness:earningsRow ?? null,
        earnings_tracking_witness:tracking.rows[0] ?? null,
        insurance_compensation_supported:false,
        verification_earnings_compensation_supported:false,
        canonical_refund_applied:false,
      },
      idempotencyKey:
        `released-refund-economics-reconciliation-required-v1:${input.escrowId}:${input.refundId}`,
    });
    return true;
  });
}

async function handleChargeRefunded(
  charge: Stripe.Charge,
  stripeEventId: string,
  claimToken: string,
): Promise<boolean> {
  // P0: Extract escrow_id from charge metadata (preferred), fallback to payment_intent lookup
  const escrowId = charge.metadata?.escrow_id;
  const chargePaymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : charge.payment_intent?.id;
  if (
    charge.currency !== 'usd'
    || charge.refunded !== true
    || !Number.isInteger(charge.amount)
    || charge.amount <= 0
    || charge.amount_refunded !== charge.amount
    || !chargePaymentIntentId
  ) {
    await recordRefundReconciliationRequired(
      charge,
      stripeEventId,
      claimToken,
      'Provider event is not an exact full USD refund with a bound PaymentIntent.',
    );
    return true;
  }

  const refundRows = charge.refunds?.data ?? [];
  const exactSucceededFullRefunds = refundRows.filter((refund) => {
    const refundChargeId = typeof refund.charge === 'string'
      ? refund.charge
      : refund.charge?.id;
    const refundPaymentIntentId = typeof refund.payment_intent === 'string'
      ? refund.payment_intent
      : refund.payment_intent?.id;
    return refund.status === 'succeeded'
      && refund.currency === 'usd'
      && refund.amount === charge.amount
      && refundChargeId === charge.id
      && refundPaymentIntentId === chargePaymentIntentId;
  });
  if (charge.refunds?.has_more !== false || exactSucceededFullRefunds.length !== 1) {
    await recordRefundReconciliationRequired(
      charge,
      stripeEventId,
      claimToken,
      'Provider refund list does not prove one exact succeeded full USD refund bound to this Charge and PaymentIntent.',
    );
    return true;
  }
  const refundId = exactSucceededFullRefunds[0].id;
  const exactProviderRefund = exactSucceededFullRefunds[0];
  const providerRefundChargeId = typeof exactProviderRefund.charge === 'string'
    ? exactProviderRefund.charge
    : exactProviderRefund.charge?.id ?? null;
  const providerRefundPaymentIntentId = typeof exactProviderRefund.payment_intent === 'string'
    ? exactProviderRefund.payment_intent
    : exactProviderRefund.payment_intent?.id ?? null;

  // -------------------------------------------------------------------------
  // F-03 FIX: Split into three phases to avoid holding the DB connection and
  // FOR UPDATE row lock for the entire Stripe network round-trip.
  //
  // Phase 1 (transaction): Lock escrow FOR UPDATE, read state + stripe_transfer_id,
  //   perform state checks and terminal-skip handling.
  // Phase 2 (outside transaction): Call StripeService.createTransferReversal() if needed.
  // Phase 3 (transaction): Update escrow state to REFUNDED atomically.
  // -------------------------------------------------------------------------

  // --- Phase 1: Lock and read ---
  type EscrowReadRow = {
    id: string;
    task_id: string;
    state: string;
    version: number;
    amount: number;
    platform_fee_cents: number | null;
    stripe_refund_id: string | null;
    stripe_transfer_id: string | null;
    stripe_payment_intent_id: string | null;
    provider_transfer_status: string | null;
  };
  const phase1Result = await db.transaction(async (trx: QueryFn) => {
    let escrowResult;
    if (escrowId) {
      // Find by metadata (preferred - explicit correlation)
      escrowResult = await trx<EscrowReadRow>(
        `SELECT id, task_id, state, version, amount, platform_fee_cents, stripe_refund_id,
                stripe_transfer_id, stripe_payment_intent_id, provider_transfer_status
         FROM escrows
         WHERE id = $1
         FOR UPDATE`,
        [escrowId]
      );
    } else {
      // Fallback: Find by payment_intent_id (charge.payment_intent)
        const paymentIntentId = chargePaymentIntentId;

      if (!paymentIntentId) {
        // BUG 3 FIX: Both paths failed — no escrow_id in charge metadata AND no
        // payment_intent on the charge. Throwing here causes infinite BullMQ retry
        // because there is no recoverable state to retry into. Log CRITICAL and alert
        // ops instead so a human can reconcile manually.
        const criticalMsg = `CRITICAL: charge.refunded for charge ${charge.id} has no escrow_id metadata and no payment_intent — cannot correlate to an escrow. Manual reconciliation required.`;
        log.error({ chargeId: charge.id, stripeEventId }, criticalMsg);
        await notifyAdmins({
          title: 'charge.refunded: unroutable refund event',
          body: criticalMsg,
          deepLink: `/admin/stripe-events/${stripeEventId}`,
          priority: 'CRITICAL',
          metadata: { charge_id: charge.id, stripe_event_id: stripeEventId },
        }).catch(err => log.error({ err }, 'Failed to send admin notification for unroutable charge.refunded'));
        // Mark the stripe_event as failed-permanent so it is not retried.
        await finalizeStripeEventInboxClaim({
          stripeEventId,
          claimToken,
          result:'failed',
          errorMessage:criticalMsg,
          query:trx,
        });
        return {
          escrow: null as EscrowReadRow | null,
          skipped: true,
          unroutable: true,
          reconciliationReason: null as string | null,
        };
      }

      escrowResult = await trx<EscrowReadRow>(
        `SELECT id, task_id, state, version, amount, platform_fee_cents, stripe_refund_id,
                stripe_transfer_id, stripe_payment_intent_id, provider_transfer_status
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
    if (
      escrow.stripe_payment_intent_id !== chargePaymentIntentId
      || escrow.amount !== charge.amount
    ) {
      return {
        escrow,
        skipped: true,
        unroutable: false,
        reconciliationReason:
          'Provider charge identity or gross amount does not match the canonical escrow.',
      };
    }

    // REFUND_PARTIAL cannot be treated as an idempotent replay of an exact full
    // provider refund. The provider and canonical ledgers disagree and ordinary
    // success classification would hide the remaining reconciliation work.
    if (escrow.state === 'REFUND_PARTIAL') {
      return {
        escrow,
        skipped: true,
        unroutable: false,
        reconciliationReason:
          'Provider reports a full refund while the canonical escrow is only partially refunded.',
      };
    }

    const taskResult = await trx<{
      id: string;
      state: string;
      progress_state: string;
      worker_id: string | null;
      payout_recipient_user_id: string | null;
      provider_organization_id: string | null;
      refund_state: string;
      refund_blocker: string | null;
    }>(
      `SELECT id,state,progress_state,worker_id,payout_recipient_user_id,provider_organization_id,
              refund_state,refund_blocker
         FROM tasks WHERE id=$1 FOR UPDATE`,
      [escrow.task_id],
    );
    const task = taskResult.rows[0];
    if (!task) throw new Error(`Task ${escrow.task_id} not found for refund ${refundId}`);

    const hasTransfer = Boolean(escrow.stripe_transfer_id);
    let releasedRefundBinding: ExactFullTransferReversalBinding | null = null;
    if (hasTransfer && escrow.state === 'LOCKED_DISPUTE') {
      try {
        releasedRefundBinding = await loadExactReleasedDisputeRefundBinding(trx, escrow, task);
      } catch (error) {
        return {
          escrow,
          task,
          skipped: true,
          retryTransferReversal: false,
          feeWasCollected: false,
          releasedRefundBinding: null,
          unroutable: false,
          reconciliationReason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (escrow.state === 'LOCKED_DISPUTE' && !hasTransfer) {
      try {
        await requireExactOrdinaryLockedRefundBinding(trx, {
          escrowId:escrow.id,
          taskId:escrow.task_id,
          state:escrow.state,
          version:escrow.version,
          amount:escrow.amount,
          paymentIntentId:escrow.stripe_payment_intent_id,
          transferId:escrow.stripe_transfer_id,
          storedRefundId:escrow.stripe_refund_id,
          refundId,
          chargeId:charge.id,
        });
      } catch (error) {
        return {
          escrow,
          task,
          skipped:true,
          retryTransferReversal:false,
          feeWasCollected:false,
          releasedRefundBinding:null,
          unroutable:false,
          reconciliationReason:error instanceof Error ? error.message : String(error),
        };
      }
    }
    const hasReleasedEconomics = hasTransfer || releasedRefundBinding !== null;
    const taskStateAllowed = hasReleasedEconomics
      ? ['COMPLETED', 'CLOSED', 'CANCELLED'].includes(task.state)
      : ['OPEN', 'MATCHING', 'ACCEPTED', 'CANCELLED', 'EXPIRED'].includes(task.state);
    if (!taskStateAllowed) {
      return {
        escrow,
        task,
        skipped: true,
        retryTransferReversal: false,
        feeWasCollected: false,
        releasedRefundBinding,
        unroutable: false,
        reconciliationReason:
          'Canonical task lifecycle does not match the refunded escrow transfer witness.',
      };
    }

    if (escrow.state === 'RELEASED' && !escrow.stripe_transfer_id) {
      return {
        escrow,
        task,
        skipped: true,
        retryTransferReversal: false,
        feeWasCollected: false,
        unroutable: false,
        reconciliationReason:
          'Released escrow has no worker-transfer identity and cannot be finalized as an ordinary refund.',
      };
    }

    // REFUNDED/manual_reconciliation is not terminal success. It is the durable
    // retry state written after a failed worker-transfer reversal. Replays must
    // retry the same idempotent reversal and leave this Stripe event unprocessed
    // until current provider evidence confirms the reversal.
    if (escrow.state === 'REFUNDED') {
      if (escrow.stripe_refund_id !== refundId) {
        return {
          escrow,
          task,
          skipped: true,
          retryTransferReversal: false,
          feeWasCollected: false,
          releasedRefundBinding,
          unroutable: false,
          reconciliationReason:
            'Canonical refund identity does not match the current provider refund.',
        };
      }
      if (escrow.provider_transfer_status === 'manual_reconciliation') {
        if (!escrow.stripe_transfer_id) {
          return {
            escrow,
            task,
            skipped: true,
            retryTransferReversal: false,
            feeWasCollected: false,
            releasedRefundBinding,
            unroutable: false,
            reconciliationReason:
              'Manual transfer reconciliation has no retryable transfer identity.',
          };
        }
        const origin = await trx<{ from_state: string }>(
          `SELECT from_state FROM escrow_events
            WHERE escrow_id=$1
              AND to_state='REFUNDED'
              AND metadata::jsonb->>'stripe_event_id'=$2
            ORDER BY created_at ASC LIMIT 1`,
          [escrow.id,stripeEventId],
        );
        return {
          escrow,
          task,
          skipped: false,
          retryTransferReversal: true,
          feeWasCollected: origin.rows[0]?.from_state === 'RELEASED',
          releasedRefundBinding,
          unroutable: false,
          reconciliationReason: null,
        };
      }
      // Do not terminalize the Stripe event here. Required fee, lifecycle, and
      // outbox witnesses are recovered after this transaction; only the outer
      // success path may set processed_at once all of them converge.
      log.info(
        { escrowId: escrow.id, state: escrow.state, stripeEventId },
        'Stripe refund replay requires post-terminal witness convergence',
      );
      return {
        escrow,
        task,
        skipped: true,
        retryTransferReversal: false,
        feeWasCollected: releasedRefundBinding !== null,
        releasedRefundBinding,
        unroutable: false,
        reconciliationReason: null,
      };
    }

    // Validate state transition: PENDING|FUNDED|LOCKED_DISPUTE|RELEASED → REFUNDED
    if (!['PENDING', 'FUNDED', 'LOCKED_DISPUTE', 'RELEASED'].includes(escrow.state)) {
      throw new Error(`Cannot refund escrow ${escrow.id}: current state is ${escrow.state}, expected PENDING, FUNDED, LOCKED_DISPUTE, or RELEASED`);
    }

    // Transaction committed here; row lock released. stripe_transfer_id captured for Phase 2.
    return {
      escrow,
      task,
      skipped: false,
      retryTransferReversal: false,
      feeWasCollected: escrow.state === 'RELEASED' || releasedRefundBinding !== null,
      releasedRefundBinding,
      unroutable: false,
      reconciliationReason: null,
    };
  });

  if (phase1Result.unroutable) {
    return true;
  }

  if (phase1Result.reconciliationReason) {
    await recordRefundReconciliationRequired(
      charge,
      stripeEventId,
      claimToken,
      phase1Result.reconciliationReason,
    );
    return true;
  }

  const { escrow: phase1Escrow, skipped: phase1Skipped } = phase1Result;
  const phase1Task = 'task' in phase1Result ? phase1Result.task : null;
  const retryTransferReversal = 'retryTransferReversal' in phase1Result
    ? phase1Result.retryTransferReversal
    : false;
  const feeWasCollected = 'feeWasCollected' in phase1Result
    ? phase1Result.feeWasCollected
    : false;
  const releasedRefundBinding = 'releasedRefundBinding' in phase1Result
    ? phase1Result.releasedRefundBinding ?? null
    : null;

  // Handle Phase 1 skipped path (retry recovery runs below, same as before)
  if (phase1Skipped || !phase1Escrow) {
    // BUG FIX (MEDIUM - Bug 3 retry recovery): When BullMQ retries after a side-effect
    // failure (TaskService.advanceProgress or writeToOutbox threw), the DB transaction has
    // already committed and the escrow is REFUNDED. The terminal-skip guard fires and we
    // reach this branch. If the original transition was RELEASED→REFUNDED (platform fee was
    // collected), the platform_fee_reversal ledger entry may not have been written yet.
    // We recover by checking escrow_events (which records the from_state atomically inside
    // the DB transaction) and revenue_ledger (which is the dedup key).
    if (phase1Escrow?.state === 'REFUNDED') {
      try {
        // Check if this Stripe event triggered a RELEASED→REFUNDED transition (retry recovery)
        const priorStateCheckResult = await db.query<{ from_state: string }>(
          `SELECT from_state FROM escrow_events
           WHERE escrow_id = $1
             AND to_state = 'REFUNDED'
             AND metadata::jsonb->>'stripe_event_id' = $2
           ORDER BY created_at DESC LIMIT 1`,
          [phase1Escrow.id, stripeEventId]
        );
        const priorFromState = priorStateCheckResult?.rows?.[0]?.from_state;

        // Only emit reversal if the transition was from RELEASED (fee was previously collected).
        // The helper validates any existing row instead of accepting presence as proof.
        if (priorFromState === 'RELEASED') {
          await ensurePlatformFeeReversal({
            escrowId:phase1Escrow.id,
            escrowAmountCents:phase1Escrow.amount,
            escrowPlatformFeeCents:phase1Escrow.platform_fee_cents,
            stripeEventId,
            chargeId:charge.id,
              refundId,
              retryRecovery:true,
              taskId:phase1Escrow.task_id,
              paymentIntentId:phase1Escrow.stripe_payment_intent_id!,
          });
        }
      } catch (recoveryErr) {
        const message = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
        log.error(
          { err: message, escrowId: phase1Escrow?.id, stripeEventId },
          'handleChargeRefunded: required retry witness failed — retaining event for retry',
        );
        throw new Error(`Refund witness recovery failed: ${message}`);
      }
      if (phase1Task?.state === 'COMPLETED') {
        const closed = await TaskService.advanceProgress({
          taskId:phase1Escrow.task_id,
          to:'CLOSED',
          actor:{ type:'system' },
        });
        if (!closed.success) {
          throw new Error(`Refund task closure recovery failed: ${closed.error.message}`);
        }
      }
      await writeToOutbox({
        eventType:'escrow.refunded',
        aggregateType:'escrow',
        aggregateId:phase1Escrow.id,
        eventVersion:phase1Escrow.version,
        payload:{
          escrowId:phase1Escrow.id,
          refundId,
          version:phase1Escrow.version,
        },
        queueName:'user_notifications',
        idempotencyKey:`escrow.refunded:${phase1Escrow.id}:${phase1Escrow.version}`,
      });
    }
    return false;
  }
  if (!phase1Task) {
    throw new Error(`Task ${phase1Escrow.task_id} refund witness is missing`);
  }

  const refundWitness = exactSucceededRefundWitness({
    escrowId: phase1Escrow.id,
    taskId: phase1Escrow.task_id,
    canonicalState: retryTransferReversal ? 'RELEASED' : phase1Escrow.state,
    paymentIntentId: phase1Escrow.stripe_payment_intent_id!,
    expectedAmountCents: phase1Escrow.amount,
    provider: {
      refundId,
      amount: exactProviderRefund.amount,
      status: exactProviderRefund.status ?? '',
      currency: exactProviderRefund.currency,
      paymentIntentId: providerRefundPaymentIntentId,
      chargeId: providerRefundChargeId,
    },
  });
  if (!refundWitness) {
    throw new Error(`Refund ${refundId} no longer matches the locked canonical refund identity`);
  }

  let currentDestinationAccountId: string | null = null;
  const payoutRecipientUserId = phase1Task.payout_recipient_user_id ?? phase1Task.worker_id;
  if (phase1Escrow.stripe_transfer_id && phase1Task.worker_id && payoutRecipientUserId) {
    const destination = await loadCurrentTaskPayoutDestination(db.query.bind(db), {
      taskId:phase1Escrow.task_id,
      workerId:phase1Task.worker_id,
      payoutRecipientUserId,
    });
    if (destination.ready) currentDestinationAccountId = destination.stripeConnectId;
  }

  // --- Phase 2: Stripe transfer reversal (outside transaction, lock released) ---
  // A stored transfer means processor money may have left even if a crash
  // prevented canonical RELEASED. Reverse every exact stored transfer before
  // ordinary refund success. Failures are persisted as manual_reconciliation
  // in Phase 3, then thrown so BullMQ can retry this same Stripe event.
  let reversalFailure: string | null = null;
  let reversalId: string | null = null;
  let reversalConfirmed = false;
  let activeReversalBinding: ExactFullTransferReversalBinding | null = releasedRefundBinding;
  if (releasedRefundBinding) {
    try {
      // The immutable released-dispute binding proves a full reversal already
      // completed. Replaying createTransferReversal with the charge-refund key
      // would authorize a second provider operation. Re-read the current
      // provider transfer and accept only the exact fully-reversed witness.
      const currentReversal = await StripeService.readTransferWitness(
        releasedRefundBinding.transferId,
      );
      if (!currentReversal.success) {
        throw new Error(currentReversal.error.message);
      }
      requireExactFullTransferReversal(releasedRefundBinding, {
        reversalId:null,
        reversalAmountCents:null,
        transferWitness:currentReversal.data,
      });
      reversalConfirmed = true;
    } catch (reversalError) {
      reversalFailure = `Transfer ${releasedRefundBinding.transferId} prior reversal cannot be verified: ${
        reversalError instanceof Error ? reversalError.message : String(reversalError)
      }`;
    }
  } else if (phase1Escrow.stripe_transfer_id) {
    try {
      const breakdown = computeFeeBreakdown(
        phase1Escrow.amount,
        config.stripe.platformFeePercent,
        phase1Escrow.platform_fee_cents,
      );
      if (
        !phase1Task.worker_id
        || !payoutRecipientUserId
        || !currentDestinationAccountId
        || !['RELEASED', 'LOCKED_DISPUTE', 'REFUNDED'].includes(phase1Escrow.state)
      ) {
        throw new Error(
          `Transfer ${phase1Escrow.stripe_transfer_id} lacks a locked released-payout binding`,
        );
      }
      activeReversalBinding = {
        escrowId:phase1Escrow.id,
        canonicalState:phase1Escrow.state === 'LOCKED_DISPUTE' ? 'LOCKED_DISPUTE' : 'RELEASED',
        taskId:phase1Escrow.task_id,
        workerId:phase1Task.worker_id,
        payoutRecipientUserId,
        destinationAccountId:currentDestinationAccountId,
        stripePaymentIntentId:phase1Escrow.stripe_payment_intent_id!,
        transferId:phase1Escrow.stripe_transfer_id,
        escrowAmountCents:phase1Escrow.amount,
        platformFeeCents:breakdown.platformFeeCents,
        insuranceContributionCents:breakdown.insuranceContributionCents,
        transferAmountCents:breakdown.netPayoutCents,
      };
      const reversalResult = await StripeService.createTransferReversal(
        phase1Escrow.stripe_transfer_id,
        phase1Escrow.id,
        refundId,
      );
      if (reversalResult.success) {
        requireExactFullTransferReversal(activeReversalBinding, reversalResult.data);
        await db.transaction((query) => (
          persistExactFullTransferReversalWitness(query, activeReversalBinding!)
        ));
        reversalId = reversalResult.data.reversalId;
        reversalConfirmed = true;
      } else {
        reversalFailure =
          `Transfer ${phase1Escrow.stripe_transfer_id} reversal failed: ${reversalResult.error.message}`;
      }
    } catch (reversalError) {
      reversalFailure = `Transfer ${phase1Escrow.stripe_transfer_id} reversal threw: ${
        reversalError instanceof Error ? reversalError.message : String(reversalError)
      }`;
    }
  }

  if (feeWasCollected && !reversalFailure) {
    if (!reversalConfirmed || !phase1Task.worker_id) {
      throw new Error(
        `Released refund ${refundId} lacks its exact full-reversal or worker witness`,
      );
    }
    await ensurePlatformFeeReversal({
      escrowId:phase1Escrow.id,
      escrowAmountCents:phase1Escrow.amount,
      escrowPlatformFeeCents:phase1Escrow.platform_fee_cents,
      stripeEventId,
      chargeId:charge.id,
      refundId,
      retryRecovery:false,
      taskId:phase1Escrow.task_id,
      paymentIntentId:phase1Escrow.stripe_payment_intent_id!,
    });
    await ensureExactRefundXpClawback({
      escrowId:phase1Escrow.id,
      taskId:phase1Escrow.task_id,
      workerId:phase1Task.worker_id,
    });
    const economicsBlocked = !retryTransferReversal
      && await persistReleasedRefundEconomicsBlock({
      escrowId:phase1Escrow.id,
      canonicalState:phase1Escrow.state,
      taskId:phase1Escrow.task_id,
      workerId:phase1Task.worker_id,
      providerOrganizationId:phase1Task.provider_organization_id ?? null,
      refundId,
      stripeEventId,
      expectedInsuranceContributionCents:activeReversalBinding!.insuranceContributionCents,
      expectedNetPayoutCents:activeReversalBinding!.transferAmountCents,
      });
    if (economicsBlocked) {
      throw new Error(
        `RELEASED_REFUND_ECONOMICS_RECONCILIATION_REQUIRED: escrow ${phase1Escrow.id} has uncompensated release economics`,
      );
    }
  }

  // --- Phase 3: consume the complete Phase-1 witness under one locked CAS ---
  const { updatedEscrow, escrow, skipped, reconciliationReason } = await db.transaction(async (trx: QueryFn) => {
    const reReadResult = await trx<EscrowReadRow>(
      `SELECT id, task_id, state, version, amount, platform_fee_cents, stripe_refund_id,
              stripe_transfer_id, stripe_payment_intent_id, provider_transfer_status
         FROM escrows
        WHERE id=$1
        FOR UPDATE`,
      [phase1Escrow.id],
    );
    const freshEscrow = reReadResult.rows[0];
    if (!freshEscrow) {
      throw new Error(`Escrow ${phase1Escrow.id} disappeared between Phase 1 and Phase 3`);
    }
    const taskResult = await trx<{
      id: string;
      state: string;
      progress_state: string;
      worker_id: string | null;
      payout_recipient_user_id: string | null;
      provider_organization_id: string | null;
      refund_state: string;
      refund_blocker: string | null;
    }>(
      `SELECT id,state,progress_state,worker_id,payout_recipient_user_id,provider_organization_id,
              refund_state,refund_blocker
         FROM tasks WHERE id=$1 FOR UPDATE`,
      [phase1Escrow.task_id],
    );
    const freshTask = taskResult.rows[0];
    if (!freshTask) {
      throw new Error(`Task ${phase1Escrow.task_id} disappeared between Phase 1 and Phase 3`);
    }
    await persistExactSucceededRefundWitness(trx, refundWitness);

    const escrowDrift = freshEscrow.id !== phase1Escrow.id
      || freshEscrow.task_id !== phase1Escrow.task_id
      || freshEscrow.state !== phase1Escrow.state
      || freshEscrow.version !== phase1Escrow.version
      || freshEscrow.amount !== phase1Escrow.amount
      || freshEscrow.platform_fee_cents !== phase1Escrow.platform_fee_cents
      || freshEscrow.stripe_refund_id !== phase1Escrow.stripe_refund_id
      || freshEscrow.stripe_transfer_id !== phase1Escrow.stripe_transfer_id
      || freshEscrow.stripe_payment_intent_id !== phase1Escrow.stripe_payment_intent_id
      || freshEscrow.provider_transfer_status !== phase1Escrow.provider_transfer_status;
    const taskDrift = freshTask.id !== phase1Task.id
      || freshTask.state !== phase1Task.state
      || freshTask.progress_state !== phase1Task.progress_state
      || freshTask.worker_id !== phase1Task.worker_id
      || freshTask.payout_recipient_user_id !== phase1Task.payout_recipient_user_id
      || freshTask.provider_organization_id !== phase1Task.provider_organization_id
      || freshTask.refund_state !== phase1Task.refund_state
      || freshTask.refund_blocker !== phase1Task.refund_blocker;
    if (escrowDrift || taskDrift) {
      const sameTransferStillCurrent = Boolean(phase1Escrow.stripe_transfer_id)
        && freshEscrow.stripe_transfer_id === phase1Escrow.stripe_transfer_id;
      const observedProviderStatus = reversalFailure
        ? 'manual_reconciliation'
        : reversalConfirmed ? 'reversed' : freshEscrow.provider_transfer_status;
      if (sameTransferStillCurrent && observedProviderStatus !== freshEscrow.provider_transfer_status) {
        await authorizeProviderTransferStatusChange({
          query:trx,
          escrowId:freshEscrow.id,
          taskId:freshEscrow.task_id,
          canonicalState:freshEscrow.state,
          canonicalVersion:freshEscrow.version,
          transferId:freshEscrow.stripe_transfer_id!,
          stripeEventId,
          reason:'charge_refunded_phase3_drift',
          statusBefore:freshEscrow.provider_transfer_status,
          statusAfter:observedProviderStatus!,
        });
        const providerFact = await trx<{ version:number }>(
          `UPDATE escrows
              SET provider_transfer_status=$1,version=version+1,updated_at=NOW()
            WHERE id=$2 AND version=$3 AND stripe_transfer_id=$4
              AND provider_transfer_status IS NOT DISTINCT FROM $5
            RETURNING version`,
          [
            observedProviderStatus,
            freshEscrow.id,
            freshEscrow.version,
            freshEscrow.stripe_transfer_id,
            freshEscrow.provider_transfer_status,
          ],
        );
        if (providerFact.rowCount !== 1) {
          throw new Error(`Escrow ${freshEscrow.id} changed while persisting refund reversal evidence`);
        }
      }

      const reversalOutcome = reversalFailure
        ? 'reversal-failed'
        : reversalConfirmed ? `reversal-${reversalId ?? 'already-complete'}` : 'no-transfer';
      await ensureExactSystemEscrowEvent({
        query:trx,
        escrowId:freshEscrow.id,
        fromState:freshEscrow.state,
        toState:freshEscrow.state,
        metadata:{
            reason:'charge_refunded_phase3_drift',
            stripe_event_id:stripeEventId,
            charge_id:charge.id,
            refund_id:refundId,
            canonical_refund_applied:false,
            phase1_transfer_id:phase1Escrow.stripe_transfer_id,
            phase3_transfer_id:freshEscrow.stripe_transfer_id,
            transfer_reversal_id:reversalId,
            transfer_reversal_error:reversalFailure,
            observed_provider_transfer_status:observedProviderStatus,
            phase1_escrow_version:phase1Escrow.version,
            phase3_escrow_version:freshEscrow.version,
            phase1_task_state:phase1Task.state,
            phase3_task_state:freshTask.state,
        },
        idempotencyKey:
          `escrow.refund:${freshEscrow.id}:${stripeEventId}:phase3-drift:${reversalOutcome}`,
      });
      return {
        updatedEscrow: null,
        escrow: freshEscrow,
        skipped: true,
        reconciliationReason:
          'Escrow or task identity, lifecycle, amount, PaymentIntent, transfer, or provider status changed after refund preflight.',
      };
    }

    let taskCancelled = false;
    if (
      !reversalFailure
      &&
      !freshEscrow.stripe_transfer_id
      && ['OPEN', 'MATCHING', 'ACCEPTED'].includes(freshTask.state)
    ) {
      const cancelled = await trx(
        `UPDATE tasks
            SET state='CANCELLED',cancelled_at=NOW(),updated_at=NOW()
          WHERE id=$1 AND state=$2 AND progress_state=$3`,
        [freshTask.id,freshTask.state,freshTask.progress_state],
      );
      if (cancelled.rowCount !== 1) {
        throw new Error(`Task ${freshTask.id} changed during atomic refund cancellation`);
      }
      taskCancelled = true;
    }

    let taskRefundRecorded = false;
    if (!reversalFailure && freshTask.refund_state === 'PENDING') {
      const taskStateAfterRefund = taskCancelled ? 'CANCELLED' : freshTask.state;
      const refundedTask = await trx<{ id:string }>(
        `UPDATE tasks
            SET refund_state='REFUNDED',refund_blocker=NULL,updated_at=NOW()
          WHERE id=$1 AND state=$2 AND progress_state=$3
            AND refund_state='PENDING'
            AND refund_blocker IS NOT DISTINCT FROM $4
          RETURNING id`,
        [freshTask.id,taskStateAfterRefund,freshTask.progress_state,freshTask.refund_blocker],
      );
      if (refundedTask.rowCount !== 1) {
        throw new Error(`Task ${freshTask.id} changed during atomic refund-state convergence`);
      }
      taskRefundRecorded = true;
    }

    const providerTransferStatus = reversalFailure
      ? 'manual_reconciliation'
      : reversalConfirmed ? 'reversed' : freshEscrow.provider_transfer_status;
    let resultingEscrow: { id: string; state: string; version: number };

    if (reversalFailure) {
      if (freshEscrow.provider_transfer_status === 'manual_reconciliation') {
        resultingEscrow = {
          id:freshEscrow.id,
          state:freshEscrow.state,
          version:freshEscrow.version,
        };
      } else {
        await authorizeProviderTransferStatusChange({
          query:trx,
          escrowId:freshEscrow.id,
          taskId:freshEscrow.task_id,
          canonicalState:freshEscrow.state,
          canonicalVersion:freshEscrow.version,
          transferId:freshEscrow.stripe_transfer_id!,
          stripeEventId,
          reason:'charge_refunded_reversal_failed',
          statusBefore:freshEscrow.provider_transfer_status,
          statusAfter:'manual_reconciliation',
        });
        const failedReversalUpdate = await trx<{ id:string; state:string; version:number }>(
          `UPDATE escrows
              SET provider_transfer_status='manual_reconciliation',version=version+1,updated_at=NOW()
            WHERE id=$1
              AND state=$2
              AND version=$3
              AND stripe_transfer_id=$4
              AND provider_transfer_status IS NOT DISTINCT FROM $5
            RETURNING id,state,version`,
          [
            freshEscrow.id,freshEscrow.state,freshEscrow.version,
            freshEscrow.stripe_transfer_id,freshEscrow.provider_transfer_status,
          ],
        );
        if (failedReversalUpdate.rowCount !== 1) {
          throw new Error(`Escrow ${freshEscrow.id} changed while recording reversal failure`);
        }
        resultingEscrow = failedReversalUpdate.rows[0];
      }
    } else if (retryTransferReversal) {
      await authorizeProviderTransferStatusChange({
        query:trx,
        escrowId:freshEscrow.id,
        taskId:freshEscrow.task_id,
        canonicalState:freshEscrow.state,
        canonicalVersion:freshEscrow.version,
        transferId:freshEscrow.stripe_transfer_id!,
        stripeEventId,
        reason:'charge_refunded_reversal_confirmed',
        statusBefore:freshEscrow.provider_transfer_status,
        statusAfter:'reversed',
      });
      const retryUpdate = await trx<{ id: string; state: string; version: number }>(
        `UPDATE escrows
            SET provider_transfer_status='reversed',version=version+1,updated_at=NOW()
          WHERE id=$1
            AND state='REFUNDED'
            AND version=$2
            AND amount=$3
            AND platform_fee_cents IS NOT DISTINCT FROM $4
            AND stripe_refund_id=$5
            AND stripe_transfer_id=$6
            AND stripe_payment_intent_id=$7
            AND provider_transfer_status='manual_reconciliation'
          RETURNING id,state,version`,
        [
          freshEscrow.id,freshEscrow.version,freshEscrow.amount,
          freshEscrow.platform_fee_cents,refundId,freshEscrow.stripe_transfer_id,
          freshEscrow.stripe_payment_intent_id,
        ],
      );
      if (retryUpdate.rowCount !== 1) {
        throw new Error(`Escrow ${freshEscrow.id} changed during transfer-reversal recovery`);
      }
      resultingEscrow = retryUpdate.rows[0];
    } else {
      if (feeWasCollected) {
        await trx(
          `SELECT set_config('hustlexp.released_refund_authority',$1,true)`,
          [freshEscrow.id],
        );
      }
      const updateResult = await trx<{ id: string; state: string; version: number }>(
        `UPDATE escrows
            SET state='REFUNDED',stripe_refund_id=$1,refunded_at=NOW(),
                provider_transfer_status=$2,version=version+1,updated_at=NOW()
          WHERE id=$3
            AND state=$4
            AND version=$5
            AND amount=$6
            AND platform_fee_cents IS NOT DISTINCT FROM $7
            AND stripe_refund_id IS NOT DISTINCT FROM $8
            AND stripe_transfer_id IS NOT DISTINCT FROM $9
            AND stripe_payment_intent_id=$10
            AND provider_transfer_status IS NOT DISTINCT FROM $11
          RETURNING id,state,version`,
        [
          refundId,providerTransferStatus,freshEscrow.id,freshEscrow.state,
          freshEscrow.version,freshEscrow.amount,freshEscrow.platform_fee_cents,
          freshEscrow.stripe_refund_id,freshEscrow.stripe_transfer_id,
          freshEscrow.stripe_payment_intent_id,freshEscrow.provider_transfer_status,
        ],
      );
      if (updateResult.rowCount !== 1) {
        throw new Error(`Escrow ${freshEscrow.id} changed during exact refund CAS`);
      }
      resultingEscrow = updateResult.rows[0];
    }

    const eventKey = reversalFailure
      ? `escrow.refund:${freshEscrow.id}:${stripeEventId}:reversal-failed:${freshEscrow.version}`
      : retryTransferReversal
        ? `escrow.refund:${freshEscrow.id}:${stripeEventId}:reversal-confirmed`
        : `escrow.refund:${freshEscrow.id}:${stripeEventId}:canonical`;
    await ensureExactSystemEscrowEvent({
      query:trx,
      escrowId:freshEscrow.id,
      fromState:freshEscrow.state,
      toState:reversalFailure ? freshEscrow.state : 'REFUNDED',
      metadata:{
          reason:'charge_refunded',
          stripe_event_id:stripeEventId,
          charge_id:charge.id,
          refund_id:refundId,
          transfer_id:freshEscrow.stripe_transfer_id,
          transfer_reversal_id:reversalId,
          transfer_reversal_error:reversalFailure,
          provider_transfer_status:providerTransferStatus,
          task_cancelled:taskCancelled,
          task_refund_recorded:taskRefundRecorded,
          canonical_refund_applied:!reversalFailure,
      },
      idempotencyKey:eventKey,
    });

    return {
      updatedEscrow:resultingEscrow,
      escrow:phase1Escrow,
      skipped:false,
      reconciliationReason:null,
    };
  });

  if (reconciliationReason) {
    await recordRefundReconciliationRequired(
      charge,
      stripeEventId,
      claimToken,
      reconciliationReason,
      false,
    );
    throw new Error(`REFUND_PHASE3_RECONCILIATION_RETRY_REQUIRED: ${reconciliationReason}`);
  }

  // Phase 3 skipped: the exact terminal refund may have won concurrently.
  // Re-run the same required witness convergence before this Stripe event can
  // be marked successful; never let a terminal row bypass fee/outbox recovery.
  if (skipped || !updatedEscrow) {
    if (escrow.state !== 'REFUNDED' || escrow.stripe_refund_id !== refundId) {
      throw new Error(`Refund concurrency did not converge for escrow ${escrow.id}`);
    }
    const origin = await db.query<{ from_state:string }>(
      `SELECT from_state FROM escrow_events
        WHERE escrow_id=$1 AND to_state='REFUNDED'
          AND metadata::jsonb->>'stripe_event_id'=$2
        ORDER BY created_at ASC LIMIT 1`,
      [escrow.id,stripeEventId],
    );
    if (origin.rows[0]?.from_state === 'RELEASED') {
      await ensurePlatformFeeReversal({
        escrowId:escrow.id,
        escrowAmountCents:escrow.amount,
        escrowPlatformFeeCents:escrow.platform_fee_cents,
        stripeEventId,
        chargeId:charge.id,
        refundId,
        retryRecovery:true,
        taskId:escrow.task_id,
        paymentIntentId:escrow.stripe_payment_intent_id!,
      });
    }
    if (phase1Task.state === 'COMPLETED') {
      const closed = await TaskService.advanceProgress({
        taskId:escrow.task_id,
        to:'CLOSED',
        actor:{ type:'system' },
      });
      if (!closed.success) {
        throw new Error(`Refund task closure recovery failed: ${closed.error.message}`);
      }
    }
    await writeToOutbox({
      eventType:'escrow.refunded',
      aggregateType:'escrow',
      aggregateId:escrow.id,
      eventVersion:escrow.version,
      payload:{ escrowId:escrow.id,refundId,version:escrow.version },
      queueName:'user_notifications',
      idempotencyKey:`escrow.refunded:${escrow.id}:${escrow.version}`,
    });
    return false;
  }

  if (reversalFailure) {
    log.error({
      escrowId:escrow.id,
      stripeTransferId:escrow.stripe_transfer_id,
      stripeEventId,
      reversalFailure,
    }, 'Transfer reversal is unconfirmed; retaining retryable manual reconciliation state');
    await notifyAdmins({
      title:'charge.refunded: transfer reversal requires retry',
      body:`Escrow ${escrow.id} remains manual_reconciliation: ${reversalFailure}`,
      deepLink:`/admin/escrows/${escrow.id}`,
      priority:'CRITICAL',
      metadata:{
        escrow_id:escrow.id,
        stripe_transfer_id:escrow.stripe_transfer_id,
        stripe_event_id:stripeEventId,
        refund_id:refundId,
      },
    }).catch((notifyError) => log.error({ notifyError }, 'Failed to alert ops about reversal retry'));
    // The Phase-3 transaction has committed the visible exception state. Throw
    // now so processPaymentJob clears claimed_at without setting processed_at;
    // BullMQ can then retry this exact event and idempotency key.
    throw new Error(`TRANSFER_REVERSAL_RETRY_REQUIRED: ${reversalFailure}`);
  }

  if (retryTransferReversal && feeWasCollected && phase1Task.worker_id) {
    const economicsBlocked = await persistReleasedRefundEconomicsBlock({
      escrowId:phase1Escrow.id,
      canonicalState:phase1Escrow.state,
      taskId:phase1Escrow.task_id,
      workerId:phase1Task.worker_id,
      providerOrganizationId:phase1Task.provider_organization_id ?? null,
      refundId,
      stripeEventId,
      expectedInsuranceContributionCents:activeReversalBinding!.insuranceContributionCents,
      expectedNetPayoutCents:activeReversalBinding!.transferAmountCents,
    });
    if (economicsBlocked) {
      throw new Error(
        `RELEASED_REFUND_ECONOMICS_RECONCILIATION_REQUIRED: escrow ${phase1Escrow.id} has uncompensated release economics`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Post-Phase-3 side effects
  // -------------------------------------------------------------------------

  if (phase1Task.state === 'COMPLETED') {
    const closed = await TaskService.advanceProgress({
      taskId: escrow.task_id,
      to: 'CLOSED',
      actor: { type: 'system' },
    });
    if (!closed.success) {
      throw new Error(`Refund task closure failed: ${closed.error.message}`);
    }
  }

  // RELEASED-origin platform-fee and XP reversals were read back exactly before
  // the guarded terminal CAS. Re-running them here would add no authority and
  // would widen the post-terminal crash window.

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
  return false;
}

/**
 * Handle transfer.failed: escrow RELEASED → LOCKED_DISPUTE (ops triage required)
 *
 * A released escrow whose underlying Stripe transfer has failed must be flagged
 * for manual ops intervention. We cannot automatically re-release — that would
 * risk a double-payment if the transfer was retried by Stripe. Instead we:
 *  1. Look up the escrow by stripe_transfer_id (inside a transaction with FOR UPDATE)
 *  2. Revert to LOCKED_DISPUTE with reason='transfer_failed' so ops can triage
 *  3. Log a CRITICAL error for alerting
 *  4. Insert a revenue_ledger row (type='failed_transfer') as an audit trail
 *  5. Push an urgent notification to the worker
 *
 * NOTE: Admin must resolve via the dispute resolution path — no auto re-release.
 *
 * The SELECT ... FOR UPDATE and state revert UPDATE run inside a db.transaction().
 * RevenueService.logEvent, NotificationService, and writeToOutbox are intentionally
 * outside — they must always fire even if the lock is lost (so the worker is
 * never silently unnotified).
 */
interface FailedTransferBinding {
  escrowId: string;
  taskId: string;
  workerId: string;
  payoutRecipientUserId: string;
  destinationAccountId: string;
  paymentIntentId: string | null;
  transferId: string;
  escrowAmountCents: number;
  platformFeeCents: number;
  transferAmountCents: number;
  stripeEventId: string;
}

interface FailedTransferLedgerRow {
  id: string;
  event_type: string;
  user_id: string | null;
  task_id: string | null;
  amount_cents: number;
  currency: string;
  gross_amount_cents: number;
  platform_fee_cents: number;
  net_amount_cents: number;
  fee_basis_points: number | null;
  escrow_id: string | null;
  stripe_event_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  metadata: unknown;
}

function failedTransferMetadata(binding: FailedTransferBinding): Record<string, unknown> {
  return {
    event: 'transfer_failed_provider_reconciliation',
    escrow_state_before: 'RELEASED',
    escrow_state_after: 'LOCKED_DISPUTE',
    payout_recipient_user_id: binding.payoutRecipientUserId,
    destination_account_id: binding.destinationAccountId,
    transfer_amount_cents: binding.transferAmountCents,
    requires_admin_intervention: true,
  };
}

function failedTransferLedgerExact(
  row: FailedTransferLedgerRow | undefined,
  binding: FailedTransferBinding,
): boolean {
  return Boolean(row)
    && row?.event_type === 'failed_transfer'
    && row?.user_id === binding.workerId
    && row?.task_id === binding.taskId
    && Number(row?.amount_cents) === -binding.transferAmountCents
    && row?.currency === 'usd'
    && Number(row?.gross_amount_cents) === binding.escrowAmountCents
    && Number(row?.platform_fee_cents) === binding.platformFeeCents
    && Number(row?.net_amount_cents) === binding.transferAmountCents
    && Number(row?.fee_basis_points)
      === feeBasisPoints(binding.escrowAmountCents, binding.platformFeeCents)
    && row?.escrow_id === binding.escrowId
    && row?.stripe_event_id === binding.stripeEventId
    && row?.stripe_payment_intent_id === binding.paymentIntentId
    && row?.stripe_transfer_id === binding.transferId
    && exactJson(row?.metadata, failedTransferMetadata(binding));
}

async function loadFailedTransferLedger(binding: FailedTransferBinding): Promise<FailedTransferLedgerRow[]> {
  const result = await db.query<FailedTransferLedgerRow>(
    `SELECT id,event_type,user_id,task_id,amount_cents,currency,gross_amount_cents,
            platform_fee_cents,net_amount_cents,fee_basis_points,escrow_id,
            stripe_event_id,stripe_payment_intent_id,stripe_transfer_id,metadata
       FROM revenue_ledger
      WHERE stripe_event_id=$1 AND event_type='failed_transfer'
      ORDER BY created_at ASC LIMIT 2`,
    [binding.stripeEventId],
  );
  return result.rows;
}

async function ensureFailedTransferLedger(binding: FailedTransferBinding): Promise<void> {
  let rows = await loadFailedTransferLedger(binding);
  if (rows.length === 0) {
    const recorded = await RevenueService.logEvent({
      eventType: 'failed_transfer',
      userId: binding.workerId,
      taskId: binding.taskId,
      amountCents: -binding.transferAmountCents,
      currency: 'usd',
      grossAmountCents: binding.escrowAmountCents,
      platformFeeCents: binding.platformFeeCents,
      netAmountCents: binding.transferAmountCents,
      feeBasisPoints: feeBasisPoints(binding.escrowAmountCents, binding.platformFeeCents),
      escrowId: binding.escrowId,
      stripeEventId: binding.stripeEventId,
      stripePaymentIntentId: binding.paymentIntentId ?? undefined,
      stripeTransferId: binding.transferId,
      metadata: failedTransferMetadata(binding),
    });
    rows = await loadFailedTransferLedger(binding);
    if (!(rows.length === 1 && failedTransferLedgerExact(rows[0], binding)) && !recorded.success) {
      throw new Error(`Failed-transfer revenue write failed: ${recorded.error.message}`);
    }
  }
  if (rows.length !== 1 || !failedTransferLedgerExact(rows[0], binding)) {
    throw new Error(`Failed-transfer revenue witness is missing or inexact for ${binding.stripeEventId}`);
  }
  await db.transaction(async (query) => {
    await ensureExactSystemEscrowEvent({
      query,
      escrowId: binding.escrowId,
      fromState: 'LOCKED_DISPUTE',
      toState: 'LOCKED_DISPUTE',
      metadata: {
        event_type: 'transfer_failed_revenue_witness_v1',
        stripe_event_id: binding.stripeEventId,
        escrow_id: binding.escrowId,
        task_id: binding.taskId,
        transfer_id: binding.transferId,
        revenue_ledger_id: rows[0].id,
        failed_transfer_amount_cents: -binding.transferAmountCents,
        currency: 'usd',
      },
      idempotencyKey: `transfer-failed-revenue-witness-v1:${binding.escrowId}:${binding.stripeEventId}`,
    });
  });
}

async function handleTransferFailed(transfer: Stripe.Transfer, stripeEventId: string): Promise<void> {
  const transferId = transfer.id;
  const currentWitnessResult = await StripeService.readTransferWitness(transferId);
  if (!currentWitnessResult.success) {
    throw new Error(
      `transfer.failed ${transferId} lacks current provider evidence: ${currentWitnessResult.error.message}`,
    );
  }
  const currentTransferWitness = currentWitnessResult.data;
  const eventDestinationId = typeof transfer.destination === 'string'
    ? transfer.destination
    : transfer.destination?.id ?? null;

  // -------------------------------------------------------------------------
  // Critical section: lock escrow row, attempt state revert atomically
  // -------------------------------------------------------------------------
  const { escrow, revertedVersion, revertError, workerId, ledgerBinding } = await db.transaction(async (trx: QueryFn) => {
    // Find escrow by stripe_transfer_id — FOR UPDATE holds the lock
    const escrowResult = await trx<{
      id: string;
      task_id: string;
      state: string;
      version: number;
      amount: number;
      platform_fee_cents: number | null;
      stripe_payment_intent_id: string | null;
      stripe_transfer_id: string | null;
      provider_transfer_status: string | null;
    }>(
      `SELECT e.id,e.task_id,e.state,e.version,e.amount,e.platform_fee_cents,
              e.stripe_payment_intent_id,e.stripe_transfer_id,e.provider_transfer_status
       FROM escrows e
       WHERE e.stripe_transfer_id = $1
       FOR UPDATE`,
      [transferId]
    );

    if (escrowResult.rows.length === 0) {
      // No escrow linked to this transfer — log and skip gracefully
      log.warn({ transferId, stripeEventId }, 'transfer.failed: no escrow found for transfer_id, skipping');
      return { escrow: null, revertedVersion: null, revertError: null, workerId: null, ledgerBinding: null };
    }

    const escrow = escrowResult.rows[0];

    // CRITICAL: A payout to a worker has failed. Requires manual intervention.
    log.error(
      { transferId, escrowId: escrow.id, escrowState: escrow.state, stripeEventId },
      'CRITICAL: Stripe transfer.failed — worker payout failed, escrow requires ops triage'
    );

    const taskResult = await trx<{
      worker_id:string | null;
      payout_recipient_user_id:string | null;
    }>(
      `SELECT worker_id,payout_recipient_user_id FROM tasks WHERE id=$1 FOR UPDATE`,
      [escrow.task_id],
    );
    const task = taskResult.rows[0];
    if (!task?.worker_id) {
      throw new Error(`transfer.failed ${transferId} has no canonical worker binding`);
    }
    const payoutRecipientUserId = task.payout_recipient_user_id ?? task.worker_id;
    const destination = await loadCurrentTaskPayoutDestination(trx, {
      taskId:escrow.task_id,
      workerId:task.worker_id,
      payoutRecipientUserId,
    });
    const expectedTransferAmount = computeFeeBreakdown(
      escrow.amount,
      config.stripe.platformFeePercent,
      escrow.platform_fee_cents,
    ).netPayoutCents;
    const breakdown = computeFeeBreakdown(
      escrow.amount,
      config.stripe.platformFeePercent,
      escrow.platform_fee_cents,
    );
    if (
      transfer.metadata?.escrow_id !== escrow.id
      || transfer.metadata?.task_id !== escrow.task_id
      || transfer.amount !== expectedTransferAmount
      || transfer.currency !== 'usd'
      || !destination.ready
      || eventDestinationId !== destination.stripeConnectId
      || currentTransferWitness.provider !== 'STRIPE'
      || currentTransferWitness.transferId !== transferId
      || currentTransferWitness.escrowId !== escrow.id
      || currentTransferWitness.taskId !== escrow.task_id
      || currentTransferWitness.payoutRecipientUserId !== payoutRecipientUserId
      || currentTransferWitness.destinationAccountId !== destination.stripeConnectId
      || currentTransferWitness.amountCents !== expectedTransferAmount
      || currentTransferWitness.currency !== 'usd'
      || currentTransferWitness.reversed
      || currentTransferWitness.amountReversedCents !== 0
    ) {
      throw new Error(
        `transfer.failed ${transferId} does not match the locked canonical payout binding`,
      );
    }

    const ledgerBinding: FailedTransferBinding = {
      escrowId: escrow.id,
      taskId: escrow.task_id,
      workerId: task.worker_id,
      payoutRecipientUserId,
      destinationAccountId: destination.stripeConnectId!,
      paymentIntentId: escrow.stripe_payment_intent_id,
      transferId,
      escrowAmountCents: escrow.amount,
      platformFeeCents: breakdown.platformFeeCents,
      transferAmountCents: expectedTransferAmount,
      stripeEventId,
    };

    if (escrow.state !== 'RELEASED') {
      log.warn(
        { transferId, escrowId: escrow.id, state: escrow.state },
        'transfer.failed: escrow not in RELEASED state, skipping state revert',
      );
      const recoverable = escrow.state === 'LOCKED_DISPUTE'
        && escrow.provider_transfer_status === 'manual_reconciliation';
      return {
        escrow,
        revertedVersion: recoverable ? escrow.version : null,
        revertError: null,
        workerId: task.worker_id,
        ledgerBinding: recoverable ? ledgerBinding : null,
      };
    }

    await ensureExactSystemEscrowEvent({
      query:trx,
      escrowId:escrow.id,
      fromState:'RELEASED',
      toState:'LOCKED_DISPUTE',
      metadata:{
        event_type:'transfer_failed_provider_witness_v1',
        stripe_event_id:stripeEventId,
        escrow_id:escrow.id,
        task_id:escrow.task_id,
        worker_id:task.worker_id,
        payout_recipient_user_id:payoutRecipientUserId,
        destination_account_id:destination.stripeConnectId,
        stripe_payment_intent_id:escrow.stripe_payment_intent_id,
        transfer_id:transferId,
        escrow_amount_cents:escrow.amount,
        platform_fee_cents:computeFeeBreakdown(
          escrow.amount,
          config.stripe.platformFeePercent,
          escrow.platform_fee_cents,
        ).platformFeeCents,
        transfer_amount_cents:expectedTransferAmount,
        currency:'usd',
        provider_transfer_status_before:escrow.provider_transfer_status,
        current_transfer_reversed:false,
        current_amount_reversed_cents:0,
      },
      idempotencyKey:`transfer-failed-provider-witness-v1:${escrow.id}:${transferId}:${stripeEventId}`,
    });

    await trx(
      `SELECT set_config('hustlexp.transfer_failed_authority',$1,true)`,
      [escrow.id],
    );

    // Revert escrow: RELEASED → LOCKED_DISPUTE (ops triage path)
    const updateResult = await trx<{ id: string; state: string; version: number }>(
      `UPDATE escrows
       SET state = 'LOCKED_DISPUTE',
           provider_transfer_status = 'manual_reconciliation',
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1
         AND state = 'RELEASED'
         AND version = $2
       RETURNING id, state, version`,
      [escrow.id, escrow.version]
    );

    const workerId = task.worker_id;

    if (updateResult.rowCount === 0) {
      const revertError = new Error(
        `Escrow ${escrow.id} state or version changed during transfer.failed revert (optimistic lock)`
      );
      log.error(
        { escrowId: escrow.id, transferId },
        'Optimistic lock failure during transfer.failed revert — notification still sent, BullMQ will retry'
      );
      return { escrow, revertedVersion: null, revertError, workerId, ledgerBinding: null };
    }

    const updatedEscrow = updateResult.rows[0];

    log.info(
      { escrowId: escrow.id, transferId, version: updatedEscrow.version },
      'Escrow reverted to LOCKED_DISPUTE after transfer.failed (requires admin triage)'
    );

    return { escrow, revertedVersion: updatedEscrow.version, revertError: null, workerId, ledgerBinding };
  });

  // No escrow found — nothing more to do
  if (!escrow) {
    return;
  }

  // -------------------------------------------------------------------------
  // Post-transaction side effects — always fire regardless of revert outcome
  // so the worker is never silently unnotified.
  // -------------------------------------------------------------------------

  if (ledgerBinding) await ensureFailedTransferLedger(ledgerBinding);

  // Emit outbox event for ops alerting / escalation pipeline
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
 *
 * The SELECT ... FOR UPDATE, the escrow UPDATE, the escrow_events INSERT, and the
 * tasks UPDATE all run inside a single db.transaction(). NotificationService and
 * writeToOutbox are intentionally outside.
 */
async function handlePaymentIntentPaymentFailed(
  paymentIntent: Stripe.PaymentIntent,
  stripeEventId: string,
  claimToken: string,
): Promise<boolean> {
  const paymentIntentId = paymentIntent.id;

  // -------------------------------------------------------------------------
  // Critical section: lock escrow row, validate state, update atomically
  // -------------------------------------------------------------------------
  const { updatedEscrow, escrow, posterId, skipped } = await db.transaction(async (trx: QueryFn) => {
    // Find escrow by stripe_payment_intent_id — FOR UPDATE holds the lock
    const escrowResult = await trx<{
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
      return { updatedEscrow: null, escrow: null, posterId: null, skipped: true };
    }

    const escrow = escrowResult.rows[0];

    // If escrow is already terminal, skip silently (idempotency)
    if (['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(escrow.state)) {
      await finalizeStripeEventInboxClaim({
        stripeEventId,
        claimToken,
        result:'skipped',
        errorMessage:`Escrow ${escrow.id} already terminal (${escrow.state})`,
        query:trx,
      });
      log.warn({ escrowId: escrow.id, state: escrow.state, stripeEventId }, 'Stripe event skipped: escrow already terminal');
      return { updatedEscrow: null, escrow, posterId: null, skipped: true };
    }

    if (escrow.state !== 'PENDING') {
      // Payment failed but escrow already funded — unexpected scenario, surface as error
      throw new Error(
        `payment_intent.payment_failed: escrow ${escrow.id} is in state ${escrow.state}, expected PENDING`
      );
    }

    // Cancel the escrow: PENDING → REFUNDED (terminal; nothing was funded)
    const updateResult = await trx<{ id: string; state: string; version: number }>(
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

    // Log escrow event for audit trail — inside transaction so it's atomic with the cancel
    await trx(
      `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
       VALUES ($1, 'PENDING', 'REFUNDED', NULL, 'system', $2)`,
      [escrow.id, JSON.stringify({ reason: 'payment_failed', stripe_payment_intent_id: paymentIntentId, stripe_event_id: stripeEventId })]
    );

    // Return task to OPEN so poster can retry payment — inside the same transaction
    // so the task state flip and escrow cancel are atomic. If it fails we log and
    // let the transaction roll back (both will retry together).
    try {
      await trx(
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
        'payment_intent.payment_failed: failed to revert task to OPEN — rolling back escrow cancel too'
      );
      throw taskError;
    }

    // Look up poster via task — inside transaction so the read is consistent
    const taskResult = await trx<{ poster_id: string | null }>(
      `SELECT poster_id FROM tasks WHERE id = $1`,
      [escrow.task_id]
    );

    return {
      updatedEscrow: updateResult.rows[0],
      escrow,
      posterId: taskResult.rows[0]?.poster_id ?? null,
      skipped: false,
    };
  });

  // Skipped paths: already handled inside the transaction
  if (skipped || !updatedEscrow || !escrow) {
    return escrow !== null;
  }

  // -------------------------------------------------------------------------
  // Post-transaction side effects
  // -------------------------------------------------------------------------

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
  return false;
}

/**
 * Handle payout.failed: audited notification to worker, ledger entry, no state machine change
 *
 * Stripe automatically returns funds to the Connect balance when a payout fails.
 * Therefore no escrow state transition is needed. We:
 *  1. Extract the Connect account ID from the payout object
 *  2. Look up the user by stripe_connect_id
 *  3. Create an audited notification: "Your bank transfer failed — update bank details"
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
 *
 * This handler has no FOR UPDATE — no transaction needed; it is read-only + side effects.
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
    // Look up user by stripe_connect_id — read-only, no lock needed
    const userResult = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE stripe_connect_id = $1 LIMIT 1`,
      [connectAccountId]
    );
    userId = userResult.rows[0]?.id ?? null;
  }

  // Persist a provider-observable notification if we can identify the worker.
  if (userId) {
    const notification = await NotificationService.createNotification({
      userId,
      category: 'payout_failed',
      title: 'Bank Transfer Failed',
      body: 'Your bank transfer failed. Please update your bank details in the app to receive your earnings.',
      deepLink: 'app://settings/payouts',
      objectRef: { type: 'payout', id: payoutId },
      dedupeKey: `stripe:${stripeEventId}:payout_failed`,
      metadata: { payoutId, stripeEventId, eventVersion: 1 },
      channels: ['in_app', 'push'],
      priority: 'CRITICAL',
    });
    if (!notification.success) throw new Error(notification.error.message);
  } else {
    log.warn(
      { payoutId, connectAccountId, stripeEventId },
      'payout.failed: could not identify user for audited notification (connect_account_id not in metadata or not found in users table)'
    );
  }

  // Insert failed_payout ledger entry for financial ops visibility
  // Amount is negative (funds did not reach the worker's bank)
  // Idempotency guard: check for an existing entry before writing so that
  // BullMQ retries do not create duplicate ledger rows.
  const existingFailedPayoutEntry = await db.query(
    `SELECT id FROM revenue_ledger WHERE stripe_event_id = $1 AND event_type = 'failed_payout' LIMIT 1`,
    [stripeEventId]
  );
  if (existingFailedPayoutEntry.rows.length > 0) {
    log.info({ stripeEventId, payoutId }, 'handlePayoutFailed: failed_payout ledger entry already exists — skipping duplicate (idempotent retry)');
  } else {
    await RevenueService.logEvent({
      eventType: 'failed_payout',
      userId: userId ?? null,
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
  }

  log.info(
    { payoutId, connectAccountId, userId, stripeEventId },
    'payout.failed processed: audited notification created (if user found), ledger entry created, no state machine change needed'
  );
}
