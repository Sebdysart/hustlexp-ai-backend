import { config } from '../config.js';
import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { computeFeeBreakdown } from '../lib/money.js';
import { escrowLogger } from '../logger.js';
import { ErrorCodes } from '../types.js';
import type { Escrow, ServiceResult } from '../types.js';
import { StripeService } from './StripeService.js';
import type { StripeTransferWitness } from './EscrowReleaseTypes.js';
import type { RefundContext } from './EscrowRefundTypes.js';
import { prepareRefund, terminalizeRefund } from './EscrowRefundTransaction.js';
import {
  persistRefundProviderFailure,
  refundProviderCreateAllowed,
} from './EscrowRefundProviderClaim.js';
import type { RefundEscrowParams } from './EscrowServiceShared.js';
import { loadCurrentTaskPayoutDestination } from './TaskPayoutDestinationService.js';
import {
  exactSucceededRefundWitness,
  persistExactSucceededRefundWitness,
} from './EscrowRefundProviderWitness.js';

const FULL_REVERSAL_WITNESS_EVENT = 'full_transfer_reversal_witness_v1';

export interface ExactFullTransferReversalBinding {
  escrowId: string;
  canonicalState: 'LOCKED_DISPUTE' | 'RELEASED';
  taskId: string;
  workerId: string;
  payoutRecipientUserId: string;
  destinationAccountId: string;
  stripePaymentIntentId: string;
  transferId: string;
  escrowAmountCents: number;
  platformFeeCents: number;
  insuranceContributionCents: number;
  transferAmountCents: number;
}

export interface TransferReversalEvidence {
  reversalId: string | null;
  reversalAmountCents: number | null;
  transferWitness: StripeTransferWitness;
}

interface ServiceReversalEscrowRow {
  id: string;
  task_id: string;
  amount: number;
  platform_fee_cents: number | null;
  state: string;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  stripe_transfer_id: string | null;
}

interface ServiceReversalTaskRow {
  worker_id: string | null;
  payout_recipient_user_id: string | null;
  price: number;
}

