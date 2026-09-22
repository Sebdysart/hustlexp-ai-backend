import { db } from '../db.js';
import { loadEscrowPaymentBinding } from './EscrowPaymentBindingService.js';

export class ManualRefundRequiredError extends Error {
  readonly code = 'MANUAL_REFUND_REQUIRED';
  constructor() { super('Automatic refunds are unavailable. Operations must verify and complete the refund manually.'); }
}

/** Persist the unresolved obligation without pretending a provider refund succeeded. */
export async function recordManualRefundRequirement(escrowId: string, action: string, reason?: string): Promise<void> {
  await db.transaction(async (query) => {
    const locked = await query<{ id: string; task_id: string; state: string }>(
      'SELECT id, task_id, state FROM escrows WHERE id = $1 FOR UPDATE', [escrowId],
    );
    const escrow = locked.rows[0];
    if (!escrow) throw new Error('ESCROW_NOT_FOUND');
    // A delayed retry must not replace an authoritative terminal refund outcome.
    if (escrow.state === 'REFUNDED' || escrow.state === 'REFUND_PARTIAL') return;
    const binding = await loadEscrowPaymentBinding(query, escrowId);
    await query(
      `UPDATE tasks SET refund_state = 'BLOCKED', refund_blocker = 'MANUAL_REFUND_REQUIRED',
       refund_requested_at = COALESCE(refund_requested_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [escrow.task_id],
    );
    await query(
      `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_type, metadata, idempotency_key)
       VALUES ($1, $2, $2, 'system', $3, $4)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [escrowId, escrow.state, JSON.stringify({ event_type: 'manual_refund_required', action,
        provider: binding?.provider ?? 'unresolved', reason: reason ?? null }), `manual-refund:${action}:${escrowId}`],
    );
  });
}

export async function confirmEscrowRefund(input: {
  escrowId: string; paymentIntentId: string; amount: number;
  idempotencyKeySuffix: string; checkpointType: string; existingRefundId?: string | null;
}): Promise<string> {
  await recordManualRefundRequirement(input.escrowId, input.checkpointType);
  throw new ManualRefundRequiredError();
}
