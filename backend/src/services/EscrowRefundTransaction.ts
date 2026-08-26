import type { QueryFn } from '../db.js';
import type { Escrow, EscrowState, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { getEscrowById } from './EscrowReadService.js';
import type {
  RefundContext,
  RefundEscrowRow,
  RefundPreparation,
  RefundTaskRow,
} from './EscrowRefundTypes.js';
import {
  persistRefundProviderResolution,
  prepareRefundProviderClaim,
  refundProviderResolutionMetadata,
} from './EscrowRefundProviderClaim.js';
import { isTerminalEscrowState } from './EscrowServiceShared.js';

function failed(code: string, message: string): Extract<ServiceResult<Escrow>, { success: false }> {
  return { success: false, error: { code, message } };
}

async function loadRefundEscrow(query: QueryFn, escrowId: string): Promise<RefundEscrowRow | null> {
  const result = await query<RefundEscrowRow>(
    `SELECT task_id,version,state,amount,platform_fee_cents,
            stripe_payment_intent_id,stripe_refund_id,stripe_transfer_id,
            payout_provider,provider_transfer_id,provider_transfer_status,provider_transfer_paid_at
       FROM escrows WHERE id = $1 FOR UPDATE`,
    [escrowId],
  );
  return result.rows[0] ?? null;
}

async function loadRefundTask(
  query: QueryFn,
  taskId: string,
): Promise<RefundTaskRow | null> {
  const result = await query<RefundTaskRow>(
    `SELECT id,version,worker_id,state FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

function workerStateError(
  task: RefundTaskRow,
): Extract<ServiceResult<Escrow>, { success: false }> | null {
  const assignedStates = ['ACCEPTED', 'MATCHING', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED'];
  if (task.worker_id === null && !assignedStates.includes(task.state)) return null;
  return failed(ErrorCodes.INVALID_STATE, 'Cannot refund escrow for a task that has been accepted by a worker');
}

function refundEscrowError(
  escrow: RefundEscrowRow,
  adminOverride: boolean,
): Extract<ServiceResult<Escrow>, { success: false }> | null {
  if (adminOverride || escrow.state === 'FUNDED') return null;
  return failed(ErrorCodes.INVALID_STATE,
    `Cannot refund escrow from ${escrow.state}; the canonical service lane accepts FUNDED only`);
}

function refundContext(input: {
  escrowId: string;
  escrow: RefundEscrowRow;
  task: RefundTaskRow;
  adminOverride: boolean;
}): Omit<RefundContext, 'providerClaim'> {
  return {
    escrowId: input.escrowId,
    taskId: input.escrow.task_id,
    workerId: input.task.worker_id,
    taskVersion: input.task.version,
    taskState: input.task.state,
    version: input.escrow.version,
    stateBefore: input.escrow.state || 'FUNDED',
    platformFeeCents: input.escrow.platform_fee_cents,
    stripePaymentIntentId: input.escrow.stripe_payment_intent_id,
    stripeRefundId: input.escrow.stripe_refund_id,
    stripeTransferId: input.escrow.stripe_transfer_id,
    payoutProvider: input.escrow.payout_provider,
    providerTransferId: input.escrow.provider_transfer_id,
    providerTransferStatus: input.escrow.provider_transfer_status,
    providerTransferPaidAt: input.escrow.provider_transfer_paid_at,
    amount: input.escrow.amount,
    allowedStates: input.adminOverride ? ['FUNDED', 'LOCKED_DISPUTE', 'RELEASED'] : ['FUNDED'],
  };
}

export async function prepareRefund(
  query: QueryFn,
  escrowId: string,
  adminOverride: boolean,
): Promise<RefundPreparation> {
  const escrow = await loadRefundEscrow(query, escrowId);
  if (!escrow) return failed(ErrorCodes.NOT_FOUND, `Escrow ${escrowId} not found`);
  const escrowError = refundEscrowError(escrow, adminOverride);
  if (escrowError) return escrowError;
  const task = escrow.task_id ? await loadRefundTask(query, escrow.task_id) : null;
  if (!task) return failed(ErrorCodes.NOT_FOUND, `Task ${escrow.task_id} not found for escrow ${escrowId}`);
  const taskError = workerStateError(task);
  if (taskError) return taskError;
  const context = refundContext({ escrowId, escrow, task, adminOverride });
  if (!context.stripePaymentIntentId) {
    return failed(
      'STRIPE_REFUND_EVIDENCE_MISMATCH',
      `Escrow ${escrowId} has no canonical Stripe PaymentIntent to refund`,
    );
  }
  const providerClaim = await prepareRefundProviderClaim(query, {
    escrowId: context.escrowId,
    taskId: context.taskId,
    canonicalState: context.stateBefore,
    canonicalVersion: context.version,
    taskVersion: context.taskVersion,
    taskState: context.taskState,
    workerId: context.workerId,
    paymentIntentId: context.stripePaymentIntentId,
    existingRefundId: context.stripeRefundId,
    amountCents: context.amount,
  });
  return { success: true, data: { ...context, providerClaim } };
}

async function lockRefundRow(query: QueryFn, escrowId: string): Promise<{
  id: string;
  task_id: string;
  version: number;
  state: string;
  amount: number;
  platform_fee_cents: number | null;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  stripe_transfer_id: string | null;
  payout_provider: string | null;
  provider_transfer_id: string | null;
  provider_transfer_status: string | null;
  provider_transfer_paid_at: Date | null;
} | null> {
  try {
    const result = await query<{
      id:string;task_id:string;version:number;state:string;amount:number;
      platform_fee_cents:number|null;stripe_payment_intent_id:string|null;
      stripe_refund_id:string|null;stripe_transfer_id:string|null;
      payout_provider:string|null;provider_transfer_id:string|null;
      provider_transfer_status:string|null;provider_transfer_paid_at:Date|null;
    }>(
      `SELECT id,task_id,version,state,amount,platform_fee_cents,
              stripe_payment_intent_id,stripe_refund_id,stripe_transfer_id,
              payout_provider,provider_transfer_id,provider_transfer_status,provider_transfer_paid_at
         FROM escrows WHERE id = $1 FOR UPDATE NOWAIT`,
      [escrowId],
    );
    return result.rows[0] ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('55P03') || message.toLowerCase().includes('could not obtain lock')) {
      throw new Error('LOCK_CONTENTION: Another worker is processing this escrow refund — will retry');
    }
    throw error;
  }
}

type LockedRefundRow = NonNullable<Awaited<ReturnType<typeof lockRefundRow>>>;

function sameTimestamp(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return new Date(left).getTime() === new Date(right).getTime();
}

function exactRefundBinding(context: RefundContext, row: LockedRefundRow): boolean {
  return row.id === context.escrowId
    && row.task_id === context.taskId
    && row.version === context.version
    && row.state === context.stateBefore
    && row.amount === context.amount
    && row.platform_fee_cents === context.platformFeeCents
    && row.stripe_payment_intent_id === context.stripePaymentIntentId
    && row.stripe_refund_id === context.stripeRefundId
    && row.stripe_transfer_id === context.stripeTransferId
    && row.payout_provider === context.payoutProvider
    && row.provider_transfer_id === context.providerTransferId
    && row.provider_transfer_status === context.providerTransferStatus
    && sameTimestamp(row.provider_transfer_paid_at, context.providerTransferPaidAt);
}

function exactTaskBinding(context: RefundContext, row: RefundTaskRow): boolean {
  return row.id === context.taskId
    && row.version === context.taskVersion
    && row.state === context.taskState
    && row.worker_id === context.workerId;
}

function recoveryMetadata(
  context: RefundContext,
  row: LockedRefundRow,
  task: RefundTaskRow | null,
  stripeRefundId: string,
): Record<string, unknown> {
  return {
    event_type:'refund_canonical_reconciliation_required_v1',
    refund_id:stripeRefundId,
    expected:{
      escrow_id:context.escrowId,task_id:context.taskId,version:context.version,
      state:context.stateBefore,amount:context.amount,platform_fee_cents:context.platformFeeCents,
      payment_intent_id:context.stripePaymentIntentId,refund_id:context.stripeRefundId,
      transfer_id:context.stripeTransferId,payout_provider:context.payoutProvider,
      provider_transfer_id:context.providerTransferId,
      provider_transfer_status:context.providerTransferStatus,
      provider_transfer_paid_at:context.providerTransferPaidAt?.toISOString() ?? null,
      task_version:context.taskVersion,task_state:context.taskState,worker_id:context.workerId,
    },
    observed:{
      escrow_id:row.id,task_id:row.task_id,version:row.version,state:row.state,amount:row.amount,
      platform_fee_cents:row.platform_fee_cents,payment_intent_id:row.stripe_payment_intent_id,
      refund_id:row.stripe_refund_id,transfer_id:row.stripe_transfer_id,
      payout_provider:row.payout_provider,provider_transfer_id:row.provider_transfer_id,
      provider_transfer_status:row.provider_transfer_status,
      provider_transfer_paid_at:row.provider_transfer_paid_at?.toISOString() ?? null,
      task_version:task?.version ?? null,task_state:task?.state ?? null,
      worker_id:task?.worker_id ?? null,
    },
    reconciliation_required:true,
  };
}

async function persistRefundRecovery(
  query: QueryFn,
  context: RefundContext,
  row: LockedRefundRow,
  task: RefundTaskRow | null,
  stripeRefundId: string,
): Promise<void> {
  const metadata = recoveryMetadata(context, row, task, stripeRefundId);
  const idempotencyKey =
    `refund-canonical-reconciliation-required-v1:${context.escrowId}:${stripeRefundId}:${context.version}`;
  const result = await query<{ exact: boolean }>(
    `WITH desired(metadata) AS (VALUES ($4::jsonb)), attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,$2,$2,NULL,'system',$4::jsonb,$3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id
     )
     SELECT COUNT(*)=1 AS exact
       FROM escrow_events event,desired
      WHERE event.escrow_id=$1 AND event.from_state=$2 AND event.to_state=$2
        AND event.actor_id IS NULL AND event.actor_type='system'
        AND event.idempotency_key=$3 AND event.metadata=desired.metadata`,
    [row.id,row.state,idempotencyKey,JSON.stringify(metadata)],
  );
  if (result.rows.length !== 1 || result.rows[0].exact !== true) {
    throw new Error(`Immutable refund recovery evidence conflicts for escrow ${context.escrowId}`);
  }
}

function exactTerminalReplayBinding(
  context: RefundContext,
  row: LockedRefundRow,
  task: RefundTaskRow,
  stripeRefundId: string,
): boolean {
  return row.id === context.escrowId
    && row.task_id === context.taskId
    && row.version === context.version + 1
    && row.state === 'REFUNDED'
    && row.amount === context.amount
    && row.platform_fee_cents === context.platformFeeCents
    && row.stripe_payment_intent_id === context.stripePaymentIntentId
    && row.stripe_refund_id === stripeRefundId
    && row.stripe_transfer_id === context.stripeTransferId
    && row.payout_provider === context.payoutProvider
    && row.provider_transfer_id === context.providerTransferId
    && row.provider_transfer_status === context.providerTransferStatus
    && sameTimestamp(row.provider_transfer_paid_at, context.providerTransferPaidAt)
    && exactTaskBinding(context, task);
}

async function hasExactTerminalReplayEvidence(
  query: QueryFn,
  context: RefundContext,
  row: LockedRefundRow,
  stripeRefundId: string,
): Promise<boolean> {
  const transitionKey = `escrow-refunded-transition-v1:${row.id}:${row.version}`;
  const transitionMetadata = {
    event_type:'escrow_refunded_transition_v1',
    escrow_id:row.id,
    task_id:row.task_id,
    task_version:context.taskVersion,
    task_state:context.taskState,
    worker_id:context.workerId,
    payment_intent_id:context.stripePaymentIntentId,
    refund_id:stripeRefundId,
    amount_cents:context.amount,
    canonical_version_before:context.version,
    canonical_version_after:row.version,
  };
  const evidence = await query<{ exact: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM escrow_events event
          WHERE event.escrow_id=$1 AND event.from_state=$2 AND event.to_state=$2
            AND event.actor_id IS NULL AND event.actor_type='system'
            AND event.idempotency_key='exact-succeeded-refund-v1:' || $1::text || ':' || $3
            AND event.metadata->>'event_type'='exact_succeeded_refund_witness_v1'
            AND event.metadata->>'escrow_id'=$1::text
            AND event.metadata->>'task_id'=$4::text
            AND event.metadata->>'canonical_state'=$2
            AND event.metadata->>'payment_intent_id'=$5
            AND event.metadata->>'refund_id'=$3
            AND event.metadata->>'amount_cents'=$6::text
            AND event.metadata->>'currency'='usd'
            AND event.metadata->>'status'='succeeded'
            AND NULLIF(event.metadata->>'charge_id','') IS NOT NULL
       ) AND EXISTS (
         SELECT 1 FROM escrow_events event
          WHERE event.escrow_id=$1 AND event.from_state=$2 AND event.to_state='REFUNDED'
            AND event.actor_id IS NULL AND event.actor_type='system'
            AND event.idempotency_key=$7 AND event.metadata=$8::jsonb
       ) AND EXISTS (
         SELECT 1 FROM escrow_events claim
          WHERE claim.escrow_id=$1 AND claim.from_state=$2 AND claim.to_state=$2
            AND claim.actor_id IS NULL AND claim.actor_type='system'
            AND claim.idempotency_key=$9
            AND jsonb_object_length(claim.metadata)=16
            AND claim.metadata->>'event_type'='refund_provider_create_claim_v1'
            AND claim.metadata->>'claim_idempotency_key'=$9
            AND claim.metadata->>'provider'='stripe'
            AND claim.metadata->>'escrow_id'=$1::text
            AND claim.metadata->>'task_id'=$4::text
            AND claim.metadata->>'canonical_state'=$2
            AND claim.metadata->>'canonical_version'=$16::text
            AND claim.metadata->>'task_version'=$12::text
            AND claim.metadata->>'task_state'=$13
            AND claim.metadata->>'worker_id' IS NOT DISTINCT FROM $14::text
            AND claim.metadata->>'payment_intent_id'=$5
            AND claim.metadata->>'existing_refund_id' IS NOT DISTINCT FROM $11
            AND claim.metadata->>'refund_amount_cents'=$6::text
            AND claim.metadata->>'currency'='usd'
            AND claim.metadata->>'provider_idempotency_key'=$10
            AND claim.metadata->>'provider_replay_deadline'
                  = (to_jsonb(claim.created_at + interval '20 hours') #>> '{}')
            AND NOT EXISTS (
              SELECT 1 FROM escrow_events other_claim
               WHERE other_claim.escrow_id=$1
                 AND other_claim.idempotency_key LIKE
                   'refund-provider-create-claim-v1:' || $1::text || ':%'
                 AND other_claim.metadata->>'event_type'='refund_provider_create_claim_v1'
                 AND other_claim.metadata->>'escrow_id'=$1::text
                 AND other_claim.idempotency_key<>$9
            )
       ) AND EXISTS (
         SELECT 1 FROM escrow_events outcome
          WHERE outcome.escrow_id=$1 AND outcome.from_state=$2
            AND outcome.to_state='REFUNDED'
            AND outcome.actor_id IS NULL AND outcome.actor_type='system'
            AND outcome.idempotency_key=
              'refund-provider-claim-resolved-v1:' || $1::text || ':'
                || $16::text || ':' || $3
            AND outcome.metadata=$15::jsonb
       )
     ) AS exact`,
    [
      row.id,context.stateBefore,stripeRefundId,context.taskId,
      context.stripePaymentIntentId,context.amount,transitionKey,
      JSON.stringify(transitionMetadata),
      context.providerClaim.claimIdempotencyKey,
      context.providerClaim.providerIdempotencyKey,
      context.stripeRefundId,
      context.taskVersion,
      context.taskState,
      context.workerId,
      JSON.stringify(refundProviderResolutionMetadata(context, stripeRefundId)),
      context.version,
    ],
  );
  return evidence.rows.length === 1 && evidence.rows[0].exact === true;
}

