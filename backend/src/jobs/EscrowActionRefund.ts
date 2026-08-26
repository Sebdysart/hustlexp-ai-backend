import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { workerLogger } from '../logger.js';
import {
  persistRefundProviderFailure,
  prepareRefundProviderClaim,
  refundProviderClaimKey,
  refundProviderClaimResolvedKey,
  refundProviderCreateAllowed,
  refundProviderIdempotencyKey,
  refundProviderResolutionMetadata,
} from '../services/EscrowRefundProviderClaim.js';
import {
  exactSucceededRefundWitness,
  persistExactSucceededRefundWitness,
} from '../services/EscrowRefundProviderWitness.js';
import type { ExactSucceededRefundWitness } from '../services/EscrowRefundProviderWitness.js';
import { terminalizeRefund } from '../services/EscrowRefundTransaction.js';
import type { RefundContext, RefundProviderClaim } from '../services/EscrowRefundTypes.js';
import { StripeService } from '../services/StripeService.js';
import type {
  EscrowActionInput,
  EscrowActionRow,
  EscrowActionTerminalProof,
} from './EscrowActionTypes.js';

const log = workerLogger.child({ worker: 'escrow-action' });

type RefundAuthorityOrigin =
  | 'dispute_resolution'
  | 'worker_abandoned'
  | 'dispatch_expired_unfilled';

interface ActionRefundAuthority {
  origin: RefundAuthorityOrigin;
  authorityId: string;
  authorityVersion: number | null;
  taskVersion: number;
  taskState: string;
  workerId: string | null;
}

interface LockedActionRefundRow extends EscrowActionRow {
  released_origin: boolean;
}

interface PreparedActionRefund {
  action: EscrowActionInput;
  authority: ActionRefundAuthority;
  context: RefundContext;
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) as unknown : metadata;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sameTimestamp(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return new Date(left).getTime() === new Date(right).getTime();
}

function actionEscrowMatches(actual: EscrowActionRow, action: EscrowActionInput): boolean {
  return actual.id === action.escrow.id
    && actual.task_id === action.taskId
    && actual.state === action.escrow.state
    && actual.version === action.escrow.version
    && Number(actual.amount) === action.escrow.amount
    && actual.platform_fee_cents === action.escrow.platform_fee_cents
    && actual.stripe_payment_intent_id === action.escrow.stripe_payment_intent_id
    && actual.stripe_transfer_id === action.escrow.stripe_transfer_id
    && actual.stripe_refund_id === action.escrow.stripe_refund_id
    && actual.refund_amount === action.escrow.refund_amount
    && actual.release_amount === action.escrow.release_amount
    && actual.payout_provider === action.escrow.payout_provider
    && actual.provider_transfer_id === action.escrow.provider_transfer_id
    && actual.provider_transfer_status === action.escrow.provider_transfer_status
    && sameTimestamp(actual.provider_transfer_paid_at, action.escrow.provider_transfer_paid_at);
}

async function loadCurrentActionEscrow(
  query: QueryFn,
  action: EscrowActionInput,
): Promise<LockedActionRefundRow> {
  const result = await query<LockedActionRefundRow>(
    `SELECT escrow.id,escrow.task_id,escrow.state,escrow.version,escrow.amount,
            escrow.platform_fee_cents,escrow.stripe_payment_intent_id,
            escrow.stripe_transfer_id,escrow.stripe_refund_id,
            escrow.refund_amount,escrow.release_amount,escrow.payout_provider,
            escrow.provider_transfer_id,escrow.provider_transfer_status,
            escrow.provider_transfer_paid_at,
            EXISTS (
              SELECT 1 FROM escrow_events origin
               WHERE origin.escrow_id=escrow.id
                 AND origin.from_state='RELEASED'
                 AND origin.to_state='LOCKED_DISPUTE'
                 AND origin.actor_id IS NULL
                 AND origin.actor_type='system'
                 AND origin.metadata->>'event_type'='dispute_locked_after_release'
                 AND NULLIF(origin.metadata->>'original_transfer_id','') IS NOT NULL
            ) AS released_origin
       FROM escrows escrow WHERE escrow.id=$1 FOR UPDATE`,
    [action.escrow.id],
  );
  const current = result.rows[0];
  if (!current) throw new Error(`Escrow ${action.escrow.id} disappeared during refund`);
  return current;
}

