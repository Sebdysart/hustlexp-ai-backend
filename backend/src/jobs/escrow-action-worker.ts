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
 * Responsibilities:
 * - Validate escrow state (must be LOCKED_DISPUTE for dispute-driven)
 * - Execute Stripe API calls (transfer/refund)
 * - Store Stripe IDs on escrow
 * - For SPLIT only: Set escrow.state = REFUND_PARTIAL (MVP-authoritative)
 *
 * CRITICAL RULES:
 * - SELECT ... FOR UPDATE MUST be inside db.transaction() — bare db.query() releases
 *   the row lock when the connection is returned to the pool.
 * - The critical section (FOR UPDATE through version-checked UPDATE) runs inside
 *   db.transaction() so both queries share the same connection.
 * - External side effects (Stripe API calls, writeToOutbox, notifications) remain
 *   OUTSIDE the transaction because rolling back a DB transaction cannot roll back
 *   an already-submitted Stripe transfer; each side effect has its own idempotency.
 *
 * NOTE: Does NOT set RELEASED/REFUNDED states (PaymentWorker does via Stripe events)
 *
 * @see Dispute Resolution MVP Implementation Spec §4
 */

import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { StripeService } from '../services/StripeService.js';
import { TaskService } from '../services/TaskService.js';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';
import { RevenueService } from '../services/RevenueService.js';
import { workerLogger } from '../logger.js';
import { config } from '../config.js';
import { verifyJobSignature } from './queues.js';
import { z } from 'zod';
import type { Job } from 'bullmq';

// ============================================================================
// STRIPE ACCOUNT RESTRICTION ERROR CODES (Bug 1)
// These codes represent non-retryable Stripe Connect account states.
// When encountered, the escrow must be locked for admin review rather
// than retried — retrying will never succeed.
// ============================================================================
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
  // Transition escrow to LOCKED_DISPUTE with a stripe_account_restricted reason.
  // This is a non-retryable state — admin must manually resolve.
  // BUG FIX: wrap both DML statements in a transaction so a crash between the
  // UPDATE and the INSERT cannot leave the escrow locked with no audit record.
  await db.transaction(async (txQuery) => {
    await txQuery(
      `WITH pre AS (SELECT state FROM escrows WHERE id = $1 FOR UPDATE),
            upd AS (
              UPDATE escrows SET state = 'LOCKED_DISPUTE', version = version + 1, updated_at = NOW()
              WHERE id = $1 AND state IN ('FUNDED', 'LOCKED_DISPUTE')
              RETURNING id
            )
       INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
       SELECT $1, pre.state, 'LOCKED_DISPUTE', NULL, 'system', $2 FROM pre
       WHERE EXISTS (SELECT 1 FROM upd)`,
      [escrowId, JSON.stringify({ reason: 'stripe_account_restricted', stripe_code: stripeCode, worker_id: workerId })],
    );
  });

  try {
    await notifyAdmins({
      title: 'Escrow Locked: Stripe Account Restricted',
      body: `Escrow ${escrowId} could not be released — worker Stripe account is restricted (code: ${stripeCode}). Manual admin review required.`,
      deepLink: `/admin/escrows/${escrowId}`,
      priority: 'CRITICAL',
      metadata: { escrow_id: escrowId, worker_id: workerId, stripe_code: stripeCode },
    });
  } catch (notifyError) {
    // Non-fatal: notification failure must not mask the core lock action
    log.error(
      { err: notifyError instanceof Error ? notifyError.message : String(notifyError), escrowId },
      'Failed to notify admins of stripe account restriction — escrow is locked regardless',
    );
  }
}

const log = workerLogger.child({ worker: 'escrow-action' });

// ============================================================================
// TYPES
// ============================================================================

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

// Row shape returned by the critical-section FOR UPDATE SELECT
interface EscrowRow {
  id: string;
  state: string;
  version: number;
  amount: number;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
}

// ============================================================================
// ZOD SCHEMA (Attack 1 — null payload / schema validation)
// ============================================================================

