/**
 * Escrow Action Worker v2.0.0
 *
 * Dispute Resolution MVP: Processes escrow action requests from disputes
 *
 * Consumes:
 * - escrow.release_requested
 * - escrow.refund_requested
 * - escrow.partial_refund_requested
 *
 * @see Dispute Resolution MVP Implementation Spec §4
 */

import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { StripeService } from '../services/StripeService.js';
import { TaskService } from '../services/TaskService.js';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';
import { workerLogger } from '../logger.js';
import { config } from '../config.js';
import { verifyJobSignature } from './queues.js';
import { z } from 'zod';
import type { Job } from 'bullmq';

const STRIPE_ACCOUNT_RESTRICTION_CODES = new Set([
  'account_closed',
  'account_invalid',
  'account_deauthorized',
  'transfer_not_reversible',
]);

function isStripeAccountRestrictionError(error: unknown): boolean {
  if (error instanceof Error && 'code' in error) {
    const stripeError = error as Error & { code?: string };
    return STRIPE_ACCOUNT_RESTRICTION_CODES.has(stripeError.code ?? '');
  }
  return false;
}

async function lockEscrowForStripeRestriction(escrowId: string, workerId: string, stripeCode: string): Promise<void> {
  await db.query(
    `UPDATE escrows
     SET state = 'LOCKED_DISPUTE',
         version = version + 1
     WHERE id = $1
       AND state IN ('FUNDED', 'LOCKED_DISPUTE')`,
    [escrowId],
  );

  await db.query(
    `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
     VALUES ($1, 'FUNDED', 'LOCKED_DISPUTE', NULL, 'system', $2)`,
    [escrowId, JSON.stringify({ reason: 'stripe_account_restricted', stripe_code: stripeCode, worker_id: workerId })],
  );

  try {
    await notifyAdmins({
      title: 'Escrow Locked: Stripe Account Restricted',
      body: `Escrow ${escrowId} could not be released — worker Stripe account is restricted (code: ${stripeCode}). Manual admin review required.`,
      deepLink: `/admin/escrows/${escrowId}`,
      priority: 'CRITICAL',
      metadata: { escrow_id: escrowId, worker_id: workerId, stripe_code: stripeCode },
    });
  } catch (notifyError) {
    log.error(
      { err: notifyError instanceof Error ? notifyError.message : String(notifyError), escrowId },
      'Failed to notify admins of stripe account restriction',
    );
  }
}

const log = workerLogger.child({ worker: 'escrow-action' });

interface EscrowActionPayload {
  escrow_id: string;
  task_id: string;
  dispute_id?: string;
  reason: string;
  refund_amount?: number;
  release_amount?: number;
}

interface EscrowActionJobData {
  payload: EscrowActionPayload;
}

interface EscrowRow {
  id: string;
  state: string;
  version: number;
  amount: number;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
}

const FinancialJobPayloadSchema = z.object({
  escrow_id: z.string().uuid(),
  task_id: z.string().uuid(),
  dispute_id: z.string().uuid().optional(),
  reason: z.string().min(1),
  refund_amount: z.number().nonnegative().optional(),
  release_amount: z.number().nonnegative().optional(),
  _sig: z.string().length(64),
});

