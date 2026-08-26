import type { QueryFn } from '../db.js';

export const EXACT_SUCCEEDED_REFUND_EVENT = 'exact_succeeded_refund_witness_v1';

export interface ExactSucceededRefundWitness {
  escrowId: string;
  taskId: string;
  canonicalState: string;
  paymentIntentId: string;
  refundId: string;
  chargeId: string;
  amountCents: number;
  currency: 'usd';
  status: 'succeeded';
}

interface RefundProviderEvidence {
  refundId: string;
  amount: number;
  status: string;
  currency: string;
  paymentIntentId: string | null;
  chargeId: string | null;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
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

function exactMetadata(actualValue: unknown, expected: Record<string, unknown>): boolean {
  const actual = metadataRecord(actualValue);
  if (!actual) return false;
  const keys = Object.keys(expected);
  return Object.keys(actual).length === keys.length
    && keys.every((key) => actual[key] === expected[key]);
}

function witnessMetadata(witness: ExactSucceededRefundWitness): Record<string, unknown> {
  return {
    event_type: EXACT_SUCCEEDED_REFUND_EVENT,
    escrow_id: witness.escrowId,
    task_id: witness.taskId,
    canonical_state: witness.canonicalState,
    payment_intent_id: witness.paymentIntentId,
    refund_id: witness.refundId,
    charge_id: witness.chargeId,
    amount_cents: witness.amountCents,
    currency: witness.currency,
    status: witness.status,
  };
}

export function exactSucceededRefundWitness(input: {
  escrowId: string;
  taskId: string;
  canonicalState: string;
  paymentIntentId: string;
  expectedAmountCents: number;
  provider: RefundProviderEvidence;
}): ExactSucceededRefundWitness | null {
  if (
    input.provider.status !== 'succeeded'
    || input.provider.amount !== input.expectedAmountCents
    || input.provider.currency !== 'usd'
    || input.provider.paymentIntentId !== input.paymentIntentId
    || !input.provider.chargeId
  ) return null;
  return {
    escrowId: input.escrowId,
    taskId: input.taskId,
    canonicalState: input.canonicalState,
    paymentIntentId: input.paymentIntentId,
    refundId: input.provider.refundId,
    chargeId: input.provider.chargeId,
    amountCents: input.expectedAmountCents,
    currency: 'usd',
    status: 'succeeded',
  };
}

export function exactSucceededRefundWitnessKey(
  witness: Pick<ExactSucceededRefundWitness, 'escrowId' | 'refundId'>,
): string {
  return `exact-succeeded-refund-v1:${witness.escrowId}:${witness.refundId}`;
}

export async function persistExactSucceededRefundWitness(
  query: QueryFn,
  witness: ExactSucceededRefundWitness,
): Promise<void> {
  const metadata = witnessMetadata(witness);
  const idempotencyKey = exactSucceededRefundWitnessKey(witness);
  const result = await query<{ metadata: unknown }>(
    `WITH attempted AS (
       INSERT INTO escrow_events
         (escrow_id, from_state, to_state, actor_id, actor_type, metadata, idempotency_key)
       VALUES ($1, $2, $2, NULL, 'system', $3::jsonb, $4)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata
     ), existing AS (
       SELECT metadata FROM escrow_events
        WHERE escrow_id=$1 AND from_state=$2 AND to_state=$2
          AND actor_id IS NULL AND actor_type='system' AND idempotency_key=$4
     )
     SELECT metadata FROM attempted
     UNION ALL
     SELECT metadata FROM existing WHERE NOT EXISTS (SELECT 1 FROM attempted)`,
    [witness.escrowId, witness.canonicalState, JSON.stringify(metadata), idempotencyKey],
  );
  if (result.rows.length !== 1 || !exactMetadata(result.rows[0]?.metadata, metadata)) {
    throw new Error(`Immutable succeeded-refund witness conflicts for escrow ${witness.escrowId}`);
  }
}