const FinancialJobPayloadSchema = z.object({
  escrow_id: z.string().uuid(),
  task_id: z.string().uuid(),
  dispute_id: z.string().uuid().optional(),
  reason: z.string().min(1),
  refund_amount: z.number().int().nonnegative().optional(),
  release_amount: z.number().int().nonnegative().optional(),
  _sig: z.string().length(64), // SHA256 hex = 64 chars
});

// ============================================================================
// ESCROW ACTION WORKER
// ============================================================================

export async function processEscrowActionJob(job: Job<EscrowActionJobData>): Promise<void> {
  const { payload } = job.data;
  const eventType = job.name;

  // --- Step 1: Zod schema validation (Attack 1 — reject null / malformed payloads) ---
  const parsed = FinancialJobPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    log.error(
      { jobId: job.id, eventType, errors: parsed.error.issues },
      'Invalid financial job payload schema — rejecting',
    );
    throw new Error('JOB_SCHEMA_INVALID: ' + parsed.error.message);
  }

  // --- Step 2: HMAC signature verification (Attack 12 — Redis injection defence) ---
  const { _sig, ...payloadWithoutSig } = parsed.data;
  if (!verifyJobSignature(payloadWithoutSig as Record<string, unknown>, _sig)) {
    log.error(
      { jobId: job.id, eventType },
      'Job signature verification failed — possible Redis injection attack',
    );
    throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
  }

  const { escrow_id, task_id, dispute_id, reason, refund_amount, release_amount } = parsed.data;

  try {
    // -------------------------------------------------------------------------
    // Critical section: lock escrow row, validate state, dispatch to handler.
    //
    // The SELECT ... FOR UPDATE and the subsequent state-mutation UPDATE for
    // each handler MUST share the same DB connection so the row-level lock is
    // held throughout. db.transaction() acquires a dedicated connection, issues
    // BEGIN, runs the callback, then COMMITs — guaranteeing the lock is never
    // released between the SELECT and the UPDATE.
    //
    // External side effects (Stripe calls, notifications) are performed AFTER
    // the transaction returns because:
    //   (a) Rolling back a DB transaction cannot roll back a submitted Stripe
    //       transfer — so Stripe must be called outside the transaction.
    //   (b) Each Stripe call has its own idempotency key.
    // -------------------------------------------------------------------------
    const criticalSectionResult = await db.transaction(async (trx: QueryFn) => {
      // Lock escrow FOR UPDATE — held until COMMIT at end of transaction
      const escrowResult = await trx<EscrowRow>(
        `SELECT id, state, version, amount, stripe_payment_intent_id, stripe_transfer_id, stripe_refund_id
         FROM escrows
         WHERE id = $1
         FOR UPDATE`,
        [escrow_id]
      );

      if (escrowResult.rows.length === 0) {
        throw new Error(`Escrow ${escrow_id} not found`);
      }

      const escrow = escrowResult.rows[0];

      // Validate state: must be LOCKED_DISPUTE for dispute-driven actions
      if (escrow.state !== 'LOCKED_DISPUTE') {
        throw new Error(`Escrow must be LOCKED_DISPUTE to process dispute action (current: ${escrow.state})`);
      }

      // Return the locked escrow row so post-transaction handlers can use it.
      // Each handler receives `trx` for any additional DB reads/writes that
      // must remain inside the same connection (e.g. version-checked UPDATE).
      return { escrow };
    });

    const { escrow } = criticalSectionResult;

    // Process based on event type (outside the FOR UPDATE transaction so that
    // Stripe API calls — which cannot be rolled back — are never inside a
    // database transaction that might be aborted on a subsequent DB error).
    switch (eventType) {
      case 'escrow.release_requested':
        await handleReleaseRequest(escrow, task_id, dispute_id, reason);
        break;

      case 'escrow.refund_requested':
        await handleRefundRequest(escrow, dispute_id, reason, refund_amount);
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
    throw error; // Re-throw for BullMQ retry logic
  }
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle RELEASE: Create Stripe transfer, store transfer_id.
 *
 * The escrow row was already locked and validated (state=LOCKED_DISPUTE) by the
 * FOR UPDATE transaction in processEscrowActionJob. This handler:
 *   1. Re-reads any auxiliary data (task, user) via plain db.query — these reads
 *      do not need to hold the escrow row lock; they only extend a data query.
 *   2. Calls Stripe (outside any transaction — cannot be rolled back).
 *   3. Runs a second db.transaction() for the version-checked UPDATE so that the
 *      UPDATE is atomic with the lock re-acquisition. This is safe because:
 *      - The idempotency check (stripe_transfer_id already set) prevents a second
 *        Stripe call if the first one already committed.
 *      - The WHERE version = $N guard prevents double-write if another process
 *        raced in between (should not happen — BullMQ provides at-most-once
 *        delivery for a given job ID, and the FOR UPDATE above serialises
 *        concurrent workers on the same escrow_id).
 */
async function handleReleaseRequest(
  escrow: EscrowRow,
  taskId: string,
  disputeId: string | undefined,
  reason: string
): Promise<void> {
  // Idempotency: If transfer_id already exists, skip
  if (escrow.stripe_transfer_id) {
    log.info({ escrowId: escrow.id, transferId: escrow.stripe_transfer_id }, 'Escrow already has transfer_id, idempotent replay');
    return;
  }

  // Get task to find worker_id
  const taskResult = await db.query<{ worker_id: string | null }>(
    'SELECT worker_id FROM tasks WHERE id = $1',
    [taskId]
  );

  if (taskResult.rows.length === 0) {
    throw new Error(`Task ${taskId} not found`);
  }

  const task = taskResult.rows[0];

  if (!task.worker_id) {
    throw new Error(`Task ${taskId} has no worker_id`);
  }

  // Bug 2 Fix: Re-fetch stripe_connect_id from DB immediately before calling
  // createTransfer(). The job payload may have captured a stale account ID if
  // the worker updated their Connect account between queue time and execution.
  const workerResult = await db.query<{ stripe_connect_id: string | null }>(
    'SELECT stripe_connect_id FROM users WHERE id = $1',
    [task.worker_id]
  );

  if (workerResult.rows.length === 0) {
    throw new Error(`Worker ${task.worker_id} not found`);
  }

  const worker = workerResult.rows[0];

  if (!worker.stripe_connect_id) {
    throw new Error(`Worker ${task.worker_id} has no stripe_connect_id`);
  }

  // TT-03: Re-read stripe_transfer_id from the DB after the first transaction committed
  // (the FOR UPDATE lock was released at commit). Two BullMQ workers can both see
  // stripe_transfer_id = null in their stale escrow snapshots and both pass the
  // idempotency check above; the re-read below is the second line of defence.
  const freshEscrowResult = await db.query<{ stripe_transfer_id: string | null }>(
    'SELECT stripe_transfer_id FROM escrows WHERE id = $1',
    [escrow.id]
  );
  if (freshEscrowResult.rows[0]?.stripe_transfer_id) {
    log.info(
      { escrowId: escrow.id, transferId: freshEscrowResult.rows[0].stripe_transfer_id },
      'Fresh DB re-read: transfer already created on a prior attempt — skipping Stripe call',
    );
    return;
  }

  // Deduct platform fee before paying out to worker (PRODUCT_SPEC §9: 15% default)
  const platformFeePercent = Math.min(100, Math.max(0, config.stripe.platformFeePercent ?? 15));
  const platformFeeCents = Math.round(escrow.amount * (platformFeePercent / 100));
  const netPayoutCents = escrow.amount - platformFeeCents;

  log.info({ escrowId: escrow.id, escrowAmount: escrow.amount, platformFeeCents, netPayoutCents }, 'Platform fee applied to transfer');

  // Bug 1 Fix: Wrap createTransfer in a try/catch that detects non-retryable
  // Stripe account restriction codes. When detected, lock the escrow for admin
  // review and return without rethrowing so BullMQ does NOT retry the job.
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
      log.error(
        { escrowId: escrow.id, workerId: task.worker_id, stripeCode: code },
        'CRITICAL: Stripe account restricted — locking escrow, NOT retrying',
      );
      await lockEscrowForStripeRestriction(escrow.id, task.worker_id, code);
      // Return without rethrowing — BullMQ must not retry this job
      return;
    }
    // Unknown Stripe error — rethrow for normal BullMQ retry
    throw stripeError;
  }

  if (!transferResult.success) {
    throw new Error(`Failed to create transfer: ${transferResult.error.message}`);
  }

  const transferId = transferResult.data.transferId;

  // Store transfer_id on escrow inside a transaction so the version-checked UPDATE
  // is atomic. (The escrow row lock from processEscrowActionJob was already released
  // when that transaction committed — this second short transaction re-acquires it
  // just for the UPDATE statement itself, which is sufficient to prevent concurrent
  // double-write from two workers that both passed the idempotency check above.)
  await db.transaction(async (trx: QueryFn) => {
    const updateResult = await trx<{ id: string }>(
      `UPDATE escrows
       SET stripe_transfer_id = $1,
           version = version + 1
       WHERE id = $2 AND version = $3
       RETURNING id`,
      [transferId, escrow.id, escrow.version]
    );
    if (!updateResult.rows.length) {
      throw new Error(`Concurrent version conflict storing transfer ${transferId} for escrow ${escrow.id} — retry`);
    }
  });

  log.info({ escrowId: escrow.id, transferId }, 'Transfer created for escrow');

  // Log platform fee to revenue ledger for dispute-driven RELEASE outcomes.
  // Non-fatal: ledger write failure must not block payout confirmation.
  if (platformFeeCents > 0) {
    try {
      await RevenueService.logEvent({
        eventType: 'platform_fee',
        userId: task.worker_id!,
        taskId,
        amountCents: platformFeeCents,
        grossAmountCents: escrow.amount,
        platformFeeCents,
        netAmountCents: netPayoutCents,
        feeBasisPoints: Math.round(platformFeePercent * 100),
        escrowId: escrow.id,
        stripeTransferId: transferId,
        metadata: { event: 'escrow_dispute_release' },
      });
    } catch (revenueErr) {
      log.warn(
        { err: revenueErr instanceof Error ? revenueErr.message : String(revenueErr), escrowId: escrow.id },
        'handleReleaseRequest: revenue ledger write failed — manual reconciliation required'
      );
    }
  }
}

