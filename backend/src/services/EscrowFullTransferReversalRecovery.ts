import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import type {
  ExactFullTransferReversalBinding,
  TransferReversalEvidence,
} from './EscrowRefundService.js';

export const FULL_TRANSFER_REVERSAL_RECONCILIATION_EVENT =
  'full_transfer_reversal_reconciliation_required_v1';

interface ObservedReversalBindingRow {
  id: string;
  task_id: string;
  state: string;
  version: number;
  amount: number;
  platform_fee_cents: number | null;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  stripe_transfer_id: string | null;
  provider_transfer_status: string | null;
  worker_id: string | null;
  payout_recipient_user_id: string | null;
  task_price: number | null;
}

function expectedMetadata(
  expected: ExactFullTransferReversalBinding,
  observed: ObservedReversalBindingRow,
  evidence: TransferReversalEvidence,
): Record<string, unknown> {
  const witness = evidence.transferWitness;
  return {
    event_type: FULL_TRANSFER_REVERSAL_RECONCILIATION_EVENT,
    expected_binding: {
      escrow_id: expected.escrowId,
      canonical_state: expected.canonicalState,
      task_id: expected.taskId,
      worker_id: expected.workerId,
      payout_recipient_user_id: expected.payoutRecipientUserId,
      destination_account_id: expected.destinationAccountId,
      stripe_payment_intent_id: expected.stripePaymentIntentId,
      stripe_transfer_id: expected.transferId,
      escrow_amount_cents: expected.escrowAmountCents,
      platform_fee_cents: expected.platformFeeCents,
      insurance_contribution_cents: expected.insuranceContributionCents,
      transfer_amount_cents: expected.transferAmountCents,
    },
    observed_binding: {
      escrow_id: observed.id,
      task_id: observed.task_id,
      canonical_state: observed.state,
      version: observed.version,
      escrow_amount_cents: observed.amount,
      platform_fee_cents: observed.platform_fee_cents,
      stripe_payment_intent_id: observed.stripe_payment_intent_id,
      stripe_refund_id: observed.stripe_refund_id,
      stripe_transfer_id: observed.stripe_transfer_id,
      provider_transfer_status: observed.provider_transfer_status,
      worker_id: observed.worker_id,
      payout_recipient_user_id:
        observed.payout_recipient_user_id ?? observed.worker_id,
      task_price_cents: observed.task_price,
    },
    provider_reversal: {
      reversal_id: evidence.reversalId,
      reversal_amount_cents: evidence.reversalAmountCents,
      current_transfer_witness: {
        provider: witness.provider,
        transfer_id: witness.transferId,
        amount_cents: witness.amountCents,
        currency: witness.currency,
        destination_account_id: witness.destinationAccountId,
        reversed: witness.reversed,
        amount_reversed_cents: witness.amountReversedCents,
        escrow_id: witness.escrowId,
        task_id: witness.taskId,
        payout_recipient_user_id: witness.payoutRecipientUserId,
      },
    },
    recovery_reason: 'provider_reversal_succeeded_before_canonical_witness_persistence',
  };
}

async function persistWithObservedBinding(
  query: QueryFn,
  expected: ExactFullTransferReversalBinding,
  evidence: TransferReversalEvidence,
): Promise<void> {
  const observedResult = await query<ObservedReversalBindingRow>(
    `SELECT e.id,e.task_id,e.state,e.version,e.amount,e.platform_fee_cents,
            e.stripe_payment_intent_id,e.stripe_refund_id,e.stripe_transfer_id,
            e.provider_transfer_status,t.worker_id,t.payout_recipient_user_id,
            t.price AS task_price
       FROM escrows e
       LEFT JOIN tasks t ON t.id=e.task_id
      WHERE e.id=$1
      FOR UPDATE OF e`,
    [expected.escrowId],
  );
  const observed = observedResult.rows[0];
  if (!observed) {
    throw new Error(
      `Escrow ${expected.escrowId} disappeared after provider transfer reversal; recovery witness cannot be persisted`,
    );
  }
  const metadata = expectedMetadata(expected, observed, evidence);
  const reversalIdentity = evidence.reversalId ?? 'already-reversed';
  const idempotencyKey = [
    'full-transfer-reversal-reconciliation-required-v1',
    expected.escrowId,
    expected.transferId,
    reversalIdentity,
    observed.state,
    observed.version,
  ].join(':');
  const exact = await query<{ id:string }>(
    `WITH attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,$2,$2,NULL,'system',$3::jsonb,$4)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id
     )
     SELECT id FROM attempted
     UNION ALL
     SELECT id FROM escrow_events
      WHERE escrow_id=$1 AND from_state=$2 AND to_state=$2
        AND actor_id IS NULL AND actor_type='system'
        AND metadata::jsonb=$3::jsonb AND idempotency_key=$4
     LIMIT 1`,
    [expected.escrowId, observed.state, JSON.stringify(metadata), idempotencyKey],
  );
  if (exact.rowCount !== 1) {
    throw new Error(
      `Full-transfer reversal recovery witness conflicts for escrow ${expected.escrowId}`,
    );
  }
}

export async function persistFullTransferReversalReconciliationRequired(
  expected: ExactFullTransferReversalBinding,
  evidence: TransferReversalEvidence,
): Promise<void> {
  await db.transaction((query) => persistWithObservedBinding(query, expected, evidence));
}
