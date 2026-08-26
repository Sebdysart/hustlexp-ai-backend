import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { escrowLogger } from '../logger.js';
import { StripeService } from './StripeService.js';
import { loadCurrentTaskPayoutDestination } from './TaskPayoutDestinationService.js';
import type { StripeTransferWitness } from './EscrowReleaseTypes.js';

export const PARTIAL_REFUND_RECONCILIATION_CODE =
  'PARTIAL_REFUND_RECONCILIATION_REQUIRED';

const CLAIM_EVENT = 'partial_refund_provider_claim_v2';
const CHECKPOINT_EVENT = 'partial_refund_provider_checkpoint_v3';
const TRANSFER_CLAIM_EVENT = 'partial_refund_transfer_claim_v1';
const TRANSFER_CHECKPOINT_EVENT = 'partial_refund_transfer_checkpoint_v1';
const TRANSFER_RECOVERY_EVENT = 'partial_refund_transfer_recovery_v1';
const PROVIDER_EXCEPTION_EVENT = 'partial_refund_provider_exception_v1';
const TERMINAL_TRANSITION_EVENT = 'partial_refund_terminal_transition_v1';

// Stripe API-v1 idempotency records are not a permanent ledger. Keep automated
// replay comfortably inside the documented minimum retention period; after the
// deadline the only safe path is read-only processor reconciliation by identity.
export const PARTIAL_REFUND_PROVIDER_REPLAY_WINDOW_MS = 20 * 60 * 60 * 1_000;
const MAX_CLAIM_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type PartialRefundTransferFailureStage =
  | 'TRANSFER_CHECKPOINT_FAILED'
  | 'CANONICAL_T2_FAILED'
  | 'POST_TERMINAL_EFFECT_FAILED';

export interface PartialRefundBinding {
  escrowId: string;
  escrowVersion: number;
  taskId: string;
  disputeId: string | null;
  escrowAmountCents: number;
  canonicalPlatformFeeCents: number | null;
  paymentIntentId: string;
  existingTransferId: string | null;
  existingRefundId: string | null;
  refundAmountCents: number;
  releaseAmountCents: number;
  splitPlatformFeeCents: number;
  platformFeeBasisPoints: number;
  insuranceContributionCents: number;
  netReleaseAmountCents: number;
  xpClawbackFraction: number;
  workerId: string | null;
  payoutRecipientUserId: string | null;
  providerOrganizationId: string | null;
  providerAssignmentId: string | null;
  posterId: string | null;
  destinationAccountId: string | null;
  payoutDestinationError: string | null;
}

export interface PartialRefundProcessorWitness {
  refundId: string;
  amount: number;
  status: string;
  currency: string;
  paymentIntentId: string | null;
  chargeId: string | null;
}

export interface PartialRefundTerminalProviderEvidence {
  refundWitness: PartialRefundProcessorWitness;
  transferWitness: StripeTransferWitness;
  transferCreated: boolean;
}

export interface PartialRefundTerminalEvidence {
  binding: PartialRefundBinding;
  provider: PartialRefundTerminalProviderEvidence;
}

export interface PartialRefundT2ProviderEvidence {
  refundId: string | null;
  transferId: string | null;
  transferWitness: StripeTransferWitness | null;
  transferCreated: boolean;
}

interface LockedEscrowRow {
  version: number;
  state: string;
  task_id: string;
  amount: number;
  platform_fee_cents: number | null;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
  refund_amount: number | null;
  release_amount: number | null;
}

interface TaskBindingRow {
  worker_id: string | null;
  payout_recipient_user_id: string | null;
  provider_organization_id: string | null;
  provider_assignment_id: string | null;
  poster_id: string | null;
}

interface DisputeBindingRow {
  state: string;
  escrow_id: string;
  task_id: string;
  outcome_escrow_action: string | null;
  outcome_refund_amount: number | null;
  outcome_release_amount: number | null;
}

interface ObservedEscrowRow extends LockedEscrowRow {
  id: string;
}

export function partialRefundReconciliationError(message: string): Error & {
  code: typeof PARTIAL_REFUND_RECONCILIATION_CODE;
  details: Record<string, unknown>;
} {
  const error = new Error(message) as Error & {
    code: typeof PARTIAL_REFUND_RECONCILIATION_CODE;
    details: Record<string, unknown>;
  };
  error.code = PARTIAL_REFUND_RECONCILIATION_CODE;
  error.details = { reconciliationRequired: true };
  return error;
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
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  return expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index]
      && Object.is(actual[key], expected[key]));
}

function requiredString(
  metadata: Record<string, unknown>,
  key: string,
): string {
  const value = metadata[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw partialRefundReconciliationError(
      `partialRefund: evidence field ${key} is not an exact string`,
    );
  }
  return value;
}

function nullableString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  if (value === null) return null;
  return requiredString(metadata, key);
}

function exactInteger(
  metadata: Record<string, unknown>,
  key: string,
): number {
  const value = metadata[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw partialRefundReconciliationError(
      `partialRefund: evidence field ${key} is not an exact integer`,
    );
  }
  return value;
}

function nullableInteger(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  if (metadata[key] === null) return null;
  return exactInteger(metadata, key);
}

function exactNumber(
  metadata: Record<string, unknown>,
  key: string,
): number {
  const value = metadata[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw partialRefundReconciliationError(
      `partialRefund: evidence field ${key} is not an exact number`,
    );
  }
  return value;
}

export function partialRefundClaimIdempotencyKey(escrowId: string): string {
  return `partial-refund-provider-claim:${escrowId}`;
}

export function partialRefundCheckpointIdempotencyKey(escrowId: string): string {
  return `partial-refund-provider-checkpoint:${escrowId}`;
}

export function partialRefundTransferClaimIdempotencyKey(escrowId: string): string {
  return `partial-refund-transfer-claim:${escrowId}`;
}

export function partialRefundTerminalTransitionIdempotencyKey(
  escrowId: string,
  terminalVersion: number,
): string {
  return `partial-refund-terminal-transition:${escrowId}:${terminalVersion}`;
}

