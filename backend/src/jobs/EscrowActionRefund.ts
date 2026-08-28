import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { workerLogger } from '../logger.js';
import { StripeService } from '../services/StripeService.js';
import type { EscrowActionInput } from './EscrowActionTypes.js';

const log = workerLogger.child({ worker: 'escrow-action' });

async function freshRefundExists(escrowId: string): Promise<boolean> {
  try {
    const result = await db.transaction((query: QueryFn) => query<{ stripe_refund_id: string | null }>(
      'SELECT stripe_refund_id FROM escrows WHERE id = $1 FOR UPDATE NOWAIT',
      [escrowId],
    ));
    const refundId = result.rows[0]?.stripe_refund_id;
    if (!refundId) return false;
    log.info(
      { escrowId, refundId },
      'Fresh DB re-read (NOWAIT): refund already issued on a prior attempt (concurrent retry) — skipping Stripe call',
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('could not obtain lock')) {
      throw new Error('LOCK_CONTENTION: Another worker is processing this escrow refund — will retry');
    }
    throw error;
  }
}

function metadataValue(metadata: string, key: string): string | null {
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return typeof parsed[key] === 'string' ? parsed[key] : null;
  } catch {
    return null;
  }
}

async function originalTransferId(escrowId: string): Promise<string | null> {
  const result = await db.query<{ metadata: string }>(
    `SELECT metadata FROM escrow_events
      WHERE escrow_id = $1 AND actor_type = 'system'
        AND metadata::jsonb->>'event_type' = 'dispute_locked_after_release'
        AND metadata::jsonb->>'original_transfer_id' IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [escrowId],
  );
  return result.rows[0] ? metadataValue(result.rows[0].metadata, 'original_transfer_id') : null;
}

async function reversalExists(escrowId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM escrow_events
      WHERE escrow_id = $1 AND metadata::jsonb->>'event_type' = 'transfer_reversed'
      LIMIT 1`,
    [escrowId],
  );
  return result.rows.length > 0;
}

async function ensurePriorTransferReversed(escrowId: string): Promise<void> {
  const transferId = await originalTransferId(escrowId);
  if (!transferId) return;
  if (await reversalExists(escrowId)) {
    log.info(
      { escrowId, originalTransferId: transferId },
      'handleRefundRequest: transfer_reversed checkpoint found — skipping reversal call (idempotent retry)',
    );
    return;
  }
  const result = await StripeService.createTransferReversal(transferId, escrowId);
  if (!result.success) throw new Error(`Transfer reversal failed: ${result.error.message}`);
  await db.query(
    `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
     VALUES ($1, 'LOCKED_DISPUTE', 'LOCKED_DISPUTE', NULL, 'system', $2)`,
    [escrowId, JSON.stringify({
      event_type: 'transfer_reversed',
      original_transfer_id: transferId,
      reversal_id: result.data.reversalId,
    })],
  );
  log.info({
    escrowId,
    originalTransferId: transferId,
    reversalId: result.data.reversalId,
  }, 'Transfer reversal completed and checkpoint written — proceeding with charge refund');
}

async function storeRefund(query: QueryFn, input: {
  escrowId: string;
  refundId: string;
}): Promise<void> {
  const result = await query<{ id: string; version: number; stripe_refund_id: string | null }>(
    `SELECT id, version, stripe_refund_id FROM escrows WHERE id = $1 FOR UPDATE NOWAIT`,
    [input.escrowId],
  );
  const locked = result.rows[0];
  if (!locked) throw new Error(`Escrow ${input.escrowId} disappeared during T2 refund lock — retry`);
  if (locked.stripe_refund_id) {
    log.info({
      escrowId: input.escrowId,
      existingRefundId: locked.stripe_refund_id,
      ourRefundId: input.refundId,
    }, 'T2 re-read: refund_id already set by concurrent worker — skipping UPDATE (idempotent)');
    return;
  }
  const updated = await query<{ id: string }>(
    `UPDATE escrows
        SET stripe_refund_id = $1, version = version + 1
      WHERE id = $2 AND version = $3
      RETURNING id`,
    [input.refundId, input.escrowId, locked.version],
  );
  if (!updated.rows[0]) {
    throw new Error(`Concurrent version conflict storing refund ${input.refundId} for escrow ${input.escrowId} — retry`);
  }
}

export async function handleRefundRequest(action: EscrowActionInput): Promise<void> {
  if (action.escrow.stripe_refund_id) {
    log.info({
      escrowId: action.escrow.id,
      refundId: action.escrow.stripe_refund_id,
    }, 'Escrow already has refund_id, idempotent replay');
    return;
  }
  if (!action.escrow.stripe_payment_intent_id) {
    throw new Error(`Escrow ${action.escrow.id} has no stripe_payment_intent_id`);
  }
  if (await freshRefundExists(action.escrow.id)) return;
  await ensurePriorTransferReversed(action.escrow.id);
  const amount = action.refundAmount === undefined
    ? action.escrow.amount
    : Math.min(action.refundAmount, action.escrow.amount);
  const result = await StripeService.createRefund({
    paymentIntentId: action.escrow.stripe_payment_intent_id,
    escrowId: action.escrow.id,
    amount,
    reason: 'requested_by_customer',
    idempotencyKeySuffix: 'wkr_refund',
  });
  if (!result.success) throw new Error(`Failed to create refund: ${result.error.message}`);
  await db.transaction((query) => storeRefund(query, {
    escrowId: action.escrow.id,
    refundId: result.data.refundId,
  }));
  log.info({ escrowId: action.escrow.id, refundId: result.data.refundId }, 'Refund created for escrow');
}