interface ClosedRefundDisputeRow {
  id: string;
  task_id: string;
  escrow_id: string;
  state: string;
  version: number;
  resolved_by: string | null;
  outcome_escrow_action: string | null;
  outcome_refund_amount: number | null;
  outcome_release_amount: number | null;
  task_state: string;
  task_version: number;
  task_worker_id: string | null;
}

async function requireDisputeRefundAuthority(
  query: QueryFn,
  action: EscrowActionInput,
): Promise<ActionRefundAuthority> {
  if (!action.disputeId) {
    throw new Error('REFUND_AUTHORITY_REQUIRED: dispute_resolution requires dispute_id');
  }
  const result = await query<ClosedRefundDisputeRow>(
    `SELECT dispute.id,dispute.task_id,dispute.escrow_id,dispute.state,
            dispute.version,dispute.resolved_by,dispute.outcome_escrow_action,
            dispute.outcome_refund_amount,dispute.outcome_release_amount,
            task.state AS task_state,task.version AS task_version,
            task.worker_id AS task_worker_id
       FROM disputes dispute
       JOIN tasks task ON task.id=dispute.task_id
      WHERE dispute.id=$1
      FOR SHARE OF dispute,task`,
    [action.disputeId],
  );
  const authority = result.rows[0];
  if (
    result.rows.length !== 1
    || !authority
    || authority.id !== action.disputeId
    || authority.task_id !== action.taskId
    || authority.escrow_id !== action.escrow.id
    || authority.state !== 'RESOLVED'
    || !Number.isSafeInteger(authority.version)
    || !authority.resolved_by
    || authority.outcome_escrow_action !== 'REFUND'
    || Number(authority.outcome_refund_amount) !== action.escrow.amount
    || Number(authority.outcome_release_amount) !== 0
    || authority.task_state !== 'CANCELLED'
    || !Number.isSafeInteger(authority.task_version)
  ) {
    throw new Error(
      `REFUND_AUTHORITY_REQUIRED: dispute ${action.disputeId} does not exactly authorize a full refund`,
    );
  }
  return {
    origin: 'dispute_resolution',
    authorityId: authority.id,
    authorityVersion: authority.version,
    taskVersion: authority.task_version,
    taskState: authority.task_state,
    workerId: authority.task_worker_id,
  };
}

interface WorkerAbandonAuthorityRow {
  actor_id: string | null;
  idempotency_key: string;
  metadata: unknown;
  task_state: string;
  task_version: number;
  task_worker_id: string | null;
}