export function partialRefundBindingMetadata(
  binding: PartialRefundBinding,
): Record<string, unknown> {
  return {
    provider: 'stripe',
    escrow_id: binding.escrowId,
    escrow_version: binding.escrowVersion,
    task_id: binding.taskId,
    dispute_id: binding.disputeId,
    escrow_amount_cents: binding.escrowAmountCents,
    canonical_platform_fee_cents: binding.canonicalPlatformFeeCents,
    stripe_payment_intent_id: binding.paymentIntentId,
    canonical_transfer_id: binding.existingTransferId,
    canonical_refund_id: binding.existingRefundId,
    poster_refund_amount_cents: binding.refundAmountCents,
    worker_settlement_gross_cents: binding.releaseAmountCents,
    split_platform_fee_cents: binding.splitPlatformFeeCents,
    platform_fee_basis_points: binding.platformFeeBasisPoints,
    insurance_contribution_cents: binding.insuranceContributionCents,
    worker_settlement_net_cents: binding.netReleaseAmountCents,
    xp_clawback_fraction: binding.xpClawbackFraction,
    worker_id: binding.workerId,
    payout_recipient_user_id: binding.payoutRecipientUserId,
    provider_organization_id: binding.providerOrganizationId,
    provider_assignment_id: binding.providerAssignmentId,
    poster_id: binding.posterId,
    destination_account_id: binding.destinationAccountId,
    payout_destination_error: binding.payoutDestinationError,
    blocked_lane: 'settlement_transfer',
    settlement_transfer_preexisting: binding.existingTransferId !== null,
    reconciliation_required: true,
    claim_idempotency_key: partialRefundClaimIdempotencyKey(binding.escrowId),
  };
}

export function partialRefundClaimMetadata(
  binding: PartialRefundBinding,
): Record<string, unknown> {
  return { event_type: CLAIM_EVENT, ...partialRefundBindingMetadata(binding) };
}

export function partialRefundTransferClaimMetadata(
  binding: PartialRefundBinding,
): Record<string, unknown> {
  return { event_type: TRANSFER_CLAIM_EVENT, ...partialRefundBindingMetadata(binding) };
}

function requireReplayableClaim(
  createdAt: unknown,
  operation: 'refund' | 'transfer',
  escrowId: string,
): void {
  const claimedAt = createdAt instanceof Date
    ? createdAt.getTime()
    : typeof createdAt === 'string'
      ? Date.parse(createdAt)
      : Number.NaN;
  const now = Date.now();
  if (
    !Number.isFinite(claimedAt)
    || claimedAt > now + MAX_CLAIM_CLOCK_SKEW_MS
    || now - claimedAt >= PARTIAL_REFUND_PROVIDER_REPLAY_WINDOW_MS
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: ${operation} claim for escrow ${escrowId} is outside the safe provider idempotency replay window`,
    );
  }
}

function bindingFromClaimMetadata(
  metadata: Record<string, unknown>,
): PartialRefundBinding {
  const binding: PartialRefundBinding = {
    escrowId: requiredString(metadata, 'escrow_id'),
    escrowVersion: exactInteger(metadata, 'escrow_version'),
    taskId: requiredString(metadata, 'task_id'),
    disputeId: nullableString(metadata, 'dispute_id'),
    escrowAmountCents: exactInteger(metadata, 'escrow_amount_cents'),
    canonicalPlatformFeeCents: nullableInteger(metadata, 'canonical_platform_fee_cents'),
    paymentIntentId: requiredString(metadata, 'stripe_payment_intent_id'),
    existingTransferId: nullableString(metadata, 'canonical_transfer_id'),
    existingRefundId: nullableString(metadata, 'canonical_refund_id'),
    refundAmountCents: exactInteger(metadata, 'poster_refund_amount_cents'),
    releaseAmountCents: exactInteger(metadata, 'worker_settlement_gross_cents'),
    splitPlatformFeeCents: exactInteger(metadata, 'split_platform_fee_cents'),
    platformFeeBasisPoints: exactInteger(metadata, 'platform_fee_basis_points'),
    insuranceContributionCents: exactInteger(metadata, 'insurance_contribution_cents'),
    netReleaseAmountCents: exactInteger(metadata, 'worker_settlement_net_cents'),
    xpClawbackFraction: exactNumber(metadata, 'xp_clawback_fraction'),
    workerId: nullableString(metadata, 'worker_id'),
    payoutRecipientUserId: nullableString(metadata, 'payout_recipient_user_id'),
    providerOrganizationId: nullableString(metadata, 'provider_organization_id'),
    providerAssignmentId: nullableString(metadata, 'provider_assignment_id'),
    posterId: nullableString(metadata, 'poster_id'),
    destinationAccountId: nullableString(metadata, 'destination_account_id'),
    payoutDestinationError: nullableString(metadata, 'payout_destination_error'),
  };
  if (
    binding.refundAmountCents <= 0
    || binding.releaseAmountCents <= 0
    || binding.refundAmountCents + binding.releaseAmountCents !== binding.escrowAmountCents
    || binding.splitPlatformFeeCents < 0
    || binding.insuranceContributionCents < 0
    || binding.netReleaseAmountCents <= 0
    || binding.platformFeeBasisPoints < 0
    || binding.xpClawbackFraction <= 0
    || binding.xpClawbackFraction >= 1
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: claim evidence carries an invalid economic binding for escrow ${binding.escrowId}`,
    );
  }
  if (!exactMetadata(metadata, partialRefundClaimMetadata(binding))) {
    throw partialRefundReconciliationError(
      `partialRefund: claim evidence conflicts for escrow ${binding.escrowId}`,
    );
  }
  return binding;
}

export function partialRefundCheckpointMetadata(
  binding: PartialRefundBinding,
  witness: PartialRefundProcessorWitness,
): Record<string, unknown> {
  return {
    event_type: CHECKPOINT_EVENT,
    ...partialRefundBindingMetadata(binding),
    stripe_refund_id: witness.refundId,
    stripe_refund_amount_cents: witness.amount,
    stripe_refund_status: witness.status,
    stripe_refund_currency: witness.currency,
    stripe_refund_payment_intent_id: witness.paymentIntentId,
    stripe_refund_charge_id: witness.chargeId,
  };
}

function transferWitnessMetadata(
  witness: StripeTransferWitness,
): Record<string, unknown> {
  return {
    stripe_transfer_id: witness.transferId,
    stripe_transfer_amount_cents: witness.amountCents,
    stripe_transfer_currency: witness.currency,
    stripe_transfer_destination_account_id: witness.destinationAccountId,
    stripe_transfer_reversed: witness.reversed,
    stripe_transfer_amount_reversed_cents: witness.amountReversedCents,
    stripe_transfer_escrow_id: witness.escrowId,
    stripe_transfer_task_id: witness.taskId,
    stripe_transfer_payout_recipient_user_id: witness.payoutRecipientUserId,
  };
}

export function partialRefundTransferCheckpointIdempotencyKey(
  escrowId: string,
): string {
  return `partial-refund-transfer-checkpoint:${escrowId}`;
}

export function partialRefundTransferCheckpointMetadata(input: {
  binding: PartialRefundBinding;
  witness: StripeTransferWitness;
  transferCreated: boolean;
}): Record<string, unknown> {
  return {
    event_type: TRANSFER_CHECKPOINT_EVENT,
    ...partialRefundBindingMetadata(input.binding),
    ...transferWitnessMetadata(input.witness),
    transfer_created_in_attempt: input.transferCreated,
    canonical_convergence_pending: true,
  };
}