export async function processEscrowActionJob(job: Job<EscrowActionJobData>): Promise<void> {
  const { payload } = job.data;
  const eventType = job.name;

  const parsed = FinancialJobPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    log.error({ jobId: job.id, eventType, errors: parsed.error.issues }, 'Invalid financial job payload schema');
    throw new Error('JOB_SCHEMA_INVALID: ' + parsed.error.message);
  }

  const { _sig, ...payloadWithoutSig } = parsed.data;
  if (!verifyJobSignature(payloadWithoutSig as Record<string, unknown>, _sig)) {
    log.error({ jobId: job.id, eventType }, 'Job signature verification failed');
    throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
  }

  const { escrow_id, task_id, dispute_id, reason, refund_amount, release_amount } = parsed.data;

  try {
    const criticalSectionResult = await db.transaction(async (trx: QueryFn) => {
      const escrowResult = await trx<EscrowRow>(
        `SELECT id, state, version, amount, stripe_payment_intent_id, stripe_transfer_id, stripe_refund_id
         FROM escrows WHERE id = $1 FOR UPDATE`,
        [escrow_id]
      );

      if (escrowResult.rows.length === 0) {
        throw new Error(`Escrow ${escrow_id} not found`);
      }

      const escrow = escrowResult.rows[0];

      if (escrow.state !== 'LOCKED_DISPUTE') {
        throw new Error(`Escrow must be LOCKED_DISPUTE to process dispute action (current: ${escrow.state})`);
      }

      return { escrow };
    });

    const { escrow } = criticalSectionResult;

    switch (eventType) {
      case 'escrow.release_requested':
        await handleReleaseRequest(escrow, task_id, dispute_id, reason);
        break;
      case 'escrow.refund_requested':
        await handleRefundRequest(escrow, dispute_id, reason);
        break;
      case 'escrow.partial_refund_requested':
        await handlePartialRefundRequest(escrow, task_id, dispute_id, reason, refund_amount || 0, release_amount || 0);
        break;
      default:
        throw new Error(`Unknown escrow action event type: ${eventType}`);
    }

    log.info({ eventType, escrowId: escrow_id }, 'Escrow action processed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ eventType, escrowId: escrow_id, err: errorMessage }, 'Escrow action processing failed');
    throw error;
  }
}