async function requireWorkerAbandonRefundAuthority(
  query: QueryFn,
  action: EscrowActionInput,
): Promise<ActionRefundAuthority> {
  if (action.disputeId) {
    throw new Error('REFUND_AUTHORITY_REQUIRED: worker_abandoned cannot carry dispute_id');
  }
  const result = await query<WorkerAbandonAuthorityRow>(
    `SELECT event.actor_id,event.idempotency_key,event.metadata,
            task.state AS task_state,task.version AS task_version,
            task.worker_id AS task_worker_id
       FROM escrow_events event
       JOIN tasks task ON task.id=$2
      WHERE event.escrow_id=$1
        AND event.from_state='FUNDED' AND event.to_state='LOCKED_DISPUTE'
        AND event.actor_type='user'
        AND event.metadata::jsonb->>'event_type'='worker_abandon_refund_authority_v1'
      ORDER BY event.created_at DESC
      LIMIT 2
      FOR SHARE OF task`,
    [action.escrow.id, action.taskId],
  );
  const authority = result.rows[0];
  const metadata = metadataRecord(authority?.metadata);
  const expectedKeys = [
    'canonical_state', 'canonical_version', 'event_type',
    'reason', 'task_id', 'worker_id',
  ].sort();
  const actualKeys = metadata ? Object.keys(metadata).sort() : [];
  const expectedAuthorityId =
    `worker-abandon-refund-authority-v1:${action.escrow.id}:${action.taskId}:${action.escrow.version}`;
  if (
    result.rows.length !== 1
    || !authority
    || !metadata
    || actualKeys.length !== expectedKeys.length
    || !expectedKeys.every((key, index) => key === actualKeys[index])
    || authority.idempotency_key !== expectedAuthorityId
    || metadata.event_type !== 'worker_abandon_refund_authority_v1'
    || metadata.task_id !== action.taskId
    || typeof metadata.worker_id !== 'string'
    || metadata.worker_id !== authority.actor_id
    || metadata.canonical_state !== 'LOCKED_DISPUTE'
    || metadata.canonical_version !== action.escrow.version
    || !(metadata.reason === null || typeof metadata.reason === 'string')
    || authority.task_state !== 'CANCELLED'
    || !Number.isSafeInteger(authority.task_version)
    || authority.task_worker_id !== null
  ) {
    throw new Error(
      `REFUND_AUTHORITY_REQUIRED: worker abandonment does not exactly authorize escrow ${action.escrow.id}`,
    );
  }
  return {
    origin: 'worker_abandoned',
    authorityId: authority.idempotency_key,
    authorityVersion: null,
    taskVersion: authority.task_version,
    taskState: authority.task_state,
    workerId: authority.task_worker_id,
  };
}

interface DispatchExpiryAuthorityRow {
  task_state: string;
  task_version: number;
  worker_id: string | null;
  expiration_reason: string | null;
  event_type: string;
  idempotency_key: string;
}

async function requireDispatchExpiryRefundAuthority(
  query: QueryFn,
  action: EscrowActionInput,
): Promise<ActionRefundAuthority> {
  if (action.disputeId) {
    throw new Error('REFUND_AUTHORITY_REQUIRED: dispatch expiry cannot carry dispute_id');
  }
  const result = await query<DispatchExpiryAuthorityRow>(
    `SELECT task.state AS task_state,task.version AS task_version,
            task.worker_id,task.expiration_reason,
            event.event_type,event.idempotency_key
       FROM tasks task
       JOIN engine_automation_events event
         ON event.task_id=task.id
        AND event.event_type='TASK_EXPIRED_UNFILLED'
        AND event.idempotency_key='dispatch-expiry:' || task.id::text
      WHERE task.id=$1
      FOR SHARE OF task`,
    [action.taskId],
  );
  const authority = result.rows[0];
  if (
    result.rows.length !== 1
    || !authority
    || authority.task_state !== 'EXPIRED'
    || !Number.isSafeInteger(authority.task_version)
    || authority.worker_id !== null
    || authority.expiration_reason !== 'UNFILLED'
    || authority.event_type !== 'TASK_EXPIRED_UNFILLED'
    || authority.idempotency_key !== `dispatch-expiry:${action.taskId}`
  ) {
    throw new Error(
      `REFUND_AUTHORITY_REQUIRED: dispatch expiry does not exactly authorize task ${action.taskId}`,
    );
  }
  return {
    origin: 'dispatch_expired_unfilled',
    authorityId: authority.idempotency_key,
    authorityVersion: null,
    taskVersion: authority.task_version,
    taskState: authority.task_state,
    workerId: authority.worker_id,
  };
}

async function requireClosedFullRefundAuthority(
  query: QueryFn,
  action: EscrowActionInput,
): Promise<ActionRefundAuthority> {
  if (
    !Number.isSafeInteger(action.escrow.amount)
    || action.escrow.amount <= 0
    || (action.refundAmount !== undefined && action.refundAmount !== action.escrow.amount)
    || (action.releaseAmount !== undefined && action.releaseAmount !== 0)
  ) {
    throw new Error(
      `REFUND_AUTHORITY_REQUIRED: refund amount must exactly equal escrow ${action.escrow.id} amount`,
    );
  }
  if (action.reason === 'dispute_resolution') {
    return requireDisputeRefundAuthority(query, action);
  }
  if (action.reason === 'worker_abandoned') {
    return requireWorkerAbandonRefundAuthority(query, action);
  }
  if (action.reason === 'dispatch_expired_unfilled') {
    return requireDispatchExpiryRefundAuthority(query, action);
  }
  throw new Error(`REFUND_AUTHORITY_REQUIRED: unsupported refund origin ${action.reason}`);
}

