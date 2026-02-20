/**
 * Escrow Action Worker v1.0.0
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
 * NOTE: Does NOT set RELEASED/REFUNDED states (PaymentWorker does via Stripe events)
 * 
 * @see Dispute Resolution MVP Implementation Spec §4
 */

import { db } from '../db';
import { StripeService } from '../services/StripeService';
import { TaskService } from '../services/TaskService';
import { workerLogger } from '../logger';
import type { Job } from 'bullmq';

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

// ============================================================================
// ESCROW ACTION WORKER
// ============================================================================

export async function processEscrowActionJob(job: Job<EscrowActionJobData>): Promise<void> {
  const { payload } = job.data;
  const { escrow_id, task_id, dispute_id, reason, refund_amount, release_amount } = payload;
  const eventType = job.name;

  try {
    // Lock escrow FOR UPDATE
    const escrowResult = await db.query<{
      id: string;
      state: string;
      version: number;
      amount: number;
      stripe_payment_intent_id: string | null;
      stripe_transfer_id: string | null;
      stripe_refund_id: string | null;
    }>(
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

    // Process based on event type
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
    throw error; // Re-throw for BullMQ retry logic
  }
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle RELEASE: Create Stripe transfer, store transfer_id
 */
async function handleReleaseRequest(
  escrow: { id: string; version: number; stripe_transfer_id: string | null },
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

  // Get worker's Stripe Connect ID
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

  // Get escrow amount
  const escrowAmountResult = await db.query<{ amount: number }>(
    'SELECT amount FROM escrows WHERE id = $1',
    [escrow.id]
  );

  if (escrowAmountResult.rows.length === 0) {
    throw new Error(`Escrow ${escrow.id} not found`);
  }

  const escrowAmount = escrowAmountResult.rows[0].amount;

  // Create Stripe transfer
  const transferResult = await StripeService.createTransfer({
    escrowId: escrow.id,
    taskId,
    workerId: task.worker_id,
    workerStripeAccountId: worker.stripe_connect_id,
    amount: escrowAmount,
    description: `Dispute resolution: ${reason}`,
  });

  if (!transferResult.success) {
    throw new Error(`Failed to create transfer: ${transferResult.error.message}`);
  }

  const transferId = transferResult.data.transferId;

  // Store transfer_id on escrow (do NOT set state - PaymentWorker does via Stripe event)
  await db.query(
    `UPDATE escrows
     SET stripe_transfer_id = $1,
         version = version + 1
     WHERE id = $2 AND version = $3`,
    [transferId, escrow.id, escrow.version]
  );

  log.info({ escrowId: escrow.id, transferId }, 'Transfer created for escrow');
}

/**
 * Handle REFUND: Create Stripe refund, store refund_id
 */
async function handleRefundRequest(
  escrow: { id: string; version: number; stripe_payment_intent_id: string | null; stripe_refund_id: string | null },
  disputeId: string | undefined,
  reason: string
): Promise<void> {
  // Idempotency: If refund_id already exists, skip
  if (escrow.stripe_refund_id) {
    log.info({ escrowId: escrow.id, refundId: escrow.stripe_refund_id }, 'Escrow already has refund_id, idempotent replay');
    return;
  }

  if (!escrow.stripe_payment_intent_id) {
    throw new Error(`Escrow ${escrow.id} has no stripe_payment_intent_id`);
  }

  // Get escrow amount
  const escrowAmountResult = await db.query<{ amount: number }>(
    'SELECT amount FROM escrows WHERE id = $1',
    [escrow.id]
  );

  if (escrowAmountResult.rows.length === 0) {
    throw new Error(`Escrow ${escrow.id} not found`);
  }

  const escrowAmount = escrowAmountResult.rows[0].amount;

  // Create Stripe refund
  const refundResult = await StripeService.createRefund({
    paymentIntentId: escrow.stripe_payment_intent_id,
    escrowId: escrow.id,
    amount: escrowAmount, // Full refund
    reason: 'requested_by_customer',
  });

  if (!refundResult.success) {
    throw new Error(`Failed to create refund: ${refundResult.error.message}`);
  }

  const refundId = refundResult.data.refundId;

  // Store refund_id on escrow (do NOT set state - PaymentWorker does via Stripe event)
  await db.query(
    `UPDATE escrows
     SET stripe_refund_id = $1,
         version = version + 1
     WHERE id = $2 AND version = $3`,
    [refundId, escrow.id, escrow.version]
  );

  log.info({ escrowId: escrow.id, refundId }, 'Refund created for escrow');
}

/**
 * Handle SPLIT: Create refund + transfer, store both IDs, set REFUND_PARTIAL (MVP-authoritative)
 */
async function handlePartialRefundRequest(
  escrow: { id: string; version: number; amount: number; stripe_payment_intent_id: string | null; stripe_transfer_id: string | null; stripe_refund_id: string | null },
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

  if (refundAmount + releaseAmount !== escrow.amount) {
    throw new Error(`SPLIT amounts (${refundAmount} + ${releaseAmount} = ${refundAmount + releaseAmount}) must sum to escrow amount (${escrow.amount})`);
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

  // Create refund if refund_amount > 0
  let refundId: string | null = escrow.stripe_refund_id;
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
    }
  }

  // Create transfer if release_amount > 0
  let transferId: string | null = escrow.stripe_transfer_id;
  if (releaseAmount > 0) {
    if (!transferId) {
      if (!task.worker_id) {
        throw new Error(`Task ${taskId} has no worker_id`);
      }

      // Get worker's Stripe Connect ID
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

      // Failure injection for testing (Evil Test A)
      if (process.env.HX_FAIL_STRIPE_TRANSFER === '1') {
        throw new Error('Transfer creation failed (injected failure for testing)');
      }

      const transferResult = await StripeService.createTransfer({
        escrowId: escrow.id,
        taskId,
        workerId: task.worker_id,
        workerStripeAccountId: worker.stripe_connect_id,
        amount: releaseAmount,
        description: `Dispute resolution: ${reason}`,
      });

      if (!transferResult.success) {
        throw new Error(`Failed to create transfer: ${transferResult.error.message}`);
      }

      transferId = transferResult.data.transferId;
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
  // WHERE clause enforces: non-null IDs when amounts > 0, and version matches (idempotent replay)
  const updateResult = await db.query(
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

  // P0: Handle version conflict (idempotent replay or concurrent update)
  if (updateResult.rowCount === 0) {
    // Check if escrow is already terminal (concurrent completion or replay)
    const checkResult = await db.query<{ state: string }>(
      `SELECT state FROM escrows WHERE id = $1`,
      [escrow.id]
    );
    if (checkResult.rows.length > 0 && checkResult.rows[0].state === 'REFUND_PARTIAL') {
      log.info({ escrowId: escrow.id }, 'Escrow already in REFUND_PARTIAL, idempotent replay');
      return; // No-op: already terminal
    }
    // Version mismatch: another process updated, treat as no-op
    log.warn({ escrowId: escrow.id, expectedVersion: escrow.version }, 'Escrow version mismatch, treating as no-op');
    return;
  }

  // Step 4: Hook CLOSED transition (Pillar A - Realtime Tracking)
  // System-driven transition: COMPLETED → CLOSED (triggered by escrow terminalization)
  await TaskService.advanceProgress({
    taskId,
    to: 'CLOSED',
    actor: { type: 'system' },
  });

  log.info({ escrowId: escrow.id, refundAmount, releaseAmount }, 'Escrow set to REFUND_PARTIAL');
}