async function stateChangedResult(
  query: QueryFn,
  context: RefundContext,
  row: LockedRefundRow,
  task: RefundTaskRow,
  stripeRefundId: string,
): Promise<ServiceResult<Escrow>> {
  if (
    exactTerminalReplayBinding(context, row, task, stripeRefundId)
    && await hasExactTerminalReplayEvidence(query, context, row, stripeRefundId)
  ) {
    const existing = await getEscrowById(context.escrowId);
    if (
      existing.success
      && existing.data.state === 'REFUNDED'
      && existing.data.stripe_refund_id === stripeRefundId
    ) return existing;
  }
  return failed(
    row.state === 'REFUNDED'
      ? 'REFUND_RECONCILIATION_REQUIRED'
      : isTerminalEscrowState(row.state as EscrowState)
        ? ErrorCodes.ESCROW_TERMINAL
        : ErrorCodes.INVALID_STATE,
    row.state === 'REFUNDED'
      ? `Cannot accept existing REFUNDED state without the exact refund identity and transition evidence`
      : `Cannot refund escrow: state changed to ${row.state} between T1 and T2`,
  );
}

export async function terminalizeRefund(
  query: QueryFn,
  context: RefundContext,
  stripeRefundId: string,
): Promise<ServiceResult<Escrow>> {
  const locked = await lockRefundRow(query, context.escrowId);
  if (!locked) {
    return failed(ErrorCodes.NOT_FOUND, `Escrow ${context.escrowId} not found during T2 lock`);
  }
  const task = await loadRefundTask(query, locked.task_id);
  if (
    !exactRefundBinding(context, locked)
    || !context.allowedStates.includes(locked.state)
    || !task
    || !exactTaskBinding(context, task)
  ) {
    if (!task || !exactTaskBinding(context, task)) {
      await persistRefundRecovery(query, context, locked, task, stripeRefundId);
      return failed(
        ErrorCodes.INVALID_STATE,
        `Cannot refund escrow: task assignment changed between T1 and T2`,
      );
    }
    const changed = await stateChangedResult(query, context, locked, task, stripeRefundId);
    if (changed.success) return changed;
    await persistRefundRecovery(query, context, locked, task, stripeRefundId);
    return changed;
  }
  await persistRefundProviderResolution(query, context, stripeRefundId);
  await query(
    `SELECT set_config('hustlexp.refund_terminal_authority',$1,true)`,
    [context.escrowId],
  );
  const result = await query<Escrow & {
    event_key: string;
    event_metadata: unknown;
    refund_transition_event_exact: boolean;
  }>(
    `WITH transitioned AS (
       UPDATE escrows
          SET state = 'REFUNDED', refunded_at = NOW(),
              stripe_refund_id = $3,
              version = version + 1, updated_at = NOW()
        WHERE id=$1 AND state=$4 AND version=$2
          AND task_id=$5 AND amount=$6 AND platform_fee_cents IS NOT DISTINCT FROM $7
          AND stripe_payment_intent_id=$8 AND stripe_refund_id IS NOT DISTINCT FROM $9
          AND stripe_transfer_id IS NOT DISTINCT FROM $10
          AND payout_provider IS NOT DISTINCT FROM $11
          AND provider_transfer_id IS NOT DISTINCT FROM $12
          AND provider_transfer_status IS NOT DISTINCT FROM $13
          AND provider_transfer_paid_at IS NOT DISTINCT FROM $14
          AND EXISTS (
            SELECT 1 FROM tasks task
             WHERE task.id=$5 AND task.version=$15 AND task.state=$16
               AND task.worker_id IS NOT DISTINCT FROM $17
          )
          AND EXISTS (
            SELECT 1 FROM escrow_events event
             WHERE event.escrow_id=$1 AND event.from_state=$4 AND event.to_state=$4
               AND event.actor_id IS NULL AND event.actor_type='system'
               AND event.idempotency_key='exact-succeeded-refund-v1:' || $1::text || ':' || $3
               AND event.metadata->>'event_type'='exact_succeeded_refund_witness_v1'
               AND event.metadata->>'escrow_id'=$1::text
               AND event.metadata->>'task_id'=$5::text
               AND event.metadata->>'canonical_state'=$4
               AND event.metadata->>'payment_intent_id'=$8
               AND event.metadata->>'refund_id'=$3
               AND event.metadata->>'amount_cents'=$6::text
               AND event.metadata->>'currency'='usd'
               AND event.metadata->>'status'='succeeded'
               AND NULLIF(event.metadata->>'charge_id','') IS NOT NULL
          )
          AND EXISTS (
            SELECT 1 FROM escrow_events claim
             WHERE claim.escrow_id=$1 AND claim.from_state=$4 AND claim.to_state=$4
               AND claim.actor_id IS NULL AND claim.actor_type='system'
               AND claim.idempotency_key=$18
               AND jsonb_object_length(claim.metadata)=16
               AND claim.metadata->>'event_type'='refund_provider_create_claim_v1'
               AND claim.metadata->>'claim_idempotency_key'=$18
               AND claim.metadata->>'provider'='stripe'
               AND claim.metadata->>'escrow_id'=$1::text
               AND claim.metadata->>'task_id'=$5::text
               AND claim.metadata->>'canonical_state'=$4
               AND claim.metadata->>'canonical_version'=$2::text
               AND claim.metadata->>'task_version'=$15::text
               AND claim.metadata->>'task_state'=$16
               AND claim.metadata->>'worker_id' IS NOT DISTINCT FROM $17::text
               AND claim.metadata->>'payment_intent_id'=$8
               AND claim.metadata->>'existing_refund_id' IS NOT DISTINCT FROM $9
               AND claim.metadata->>'refund_amount_cents'=$6::text
               AND claim.metadata->>'currency'='usd'
               AND claim.metadata->>'provider_idempotency_key'=$19
               AND claim.metadata->>'provider_replay_deadline'
                     = (to_jsonb(claim.created_at + interval '20 hours') #>> '{}')
               AND NOT EXISTS (
                 SELECT 1 FROM escrow_events other_claim
                  WHERE other_claim.escrow_id=$1
                    AND other_claim.idempotency_key LIKE
                      'refund-provider-create-claim-v1:' || $1::text || ':%'
                    AND other_claim.metadata->>'event_type'='refund_provider_create_claim_v1'
                    AND other_claim.metadata->>'escrow_id'=$1::text
                    AND other_claim.idempotency_key<>$18
               )
          )
          AND EXISTS (
            SELECT 1 FROM escrow_events outcome
             WHERE outcome.escrow_id=$1 AND outcome.from_state=$4
               AND outcome.to_state='REFUNDED'
               AND outcome.actor_id IS NULL AND outcome.actor_type='system'
               AND outcome.idempotency_key=
                 'refund-provider-claim-resolved-v1:' || $1::text || ':' || $2::text || ':' || $3
               AND outcome.created_at=transaction_timestamp()
               AND outcome.metadata=$20::jsonb
          )
        RETURNING *
     ), desired AS (
       SELECT transitioned.*,
              'escrow-refunded-transition-v1:' || transitioned.id::text || ':'
                || transitioned.version::text AS event_key,
              jsonb_build_object(
                'event_type','escrow_refunded_transition_v1',
                'escrow_id',transitioned.id::text,
                'task_id',transitioned.task_id::text,
                'task_version',$15,
                'task_state',$16,
                'worker_id',$17::text,
                'payment_intent_id',$8,
                'refund_id',$3,
                'amount_cents',$6,
                'canonical_version_before',$2,
                'canonical_version_after',transitioned.version
              ) AS event_metadata
         FROM transitioned
     ), inserted_event AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       SELECT id,$4,'REFUNDED',NULL,'system',event_metadata,event_key
         FROM desired
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id
     )
     SELECT desired.*,
            (
              EXISTS (SELECT 1 FROM inserted_event)
              OR EXISTS (
                SELECT 1 FROM escrow_events event
                 WHERE event.escrow_id=desired.id
                   AND event.from_state=$4 AND event.to_state='REFUNDED'
                   AND event.actor_id IS NULL AND event.actor_type='system'
                   AND event.idempotency_key=desired.event_key
                   AND event.metadata=desired.event_metadata
              )
            ) AS refund_transition_event_exact
       FROM desired`,
    [
      context.escrowId,context.version,stripeRefundId,context.stateBefore,context.taskId,
      context.amount,context.platformFeeCents,context.stripePaymentIntentId,
      context.stripeRefundId,context.stripeTransferId,context.payoutProvider,
      context.providerTransferId,context.providerTransferStatus,context.providerTransferPaidAt,
      context.taskVersion,context.taskState,context.workerId,
      context.providerClaim.claimIdempotencyKey,
      context.providerClaim.providerIdempotencyKey,
      JSON.stringify(refundProviderResolutionMetadata(context, stripeRefundId)),
    ],
  );
  if ((result.rowCount ?? 0) > 0) {
    const row = result.rows[0];
    if (row.refund_transition_event_exact !== true) {
      throw new Error(`Immutable refund transition evidence conflicts for escrow ${context.escrowId}`);
    }
    const {
      refund_transition_event_exact: _exact,
      event_key: _eventKey,
      event_metadata: _eventMetadata,
      ...escrow
    } = row;
    return { success:true,data:escrow as Escrow };
  }
  throw new Error(
    `Refund terminalization lost its exact claim/witness authority for escrow ${context.escrowId}`,
  );
}