function escrowMatches(row: LockedEscrowRow, binding: PartialRefundBinding): boolean {
  return row.version === binding.escrowVersion
    && row.state === 'LOCKED_DISPUTE'
    && row.task_id === binding.taskId
    && row.amount === binding.escrowAmountCents
    && (row.platform_fee_cents ?? null) === binding.canonicalPlatformFeeCents
    && row.stripe_payment_intent_id === binding.paymentIntentId
    && (row.stripe_transfer_id ?? null) === binding.existingTransferId
    && (row.stripe_refund_id ?? null) === binding.existingRefundId
    && (row.refund_amount ?? null) === null
    && (row.release_amount ?? null) === null;
}

function taskMatches(row: TaskBindingRow, binding: PartialRefundBinding): boolean {
  return (row.worker_id ?? null) === binding.workerId
    && (row.payout_recipient_user_id ?? row.worker_id) === binding.payoutRecipientUserId
    && (row.provider_organization_id ?? null) === binding.providerOrganizationId
    && (row.provider_assignment_id ?? null) === binding.providerAssignmentId
    && (row.poster_id ?? null) === binding.posterId;
}

async function requireExactDispute(
  query: QueryFn,
  binding: PartialRefundBinding,
): Promise<void> {
  if (!binding.disputeId) return;
  const result = await query<DisputeBindingRow>(
    `SELECT state,escrow_id,task_id,outcome_escrow_action,
            outcome_refund_amount,outcome_release_amount
       FROM disputes WHERE id=$1 FOR SHARE`,
    [binding.disputeId],
  );
  const row = result.rows[0];
  if (
    !row
    || row.state !== 'RESOLVED'
    || row.escrow_id !== binding.escrowId
    || row.task_id !== binding.taskId
    || row.outcome_escrow_action !== 'SPLIT'
    || row.outcome_refund_amount !== binding.refundAmountCents
    || row.outcome_release_amount !== binding.releaseAmountCents
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: dispute ${binding.disputeId} does not exactly authorize this split`,
    );
  }
}

export async function lockExactPartialRefundBinding(
  query: QueryFn,
  binding: PartialRefundBinding,
  nowait = false,
): Promise<void> {
  let escrowResult;
  try {
    escrowResult = await query<LockedEscrowRow>(
      `SELECT version,state,task_id,amount,platform_fee_cents,
              stripe_payment_intent_id,stripe_transfer_id,stripe_refund_id,
              refund_amount,release_amount
         FROM escrows WHERE id=$1 FOR UPDATE${nowait ? ' NOWAIT' : ''}`,
      [binding.escrowId],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw partialRefundReconciliationError(
      `partialRefund: could not lock exact escrow binding (${message})`,
    );
  }
  const escrow = escrowResult.rows[0];
  if (!escrow || !escrowMatches(escrow, binding)) {
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${binding.escrowId} changed from its Phase-1 binding`,
    );
  }

  const taskResult = await query<TaskBindingRow>(
    `SELECT worker_id,payout_recipient_user_id,provider_organization_id,
            provider_assignment_id,poster_id
       FROM tasks WHERE id=$1 FOR SHARE`,
    [binding.taskId],
  );
  const task = taskResult.rows[0];
  if (!task || !taskMatches(task, binding)) {
    throw partialRefundReconciliationError(
      `partialRefund: task ${binding.taskId} changed from its Phase-1 payout binding`,
    );
  }

  if (binding.releaseAmountCents > 0) {
    if (!binding.workerId || !binding.payoutRecipientUserId) {
      throw partialRefundReconciliationError(
        `partialRefund: task ${binding.taskId} has no exact payout recipient`,
      );
    }
    const destination = await loadCurrentTaskPayoutDestination(query, {
      taskId: binding.taskId,
      workerId: binding.workerId,
      payoutRecipientUserId: binding.payoutRecipientUserId,
    });
    const destinationId = destination.ready ? destination.stripeConnectId : null;
    const destinationError = destination.ready ? null : destination.reason;
    if (
      destinationId !== binding.destinationAccountId
      || destinationError !== binding.payoutDestinationError
    ) {
      throw partialRefundReconciliationError(
        `partialRefund: payout destination for task ${binding.taskId} changed from Phase 1`,
      );
    }
  }

  await requireExactDispute(query, binding);
}

function exactRefundWitness(
  witness: PartialRefundProcessorWitness,
  binding: PartialRefundBinding,
): boolean {
  return typeof witness.refundId === 'string'
    && witness.refundId.length > 0
    && witness.amount === binding.refundAmountCents
    && witness.status === 'succeeded'
    && witness.currency === 'usd'
    && witness.paymentIntentId === binding.paymentIntentId
    && typeof witness.chargeId === 'string'
    && witness.chargeId.length > 0;
}

export function requireExactPartialRefundWitness(
  witness: PartialRefundProcessorWitness,
  binding: PartialRefundBinding,
): PartialRefundProcessorWitness {
  if (!exactRefundWitness(witness, binding)) {
    throw partialRefundReconciliationError(
      `partialRefund: processor refund does not exactly match escrow ${binding.escrowId}`,
    );
  }
  return witness;
}

async function loadCheckpoint(
  binding: PartialRefundBinding,
): Promise<PartialRefundProcessorWitness | null> {
  const idempotencyKey = partialRefundCheckpointIdempotencyKey(binding.escrowId);
  const result = await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM escrow_events
      WHERE escrow_id=$1 AND idempotency_key=$2
        AND from_state='LOCKED_DISPUTE' AND to_state='LOCKED_DISPUTE'
        AND actor_id IS NULL AND actor_type='system'`,
    [binding.escrowId, idempotencyKey],
  );
  if (result.rows.length === 0) return null;
  const metadata = metadataRecord(result.rows[0]?.metadata);
  const witness: PartialRefundProcessorWitness = {
    refundId: typeof metadata?.stripe_refund_id === 'string'
      ? metadata.stripe_refund_id : '',
    amount: Number(metadata?.stripe_refund_amount_cents),
    status: typeof metadata?.stripe_refund_status === 'string'
      ? metadata.stripe_refund_status : '',
    currency: typeof metadata?.stripe_refund_currency === 'string'
      ? metadata.stripe_refund_currency : '',
    paymentIntentId: typeof metadata?.stripe_refund_payment_intent_id === 'string'
      ? metadata.stripe_refund_payment_intent_id : null,
    chargeId: typeof metadata?.stripe_refund_charge_id === 'string'
      ? metadata.stripe_refund_charge_id : null,
  };
  if (
    result.rows.length !== 1
    || !exactRefundWitness(witness, binding)
    || !exactMetadata(metadata, partialRefundCheckpointMetadata(binding, witness))
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: provider checkpoint conflicts for escrow ${binding.escrowId}`,
    );
  }
  if (binding.existingRefundId && binding.existingRefundId !== witness.refundId) {
    throw partialRefundReconciliationError(
      `partialRefund: canonical refund conflicts with checkpoint for escrow ${binding.escrowId}`,
    );
  }
  escrowLogger.info(
    { escrowId: binding.escrowId, stripeRefundId: witness.refundId },
    'partialRefund: reusing exact processor checkpoint',
  );
  return witness;
}