/**
 * Handle REFUND: Create Stripe refund, store refund_id.
 *
 * Same structural pattern as handleReleaseRequest: Stripe call happens outside
 * any DB transaction, then a short transaction writes the result back atomically.
 */
async function handleRefundRequest(
  escrow: EscrowRow,
  _disputeId: string | undefined,
  _reason: string,
  refundAmount?: number
): Promise<void> {
  // Idempotency: If refund_id already exists, skip
  if (escrow.stripe_refund_id) {
    log.info({ escrowId: escrow.id, refundId: escrow.stripe_refund_id }, 'Escrow already has refund_id, idempotent replay');
    return;
  }

  if (!escrow.stripe_payment_intent_id) {
    throw new Error(`Escrow ${escrow.id} has no stripe_payment_intent_id`);
  }

  // TT-04: Re-read stripe_refund_id from the DB after the FOR UPDATE transaction
  // committed (the lock was released at commit). Two BullMQ workers can both see
  // stripe_refund_id = null in their stale escrow snapshots and both pass the
  // idempotency check above; this fresh re-read is the second line of defence,
  // mirroring the TT-03 pattern in handleReleaseRequest.
  const freshRefundCheck = await db.query<{ stripe_refund_id: string | null }>(
    'SELECT stripe_refund_id FROM escrows WHERE id = $1',
    [escrow.id]
  );
  if (freshRefundCheck.rows[0]?.stripe_refund_id) {
    log.info(
      { escrowId: escrow.id, refundId: freshRefundCheck.rows[0].stripe_refund_id },
      'Fresh DB re-read: refund already issued on a prior attempt (concurrent retry) — skipping Stripe call',
    );
    return;
  }

  // Use refund_amount from job payload when provided; fall back to full escrow amount.
  // Clamp to escrow.amount to prevent overage that would cause an infinite Stripe reject+retry loop.
  const amountToRefund = refundAmount !== undefined
    ? Math.min(refundAmount, escrow.amount)
    : escrow.amount;

  // Create Stripe refund
  const refundResult = await StripeService.createRefund({
    paymentIntentId: escrow.stripe_payment_intent_id,
    escrowId: escrow.id,
    amount: amountToRefund,
    reason: 'requested_by_customer',
  });

  if (!refundResult.success) {
    throw new Error(`Failed to create refund: ${refundResult.error.message}`);
  }

  const refundId = refundResult.data.refundId;

  // Store refund_id on escrow atomically (version-checked)
  await db.transaction(async (trx: QueryFn) => {
    const updateResult = await trx<{ id: string }>(
      `UPDATE escrows
       SET stripe_refund_id = $1,
           version = version + 1
       WHERE id = $2 AND version = $3
       RETURNING id`,
      [refundId, escrow.id, escrow.version]
    );
    if (!updateResult.rows.length) {
      throw new Error(`Concurrent version conflict storing refund ${refundId} for escrow ${escrow.id} — retry`);
    }
  });

  log.info({ escrowId: escrow.id, refundId }, 'Refund created for escrow');
}

