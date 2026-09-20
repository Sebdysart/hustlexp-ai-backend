import { db } from '../db.js';
import { StripeService } from './StripeService.js';

type RefundEvidence = { refundId: string; amount: number; status: string };

function refundIdFromMetadata(value: unknown): string | null {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || !('stripe_refund_id' in parsed)) return null;
  return typeof parsed.stripe_refund_id === 'string' ? parsed.stripe_refund_id : null;
}

function assertRefund(input: {
  evidence: RefundEvidence;
  paymentIntentId: string;
  escrowId: string;
  amount: number;
  binding?: { paymentIntentId: string | null; escrowId: string | null };
}): string {
  const { evidence } = input;
  if (!evidence.refundId || evidence.amount !== input.amount
    || (input.binding && (input.binding.paymentIntentId !== input.paymentIntentId
      || input.binding.escrowId !== input.escrowId))) {
    throw new Error('REFUND_BINDING_MISMATCH: Provider refund does not match the escrow payment and amount');
  }
  if (evidence.status !== 'succeeded') {
    throw new Error(`REFUND_NOT_SUCCEEDED: Provider refund status is ${evidence.status || 'unknown'}`);
  }
  return evidence.refundId;
}

export async function confirmEscrowRefund(input: {
  escrowId: string;
  paymentIntentId: string;
  amount: number;
  idempotencyKeySuffix: string;
  checkpointType: string;
  existingRefundId?: string | null;
}): Promise<string> {
  const checkpointKey = `refund:${input.checkpointType}:${input.escrowId}`;
  const checkpoint = await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM escrow_events WHERE idempotency_key = $1 LIMIT 1`,
    [checkpointKey],
  );
  const checkpointId = refundIdFromMetadata(checkpoint.rows[0]?.metadata);
  if (checkpoint.rows[0] && !checkpointId) {
    throw new Error('REFUND_CHECKPOINT_INVALID: Provider refund identity is missing');
  }
  const priorId = input.existingRefundId ?? checkpointId;
  if (priorId) {
    const prior = await StripeService.getEscrowRefund(priorId);
    if (!prior.success) throw new Error(`REFUND_VERIFICATION_UNAVAILABLE: ${prior.error.code}`);
    return assertRefund({
      evidence: prior.data,
      paymentIntentId: input.paymentIntentId,
      escrowId: input.escrowId,
      amount: input.amount,
      binding: prior.data,
    });
  }
  const result = await StripeService.createRefund({
    paymentIntentId: input.paymentIntentId,
    escrowId: input.escrowId,
    amount: input.amount,
    reason: 'requested_by_customer',
    idempotencyKeySuffix: input.idempotencyKeySuffix,
  });
  if (!result.success) throw new Error(`REFUND_PROVIDER_FAILED: ${result.error.code}`);
  if (!result.data.refundId || result.data.amount !== input.amount) {
    throw new Error('REFUND_BINDING_MISMATCH: Provider refund response has incorrect amount or identity');
  }
  // The provider response is checkpointed before any local terminal state or transfer.
  await db.query(
    `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata, idempotency_key)
     VALUES ($1, 'LOCKED_DISPUTE', 'LOCKED_DISPUTE', NULL, 'system', $2, $3)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [input.escrowId, JSON.stringify({ event_type: input.checkpointType, stripe_refund_id: result.data.refundId }), checkpointKey],
  );
  const saved = await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM escrow_events WHERE idempotency_key = $1`, [checkpointKey],
  );
  const savedId = refundIdFromMetadata(saved.rows[0]?.metadata);
  if (savedId !== result.data.refundId) {
    throw new Error('REFUND_CHECKPOINT_CONFLICT: Concurrent provider refund identity differs');
  }
  return assertRefund({
    evidence: result.data,
    paymentIntentId: input.paymentIntentId,
    escrowId: input.escrowId,
    amount: input.amount,
  });
}