function exactAuthority(
  actual: ActionRefundAuthority,
  expected: ActionRefundAuthority,
): boolean {
  return actual.origin === expected.origin
    && actual.authorityId === expected.authorityId
    && actual.authorityVersion === expected.authorityVersion
    && actual.taskVersion === expected.taskVersion
    && actual.taskState === expected.taskState
    && actual.workerId === expected.workerId;
}

function refundContext(
  action: EscrowActionInput,
  authority: ActionRefundAuthority,
  providerClaim: RefundProviderClaim,
): RefundContext {
  return {
    escrowId: action.escrow.id,
    taskId: action.taskId,
    workerId: authority.workerId,
    taskVersion: authority.taskVersion,
    taskState: authority.taskState,
    version: action.escrow.version,
    stateBefore: 'LOCKED_DISPUTE',
    platformFeeCents: action.escrow.platform_fee_cents,
    stripePaymentIntentId: action.escrow.stripe_payment_intent_id,
    stripeRefundId: action.escrow.stripe_refund_id,
    stripeTransferId: action.escrow.stripe_transfer_id,
    payoutProvider: action.escrow.payout_provider,
    providerTransferId: action.escrow.provider_transfer_id,
    providerTransferStatus: action.escrow.provider_transfer_status,
    providerTransferPaidAt: action.escrow.provider_transfer_paid_at,
    amount: action.escrow.amount,
    allowedStates: ['LOCKED_DISPUTE'],
    providerClaim,
  };
}

async function prepareActionRefund(action: EscrowActionInput): Promise<PreparedActionRefund> {
  return db.transaction(async (query) => {
    const current = await loadCurrentActionEscrow(query, action);
    if (!actionEscrowMatches(current, action) || current.state !== 'LOCKED_DISPUTE') {
      throw new Error(`Escrow ${action.escrow.id} changed before refund provider claim`);
    }
    if (
      current.released_origin === true
      || current.stripe_transfer_id !== null
      || current.payout_provider !== null
      || current.provider_transfer_id !== null
      || current.provider_transfer_status !== null
      || current.provider_transfer_paid_at !== null
    ) {
      throw new Error(
        `RELEASED_ORIGIN_REFUND_RECONCILIATION_REQUIRED: escrow ${current.id} has payout-transfer history`,
      );
    }
    const authority = await requireClosedFullRefundAuthority(query, action);
    if (!current.stripe_payment_intent_id) {
      throw new Error(`Escrow ${current.id} has no stripe_payment_intent_id`);
    }
    const providerClaim = await prepareRefundProviderClaim(query, {
      escrowId: current.id,
      taskId: current.task_id,
      canonicalState: current.state,
      canonicalVersion: current.version,
      taskVersion: authority.taskVersion,
      taskState: authority.taskState,
      workerId: authority.workerId,
      paymentIntentId: current.stripe_payment_intent_id,
      existingRefundId: current.stripe_refund_id,
      amountCents: current.amount,
    });
    return { action, authority, context: refundContext(action, authority, providerClaim) };
  });
}

async function verifyPreparedBinding(prepared: PreparedActionRefund): Promise<boolean> {
  return db.transaction(async (query) => {
    const current = await loadCurrentActionEscrow(query, prepared.action);
    if (
      !actionEscrowMatches(current, prepared.action)
      || current.state !== 'LOCKED_DISPUTE'
      || current.released_origin === true
      || current.stripe_transfer_id !== null
      || current.payout_provider !== null
      || current.provider_transfer_id !== null
      || current.provider_transfer_status !== null
      || current.provider_transfer_paid_at !== null
    ) {
      throw new Error(`Escrow ${current.id} changed before refund provider call`);
    }
    const authority = await requireClosedFullRefundAuthority(query, prepared.action);
    if (!exactAuthority(authority, prepared.authority)) {
      throw new Error(`Refund authority changed before provider call for escrow ${current.id}`);
    }
    return refundProviderCreateAllowed(query, prepared.context);
  });
}