async function handleReleaseRequest(
  escrow: EscrowRow,
  taskId: string,
  disputeId: string | undefined,
  reason: string
): Promise<void> {
  if (escrow.stripe_transfer_id) {
    log.info({ escrowId: escrow.id, transferId: escrow.stripe_transfer_id }, 'Escrow already has transfer_id, idempotent replay');
    return;
  }

  const taskResult = await db.query<{ worker_id: string | null }>(
    'SELECT worker_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (taskResult.rows.length === 0) throw new Error(`Task ${taskId} not found`);
  const task = taskResult.rows[0];
  if (!task.worker_id) throw new Error(`Task ${taskId} has no worker_id`);

  const workerResult = await db.query<{ stripe_connect_id: string | null }>(
    'SELECT stripe_connect_id FROM users WHERE id = $1',
    [task.worker_id]
  );
  if (workerResult.rows.length === 0) throw new Error(`Worker ${task.worker_id} not found`);
  const worker = workerResult.rows[0];
  if (!worker.stripe_connect_id) throw new Error(`Worker ${task.worker_id} has no stripe_connect_id`);

  // GAP-1 FIX: Added Math.min/Math.max clamp to match EscrowService.release()
  const platformFeePercent = Math.min(100, Math.max(0, config.stripe.platformFeePercent ?? 15));
  const platformFeeCents = Math.round(escrow.amount * (platformFeePercent / 100));
  const netPayoutCents = escrow.amount - platformFeeCents;

  log.info({ escrowId: escrow.id, escrowAmount: escrow.amount, platformFeeCents, netPayoutCents }, 'Platform fee applied to transfer');

  let transferResult: Awaited<ReturnType<typeof StripeService.createTransfer>>;
  try {
    transferResult = await StripeService.createTransfer({
      escrowId: escrow.id,
      taskId,
      workerId: task.worker_id,
      workerStripeAccountId: worker.stripe_connect_id,
      amount: netPayoutCents,
      description: `Dispute resolution: ${reason}`,
    });
  } catch (stripeError) {
    if (isStripeAccountRestrictionError(stripeError)) {
      const code = (stripeError as Error & { code?: string }).code ?? 'unknown';
      log.error({ escrowId: escrow.id, workerId: task.worker_id, stripeCode: code }, 'Stripe account restricted — locking escrow');
      await lockEscrowForStripeRestriction(escrow.id, task.worker_id, code);
      return;
    }
    throw stripeError;
  }

  if (!transferResult.success) {
    throw new Error(`Failed to create transfer: ${transferResult.error.message}`);
  }

  const transferId = transferResult.data.transferId;

  await db.transaction(async (trx: QueryFn) => {
    await trx(
      `UPDATE escrows SET stripe_transfer_id = $1, version = version + 1 WHERE id = $2 AND version = $3`,
      [transferId, escrow.id, escrow.version]
    );
  });

  log.info({ escrowId: escrow.id, transferId }, 'Transfer created for escrow');
}

async function handleRefundRequest(
  escrow: EscrowRow,
  _disputeId: string | undefined,
  _reason: string
): Promise<void> {
  if (escrow.stripe_refund_id) {
    log.info({ escrowId: escrow.id, refundId: escrow.stripe_refund_id }, 'Escrow already has refund_id, idempotent replay');
    return;
  }

  if (!escrow.stripe_payment_intent_id) {
    throw new Error(`Escrow ${escrow.id} has no stripe_payment_intent_id`);
  }

  const refundResult = await StripeService.createRefund({
    paymentIntentId: escrow.stripe_payment_intent_id,
    escrowId: escrow.id,
    amount: escrow.amount,
    reason: 'requested_by_customer',
  });

  if (!refundResult.success) {
    throw new Error(`Failed to create refund: ${refundResult.error.message}`);
  }

  const refundId = refundResult.data.refundId;

  await db.transaction(async (trx: QueryFn) => {
    await trx(
      `UPDATE escrows SET stripe_refund_id = $1, version = version + 1 WHERE id = $2 AND version = $3`,
      [refundId, escrow.id, escrow.version]
    );
  });

  log.info({ escrowId: escrow.id, refundId }, 'Refund created for escrow');
}

async function handlePartialRefundRequest(
  escrow: EscrowRow,
  taskId: string,
  disputeId: string | undefined,
  reason: string,
  refundAmount: number,
  releaseAmount: number
): Promise<void> {
  if (refundAmount < 0 || releaseAmount < 0) {
    throw new Error('SPLIT amounts must be non-negative');
  }
  if (refundAmount + releaseAmount !== escrow.amount) {
    throw new Error(`SPLIT amounts (${refundAmount} + ${releaseAmount}) must sum to escrow amount (${escrow.amount})`);
  }

  const taskResult = await db.query<{ worker_id: string | null }>(
    'SELECT worker_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (taskResult.rows.length === 0) throw new Error(`Task ${taskId} not found`);
  const task = taskResult.rows[0];

  let pendingRefundId: string | null = null;
  if (refundAmount > 0 && !escrow.stripe_refund_id) {
    const pendingEvent = await db.query<{ metadata: string }>(
      `SELECT metadata FROM escrow_events
       WHERE escrow_id = $1 AND actor_type = 'system'
         AND metadata::jsonb->>'event_type' = 'partial_refund_pending'
         AND metadata::jsonb->>'stripe_refund_id' IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [escrow.id]
    );
    if (pendingEvent.rows.length > 0) {
      try {
        const meta = JSON.parse(pendingEvent.rows[0].metadata) as Record<string, unknown>;
        pendingRefundId = typeof meta['stripe_refund_id'] === 'string' ? meta['stripe_refund_id'] : null;
      } catch { /* malformed metadata */ }
      if (pendingRefundId) {
        log.info({ escrowId: escrow.id, refundId: pendingRefundId }, 'Found partial_refund_pending checkpoint');
      }
    }
  }

  let refundId: string | null = escrow.stripe_refund_id ?? pendingRefundId;
  if (refundAmount > 0) {
    if (!refundId) {
      if (!escrow.stripe_payment_intent_id) throw new Error(`Escrow ${escrow.id} has no stripe_payment_intent_id`);

      const refundResult = await StripeService.createRefund({
        paymentIntentId: escrow.stripe_payment_intent_id,
        escrowId: escrow.id,
        amount: refundAmount,
        reason: 'requested_by_customer',
      });
      if (!refundResult.success) throw new Error(`Failed to create refund: ${refundResult.error.message}`);

      refundId = refundResult.data.refundId;
      log.info({ escrowId: escrow.id, refundId, amount: refundAmount }, 'Partial refund created');

      await db.query(
        `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
         VALUES ($1, 'LOCKED_DISPUTE', 'LOCKED_DISPUTE', NULL, 'system', $2)`,
        [escrow.id, JSON.stringify({ event_type: 'partial_refund_pending', stripe_refund_id: refundId })]
      );
    }
  }

  let transferId: string | null = escrow.stripe_transfer_id;
  if (releaseAmount > 0) {
    if (!transferId) {
      if (!task.worker_id) throw new Error(`Task ${taskId} has no worker_id`);

      const workerResult = await db.query<{ stripe_connect_id: string | null }>(
        'SELECT stripe_connect_id FROM users WHERE id = $1',
        [task.worker_id]
      );
      if (workerResult.rows.length === 0) throw new Error(`Worker ${task.worker_id} not found`);
      const worker = workerResult.rows[0];
      if (!worker.stripe_connect_id) throw new Error(`Worker ${task.worker_id} has no stripe_connect_id`);

      if (process.env.HX_FAIL_STRIPE_TRANSFER === '1') {
        throw new Error('Transfer creation failed (injected failure for testing)');
      }

      let partialTransferResult: Awaited<ReturnType<typeof StripeService.createTransfer>>;
      try {
        partialTransferResult = await StripeService.createTransfer({
          escrowId: escrow.id,
          taskId,
          workerId: task.worker_id,
          workerStripeAccountId: worker.stripe_connect_id,
          amount: releaseAmount,
          description: `Dispute resolution: ${reason}`,
        });
      } catch (stripeError) {
        if (isStripeAccountRestrictionError(stripeError)) {
          const code = (stripeError as Error & { code?: string }).code ?? 'unknown';
          log.error({ escrowId: escrow.id, workerId: task.worker_id, stripeCode: code }, 'Stripe account restricted (partial refund path)');
          await lockEscrowForStripeRestriction(escrow.id, task.worker_id, code);
          return;
        }
        throw stripeError;
      }

      if (!partialTransferResult.success) throw new Error(`Failed to create transfer: ${partialTransferResult.error.message}`);
      transferId = partialTransferResult.data.transferId;
      log.info({ escrowId: escrow.id, transferId, amount: releaseAmount }, 'Partial transfer created');
    }
  }

  if (refundAmount > 0 && !refundId) throw new Error(`Cannot terminalize SPLIT: refundAmount > 0 but refundId missing`);
  if (releaseAmount > 0 && !transferId) throw new Error(`Cannot terminalize SPLIT: releaseAmount > 0 but transferId missing`);

  const { rowCount: updateRowCount, finalState } = await db.transaction(async (trx: QueryFn) => {
    const updateResult = await trx<{ id: string; state: string }>(
      `UPDATE escrows
       SET state = 'REFUND_PARTIAL',
           stripe_refund_id = $1,
           stripe_transfer_id = $2,
           refund_amount = $3,
           release_amount = $4,
           refunded_at = CASE WHEN $3 > 0 THEN NOW() ELSE refunded_at END,
           released_at = CASE WHEN $4 > 0 THEN NOW() ELSE released_at END,
           version = version + 1
       WHERE id = $5 AND version = $6
         AND ($3 = 0 OR $1 IS NOT NULL)
         AND ($4 = 0 OR $2 IS NOT NULL)`,
      [refundId, transferId, refundAmount, releaseAmount, escrow.id, escrow.version]
    );

    if (updateResult.rowCount === 0) {
      const checkResult = await trx<{ state: string }>(`SELECT state FROM escrows WHERE id = $1`, [escrow.id]);
      return { rowCount: 0, finalState: checkResult.rows[0]?.state ?? null };
    }
    return { rowCount: updateResult.rowCount, finalState: 'REFUND_PARTIAL' };
  });

  if (updateRowCount === 0) {
    if (finalState === 'REFUND_PARTIAL') {
      log.info({ escrowId: escrow.id }, 'Escrow already REFUND_PARTIAL, idempotent replay');
      return;
    }
    log.warn({ escrowId: escrow.id, expectedVersion: escrow.version }, 'Escrow version mismatch, treating as no-op');
    return;
  }

  await TaskService.advanceProgress({ taskId, to: 'CLOSED', actor: { type: 'system' } });
  log.info({ escrowId: escrow.id, refundAmount, releaseAmount }, 'Escrow set to REFUND_PARTIAL');
}
