/**
 * Completion Release Worker v1.0.0
 *
 * Happy-path payout orchestration: when a task transitions to COMPLETED
 * (poster approved proof), this worker creates the Stripe transfer and
 * releases the escrow via EscrowService.release — the single audited
 * FUNDED→RELEASED path (which owns fee/insurance/earnings/XP side effects).
 *
 * Consumes:
 * - escrow.completion_release_requested  (emitted transactionally by
 *   TaskService.complete via the outbox — INV-6)
 *
 * CRITICAL RULES (mirrors escrow-action-worker):
 * - SELECT ... FOR UPDATE only inside db.transaction().
 * - Stripe calls OUTSIDE any transaction (cannot be rolled back); idempotency
 *   via Stripe idempotency key + transfer-id short-circuit + version-checked T2.
 * - This worker NEVER writes revenue/insurance/XP directly — EscrowService.release
 *   is the single source of truth for release side effects.
 * - Escrows not in FUNDED state are NEVER touched here:
 *     RELEASED        → idempotent no-op (replay)
 *     LOCKED_DISPUTE  → dispute machinery owns the money — no-op
 *     PENDING/other   → CRITICAL alert (completed task with unfunded escrow)
 * - Offline-payment tasks never produce a Stripe transfer.
 * - Worker without a Stripe Connect account → no-op + admin alert (ops releases
 *   manually); NOT retried — BullMQ backoff (~31s total) cannot wait out a
 *   days-long Connect onboarding.
 *
 * @see docs/plans/2026-06-11-completion-release-orchestration.md
 */

import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { StripeService } from '../services/StripeService.js';
import { EscrowService } from '../services/EscrowService.js';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';
import { workerLogger } from '../logger.js';
import { config } from '../config.js';
import { computeFeeBreakdown } from '../lib/money.js';
import { notifyPaymentReleased } from '../lib/task-lifecycle-notifications.js';
import { verifyJobSignature } from './queues.js';
import { z } from 'zod';
import type { Job } from 'bullmq';

const log = workerLogger.child({ worker: 'completion-release' });

// Same non-retryable Stripe Connect restriction codes as escrow-action-worker.
// Kept local on purpose: zero import coupling into the dispute worker.
const STRIPE_ACCOUNT_RESTRICTION_CODES = new Set([
  'account_closed',
  'account_invalid',
  'account_deauthorized',
  'transfer_not_reversible',
]);

function isStripeAccountRestrictionError(error: unknown): boolean {
  if (error instanceof Error && 'code' in error) {
    const stripeError = error as Error & { code?: string };
    return stripeError.code !== undefined && STRIPE_ACCOUNT_RESTRICTION_CODES.has(stripeError.code);
  }
  return false;
}

const CompletionReleasePayloadSchema = z.object({
  escrow_id: z.string().uuid(),
  task_id: z.string().uuid(),
  reason: z.string().min(1).max(200),
  _sig: z.string().min(1),
});

interface EscrowSnapshot {
  id: string;
  task_id: string;
  state: string;
  version: number;
  amount: number;
  stripe_transfer_id: string | null;
}

interface TaskSnapshot {
  state: string;
  worker_id: string | null;
  payment_method: string | null;
  poster_id: string | null;
}

type CriticalSectionResult =
  | { action: 'noop' }
  | { action: 'proceed'; escrow: EscrowSnapshot; task: TaskSnapshot };