function exactProviderRefundWitness(input: {
  prepared: PreparedActionRefund;
  provider: {
    refundId: string;
    amount: number;
    status: string;
    currency: string;
    paymentIntentId: string | null;
    chargeId: string | null;
  };
}): ExactSucceededRefundWitness {
  const paymentIntentId = input.prepared.context.stripePaymentIntentId;
  if (!paymentIntentId) {
    throw new Error(`Escrow ${input.prepared.context.escrowId} has no PaymentIntent`);
  }
  const witness = exactSucceededRefundWitness({
    escrowId: input.prepared.context.escrowId,
    taskId: input.prepared.context.taskId,
    canonicalState: input.prepared.context.stateBefore,
    paymentIntentId,
    expectedAmountCents: input.prepared.context.amount,
    provider: input.provider,
  });
  if (!witness) {
    throw new Error(
      `Refund ${input.provider.refundId} is not an exact current succeeded refund for escrow ${input.prepared.context.escrowId}`,
    );
  }
  return witness;
}

async function issueOrRecoverRefund(
  prepared: PreparedActionRefund,
): Promise<ExactSucceededRefundWitness> {
  const context = prepared.context;
  if (!context.stripePaymentIntentId) {
    throw new Error(`Escrow ${context.escrowId} has no stripe_payment_intent_id`);
  }
  const createAllowed = await verifyPreparedBinding(prepared);
  let providerOperation: 'read' | 'create' | 'discover';
  let result: Awaited<ReturnType<typeof StripeService.createRefund>>;
  if (context.stripeRefundId) {
    providerOperation = 'read';
    result = await StripeService.readRefundWitness(context.stripeRefundId);
  } else if (createAllowed) {
    providerOperation = 'create';
    result = await StripeService.createRefund({
      paymentIntentId: context.stripePaymentIntentId,
      escrowId: context.escrowId,
      amount: context.amount,
      reason: 'requested_by_customer',
      providerIdempotencyKey: context.providerClaim.providerIdempotencyKey,
      refundClaimKey: context.providerClaim.claimIdempotencyKey,
    });
  } else {
    providerOperation = 'discover';
    result = await StripeService.discoverRefundByClaim({
      paymentIntentId: context.stripePaymentIntentId,
      escrowId: context.escrowId,
      expectedAmountCents: context.amount,
      refundClaimKey: context.providerClaim.claimIdempotencyKey,
      providerIdempotencyKey: context.providerClaim.providerIdempotencyKey,
    });
  }
  if (!result.success) {
    if (providerOperation === 'create') {
      await db.transaction((query) => persistRefundProviderFailure(
        query,
        context,
        result.error.code,
      ));
    }
    throw new Error(
      `${providerOperation === 'discover' ? 'Refund discovery' : 'Refund provider evidence'} unavailable: ${result.error.message}`,
    );
  }
  const witness = exactProviderRefundWitness({ prepared, provider: result.data });
  await db.transaction((query) => persistExactSucceededRefundWitness(query, witness));
  return witness;
}

function actionRefundTerminalAuthority(input: {
  prepared: PreparedActionRefund;
  refundId: string;
}): { metadata: Record<string, unknown>; idempotencyKey: string } {
  const { context } = input.prepared;
  return {
    metadata: {
      event_type: 'action_refund_terminal_authority_v1',
      authority_origin: input.prepared.authority.origin,
      authority_id: input.prepared.authority.authorityId,
      authority_version: input.prepared.authority.authorityVersion,
      escrow_id: context.escrowId,
      task_id: context.taskId,
      canonical_version_before: context.version,
      task_version: context.taskVersion,
      task_state: context.taskState,
      worker_id: context.workerId,
      payment_intent_id: context.stripePaymentIntentId,
      refund_id: input.refundId,
      refund_amount_cents: context.amount,
      provider_claim_key: context.providerClaim.claimIdempotencyKey,
    },
    idempotencyKey:
      `action-refund-terminal-authority-v1:${context.escrowId}:${context.version}:${input.refundId}`,
  };
}