function reversalEvidenceError(message: string): Error & { refundCode: string } {
  return Object.assign(new Error(message), {
    refundCode: 'STRIPE_REVERSAL_EVIDENCE_MISMATCH',
  });
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

function exactBinding(
  actual: ExactFullTransferReversalBinding,
  expected: ExactFullTransferReversalBinding,
): boolean {
  return Object.keys(expected).every((key) => (
    actual[key as keyof ExactFullTransferReversalBinding]
      === expected[key as keyof ExactFullTransferReversalBinding]
  ));
}

function reversalWitnessMetadata(
  binding: ExactFullTransferReversalBinding,
): Record<string, unknown> {
  return {
    event_type: FULL_REVERSAL_WITNESS_EVENT,
    provider: 'stripe',
    escrow_id: binding.escrowId,
    canonical_state: binding.canonicalState,
    task_id: binding.taskId,
    worker_id: binding.workerId,
    payout_recipient_user_id: binding.payoutRecipientUserId,
    destination_account_id: binding.destinationAccountId,
    stripe_payment_intent_id: binding.stripePaymentIntentId,
    stripe_transfer_id: binding.transferId,
    escrow_amount_cents: binding.escrowAmountCents,
    platform_fee_cents: binding.platformFeeCents,
    insurance_contribution_cents: binding.insuranceContributionCents,
    transfer_amount_cents: binding.transferAmountCents,
    currency: 'usd',
    amount_reversed_cents: binding.transferAmountCents,
    reversed: true,
  };
}

function reversalWitnessIdempotencyKey(binding: ExactFullTransferReversalBinding): string {
  return `full-transfer-reversal-witness-v1:${binding.escrowId}:${binding.transferId}`;
}

export function requireExactFullTransferReversal(
  binding: ExactFullTransferReversalBinding,
  evidence: TransferReversalEvidence,
): StripeTransferWitness {
  const witness = evidence.transferWitness;
  const hasNewReversal = evidence.reversalId !== null || evidence.reversalAmountCents !== null;
  const exactNewReversal = !hasNewReversal || (
    typeof evidence.reversalId === 'string'
    && evidence.reversalId.length > 0
    && evidence.reversalAmountCents === binding.transferAmountCents
  );
  const exactCurrentTransfer = witness.provider === 'STRIPE'
    && witness.transferId === binding.transferId
    && witness.amountCents === binding.transferAmountCents
    && Number.isInteger(witness.amountCents)
    && witness.amountCents > 0
    && witness.currency === 'usd'
    && witness.destinationAccountId === binding.destinationAccountId
    && witness.escrowId === binding.escrowId
    && witness.taskId === binding.taskId
    && witness.payoutRecipientUserId === binding.payoutRecipientUserId
    && witness.reversed === true
    && witness.amountReversedCents === binding.transferAmountCents
    && Number.isInteger(witness.amountReversedCents);
  if (!exactNewReversal || !exactCurrentTransfer) {
    throw reversalEvidenceError(
      `Transfer ${binding.transferId} is not exactly and fully reversed for the locked canonical payout`,
    );
  }
  return witness;
}

export async function persistExactFullTransferReversalWitness(
  query: QueryFn,
  binding: ExactFullTransferReversalBinding,
): Promise<void> {
  const metadata = reversalWitnessMetadata(binding);
  const idempotencyKey = reversalWitnessIdempotencyKey(binding);
  let result = await query<{ metadata: unknown }>(
    `INSERT INTO escrow_events
       (escrow_id, from_state, to_state, actor_id, actor_type, metadata, idempotency_key)
     VALUES ($1, $4, $4, NULL, 'system', $2::jsonb, $3)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING metadata`,
    [binding.escrowId, JSON.stringify(metadata), idempotencyKey, binding.canonicalState],
  );
  if ((result.rowCount ?? result.rows.length) === 0) {
    result = await query<{ metadata: unknown }>(
      `SELECT metadata FROM escrow_events
        WHERE escrow_id = $1 AND idempotency_key = $2
          AND from_state = $3 AND to_state = $3
          AND actor_id IS NULL AND actor_type = 'system'`,
      [binding.escrowId, idempotencyKey, binding.canonicalState],
    );
  }
  if (result.rows.length !== 1 || !exactMetadata(result.rows[0]?.metadata, metadata)) {
    throw reversalEvidenceError(
      `Immutable full-reversal witness conflicts for escrow ${binding.escrowId}`,
    );
  }
}

function failed(code: string, message: string): Extract<ServiceResult<Escrow>, { success: false }> {
  return { success: false, error: { code, message } };
}

async function loadServiceReversalBinding(
  query: QueryFn,
  context: RefundContext,
): Promise<ExactFullTransferReversalBinding> {
  const escrowResult = await query<ServiceReversalEscrowRow>(
    `SELECT id, task_id, amount, platform_fee_cents, state,
            stripe_payment_intent_id, stripe_refund_id, stripe_transfer_id
       FROM escrows WHERE id = $1 FOR UPDATE`,
    [context.escrowId],
  );
  const escrow = escrowResult.rows[0];
  if (
    !escrow
    || escrow.id !== context.escrowId
    || escrow.state !== 'RELEASED'
    || escrow.amount !== context.amount
    || escrow.stripe_payment_intent_id !== context.stripePaymentIntentId
    || escrow.stripe_refund_id !== context.stripeRefundId
    || escrow.stripe_transfer_id !== context.stripeTransferId
    || !escrow.task_id
    || !escrow.stripe_payment_intent_id
    || !escrow.stripe_transfer_id
  ) {
    throw reversalEvidenceError(
      `Escrow ${context.escrowId} changed before its transfer reversal could be verified`,
    );
  }
  const taskResult = await query<ServiceReversalTaskRow>(
    `SELECT worker_id, payout_recipient_user_id, price
       FROM tasks WHERE id = $1 FOR UPDATE`,
    [escrow.task_id],
  );
  const task = taskResult.rows[0];
  if (!task?.worker_id || Number(task.price) !== escrow.amount) {
    throw reversalEvidenceError(
      `Task ${escrow.task_id} does not match the locked reversal escrow`,
    );
  }
  const payoutRecipientUserId = task.payout_recipient_user_id ?? task.worker_id;
  const destination = await loadCurrentTaskPayoutDestination(query, {
    taskId: escrow.task_id,
    workerId: task.worker_id,
    payoutRecipientUserId,
  });
  if (!destination.ready || !destination.stripeConnectId) {
    throw reversalEvidenceError(
      `Payout destination is not current (${destination.reason}) — cannot verify transfer reversal`,
    );
  }
  const breakdown = computeFeeBreakdown(
    escrow.amount,
    config.stripe.platformFeePercent,
    escrow.platform_fee_cents,
  );
  return {
    escrowId: escrow.id,
    canonicalState: 'RELEASED',
    taskId: escrow.task_id,
    workerId: task.worker_id,
    payoutRecipientUserId,
    destinationAccountId: destination.stripeConnectId,
    stripePaymentIntentId: escrow.stripe_payment_intent_id,
    transferId: escrow.stripe_transfer_id,
    escrowAmountCents: escrow.amount,
    platformFeeCents: breakdown.platformFeeCents,
    insuranceContributionCents: breakdown.insuranceContributionCents,
    transferAmountCents: breakdown.netPayoutCents,
  };
}

async function persistServiceReversalWitness(
  context: RefundContext,
  binding: ExactFullTransferReversalBinding,
): Promise<void> {
  await db.transaction(async (query) => {
    const current = await loadServiceReversalBinding(query, context);
    if (!exactBinding(current, binding)) {
      throw reversalEvidenceError(
        `Canonical payout binding changed while transfer ${binding.transferId} was being reversed`,
      );
    }
    await persistExactFullTransferReversalWitness(query, current);
  });
}

async function reverseReleasedTransfer(
  context: RefundContext,
  adminOverride: boolean,
): Promise<ServiceResult<Escrow> | null> {
  if (!adminOverride || context.stateBefore !== 'RELEASED') return null;
  if (!context.stripeTransferId) {
    return failed(
      'MANUAL_PAYOUT_CANNOT_REFUND',
      'Cannot refund a manually-paid RELEASED escrow — worker clawback must be handled manually',
    );
  }
  let binding: ExactFullTransferReversalBinding;
  try {
    binding = await db.transaction((query) => loadServiceReversalBinding(query, context));
  } catch (error) {
    return failed(
      'STRIPE_REVERSAL_EVIDENCE_MISMATCH',
      error instanceof Error ? error.message : 'Canonical transfer reversal facts are unavailable',
    );
  }
  const result = await StripeService.createTransferReversal(binding.transferId, binding.escrowId);
  if (!result.success) {
    return failed(
      'STRIPE_REVERSAL_FAILED',
      `Admin force-refund aborted: transfer reversal for transfer ${binding.transferId} failed — ${result.error.message}. Refund not issued to prevent double-spend.`,
    );
  }
  try {
    requireExactFullTransferReversal(binding, result.data);
    await persistServiceReversalWitness(context, binding);
  } catch (error) {
    return failed(
      'STRIPE_REVERSAL_EVIDENCE_MISMATCH',
      error instanceof Error ? error.message : 'Exact transfer reversal evidence is unavailable',
    );
  }
  escrowLogger.info({
    escrowId: binding.escrowId,
    stripeTransferId: binding.transferId,
    reversalId: result.data.reversalId,
  }, 'Admin force-refund: exact full reversal witness persisted — proceeding with poster refund');
  return null;
}

async function issueStripeRefund(
  context: RefundContext,
  adminOverride: boolean,
): Promise<string> {
  if (adminOverride && context.stateBefore === 'RELEASED' && !context.stripePaymentIntentId) {
    throw Object.assign(new Error('Cannot refund: no Stripe payment intent on record — manual refund required'), {
      refundCode: 'MISSING_STRIPE_PI',
    });
  }
  if (!context.stripePaymentIntentId) {
    throw Object.assign(
      new Error(`Escrow ${context.escrowId} has no canonical Stripe PaymentIntent to refund`),
      { refundCode:'STRIPE_REFUND_EVIDENCE_MISMATCH' },
    );
  }
  let providerOperation: 'read' | 'create' | 'discover';
  let result: Awaited<ReturnType<typeof StripeService.createRefund>>;
  if (context.stripeRefundId) {
    providerOperation = 'read';
    result = await StripeService.readRefundWitness(context.stripeRefundId);
  } else {
    const createAllowed = await db.transaction((query) => (
      refundProviderCreateAllowed(query, context)
    ));
    if (createAllowed) {
      providerOperation = 'create';
      result = await StripeService.createRefund({
        paymentIntentId: context.stripePaymentIntentId,
        escrowId: context.escrowId,
        amount: context.amount,
        reason: 'requested_by_customer',
        idempotencyKeySuffix: adminOverride ? 'admin_override' : 'svc_refund',
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
  }
  if (!result.success) {
    if (providerOperation === 'create') {
      await db.transaction((query) => persistRefundProviderFailure(
        query,
        context,
        result.error.code,
      ));
    }
    throw Object.assign(
      new Error(`Stripe refund evidence unavailable — ${result.error.message}`),
      {
        refundCode: context.stripeRefundId
          ? 'STRIPE_REFUND_EVIDENCE_MISMATCH'
          : providerOperation === 'discover'
            ? 'STRIPE_REFUND_RECONCILIATION_REQUIRED'
            : 'STRIPE_REFUND_FAILED',
      },
    );
  }
  const witness = exactSucceededRefundWitness({
    escrowId: context.escrowId,
    taskId: context.taskId,
    canonicalState: context.stateBefore,
    paymentIntentId: context.stripePaymentIntentId,
    expectedAmountCents: context.amount,
    provider: result.data,
  });
  if (!witness) {
    throw Object.assign(
      new Error(`Stripe refund ${result.data.refundId} is not an exact current succeeded refund for this escrow`),
      { refundCode: 'STRIPE_REFUND_EVIDENCE_MISMATCH' },
    );
  }
  await db.transaction((query) => persistExactSucceededRefundWitness(query, witness));
  return witness.refundId;
}

function refundFailure(error: unknown): ServiceResult<Escrow> {
  if (error instanceof Error && 'refundCode' in error) {
    return failed(String(error.refundCode), error.message);
  }
  escrowLogger.error(
    { err: error instanceof Error ? error.message : String(error) },
    'EscrowService DB error',
  );
  return failed('DB_ERROR', 'A database error occurred. Please try again.');
}

export async function refundEscrow(params: RefundEscrowParams): Promise<ServiceResult<Escrow>> {
  const adminOverride = params.adminOverride ?? false;
  if (adminOverride) {
    return failed(
      ErrorCodes.INVALID_STATE,
      'Administrative refund cannot create provider or REFUNDED economics; use the canonical dispute/refund command',
    );
  }
  try {
    const prepared = await db.transaction((query) => prepareRefund(query, params.escrowId, adminOverride));
    if (!prepared.success) return prepared;
    const reversalError = await reverseReleasedTransfer(prepared.data, adminOverride);
    if (reversalError) return reversalError;
    const stripeRefundId = await issueStripeRefund(prepared.data, adminOverride);
    const terminal = await db.transaction((query) => terminalizeRefund(query, prepared.data, stripeRefundId));
    if (!terminal.success) return terminal;
    return terminal;
  } catch (error) {
    return refundFailure(error);
  }
}