export async function processCompletionReleaseJob(job: Job<{ payload: object }>): Promise<void> {
  const { payload } = job.data;

  // --- Step 1: schema validation (reject null / malformed payloads) ---
  const parsed = CompletionReleasePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.issues }, 'Invalid completion-release payload schema — rejecting');
    throw new Error('JOB_SCHEMA_INVALID: ' + parsed.error.message);
  }

  // --- Step 2: HMAC signature verification (Redis injection defence) ---
  const { _sig, ...payloadWithoutSig } = parsed.data;
  if (!verifyJobSignature(payloadWithoutSig as Record<string, unknown>, _sig)) {
    log.error({ jobId: job.id }, 'Completion-release job signature verification failed');
    throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
  }

  const { escrow_id: escrowId, task_id: taskId } = parsed.data;

  // --- Step 3: critical section — lock escrow, branch on state, read task ---
  const critical = await db.transaction<CriticalSectionResult>(async (trx: QueryFn) => {
    const escrowResult = await trx<EscrowSnapshot>(
      `SELECT id, task_id, state, version, amount, stripe_transfer_id
       FROM escrows
       WHERE id = $1
       FOR UPDATE`,
      [escrowId]
    );

    if (escrowResult.rows.length === 0) {
      // Outbox event references a missing escrow — data corruption; surface loudly.
      throw new Error(`Escrow ${escrowId} not found for completion release`);
    }

    const escrow = escrowResult.rows[0];

    if (escrow.state === 'RELEASED' || escrow.state === 'REFUNDED' || escrow.state === 'REFUND_PARTIAL') {
      log.info({ escrowId, state: escrow.state }, 'Completion release: escrow already terminal — idempotent no-op');
      return { action: 'noop' };
    }

    if (escrow.state === 'LOCKED_DISPUTE') {
      // A dispute was filed between completion and job execution. The dispute
      // resolution path owns this money — never auto-release here.
      log.warn({ escrowId, taskId }, 'Completion release: escrow LOCKED_DISPUTE — deferring to dispute resolution');
      return { action: 'noop' };
    }

    if (escrow.state !== 'FUNDED') {
      // COMPLETED task whose escrow was never funded (PENDING or unknown state).
      // Money cannot move; ops must reconcile. Do NOT retry — state will not heal itself.
      log.error({ escrowId, taskId, state: escrow.state }, 'CRITICAL: completed task has non-FUNDED escrow — manual reconciliation required');
      await notifyAdmins({
        title: 'Completion release blocked: escrow not FUNDED',
        body: `Task ${taskId} is COMPLETED but escrow ${escrowId} is ${escrow.state}. Manual review required.`,
        deepLink: `/admin/escrows/${escrowId}`,
        priority: 'CRITICAL',
        metadata: { escrow_id: escrowId, task_id: taskId, escrow_state: escrow.state },
      });
      return { action: 'noop' };
    }

    const taskResult = await trx<TaskSnapshot>(
      `SELECT state, worker_id, payment_method, poster_id FROM tasks WHERE id = $1`,
      [taskId]
    );

    if (taskResult.rows.length === 0) {
      throw new Error(`Task ${taskId} not found for completion release`);
    }

    const task = taskResult.rows[0];

    if (task.state !== 'COMPLETED') {
      // The outbox event is written in the same transaction as the COMPLETED
      // update, so a non-COMPLETED task here means corruption or manual surgery.
      throw new Error(`Completion release for task ${taskId} but state is ${task.state}, expected COMPLETED`);
    }

    return { action: 'proceed', escrow, task };
  });

  if (critical.action === 'noop') {
    return;
  }

  const { escrow, task } = critical;

  // --- Step 4: payment-method + payout-account guards (outside lock, read-only) ---
  const paymentMethod = task.payment_method ?? 'escrow';
  if (paymentMethod !== 'escrow') {
    // Offline payments (cash/venmo/cashapp) never move money through Stripe.
    log.info({ escrowId, taskId, paymentMethod }, 'Completion release: offline payment method — no Stripe transfer, no auto-release');
    return;
  }

  if (!task.worker_id) {
    throw new Error(`Task ${taskId} is COMPLETED but has no worker_id — cannot pay out`);
  }

  let stripeTransferId = escrow.stripe_transfer_id;

  if (!stripeTransferId) {
    // Re-fetch the Connect account immediately before transfer creation (stale-payload defence).
    const workerResult = await db.query<{ stripe_connect_id: string | null }>(
      `SELECT stripe_connect_id FROM users WHERE id = $1`,
      [task.worker_id]
    );

    const stripeConnectId = workerResult.rows[0]?.stripe_connect_id ?? null;

    if (!stripeConnectId) {
      // Common in beta: hustler has not finished Connect onboarding. Retrying on
      // BullMQ backoff cannot bridge a days-long onboarding gap — alert ops and
      // exit. Escrow stays FUNDED; admin force-release or a future sweep pays out.
      log.error({ escrowId, taskId, workerId: task.worker_id }, 'CRITICAL: completion release blocked — worker has no Stripe Connect account');
      await notifyAdmins({
        title: 'Payout blocked: worker has no Stripe Connect account',
        body: `Task ${taskId} completed; escrow ${escrowId} is FUNDED but worker ${task.worker_id} has no payout account. Release manually once onboarded.`,
        deepLink: `/admin/escrows/${escrowId}`,
        priority: 'CRITICAL',
        metadata: { escrow_id: escrowId, task_id: taskId, worker_id: task.worker_id },
      });
      return;
    }

    // Unified fee + self-insurance math (single source of truth — INV-5).
    const { platformFeeCents, insuranceContributionCents, netPayoutCents } =
      computeFeeBreakdown(escrow.amount, config.stripe.platformFeePercent);

    log.info(
      { escrowId, taskId, gross: escrow.amount, platformFeeCents, insuranceContributionCents, netPayoutCents },
      'Completion release: creating Stripe transfer'
    );

    // --- Step 5: Stripe transfer (outside any transaction) ---
    let transferResult: Awaited<ReturnType<typeof StripeService.createTransfer>>;
    try {
      transferResult = await StripeService.createTransfer({
        escrowId: escrow.id,
        taskId,
        workerId: task.worker_id,
        workerStripeAccountId: stripeConnectId,
        amount: netPayoutCents,
        description: 'Task completion payout',
        idempotencyKeySuffix: 'completion_release',
      });
    } catch (stripeError) {
      if (isStripeAccountRestrictionError(stripeError)) {
        const code = (stripeError as Error & { code?: string }).code ?? 'unknown';
        log.error({ escrowId, workerId: task.worker_id, stripeCode: code }, 'CRITICAL: Stripe account restricted — completion release blocked, NOT retrying');
        await notifyAdmins({
          title: 'Payout blocked: Stripe account restriction',
          body: `Completion release for escrow ${escrowId} hit restriction '${code}'. Manual review required.`,
          deepLink: `/admin/escrows/${escrowId}`,
          priority: 'CRITICAL',
          metadata: { escrow_id: escrowId, task_id: taskId, worker_id: task.worker_id, stripe_code: code },
        });
        return; // do NOT rethrow — BullMQ must not retry a restriction
      }
      throw stripeError; // transient Stripe error — BullMQ retry
    }

    if (!transferResult.success) {
      throw new Error(`Completion release: failed to create transfer — ${transferResult.error.message}`);
    }

    const newTransferId = transferResult.data.transferId;

    // --- Step 6 (T2): store transfer_id atomically with version re-check ---
    let concurrentTransferId: string | null = null;
    await db.transaction(async (trx: QueryFn) => {
      const lockedRow = await trx<{ id: string; version: number; stripe_transfer_id: string | null }>(
        `SELECT id, version, stripe_transfer_id FROM escrows WHERE id = $1 FOR UPDATE NOWAIT`,
        [escrow.id]
      );
      if (!lockedRow.rows.length) {
        throw new Error(`Escrow ${escrow.id} disappeared during T2 lock — retry`);
      }
      const locked = lockedRow.rows[0];
      if (locked.stripe_transfer_id) {
        // Another worker won; Stripe idempotency guarantees the same transfer —
        // no double-send. Use the recorded id for the release step.
        log.info({ escrowId: escrow.id, existing: locked.stripe_transfer_id, ours: newTransferId }, 'T2 re-read: transfer_id already set — idempotent');
        concurrentTransferId = locked.stripe_transfer_id;
        return;
      }
      if (locked.version !== escrow.version) {
        throw new Error(`Version conflict in T2 for escrow ${escrow.id} (expected ${escrow.version}, got ${locked.version}) — retry`);
      }
      const updateResult = await trx<{ id: string }>(
        `UPDATE escrows
         SET stripe_transfer_id = $1,
             version = version + 1
         WHERE id = $2 AND version = $3
         RETURNING id`,
        [newTransferId, escrow.id, escrow.version]
      );
      if (!updateResult.rows.length) {
        throw new Error(`Concurrent version conflict storing transfer ${newTransferId} for escrow ${escrow.id} — retry`);
      }
    });

    stripeTransferId = concurrentTransferId ?? newTransferId;
  } else {
    log.info({ escrowId, stripeTransferId }, 'Completion release: transfer already exists — resuming at release step (crash-replay)');
  }

  // --- Step 7: release via the single audited path (fees/insurance/earnings/XP inside) ---
  const releaseResult = await EscrowService.release({
    escrowId: escrow.id,
    stripeTransferId,
  });

  if (!releaseResult.success) {
    // Terminal codes mean another path (webhook transfer.created / admin) already
    // finished the job — that is idempotent success, not an error.
    const code = releaseResult.error.code;
    if (code === 'ESCROW_TERMINAL' || code === 'INVALID_STATE') {
      log.info({ escrowId, code }, 'Completion release: escrow already terminal at release step — idempotent no-op');
      return;
    }
    throw new Error(`Completion release: EscrowService.release failed — ${releaseResult.error.message}`);
  }

  log.info({ escrowId, taskId, stripeTransferId }, 'Completion release: escrow RELEASED — payout complete');

  // Lifecycle notification (post-release, fire-and-forget): tell the worker.
  // Recomputed from the same unified module — identical to the transferred amount.
  const { netPayoutCents: notifiedNet } = computeFeeBreakdown(escrow.amount, config.stripe.platformFeePercent);
  await notifyPaymentReleased(task.worker_id, taskId, notifiedNet);
}