async function persistActionRefundTerminalAuthority(
  query: QueryFn,
  prepared: PreparedActionRefund,
  refundId: string,
): Promise<void> {
  const authority = actionRefundTerminalAuthority({ prepared, refundId });
  const result = await query<{ exact: boolean }>(
    `WITH attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,'LOCKED_DISPUTE','REFUNDED',NULL,'system',$2::jsonb,$3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata
     ), evidence AS (
       SELECT metadata FROM attempted
       UNION ALL
       SELECT event.metadata FROM escrow_events event
        WHERE event.escrow_id=$1
          AND event.from_state='LOCKED_DISPUTE' AND event.to_state='REFUNDED'
          AND event.actor_id IS NULL AND event.actor_type='system'
          AND event.idempotency_key=$3
          AND NOT EXISTS (SELECT 1 FROM attempted)
     )
     SELECT COUNT(*)=1 AS exact FROM evidence WHERE metadata=$2::jsonb`,
    [prepared.context.escrowId, JSON.stringify(authority.metadata), authority.idempotencyKey],
  );
  if (result.rows.length !== 1 || result.rows[0]?.exact !== true) {
    throw new Error(
      `Immutable action-refund terminal authority conflicts for escrow ${prepared.context.escrowId}`,
    );
  }
}

async function terminalizeActionRefund(
  prepared: PreparedActionRefund,
  witness: ExactSucceededRefundWitness,
): Promise<EscrowActionTerminalProof> {
  const terminal = await db.transaction(async (query) => {
    const current = await loadCurrentActionEscrow(query, prepared.action);
    if (actionEscrowMatches(current, prepared.action)) {
      const authority = await requireClosedFullRefundAuthority(query, prepared.action);
      if (!exactAuthority(authority, prepared.authority)) {
        throw new Error(`Refund authority changed during T2 for escrow ${current.id}`);
      }
      await persistActionRefundTerminalAuthority(query, prepared, witness.refundId);
    }
    return terminalizeRefund(query, prepared.context, witness.refundId);
  });
  if (!terminal.success) {
    throw new Error(`Refund terminalization failed: ${terminal.error.message}`);
  }
  if (
    terminal.data.state !== 'REFUNDED'
    || terminal.data.stripe_refund_id !== witness.refundId
  ) {
    throw new Error(`Refund terminalization returned inexact state for escrow ${prepared.context.escrowId}`);
  }
  return {
    escrowId: prepared.context.escrowId,
    taskId: prepared.context.taskId,
    terminalState: 'REFUNDED',
    providerOperationId: witness.refundId,
    evidence: 'EXACT_REFUND_TERMINALIZED_V1',
  };
}

function replayContext(
  action: EscrowActionInput,
  authority: ActionRefundAuthority,
): RefundContext {
  const priorVersion = action.escrow.version - 1;
  const providerClaim = {
    claimIdempotencyKey: refundProviderClaimKey(action.escrow.id, priorVersion),
    providerIdempotencyKey: refundProviderIdempotencyKey(action.escrow.id, priorVersion),
    providerReplayDeadline: new Date(0),
  };
  return {
    ...refundContext({
      ...action,
      escrow: {
        ...action.escrow,
        state: 'LOCKED_DISPUTE',
        version: priorVersion,
        stripe_refund_id: null,
      },
    }, authority, providerClaim),
    stripeRefundId: null,
  };
}