export async function acquireOrLoadPartialRefundCheckpoint(
  binding: PartialRefundBinding,
): Promise<PartialRefundProcessorWitness | null> {
  const metadata = partialRefundClaimMetadata(binding);
  const idempotencyKey = partialRefundClaimIdempotencyKey(binding.escrowId);
  const claim = await db.transaction(async (query) => {
    await lockExactPartialRefundBinding(query, binding);
    const inserted = await query<{ metadata: unknown; created_at: Date | string }>(
      `INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,'LOCKED_DISPUTE','LOCKED_DISPUTE',NULL,'system',$2::jsonb,$3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata,created_at`,
      [binding.escrowId, JSON.stringify(metadata), idempotencyKey],
    );
    if ((inserted.rowCount ?? 0) === 1) {
      if (!exactMetadata(inserted.rows[0]?.metadata, metadata)) {
        throw partialRefundReconciliationError(
          `partialRefund: provider claim write was not exact for escrow ${binding.escrowId}`,
        );
      }
      return { acquired: true, createdAt: inserted.rows[0]?.created_at };
    }
    const existing = await query<{ metadata: unknown; created_at: Date | string }>(
      `SELECT metadata,created_at FROM escrow_events
        WHERE escrow_id=$1 AND idempotency_key=$2
          AND from_state='LOCKED_DISPUTE' AND to_state='LOCKED_DISPUTE'
          AND actor_id IS NULL AND actor_type='system'`,
      [binding.escrowId, idempotencyKey],
    );
    if (existing.rows.length !== 1 || !exactMetadata(existing.rows[0]?.metadata, metadata)) {
      throw partialRefundReconciliationError(
        `partialRefund: provider claim conflicts for escrow ${binding.escrowId}`,
      );
    }
    return { acquired: false, createdAt: existing.rows[0]?.created_at };
  });

  const checkpoint = await loadCheckpoint(binding);
  if (checkpoint) return checkpoint;
  if (binding.existingRefundId) {
    throw partialRefundReconciliationError(
      `partialRefund: existing refund ${binding.existingRefundId} lacks an exact checkpoint`,
    );
  }
  if (!claim.acquired) {
    requireReplayableClaim(claim.createdAt, 'refund', binding.escrowId);
    escrowLogger.warn(
      { escrowId: binding.escrowId },
      'partialRefund: exact claim has no checkpoint — replaying the deterministic provider request',
    );
  }
  return null;
}

