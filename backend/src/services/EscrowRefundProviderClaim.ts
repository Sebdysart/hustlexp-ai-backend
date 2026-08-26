import type { QueryFn } from '../db.js';
import type { RefundContext, RefundProviderClaim } from './EscrowRefundTypes.js';

export const REFUND_PROVIDER_CLAIM_EVENT = 'refund_provider_create_claim_v1';
export const REFUND_PROVIDER_FAILED_EVENT = 'refund_provider_create_failed_v1';
export const REFUND_PROVIDER_CLAIM_RESOLVED_EVENT = 'refund_provider_claim_resolved_v1';
export const REFUND_PROVIDER_REPLAY_HOURS = 20;

export function refundProviderClaimKey(escrowId: string, version: number): string {
  return `refund-provider-create-claim-v1:${escrowId}:${version}`;
}

export function refundProviderIdempotencyKey(escrowId: string, version: number): string {
  return `hx-refund-claim-v1:${escrowId}:${version}`;
}

export function refundProviderClaimResolvedKey(
  escrowId: string,
  version: number,
  refundId: string,
): string {
  return `refund-provider-claim-resolved-v1:${escrowId}:${version}:${refundId}`;
}

function safeProviderCode(code: string): string {
  const normalized = code.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  return normalized || 'UNKNOWN';
}

export function refundProviderFailureKey(
  escrowId: string,
  version: number,
  providerCode: string,
): string {
  return `refund-provider-create-failed-v1:${escrowId}:${version}:${safeProviderCode(providerCode)}`;
}

interface ClaimRow {
  claim_idempotency_key: string;
  provider_idempotency_key: string;
  provider_replay_deadline: Date;
  exact: boolean;
}

/**
 * Create or recover the immutable provider-call claim while T1 still owns the
 * canonical escrow and task row locks. The replay deadline is derived only
 * from the database-created event timestamp; application clocks never extend
 * it on retry.
 */
export async function prepareRefundProviderClaim(
  query: QueryFn,
  input: {
    escrowId: string;
    taskId: string;
    canonicalState: string;
    canonicalVersion: number;
    taskVersion: number;
    taskState: string;
    workerId: string | null;
    paymentIntentId: string;
    existingRefundId: string | null;
    amountCents: number;
  },
): Promise<RefundProviderClaim> {
  const claimIdempotencyKey = refundProviderClaimKey(input.escrowId, input.canonicalVersion);
  const providerIdempotencyKey = refundProviderIdempotencyKey(
    input.escrowId,
    input.canonicalVersion,
  );
  const result = await query<ClaimRow>(
    `WITH clock AS (
       SELECT transaction_timestamp() AS claimed_at
     ), attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key,created_at)
       SELECT
         $1,$3,$3,NULL,'system',
         jsonb_build_object(
           'event_type','refund_provider_create_claim_v1',
           'claim_idempotency_key',$11,
           'provider','stripe',
           'escrow_id',$1::text,
           'task_id',$2::text,
           'canonical_state',$3,
           'canonical_version',$4,
           'task_version',$5,
           'task_state',$6,
           'worker_id',$7::text,
           'payment_intent_id',$8,
           'existing_refund_id',$9,
           'refund_amount_cents',$10,
           'currency','usd',
           'provider_idempotency_key',$12,
           'provider_replay_deadline',to_jsonb(clock.claimed_at + interval '20 hours')
         ),
         $11,
         clock.claimed_at
         FROM clock
        WHERE NOT EXISTS (
          SELECT 1 FROM escrow_events prior
           WHERE prior.escrow_id=$1
             AND prior.idempotency_key LIKE
               'refund-provider-create-claim-v1:' || $1::text || ':%'
             AND prior.metadata->>'event_type'='refund_provider_create_claim_v1'
             AND prior.metadata->>'escrow_id'=$1::text
             AND prior.idempotency_key<>$11
        )
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING escrow_id,from_state,to_state,actor_id,actor_type,metadata,
                 idempotency_key,created_at
     ), claim AS (
       SELECT attempted.* FROM attempted
       UNION ALL
       SELECT event.escrow_id,event.from_state,event.to_state,event.actor_id,
              event.actor_type,event.metadata,event.idempotency_key,event.created_at
         FROM escrow_events event
        WHERE event.escrow_id=$1 AND event.from_state=$3 AND event.to_state=$3
          AND event.actor_id IS NULL AND event.actor_type='system'
          AND event.idempotency_key=$11
          AND NOT EXISTS (SELECT 1 FROM attempted)
     )
     SELECT
       $11::text AS claim_idempotency_key,
       $12::text AS provider_idempotency_key,
       claim.created_at + interval '20 hours' AS provider_replay_deadline,
       (
         jsonb_object_length(claim.metadata)=16
         AND claim.metadata->>'event_type'='refund_provider_create_claim_v1'
         AND claim.metadata->>'claim_idempotency_key'=$11
         AND claim.metadata->>'provider'='stripe'
         AND claim.metadata->>'escrow_id'=$1::text
         AND claim.metadata->>'task_id'=$2::text
         AND claim.metadata->>'canonical_state'=$3
         AND claim.metadata->>'canonical_version'=$4::text
         AND claim.metadata->>'task_version'=$5::text
         AND claim.metadata->>'task_state'=$6
         AND claim.metadata->>'worker_id' IS NOT DISTINCT FROM $7::text
         AND claim.metadata->>'payment_intent_id'=$8
         AND claim.metadata->>'existing_refund_id' IS NOT DISTINCT FROM $9
         AND claim.metadata->>'refund_amount_cents'=$10::text
         AND claim.metadata->>'currency'='usd'
         AND claim.metadata->>'provider_idempotency_key'=$12
         AND claim.metadata->>'provider_replay_deadline'
               = (to_jsonb(claim.created_at + interval '20 hours') #>> '{}')
       ) AS exact
       FROM claim`,
    [
      input.escrowId,
      input.taskId,
      input.canonicalState,
      input.canonicalVersion,
      input.taskVersion,
      input.taskState,
      input.workerId,
      input.paymentIntentId,
      input.existingRefundId,
      input.amountCents,
      claimIdempotencyKey,
      providerIdempotencyKey,
    ],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row?.exact !== true
    || row.claim_idempotency_key !== claimIdempotencyKey
    || row.provider_idempotency_key !== providerIdempotencyKey
    || Number.isNaN(new Date(row.provider_replay_deadline).getTime())
  ) {
    throw Object.assign(
      new Error(`Immutable refund provider claim conflicts for escrow ${input.escrowId}`),
      { refundCode: 'REFUND_PROVIDER_CLAIM_CONFLICT' },
    );
  }
  return {
    claimIdempotencyKey,
    providerIdempotencyKey,
    providerReplayDeadline: new Date(row.provider_replay_deadline),
  };
}