async function exactTerminalRefundEvidence(input: {
  action: EscrowActionInput;
  authority: ActionRefundAuthority;
  witness: ExactSucceededRefundWitness;
}): Promise<boolean> {
  const context = replayContext(input.action, input.authority);
  const prepared: PreparedActionRefund = {
    action: {
      ...input.action,
      escrow: {
        ...input.action.escrow,
        state: 'LOCKED_DISPUTE',
        version: context.version,
        stripe_refund_id: null,
      },
    },
    authority: input.authority,
    context,
  };
  const actionAuthority = actionRefundTerminalAuthority({
    prepared,
    refundId: input.witness.refundId,
  });
  const transitionMetadata = {
    event_type: 'escrow_refunded_transition_v1',
    escrow_id: context.escrowId,
    task_id: context.taskId,
    task_version: context.taskVersion,
    task_state: context.taskState,
    worker_id: context.workerId,
    payment_intent_id: context.stripePaymentIntentId,
    refund_id: input.witness.refundId,
    amount_cents: context.amount,
    canonical_version_before: context.version,
    canonical_version_after: input.action.escrow.version,
  };
  const resolutionMetadata = refundProviderResolutionMetadata(context, input.witness.refundId);
  const result = await db.query<{ exact: boolean }>(
    `SELECT (
       escrow.task_id=$2
       AND escrow.state='REFUNDED'
       AND escrow.version=$3
       AND escrow.amount=$4
       AND escrow.stripe_payment_intent_id=$5
       AND escrow.stripe_refund_id=$6
       AND escrow.refunded_at IS NOT NULL
       AND task.version=$7
       AND task.state=$8
       AND task.worker_id IS NOT DISTINCT FROM $9
       AND EXISTS (
         SELECT 1 FROM escrow_events claim
          WHERE claim.escrow_id=escrow.id
            AND claim.from_state='LOCKED_DISPUTE' AND claim.to_state='LOCKED_DISPUTE'
            AND claim.actor_id IS NULL AND claim.actor_type='system'
            AND claim.idempotency_key=$10
            AND jsonb_object_length(claim.metadata)=16
            AND claim.metadata->>'event_type'='refund_provider_create_claim_v1'
            AND claim.metadata->>'claim_idempotency_key'=$10
            AND claim.metadata->>'provider'='stripe'
            AND claim.metadata->>'escrow_id'=escrow.id::text
            AND claim.metadata->>'task_id'=escrow.task_id::text
            AND claim.metadata->>'canonical_state'='LOCKED_DISPUTE'
            AND claim.metadata->>'canonical_version'=$11::text
            AND claim.metadata->>'task_version'=$7::text
            AND claim.metadata->>'task_state'=$8
            AND claim.metadata->>'worker_id' IS NOT DISTINCT FROM $9::text
            AND claim.metadata->>'payment_intent_id'=$5
            AND claim.metadata->>'existing_refund_id' IS NULL
            AND claim.metadata->>'refund_amount_cents'=$4::text
            AND claim.metadata->>'currency'='usd'
            AND claim.metadata->>'provider_idempotency_key'=$12
            AND claim.metadata->>'provider_replay_deadline'=
                (to_jsonb(claim.created_at+INTERVAL '20 hours') #>> '{}')
       )
       AND EXISTS (
         SELECT 1 FROM escrow_events witness
          WHERE witness.escrow_id=escrow.id
            AND witness.from_state='LOCKED_DISPUTE' AND witness.to_state='LOCKED_DISPUTE'
            AND witness.actor_id IS NULL AND witness.actor_type='system'
            AND witness.idempotency_key='exact-succeeded-refund-v1:' || escrow.id::text || ':' || $6
            AND witness.metadata->>'event_type'='exact_succeeded_refund_witness_v1'
            AND witness.metadata->>'payment_intent_id'=$5
            AND witness.metadata->>'refund_id'=$6
            AND witness.metadata->>'amount_cents'=$4::text
            AND witness.metadata->>'currency'='usd'
            AND witness.metadata->>'status'='succeeded'
            AND NULLIF(witness.metadata->>'charge_id','') IS NOT NULL
       )
       AND EXISTS (
         SELECT 1 FROM escrow_events event
          WHERE event.escrow_id=escrow.id
            AND event.from_state='LOCKED_DISPUTE' AND event.to_state='REFUNDED'
            AND event.actor_id IS NULL AND event.actor_type='system'
            AND event.idempotency_key=$13 AND event.metadata=$14::jsonb
       )
       AND EXISTS (
         SELECT 1 FROM escrow_events resolution
          WHERE resolution.escrow_id=escrow.id
            AND resolution.from_state='LOCKED_DISPUTE' AND resolution.to_state='REFUNDED'
            AND resolution.actor_id IS NULL AND resolution.actor_type='system'
            AND resolution.idempotency_key=$15 AND resolution.metadata=$16::jsonb
       )
       AND EXISTS (
         SELECT 1 FROM escrow_events transition
          WHERE transition.escrow_id=escrow.id
            AND transition.from_state='LOCKED_DISPUTE' AND transition.to_state='REFUNDED'
            AND transition.actor_id IS NULL AND transition.actor_type='system'
            AND transition.idempotency_key=$17 AND transition.metadata=$18::jsonb
       )
     ) AS exact
       FROM escrows escrow JOIN tasks task ON task.id=escrow.task_id
      WHERE escrow.id=$1`,
    [
      context.escrowId,
      context.taskId,
      input.action.escrow.version,
      context.amount,
      context.stripePaymentIntentId,
      input.witness.refundId,
      context.taskVersion,
      context.taskState,
      context.workerId,
      context.providerClaim.claimIdempotencyKey,
      context.version,
      context.providerClaim.providerIdempotencyKey,
      actionAuthority.idempotencyKey,
      JSON.stringify(actionAuthority.metadata),
      refundProviderClaimResolvedKey(context.escrowId, context.version, input.witness.refundId),
      JSON.stringify(resolutionMetadata),
      `escrow-refunded-transition-v1:${context.escrowId}:${input.action.escrow.version}`,
      JSON.stringify(transitionMetadata),
    ],
  );
  return result.rows.length === 1 && result.rows[0]?.exact === true;
}