export async function checkpointPartialRefund(
  binding: PartialRefundBinding,
  witnessInput: PartialRefundProcessorWitness,
): Promise<void> {
  const witness = requireExactPartialRefundWitness(witnessInput, binding);
  const metadata = partialRefundCheckpointMetadata(binding, witness);
  const idempotencyKey = partialRefundCheckpointIdempotencyKey(binding.escrowId);
  let result: { rowCount: number | null; rows: Array<{ metadata: unknown }> };
  try {
    result = await db.query<{ metadata: unknown }>(
      `INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,'LOCKED_DISPUTE','LOCKED_DISPUTE',NULL,'system',$2::jsonb,$3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata`,
      [binding.escrowId, JSON.stringify(metadata), idempotencyKey],
    );
  } catch (error) {
    throw partialRefundReconciliationError(
      `partialRefund: refund ${witness.refundId} checkpoint write failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if ((result.rowCount ?? 0) === 0) {
    result = await db.query<{ metadata: unknown }>(
      `SELECT metadata FROM escrow_events
        WHERE escrow_id=$1 AND idempotency_key=$2
          AND from_state='LOCKED_DISPUTE' AND to_state='LOCKED_DISPUTE'
          AND actor_id IS NULL AND actor_type='system'`,
      [binding.escrowId, idempotencyKey],
    );
  }
  if (result.rows.length !== 1 || !exactMetadata(result.rows[0]?.metadata, metadata)) {
    throw partialRefundReconciliationError(
      `partialRefund: exact checkpoint could not be persisted for escrow ${binding.escrowId}`,
    );
  }
}

function exactCurrentTransferWitness(
  witness: StripeTransferWitness,
  binding: PartialRefundBinding,
  transferId: string,
): boolean {
  return witness.provider === 'STRIPE'
    && witness.transferId === transferId
    && witness.escrowId === binding.escrowId
    && witness.taskId === binding.taskId
    && witness.payoutRecipientUserId === binding.payoutRecipientUserId
    && witness.destinationAccountId === binding.destinationAccountId
    && witness.currency === 'usd'
    && witness.amountCents === binding.netReleaseAmountCents
    && witness.reversed === false
    && witness.amountReversedCents === 0;
}

async function loadPartialRefundTransferCheckpoint(
  binding: PartialRefundBinding,
): Promise<{ witness: StripeTransferWitness; transferCreated: boolean } | null> {
  const idempotencyKey = partialRefundTransferCheckpointIdempotencyKey(binding.escrowId);
  const result = await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM escrow_events
      WHERE escrow_id=$1 AND idempotency_key=$2
        AND from_state='LOCKED_DISPUTE' AND to_state='LOCKED_DISPUTE'
        AND actor_id IS NULL AND actor_type='system'`,
    [binding.escrowId, idempotencyKey],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw partialRefundReconciliationError(
      `partialRefund: exact transfer checkpoint is missing for escrow ${binding.escrowId}`,
    );
  }
  const metadata = metadataRecord(result.rows[0]?.metadata);
  if (!metadata) {
    throw partialRefundReconciliationError(
      `partialRefund: transfer checkpoint metadata is malformed for escrow ${binding.escrowId}`,
    );
  }
  const transferCreated = metadata.transfer_created_in_attempt;
  if (typeof transferCreated !== 'boolean') {
    throw partialRefundReconciliationError(
      `partialRefund: transfer checkpoint creation flag is malformed for escrow ${binding.escrowId}`,
    );
  }
  const witness: StripeTransferWitness = {
    provider: 'STRIPE',
    transferId: requiredString(metadata, 'stripe_transfer_id'),
    amountCents: exactInteger(metadata, 'stripe_transfer_amount_cents'),
    currency: requiredString(metadata, 'stripe_transfer_currency'),
    destinationAccountId: requiredString(metadata, 'stripe_transfer_destination_account_id'),
    reversed: metadata.stripe_transfer_reversed === true,
    amountReversedCents: exactInteger(metadata, 'stripe_transfer_amount_reversed_cents'),
    escrowId: requiredString(metadata, 'stripe_transfer_escrow_id'),
    taskId: requiredString(metadata, 'stripe_transfer_task_id'),
    payoutRecipientUserId: requiredString(
      metadata,
      'stripe_transfer_payout_recipient_user_id',
    ),
  };
  if (
    typeof metadata.stripe_transfer_reversed !== 'boolean'
    || !exactCurrentTransferWitness(witness, binding, witness.transferId)
    || !exactMetadata(
      metadata,
      partialRefundTransferCheckpointMetadata({ binding, witness, transferCreated }),
    )
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: transfer checkpoint conflicts for escrow ${binding.escrowId}`,
    );
  }
  if (binding.existingTransferId && binding.existingTransferId !== witness.transferId) {
    throw partialRefundReconciliationError(
      `partialRefund: canonical transfer conflicts with its checkpoint for escrow ${binding.escrowId}`,
    );
  }
  return { witness, transferCreated };
}

export async function lockExactPartialRefundT2Evidence(
  query: QueryFn,
  binding: PartialRefundBinding,
  provider: PartialRefundT2ProviderEvidence,
): Promise<PartialRefundTerminalProviderEvidence> {
  const keys = [
    partialRefundClaimIdempotencyKey(binding.escrowId),
    partialRefundCheckpointIdempotencyKey(binding.escrowId),
    partialRefundTransferClaimIdempotencyKey(binding.escrowId),
    partialRefundTransferCheckpointIdempotencyKey(binding.escrowId),
  ];
  const result = await query<{ idempotency_key: string; metadata: unknown }>(
    `SELECT idempotency_key,metadata
       FROM escrow_events
      WHERE escrow_id=$1
        AND idempotency_key=ANY($2::text[])
        AND from_state='LOCKED_DISPUTE' AND to_state='LOCKED_DISPUTE'
        AND actor_id IS NULL AND actor_type='system'
      FOR SHARE`,
    [binding.escrowId, keys],
  );
  if (result.rows.length !== keys.length) {
    throw partialRefundReconciliationError(
      `partialRefund: T2 for escrow ${binding.escrowId} lacks all four exact provider evidence rows`,
    );
  }
  const rows = new Map(result.rows.map((row) => [row.idempotency_key, row.metadata]));
  if (
    rows.size !== keys.length
    || !exactMetadata(
      rows.get(partialRefundClaimIdempotencyKey(binding.escrowId)),
      partialRefundClaimMetadata(binding),
    )
    || !exactMetadata(
      rows.get(partialRefundTransferClaimIdempotencyKey(binding.escrowId)),
      partialRefundTransferClaimMetadata(binding),
    )
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: T2 claim evidence conflicts for escrow ${binding.escrowId}`,
    );
  }

  const refundMetadata = metadataRecord(
    rows.get(partialRefundCheckpointIdempotencyKey(binding.escrowId)),
  );
  if (!refundMetadata) {
    throw partialRefundReconciliationError(
      `partialRefund: T2 refund evidence is malformed for escrow ${binding.escrowId}`,
    );
  }
  const refundWitness: PartialRefundProcessorWitness = {
    refundId: requiredString(refundMetadata, 'stripe_refund_id'),
    amount: exactInteger(refundMetadata, 'stripe_refund_amount_cents'),
    status: requiredString(refundMetadata, 'stripe_refund_status'),
    currency: requiredString(refundMetadata, 'stripe_refund_currency'),
    paymentIntentId: nullableString(refundMetadata, 'stripe_refund_payment_intent_id'),
    chargeId: nullableString(refundMetadata, 'stripe_refund_charge_id'),
  };
  if (
    provider.refundId !== refundWitness.refundId
    || !exactRefundWitness(refundWitness, binding)
    || !exactMetadata(
      refundMetadata,
      partialRefundCheckpointMetadata(binding, refundWitness),
    )
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: T2 refund identity conflicts for escrow ${binding.escrowId}`,
    );
  }

  const transferMetadata = metadataRecord(
    rows.get(partialRefundTransferCheckpointIdempotencyKey(binding.escrowId)),
  );
  if (!transferMetadata || typeof transferMetadata.transfer_created_in_attempt !== 'boolean') {
    throw partialRefundReconciliationError(
      `partialRefund: T2 transfer evidence is malformed for escrow ${binding.escrowId}`,
    );
  }
  const transferWitness: StripeTransferWitness = {
    provider: 'STRIPE',
    transferId: requiredString(transferMetadata, 'stripe_transfer_id'),
    amountCents: exactInteger(transferMetadata, 'stripe_transfer_amount_cents'),
    currency: requiredString(transferMetadata, 'stripe_transfer_currency'),
    destinationAccountId: requiredString(
      transferMetadata,
      'stripe_transfer_destination_account_id',
    ),
    reversed: transferMetadata.stripe_transfer_reversed === true,
    amountReversedCents: exactInteger(
      transferMetadata,
      'stripe_transfer_amount_reversed_cents',
    ),
    escrowId: requiredString(transferMetadata, 'stripe_transfer_escrow_id'),
    taskId: requiredString(transferMetadata, 'stripe_transfer_task_id'),
    payoutRecipientUserId: requiredString(
      transferMetadata,
      'stripe_transfer_payout_recipient_user_id',
    ),
  };
  const transferCreated = transferMetadata.transfer_created_in_attempt;
  if (
    typeof transferMetadata.stripe_transfer_reversed !== 'boolean'
    || provider.transferId !== transferWitness.transferId
    || provider.transferCreated !== transferCreated
    || !provider.transferWitness
    || !exactCurrentTransferWitness(transferWitness, binding, transferWitness.transferId)
    || !exactCurrentTransferWitness(
      provider.transferWitness,
      binding,
      transferWitness.transferId,
    )
    || !exactMetadata(
      transferWitnessMetadata(provider.transferWitness),
      transferWitnessMetadata(transferWitness),
    )
    || !exactMetadata(
      transferMetadata,
      partialRefundTransferCheckpointMetadata({ binding, witness: transferWitness, transferCreated }),
    )
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: T2 transfer identity conflicts for escrow ${binding.escrowId}`,
    );
  }
  return { refundWitness, transferWitness, transferCreated };
}

export function partialRefundTerminalTransitionMetadata(input: {
  binding: PartialRefundBinding;
  provider: PartialRefundTerminalProviderEvidence;
}): Record<string, unknown> {
  return {
    event_type: TERMINAL_TRANSITION_EVENT,
    ...partialRefundBindingMetadata(input.binding),
    stripe_refund_id: input.provider.refundWitness.refundId,
    stripe_refund_amount_cents: input.provider.refundWitness.amount,
    stripe_refund_status: input.provider.refundWitness.status,
    stripe_refund_currency: input.provider.refundWitness.currency,
    stripe_refund_payment_intent_id: input.provider.refundWitness.paymentIntentId,
    stripe_refund_charge_id: input.provider.refundWitness.chargeId,
    ...transferWitnessMetadata(input.provider.transferWitness),
    transfer_created_in_attempt: input.provider.transferCreated,
    terminal_state: 'REFUND_PARTIAL',
    terminal_escrow_version: input.binding.escrowVersion + 1,
  };
}