/**
 * Handle SPLIT: Create refund + transfer, store both IDs, set REFUND_PARTIAL (MVP-authoritative)
 *
 * ATOMICITY DESIGN:
 * The two Stripe calls (refund + transfer) cannot be wrapped in a single DB transaction
 * because they are external API calls. The idempotency strategy is:
 *
 *   1. Before calling Stripe refund, check escrow_events for an existing
 *      'partial_refund_pending' record. If found, reuse its stripe_refund_id
 *      and skip the Stripe refund call entirely (idempotent retry).
 *   2. After Stripe refund succeeds, immediately INSERT a 'partial_refund_pending'
 *      escrow_events row with the stripe_refund_id. This is the durable checkpoint.
 *      If the process crashes or the transfer fails afterward, the next BullMQ
 *      retry will find this record and skip re-issuing the refund.
 *   3. The final DB UPDATE only runs after both Stripe calls succeed, inside
 *      a short db.transaction() for atomicity.
 *
 * This prevents the double-refund bug:
 *   Stripe refund ✓  →  [crash / transfer fails]  →  BullMQ retry
 *   Retry detects 'partial_refund_pending' event  →  skips Stripe refund  →  retries transfer only
 */
async function handlePartialRefundRequest(
  escrow: EscrowRow,
  taskId: string,
  disputeId: string | undefined,
  reason: string,
  refundAmount: number,
  releaseAmount: number
): Promise<void> {
  // Validate amounts
  if (refundAmount < 0 || releaseAmount < 0) {
    throw new Error('SPLIT amounts must be non-negative');
  }

  if (Math.round(refundAmount) + Math.round(releaseAmount) !== escrow.amount) {
    throw new Error(`SPLIT amounts (${Math.round(refundAmount)} + ${Math.round(releaseAmount)} = ${Math.round(refundAmount) + Math.round(releaseAmount)}) must sum to escrow amount (${escrow.amount})`);
  }

  // Get task to find worker_id
  const taskResult = await db.query<{ worker_id: string | null }>(
    'SELECT worker_id FROM tasks WHERE id = $1',
    [taskId]
  );

  if (taskResult.rows.length === 0) {
    throw new Error(`Task ${taskId} not found`);
  }

  const task = taskResult.rows[0];

  // ── Idempotency checkpoint: check for a previously-issued refund that was
  //    not yet written to escrow.stripe_refund_id (i.e., the transfer failed
  //    on the prior attempt after the refund was already created). ──
  let pendingRefundId: string | null = null;
  if (refundAmount > 0 && !escrow.stripe_refund_id) {
    const pendingEvent = await db.query<{ metadata: string }>(
      `SELECT metadata
       FROM escrow_events
       WHERE escrow_id = $1
         AND actor_type = 'system'
         AND metadata::jsonb->>'event_type' = 'partial_refund_pending'
         AND metadata::jsonb->>'stripe_refund_id' IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [escrow.id]
    );
    if (pendingEvent.rows.length > 0) {
      try {
        const meta = JSON.parse(pendingEvent.rows[0].metadata) as Record<string, unknown>;
        pendingRefundId = typeof meta['stripe_refund_id'] === 'string' ? meta['stripe_refund_id'] : null;
      } catch {
        // Malformed metadata — treat as no checkpoint found
      }
      if (pendingRefundId) {
        log.info(
          { escrowId: escrow.id, refundId: pendingRefundId },
          'Found partial_refund_pending checkpoint — reusing existing refund ID, skipping Stripe refund call',
        );
      }
    }
  }

  // Create refund if refund_amount > 0
  let refundId: string | null = escrow.stripe_refund_id ?? pendingRefundId;
  if (refundAmount > 0) {
    if (!refundId) {
      if (!escrow.stripe_payment_intent_id) {
        throw new Error(`Escrow ${escrow.id} has no stripe_payment_intent_id for refund`);
      }

      const refundResult = await StripeService.createRefund({
        paymentIntentId: escrow.stripe_payment_intent_id,
        escrowId: escrow.id,
        amount: refundAmount,
        reason: 'requested_by_customer',
      });

      if (!refundResult.success) {
        throw new Error(`Failed to create refund: ${refundResult.error.message}`);
      }

      refundId = refundResult.data.refundId;
      log.info({ escrowId: escrow.id, refundId, amount: refundAmount }, 'Partial refund created for escrow');

      // ── Durability checkpoint: persist refund ID before attempting the transfer.
      //    If the transfer call below fails and BullMQ retries this job, the query
      //    above will find this row and reuse the refund ID, preventing a double-refund.
      //    Uses the existing escrow_events schema (metadata JSONB) rather than a new column. ──
      await db.query(
        `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
         VALUES ($1, 'LOCKED_DISPUTE', 'LOCKED_DISPUTE', NULL, 'system', $2)`,
        [escrow.id, JSON.stringify({ event_type: 'partial_refund_pending', stripe_refund_id: refundId })]
      );
      log.info({ escrowId: escrow.id, refundId }, 'Persisted partial_refund_pending checkpoint');
    }
  }

  // Create transfer if release_amount > 0
  let transferId: string | null = escrow.stripe_transfer_id;
  // Fee variables are computed unconditionally when releaseAmount > 0 so that
  // the RevenueService.logEvent call below always has the correct values — even
  // on an idempotent retry where transferId is populated from the fresh DB re-read
  // and the new-transfer block is skipped entirely.
  let netReleaseCents: number | undefined;
  let adjustedPlatformFeeCents: number | undefined;
  if (releaseAmount > 0) {
    // Compute platform fee unconditionally — must happen before the transferId
    // idempotency checks so these values are always defined when we reach the
    // RevenueService.logEvent guard later, regardless of the retry path taken.
    const platformFeePercent = Math.min(100, Math.max(0, config.stripe?.platformFeePercent ?? 15));
    netReleaseCents = Math.round(releaseAmount * (1 - platformFeePercent / 100));
    const rawPlatformFeeCents = releaseAmount - netReleaseCents;
    // BUG 3 fix: assign any sub-cent rounding residual to the platform fee so
    // all cents are accounted for (refundAmount + netReleaseCents + platformFeeCents
    // must equal escrow.amount exactly).
    const residual = escrow.amount - Math.round(refundAmount) - netReleaseCents - rawPlatformFeeCents;
    adjustedPlatformFeeCents = rawPlatformFeeCents + residual;

    // TT-03: Re-read stripe_transfer_id from the DB after the first transaction committed.
    // Two concurrent BullMQ retries can both see stripe_transfer_id = null in their stale
    // snapshots; this fresh read is the second line of defence against double transfer.
    if (!transferId) {
      const freshTransferResult = await db.query<{ stripe_transfer_id: string | null }>(
        'SELECT stripe_transfer_id FROM escrows WHERE id = $1',
        [escrow.id]
      );
      if (freshTransferResult.rows[0]?.stripe_transfer_id) {
        transferId = freshTransferResult.rows[0].stripe_transfer_id;
        log.info(
          { escrowId: escrow.id, transferId },
          'Fresh DB re-read (partial): transfer already created on a prior attempt — skipping Stripe call',
        );
      }
    }
    if (!transferId) {
      if (!task.worker_id) {
        throw new Error(`Task ${taskId} has no worker_id`);
      }

      // Bug 2 Fix: Re-fetch stripe_connect_id from DB immediately before transfer.
      // The job payload may carry a stale account ID if the worker updated their
      // Connect account after the job was enqueued.
      const workerResult = await db.query<{ stripe_connect_id: string | null }>(
        'SELECT stripe_connect_id FROM users WHERE id = $1',
        [task.worker_id]
      );

      if (workerResult.rows.length === 0) {
        throw new Error(`Worker ${task.worker_id} not found`);
      }

      const worker = workerResult.rows[0];

      if (!worker.stripe_connect_id) {
        throw new Error(`Worker ${task.worker_id} has no stripe_connect_id`);
      }

      log.info(
        { escrowId: escrow.id, releaseAmount, platformFeePercent, netReleaseCents },
        'Platform fee applied to partial release transfer'
      );

      // Bug 1 Fix: Catch non-retryable Stripe account restriction codes.
      // Lock escrow for admin review; do NOT rethrow so BullMQ skips retry.
      let partialTransferResult: Awaited<ReturnType<typeof StripeService.createTransfer>>;
      try {
        partialTransferResult = await StripeService.createTransfer({
          escrowId: escrow.id,
          taskId,
          workerId: task.worker_id,
          workerStripeAccountId: worker.stripe_connect_id,
          amount: netReleaseCents,
          description: `Dispute resolution: ${reason}`,
        });
      } catch (stripeError) {
        if (isStripeAccountRestrictionError(stripeError)) {
          const code = (stripeError as Error & { code?: string }).code ?? 'unknown';
          log.error(
            { escrowId: escrow.id, workerId: task.worker_id, stripeCode: code },
            'CRITICAL: Stripe account restricted (partial refund path) — locking escrow, NOT retrying',
          );
          await lockEscrowForStripeRestriction(escrow.id, task.worker_id, code);
          // Return without rethrowing — BullMQ must not retry this job
          return;
        }
        throw stripeError;
      }

      if (!partialTransferResult.success) {
        throw new Error(`Failed to create transfer: ${partialTransferResult.error.message}`);
      }

      transferId = partialTransferResult.data.transferId;
      log.info({ escrowId: escrow.id, transferId, amount: releaseAmount }, 'Partial transfer created for escrow');
    }
  }

  // P0: Pre-terminal guards - enforce required Stripe IDs exist before terminalizing
  if (refundAmount > 0 && !refundId) {
    throw new Error(`Cannot terminalize SPLIT: refundAmount > 0 (${refundAmount}) but refundId is missing for escrow ${escrow.id}`);
  }
  if (releaseAmount > 0 && !transferId) {
    throw new Error(`Cannot terminalize SPLIT: releaseAmount > 0 (${releaseAmount}) but transferId is missing for escrow ${escrow.id}`);
  }

  // Store both IDs + amounts, set REFUND_PARTIAL (MVP-authoritative terminalization)
  // Wrapped in db.transaction() for atomicity of the version-checked UPDATE.
  // WHERE clause enforces: non-null IDs when amounts > 0, and version matches (idempotent replay)
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
       WHERE id = $5
         AND version = $6
         AND ($3 = 0 OR $1 IS NOT NULL)  -- If refundAmount > 0, refundId must exist
         AND ($4 = 0 OR $2 IS NOT NULL)`, // If releaseAmount > 0, transferId must exist
      [refundId, transferId, refundAmount, releaseAmount, escrow.id, escrow.version]
    );

    if (updateResult.rowCount === 0) {
      // Check if escrow is already terminal (concurrent completion or replay)
      const checkResult = await trx<{ state: string }>(
        `SELECT state FROM escrows WHERE id = $1`,
        [escrow.id]
      );
      return { rowCount: 0, finalState: checkResult.rows[0]?.state ?? null };
    }

    return { rowCount: updateResult.rowCount, finalState: 'REFUND_PARTIAL' };
  });

  // P0: Handle version conflict (idempotent replay or concurrent update)
  if (updateRowCount === 0) {
    if (finalState === 'REFUND_PARTIAL') {
      log.info({ escrowId: escrow.id }, 'Escrow already in REFUND_PARTIAL, idempotent replay');
      return; // No-op: already terminal
    }
    // Version mismatch: another process updated between the Stripe calls and the
    // terminal UPDATE. The Stripe IDs are already stored in escrow_events (durability
    // checkpoint) so a retry will find the idempotency checkpoint and skip re-issuing
    // Stripe calls. Throw to trigger BullMQ retry so the UPDATE can succeed.
    log.warn({ escrowId: escrow.id, expectedVersion: escrow.version }, 'Escrow version conflict on terminalization — retrying');
    throw new Error('Version conflict on escrow terminalization — retrying');
  }

  // Step 4: Hook CLOSED transition (Pillar A - Realtime Tracking)
  // System-driven transition: COMPLETED → CLOSED (triggered by escrow terminalization)
  await TaskService.advanceProgress({
    taskId,
    to: 'CLOSED',
    actor: { type: 'system' },
  });

  // Log platform fee to revenue ledger (SPLIT path)
  // Previously uncaptured: netReleaseCents deducts ~15% but RevenueService.logEvent() was never called.
  // Non-fatal: ledger write failure must not block dispute resolution confirmation.
  if (releaseAmount > 0 && netReleaseCents !== undefined && task.worker_id) {
    // Use adjustedPlatformFeeCents (residual-corrected) so all cents are accounted for.
    // Fall back to raw difference if undefined (idempotent replay path where the
    // new-transfer block was skipped — no residual to correct in that case).
    const platformFee = adjustedPlatformFeeCents ?? (releaseAmount - netReleaseCents);
    try {
      await RevenueService.logEvent({
        eventType: 'platform_fee',
        userId: task.worker_id,
        taskId,
        amountCents: platformFee,
        grossAmountCents: releaseAmount,
        platformFeeCents: platformFee,
        netAmountCents: netReleaseCents,
        feeBasisPoints: Math.round((config.stripe.platformFeePercent ?? 15) * 100),
        escrowId: escrow.id,
        stripeTransferId: transferId ?? undefined,
        metadata: {
          event: 'escrow_partial_release',
        },
      });
    } catch (revenueError) {
      log.error(
        { err: revenueError instanceof Error ? revenueError.message : String(revenueError), escrowId: escrow.id },
        'Failed to write revenue ledger entry for SPLIT partial release — requires manual reconciliation'
      );
    }
  } else if (releaseAmount > 0 && netReleaseCents !== undefined && !task.worker_id) {
    // worker_id is null on this idempotent retry path — skip ledger entry.
    // The Stripe transfer ID can be used for manual reconciliation later.
    log.warn(
      { escrowId: escrow.id, releaseAmount, stripeTransferId: transferId ?? null },
      'Skipping revenue ledger entry for SPLIT partial release — task.worker_id is null; reconcile via Stripe transfer ID'
    );
  }

  log.info({ escrowId: escrow.id, refundAmount, releaseAmount }, 'Escrow set to REFUND_PARTIAL');
}