export async function reconcileTerminalRefundRequest(
  action: EscrowActionInput,
): Promise<EscrowActionTerminalProof> {
  const refundId = action.escrow.stripe_refund_id;
  if (
    action.escrow.state !== 'REFUNDED'
    || !refundId
    || !Number.isSafeInteger(action.escrow.version)
    || action.escrow.version < 1
  ) {
    throw new Error('Terminal refund replay lacks canonical REFUNDED identity');
  }
  const priorAction: EscrowActionInput = {
    ...action,
    escrow: {
      ...action.escrow,
      state: 'LOCKED_DISPUTE',
      version: action.escrow.version - 1,
      stripe_refund_id: null,
    },
  };
  const authority = await db.transaction((query) => (
    requireClosedFullRefundAuthority(query, priorAction)
  ));
  const provider = await StripeService.readRefundWitness(refundId);
  if (!provider.success) {
    throw new Error(`Stored refund ${refundId} cannot be verified: ${provider.error.message}`);
  }
  const prepared: PreparedActionRefund = {
    action: priorAction,
    authority,
    context: replayContext(action, authority),
  };
  const witness = exactProviderRefundWitness({ prepared, provider: provider.data });
  await db.transaction((query) => persistExactSucceededRefundWitness(query, witness));
  if (!await exactTerminalRefundEvidence({ action, authority, witness })) {
    throw new Error(`Terminal refund replay lacks exact immutable evidence for escrow ${action.escrow.id}`);
  }
  return {
    escrowId: action.escrow.id,
    taskId: action.taskId,
    terminalState: 'REFUNDED',
    providerOperationId: refundId,
    evidence: 'EXACT_REFUND_TERMINALIZED_V1',
  };
}

export async function handleRefundRequest(
  action: EscrowActionInput,
): Promise<EscrowActionTerminalProof> {
  const prepared = await prepareActionRefund(action);
  const witness = await issueOrRecoverRefund(prepared);
  const proof = await terminalizeActionRefund(prepared, witness);
  log.info(
    { escrowId: action.escrow.id, refundId: witness.refundId },
    'Refund provider truth and canonical REFUNDED state converged',
  );
  return proof;
}