/** Re-check the immutable claim and its DB-clock deadline immediately before a blind create. */
export async function refundProviderCreateAllowed(
  query: QueryFn,
  context: RefundContext,
): Promise<boolean> {
  const result = await query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM escrow_events claim
        WHERE claim.escrow_id=$1 AND claim.from_state=$2 AND claim.to_state=$2
          AND claim.actor_id IS NULL AND claim.actor_type='system'
          AND claim.idempotency_key=$3
          AND jsonb_object_length(claim.metadata)=16
          AND claim.metadata->>'event_type'='refund_provider_create_claim_v1'
          AND claim.metadata->>'claim_idempotency_key'=$3
          AND claim.metadata->>'provider'='stripe'
          AND claim.metadata->>'escrow_id'=$1::text
          AND claim.metadata->>'task_id'=$4::text
          AND claim.metadata->>'canonical_state'=$2
          AND claim.metadata->>'canonical_version'=$5::text
          AND claim.metadata->>'task_version'=$6::text
          AND claim.metadata->>'task_state'=$7
          AND claim.metadata->>'worker_id' IS NOT DISTINCT FROM $8::text
          AND claim.metadata->>'payment_intent_id'=$9
          AND claim.metadata->>'existing_refund_id' IS NOT DISTINCT FROM $10
          AND claim.metadata->>'refund_amount_cents'=$11::text
          AND claim.metadata->>'currency'='usd'
          AND claim.metadata->>'provider_idempotency_key'=$12
          AND claim.metadata->>'provider_replay_deadline'
                = (to_jsonb(claim.created_at + interval '20 hours') #>> '{}')
          AND transaction_timestamp() < claim.created_at + interval '20 hours'
          AND NOT EXISTS (
            SELECT 1 FROM escrow_events other_claim
             WHERE other_claim.escrow_id=$1
               AND other_claim.idempotency_key LIKE
                 'refund-provider-create-claim-v1:' || $1::text || ':%'
               AND other_claim.metadata->>'event_type'='refund_provider_create_claim_v1'
               AND other_claim.metadata->>'escrow_id'=$1::text
               AND other_claim.idempotency_key<>$3
          )
          AND NOT EXISTS (
            SELECT 1 FROM escrow_events outcome
             WHERE outcome.escrow_id=$1
               AND outcome.metadata->>'event_type'='refund_provider_claim_resolved_v1'
               AND outcome.metadata->>'claim_idempotency_key'=$3
          )
     ) AS allowed`,
    [
      context.escrowId,
      context.stateBefore,
      context.providerClaim.claimIdempotencyKey,
      context.taskId,
      context.version,
      context.taskVersion,
      context.taskState,
      context.workerId,
      context.stripePaymentIntentId,
      context.stripeRefundId,
      context.amount,
      context.providerClaim.providerIdempotencyKey,
    ],
  );
  return result.rows.length === 1 && result.rows[0]?.allowed === true;
}

export async function persistRefundProviderFailure(
  query: QueryFn,
  context: RefundContext,
  providerCode: string,
): Promise<void> {
  const normalizedCode = safeProviderCode(providerCode);
  const idempotencyKey = refundProviderFailureKey(
    context.escrowId,
    context.version,
    normalizedCode,
  );
  const metadata = {
    event_type: REFUND_PROVIDER_FAILED_EVENT,
    claim_idempotency_key: context.providerClaim.claimIdempotencyKey,
    provider: 'stripe',
    escrow_id: context.escrowId,
    task_id: context.taskId,
    canonical_version: context.version,
    payment_intent_id: context.stripePaymentIntentId,
    refund_amount_cents: context.amount,
    provider_idempotency_key: context.providerClaim.providerIdempotencyKey,
    provider_error_code: normalizedCode,
    claim_resolved: false,
  };
  const result = await query<{ exact: boolean }>(
    `WITH attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,$2,$2,NULL,'system',$3::jsonb,$4)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata
     ), evidence AS (
       SELECT metadata FROM attempted
       UNION ALL
       SELECT event.metadata FROM escrow_events event
        WHERE event.escrow_id=$1 AND event.from_state=$2 AND event.to_state=$2
          AND event.actor_id IS NULL AND event.actor_type='system'
          AND event.idempotency_key=$4
          AND NOT EXISTS (SELECT 1 FROM attempted)
     )
     SELECT COUNT(*)=1 AS exact
       FROM evidence WHERE metadata=$3::jsonb`,
    [context.escrowId, context.stateBefore, JSON.stringify(metadata), idempotencyKey],
  );
  if (result.rows.length !== 1 || result.rows[0]?.exact !== true) {
    throw Object.assign(
      new Error(`Immutable refund provider failure outcome conflicts for escrow ${context.escrowId}`),
      { refundCode: 'REFUND_PROVIDER_CLAIM_CONFLICT' },
    );
  }
}

export function refundProviderResolutionMetadata(
  context: RefundContext,
  refundId: string,
): Record<string, unknown> {
  return {
    event_type: REFUND_PROVIDER_CLAIM_RESOLVED_EVENT,
    claim_idempotency_key: context.providerClaim.claimIdempotencyKey,
    provider: 'stripe',
    escrow_id: context.escrowId,
    task_id: context.taskId,
    canonical_state_before: context.stateBefore,
    canonical_state_after: 'REFUNDED',
    canonical_version_before: context.version,
    canonical_version_after: context.version + 1,
    payment_intent_id: context.stripePaymentIntentId,
    refund_id: refundId,
    refund_amount_cents: context.amount,
    currency: 'usd',
    provider_idempotency_key: context.providerClaim.providerIdempotencyKey,
    provider_witness_idempotency_key: `exact-succeeded-refund-v1:${context.escrowId}:${refundId}`,
    resolution: 'canonical_refunded',
  };
}

/**
 * Persisted only inside T2 after all row bindings pass. The caller must throw
 * on a following canonical UPDATE miss so this outcome rolls back with T2.
 */
export async function persistRefundProviderResolution(
  query: QueryFn,
  context: RefundContext,
  refundId: string,
): Promise<void> {
  const metadata = refundProviderResolutionMetadata(context, refundId);
  const idempotencyKey = refundProviderClaimResolvedKey(
    context.escrowId,
    context.version,
    refundId,
  );
  const result = await query<{ exact: boolean }>(
    `WITH attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,$2,'REFUNDED',NULL,'system',$3::jsonb,$4)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata
     ), evidence AS (
       SELECT metadata FROM attempted
       UNION ALL
       SELECT event.metadata FROM escrow_events event
        WHERE event.escrow_id=$1 AND event.from_state=$2 AND event.to_state='REFUNDED'
          AND event.actor_id IS NULL AND event.actor_type='system'
          AND event.idempotency_key=$4
          AND NOT EXISTS (SELECT 1 FROM attempted)
     )
     SELECT COUNT(*)=1 AS exact
       FROM evidence WHERE metadata=$3::jsonb`,
    [context.escrowId, context.stateBefore, JSON.stringify(metadata), idempotencyKey],
  );
  if (result.rows.length !== 1 || result.rows[0]?.exact !== true) {
    throw new Error(`Immutable refund provider resolution conflicts for escrow ${context.escrowId}`);
  }
}