export async function recordExactPartialRefundTerminalTransition(
  query: QueryFn,
  binding: PartialRefundBinding,
  provider: PartialRefundTerminalProviderEvidence,
): Promise<void> {
  const metadata = partialRefundTerminalTransitionMetadata({ binding, provider });
  const idempotencyKey = partialRefundTerminalTransitionIdempotencyKey(
    binding.escrowId,
    binding.escrowVersion + 1,
  );
  let result = await query<{ metadata: unknown }>(
    `INSERT INTO escrow_events
       (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
     VALUES ($1,'LOCKED_DISPUTE','REFUND_PARTIAL',NULL,'system',$2::jsonb,$3)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING metadata`,
    [binding.escrowId, JSON.stringify(metadata), idempotencyKey],
  );
  if ((result.rowCount ?? 0) === 0) {
    result = await query<{ metadata: unknown }>(
      `SELECT metadata FROM escrow_events
        WHERE escrow_id=$1 AND idempotency_key=$2
          AND from_state='LOCKED_DISPUTE' AND to_state='REFUND_PARTIAL'
          AND actor_id IS NULL AND actor_type='system'`,
      [binding.escrowId, idempotencyKey],
    );
  }
  if (result.rows.length !== 1 || !exactMetadata(result.rows[0]?.metadata, metadata)) {
    throw partialRefundReconciliationError(
      `partialRefund: exact terminal transition witness conflicts for escrow ${binding.escrowId}`,
    );
  }
}

async function requireExactPartialRefundTerminalTransition(
  binding: PartialRefundBinding,
  provider: PartialRefundTerminalProviderEvidence,
): Promise<void> {
  const idempotencyKey = partialRefundTerminalTransitionIdempotencyKey(
    binding.escrowId,
    binding.escrowVersion + 1,
  );
  const result = await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM escrow_events
      WHERE escrow_id=$1 AND idempotency_key=$2
        AND from_state='LOCKED_DISPUTE' AND to_state='REFUND_PARTIAL'
        AND actor_id IS NULL AND actor_type='system'`,
    [binding.escrowId, idempotencyKey],
  );
  const expected = partialRefundTerminalTransitionMetadata({ binding, provider });
  if (result.rows.length !== 1 || !exactMetadata(result.rows[0]?.metadata, expected)) {
    throw partialRefundReconciliationError(
      `partialRefund: terminal transition witness is missing or conflicting for escrow ${binding.escrowId}`,
    );
  }
}

export async function acquireOrLoadPartialRefundTransferCheckpoint(
  binding: PartialRefundBinding,
): Promise<{ witness: StripeTransferWitness; transferCreated: boolean } | null> {
  const metadata = partialRefundTransferClaimMetadata(binding);
  const idempotencyKey = partialRefundTransferClaimIdempotencyKey(binding.escrowId);
  const claim = await db.transaction(async (query) => {
    await lockExactPartialRefundBinding(query, binding);
    const inserted = await query<{ metadata: unknown; created_at: Date | string }>(
      `INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,'LOCKED_DISPUTE','LOCKED_DISPUTE',NULL,'system',$2::jsonb,$3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata,created_at`,
      [binding.escrowId, JSON.stringify(metadata), idempotencyKey],
    );
    if ((inserted.rowCount ?? 0) === 1) {
      if (!exactMetadata(inserted.rows[0]?.metadata, metadata)) {
        throw partialRefundReconciliationError(
          `partialRefund: transfer claim write was not exact for escrow ${binding.escrowId}`,
        );
      }
      return { acquired: true, createdAt: inserted.rows[0]?.created_at };
    }
    const existing = await query<{ metadata: unknown; created_at: Date | string }>(
      `SELECT metadata,created_at FROM escrow_events
        WHERE escrow_id=$1 AND idempotency_key=$2
          AND from_state='LOCKED_DISPUTE' AND to_state='LOCKED_DISPUTE'
          AND actor_id IS NULL AND actor_type='system'`,
      [binding.escrowId, idempotencyKey],
    );
    if (existing.rows.length !== 1 || !exactMetadata(existing.rows[0]?.metadata, metadata)) {
      throw partialRefundReconciliationError(
        `partialRefund: transfer claim conflicts for escrow ${binding.escrowId}`,
      );
    }
    return { acquired: false, createdAt: existing.rows[0]?.created_at };
  });

  const checkpoint = await loadPartialRefundTransferCheckpoint(binding);
  if (checkpoint) return checkpoint;
  if (!claim.acquired) {
    requireReplayableClaim(claim.createdAt, 'transfer', binding.escrowId);
    escrowLogger.warn(
      { escrowId: binding.escrowId },
      'partialRefund: exact transfer claim has no checkpoint — replaying the deterministic provider request',
    );
  }
  return null;
}

export async function lockExactTerminalPartialRefundBinding(
  query: QueryFn,
  evidence: PartialRefundTerminalEvidence,
): Promise<void> {
  const { binding, provider } = evidence;
  if (
    !exactRefundWitness(provider.refundWitness, binding)
    || !exactCurrentTransferWitness(
      provider.transferWitness,
      binding,
      provider.transferWitness.transferId,
    )
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: terminal provider evidence conflicts for escrow ${binding.escrowId}`,
    );
  }
  const escrowResult = await query<ObservedEscrowRow>(
    `SELECT id,version,state,task_id,amount,platform_fee_cents,
            stripe_payment_intent_id,stripe_transfer_id,stripe_refund_id,
            refund_amount,release_amount
       FROM escrows WHERE id=$1 FOR UPDATE`,
    [binding.escrowId],
  );
  const escrow = escrowResult.rows[0];
  if (
    !escrow
    || escrow.version !== binding.escrowVersion + 1
    || escrow.state !== 'REFUND_PARTIAL'
    || escrow.task_id !== binding.taskId
    || escrow.amount !== binding.escrowAmountCents
    || escrow.platform_fee_cents !== binding.canonicalPlatformFeeCents
    || escrow.stripe_payment_intent_id !== binding.paymentIntentId
    || escrow.stripe_refund_id !== provider.refundWitness.refundId
    || escrow.stripe_transfer_id !== provider.transferWitness.transferId
    || escrow.refund_amount !== binding.refundAmountCents
    || escrow.release_amount !== binding.releaseAmountCents
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: terminal escrow ${binding.escrowId} changed from its exact settlement binding`,
    );
  }
  const taskResult = await query<TaskBindingRow>(
    `SELECT worker_id,payout_recipient_user_id,provider_organization_id,
            provider_assignment_id,poster_id
       FROM tasks WHERE id=$1 FOR SHARE`,
    [binding.taskId],
  );
  const task = taskResult.rows[0];
  if (!task || !taskMatches(task, binding)) {
    throw partialRefundReconciliationError(
      `partialRefund: terminal task ${binding.taskId} changed from its settlement binding`,
    );
  }
  await requireExactDispute(query, binding);
}

export async function checkpointPartialRefundTransfer(input: {
  binding: PartialRefundBinding;
  witness: StripeTransferWitness;
  transferCreated: boolean;
}): Promise<void> {
  if (!exactCurrentTransferWitness(
    input.witness,
    input.binding,
    input.witness.transferId,
  )) {
    throw partialRefundReconciliationError(
      `partialRefund: transfer ${input.witness.transferId} cannot be checkpointed without an exact current witness`,
    );
  }
  const metadata = partialRefundTransferCheckpointMetadata(input);
  const idempotencyKey = partialRefundTransferCheckpointIdempotencyKey(
    input.binding.escrowId,
  );
  let result = await db.query<{ metadata: unknown }>(
    `INSERT INTO escrow_events
       (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
     VALUES ($1,'LOCKED_DISPUTE','LOCKED_DISPUTE',NULL,'system',$2::jsonb,$3)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING metadata`,
    [input.binding.escrowId, JSON.stringify(metadata), idempotencyKey],
  );
  if ((result.rowCount ?? 0) === 0) {
    result = await db.query<{ metadata: unknown }>(
      `SELECT metadata FROM escrow_events
        WHERE escrow_id=$1 AND idempotency_key=$2
          AND from_state='LOCKED_DISPUTE' AND to_state='LOCKED_DISPUTE'
          AND actor_id IS NULL AND actor_type='system'`,
      [input.binding.escrowId, idempotencyKey],
    );
  }
  if (result.rows.length !== 1 || !exactMetadata(result.rows[0]?.metadata, metadata)) {
    throw partialRefundReconciliationError(
      `partialRefund: exact transfer checkpoint conflicts for escrow ${input.binding.escrowId}`,
    );
  }
}

function observedEscrowMetadata(observed: ObservedEscrowRow): Record<string, unknown> {
  return {
    observed_escrow_state: observed.state,
    observed_escrow_version: observed.version,
    observed_task_id: observed.task_id,
    observed_amount_cents: observed.amount,
    observed_platform_fee_cents: observed.platform_fee_cents,
    observed_stripe_payment_intent_id: observed.stripe_payment_intent_id,
    observed_stripe_transfer_id: observed.stripe_transfer_id,
    observed_stripe_refund_id: observed.stripe_refund_id,
    observed_refund_amount_cents: observed.refund_amount,
    observed_release_amount_cents: observed.release_amount,
  };
}

export async function persistPartialRefundTransferRecovery(input: {
  binding: PartialRefundBinding;
  witness: StripeTransferWitness;
  transferCreated: boolean;
  failureStage: PartialRefundTransferFailureStage;
}): Promise<void> {
  if (!exactCurrentTransferWitness(
    input.witness,
    input.binding,
    input.witness.transferId,
  )) {
    throw partialRefundReconciliationError(
      `partialRefund: inexact transfer ${input.witness.transferId} cannot be recovery evidence`,
    );
  }
  await db.transaction(async (query) => {
    const current = await query<ObservedEscrowRow>(
      `SELECT id,version,state,task_id,amount,platform_fee_cents,
              stripe_payment_intent_id,stripe_transfer_id,stripe_refund_id,
              refund_amount,release_amount
         FROM escrows WHERE id=$1 FOR UPDATE`,
      [input.binding.escrowId],
    );
    const observed = current.rows[0];
    if (!observed) {
      throw partialRefundReconciliationError(
        `partialRefund: escrow ${input.binding.escrowId} disappeared before transfer recovery could be recorded`,
      );
    }
    const metadata = {
      event_type: TRANSFER_RECOVERY_EVENT,
      ...partialRefundBindingMetadata(input.binding),
      ...transferWitnessMetadata(input.witness),
      ...observedEscrowMetadata(observed),
      transfer_created_in_attempt: input.transferCreated,
      failure_stage: input.failureStage,
      reconciliation_required: true,
    };
    const idempotencyKey = [
      'partial-refund-transfer-recovery',
      input.binding.escrowId,
      input.witness.transferId,
      input.binding.escrowVersion,
      observed.state,
      observed.version,
      input.failureStage,
    ].join(':');
    let result = await query<{ metadata: unknown }>(
      `INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,$4,$4,NULL,'system',$2::jsonb,$3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata`,
      [input.binding.escrowId, JSON.stringify(metadata), idempotencyKey, observed.state],
    );
    if ((result.rowCount ?? 0) === 0) {
      result = await query<{ metadata: unknown }>(
        `SELECT metadata FROM escrow_events
          WHERE escrow_id=$1 AND idempotency_key=$2
            AND from_state=$3 AND to_state=$3
            AND actor_id IS NULL AND actor_type='system'`,
        [input.binding.escrowId, idempotencyKey, observed.state],
      );
    }
    if (result.rows.length !== 1 || !exactMetadata(result.rows[0]?.metadata, metadata)) {
      throw partialRefundReconciliationError(
        `partialRefund: transfer recovery evidence conflicts for escrow ${input.binding.escrowId}`,
      );
    }
  });
}

export async function persistPartialRefundProviderException(input: {
  binding: PartialRefundBinding;
  refundId: string;
  failureStage: 'TRANSFER_RESTRICTED_AFTER_REFUND' | 'TERMINAL_TRANSFER_INVALID';
  reasonCode: string;
}): Promise<void> {
  const refund = await loadCheckpoint(input.binding);
  if (!refund || refund.refundId !== input.refundId) {
    throw partialRefundReconciliationError(
      `partialRefund: provider exception for escrow ${input.binding.escrowId} lacks its exact refund checkpoint`,
    );
  }
  await db.transaction(async (query) => {
    const current = await query<ObservedEscrowRow>(
      `SELECT id,version,state,task_id,amount,platform_fee_cents,
              stripe_payment_intent_id,stripe_transfer_id,stripe_refund_id,
              refund_amount,release_amount
         FROM escrows WHERE id=$1 FOR UPDATE`,
      [input.binding.escrowId],
    );
    const observed = current.rows[0];
    if (!observed) {
      throw partialRefundReconciliationError(
        `partialRefund: escrow ${input.binding.escrowId} disappeared before its provider exception was recorded`,
      );
    }
    const metadata = {
      event_type: PROVIDER_EXCEPTION_EVENT,
      ...partialRefundBindingMetadata(input.binding),
      ...observedEscrowMetadata(observed),
      stripe_refund_id: refund.refundId,
      stripe_refund_status: refund.status,
      failure_stage: input.failureStage,
      reason_code: input.reasonCode,
      reconciliation_required: true,
    };
    const idempotencyKey = [
      'partial-refund-provider-exception',
      input.binding.escrowId,
      refund.refundId,
      input.failureStage,
      input.reasonCode,
    ].join(':');
    let result = await query<{ metadata: unknown }>(
      `INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,$4,$4,NULL,'system',$2::jsonb,$3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata`,
      [input.binding.escrowId, JSON.stringify(metadata), idempotencyKey, observed.state],
    );
    if ((result.rowCount ?? 0) === 0) {
      result = await query<{ metadata: unknown }>(
        `SELECT metadata FROM escrow_events
          WHERE escrow_id=$1 AND idempotency_key=$2
            AND from_state=$3 AND to_state=$3
            AND actor_id IS NULL AND actor_type='system'`,
        [input.binding.escrowId, idempotencyKey, observed.state],
      );
    }
    if (result.rows.length !== 1 || !exactMetadata(result.rows[0]?.metadata, metadata)) {
      throw partialRefundReconciliationError(
        `partialRefund: provider exception evidence conflicts for escrow ${input.binding.escrowId}`,
      );
    }
  });
}

export async function requireCurrentPartialRefundTransfer(input: {
  binding: PartialRefundBinding;
  transferId: string;
}): Promise<StripeTransferWitness> {
  const result = await StripeService.readTransferWitness(input.transferId);
  if (!result.success) {
    throw partialRefundReconciliationError(
      `partialRefund: transfer ${input.transferId} evidence is unavailable: ${result.error.message}`,
    );
  }
  const witness = result.data;
  const binding = input.binding;
  if (!exactCurrentTransferWitness(witness, binding, input.transferId)) {
    throw partialRefundReconciliationError(
      `partialRefund: transfer ${input.transferId} is not an exact current payout witness`,
    );
  }
  return witness;
}

async function loadPartialRefundClaimBinding(
  escrowId: string,
): Promise<PartialRefundBinding> {
  const idempotencyKey = partialRefundClaimIdempotencyKey(escrowId);
  const result = await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM escrow_events
      WHERE escrow_id=$1 AND idempotency_key=$2
        AND from_state='LOCKED_DISPUTE' AND to_state='LOCKED_DISPUTE'
        AND actor_id IS NULL AND actor_type='system'`,
    [escrowId, idempotencyKey],
  );
  if (result.rows.length !== 1) {
    throw partialRefundReconciliationError(
      `partialRefund: exact provider claim is missing for terminal escrow ${escrowId}`,
    );
  }
  const metadata = metadataRecord(result.rows[0]?.metadata);
  if (!metadata) {
    throw partialRefundReconciliationError(
      `partialRefund: provider claim is malformed for terminal escrow ${escrowId}`,
    );
  }
  const binding = bindingFromClaimMetadata(metadata);
  if (binding.escrowId !== escrowId) {
    throw partialRefundReconciliationError(
      `partialRefund: provider claim belongs to a different escrow than ${escrowId}`,
    );
  }
  return binding;
}

export async function loadPartialRefundTerminalEvidence(
  escrowId: string,
): Promise<PartialRefundTerminalEvidence | null> {
  const current = await db.query<{ state: string; provider_transfer_status: string | null }>(
    'SELECT state,provider_transfer_status FROM escrows WHERE id=$1',
    [escrowId],
  );
  if (!current.rows[0]) {
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${escrowId} does not exist`,
    );
  }
  if (current.rows[0].state !== 'REFUND_PARTIAL') return null;

  const binding = await loadPartialRefundClaimBinding(escrowId);
  const refundWitness = await loadCheckpoint(binding);
  if (!refundWitness) {
    throw partialRefundReconciliationError(
      `partialRefund: terminal escrow ${escrowId} has no exact refund checkpoint`,
    );
  }
  const transfer = await loadPartialRefundTransferCheckpoint(binding);
  if (!transfer) {
    throw partialRefundReconciliationError(
      `partialRefund: terminal escrow ${escrowId} has no exact transfer checkpoint`,
    );
  }
  const providerStatus = current.rows[0].provider_transfer_status;
  if (providerStatus === 'manual_reconciliation' || providerStatus === 'reversed') {
    await persistPartialRefundProviderException({
      binding,
      refundId: refundWitness.refundId,
      failureStage: 'TERMINAL_TRANSFER_INVALID',
      reasonCode: `canonical_provider_status_${providerStatus}`,
    });
    throw partialRefundReconciliationError(
      `partialRefund: terminal escrow ${escrowId} has provider status ${providerStatus}`,
    );
  }
  await requireExactPartialRefundTerminalTransition(binding, {
    refundWitness,
    transferWitness: transfer.witness,
    transferCreated: transfer.transferCreated,
  });
  // A historical checkpoint proves what was accepted at T2, not what exists at
  // the processor now. Every reconciliation pass refreshes the exact witness
  // before applying insurance, task, revenue, or XP effects.
  const currentTransfer = await StripeService.readTransferWitness(transfer.witness.transferId);
  if (!currentTransfer.success) {
    throw partialRefundReconciliationError(
      `partialRefund: transfer ${transfer.witness.transferId} evidence is unavailable: ${currentTransfer.error.message}`,
    );
  }
  if (!exactCurrentTransferWitness(
    currentTransfer.data,
    binding,
    transfer.witness.transferId,
  )) {
    await persistPartialRefundProviderException({
      binding,
      refundId: refundWitness.refundId,
      failureStage: 'TERMINAL_TRANSFER_INVALID',
      reasonCode: 'current_transfer_witness_mismatch',
    });
    throw partialRefundReconciliationError(
      `partialRefund: terminal transfer ${transfer.witness.transferId} is not an exact current payout witness`,
    );
  }
  const failedSignal = await db.query<{ stripe_event_id: string; type: string }>(
    `SELECT stripe_event_id,type
       FROM stripe_events
      WHERE type IN ('transfer.failed','transfer.reversed')
        AND payload_json->'data'->'object'->>'id'=$1
      ORDER BY created_at ASC,stripe_event_id ASC
      LIMIT 1`,
    [transfer.witness.transferId],
  );
  if (failedSignal.rows[0]) {
    await persistPartialRefundProviderException({
      binding,
      refundId: refundWitness.refundId,
      failureStage: 'TERMINAL_TRANSFER_INVALID',
      reasonCode: `${failedSignal.rows[0].type}:${failedSignal.rows[0].stripe_event_id}`,
    });
    throw partialRefundReconciliationError(
      `partialRefund: terminal transfer ${transfer.witness.transferId} has a provider failure signal`,
    );
  }
  const evidence: PartialRefundTerminalEvidence = {
    binding,
    provider: {
      refundWitness,
      transferWitness: currentTransfer.data,
      transferCreated: transfer.transferCreated,
    },
  };
  await db.transaction((query) => lockExactTerminalPartialRefundBinding(query, evidence));
  return evidence;
}

export function isPartialRefundControlError(error: unknown): error is Error & {
  code: string;
  details?: unknown;
} {
  return error instanceof Error
    && (error as Error & { code?: unknown }).code === PARTIAL_REFUND_RECONCILIATION_CODE;
}
