import type { QueryFn } from '../db.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import {
  lockExactPartialRefundBinding,
  lockExactPartialRefundT2Evidence,
  PARTIAL_REFUND_RECONCILIATION_CODE,
  recordExactPartialRefundTerminalTransition,
} from './EscrowPartialRefundEvidence.js';
import type { PartialRefundBinding } from './EscrowPartialRefundEvidence.js';
import { loadCurrentTaskPayoutDestination } from './TaskPayoutDestinationService.js';
import type {
  PartialRefundEscrowRow,
  PartialRefundPreparation,
  PartialRefundProviderResult,
} from './EscrowPartialRefundTypes.js';

function failed(code: string, message: string): Extract<ServiceResult<Escrow>, { success: false }> {
  return { success: false, error: { code, message } };
}

async function loadEscrow(query: QueryFn, escrowId: string): Promise<PartialRefundEscrowRow | null> {
  const result = await query<PartialRefundEscrowRow>(
    `SELECT version, state, task_id, amount, platform_fee_cents, stripe_payment_intent_id,
            stripe_transfer_id, stripe_refund_id, refund_amount, release_amount
       FROM escrows WHERE id = $1 FOR UPDATE`,
    [escrowId],
  );
  return result.rows[0] ?? null;
}

async function loadParticipants(query: QueryFn, taskId: string): Promise<{
  workerId: string | null;
  payoutRecipientUserId: string | null;
  providerOrganizationId: string | null;
  providerAssignmentId: string | null;
  posterId: string | null;
}> {
  if (!taskId) {
    return {
      workerId: null,
      payoutRecipientUserId: null,
      providerOrganizationId: null,
      providerAssignmentId: null,
      posterId: null,
    };
  }
  const result = await query<{
    worker_id: string | null;
    payout_recipient_user_id: string | null;
    provider_organization_id: string | null;
    provider_assignment_id: string | null;
    poster_id: string | null;
  }>(
    `SELECT t.worker_id,t.payout_recipient_user_id,t.provider_organization_id,
            t.provider_assignment_id,t.poster_id
       FROM tasks t WHERE t.id=$1`,
    [taskId],
  );
  const workerId = result.rows[0]?.worker_id ?? null;
  return {
    workerId,
    payoutRecipientUserId: result.rows[0]?.payout_recipient_user_id ?? workerId,
    providerOrganizationId: result.rows[0]?.provider_organization_id ?? null,
    providerAssignmentId: result.rows[0]?.provider_assignment_id ?? null,
    posterId: result.rows[0]?.poster_id ?? null,
  };
}

async function loadPayoutDestination(
  query: QueryFn,
  taskId: string,
  participants: Awaited<ReturnType<typeof loadParticipants>>,
) {
  if (!participants.workerId || !participants.payoutRecipientUserId) {
    return { ready:false as const,stripeConnectId:null,reason:'TASK_BINDING_MISMATCH' as const };
  }
  return loadCurrentTaskPayoutDestination(query,{
    taskId,workerId:participants.workerId,
    payoutRecipientUserId:participants.payoutRecipientUserId,
  });
}

export async function preparePartialRefund(
  query: QueryFn,
  escrowId: string,
): Promise<PartialRefundPreparation> {
  const escrow = await loadEscrow(query, escrowId);
  if (!escrow) return failed(ErrorCodes.NOT_FOUND, `Escrow ${escrowId} not found`);
  if (escrow.state !== 'LOCKED_DISPUTE') {
    return failed(
      ErrorCodes.INVALID_STATE,
      `Cannot partially refund: current state is ${escrow.state}, expected LOCKED_DISPUTE`,
    );
  }
  if (escrow.platform_fee_cents != null) {
    return failed(
      ErrorCodes.INVALID_STATE,
      'Canonical quote partial payout is fail-closed pending exact split reconciliation',
    );
  }
  if (escrow.refund_amount != null || escrow.release_amount != null) {
    return failed(
      PARTIAL_REFUND_RECONCILIATION_CODE,
      'Locked escrow already carries partial-settlement amounts',
    );
  }
  const participants = await loadParticipants(query, escrow.task_id);
  const destination = await loadPayoutDestination(query,escrow.task_id,participants);
  return {
    success: true,
    data: {
      escrowId,
      escrowVersion: escrow.version,
      escrowState: escrow.state,
      taskId: escrow.task_id,
      amount: escrow.amount,
      canonicalPlatformFeeCents: escrow.platform_fee_cents ?? null,
      stripePaymentIntentId: escrow.stripe_payment_intent_id ?? null,
      existingTransferId: escrow.stripe_transfer_id ?? null,
      existingRefundId: escrow.stripe_refund_id ?? null,
      existingRefundAmount: escrow.refund_amount ?? null,
      existingReleaseAmount: escrow.release_amount ?? null,
      ...participants,
      payoutStripeConnectId: destination.ready ? destination.stripeConnectId : null,
      payoutDestinationError: destination.ready ? null : destination.reason,
    },
  };
}

export async function terminalizePartialRefund(
  query: QueryFn,
  binding: PartialRefundBinding,
  provider: PartialRefundProviderResult,
): Promise<ServiceResult<Escrow>> {
  if (
    (binding.refundAmountCents > 0 && !provider.refundId)
    || (binding.releaseAmountCents > 0 && !provider.transferId)
  ) {
    return failed(
      PARTIAL_REFUND_RECONCILIATION_CODE,
      `partialRefund: provider evidence is incomplete for escrow ${binding.escrowId}`,
    );
  }
  await lockExactPartialRefundBinding(query, binding, true);
  const exactProvider = await lockExactPartialRefundT2Evidence(query, binding, provider);
  const result = await query<Escrow>(
    `UPDATE escrows
        SET state='REFUND_PARTIAL',
            stripe_transfer_id=$9,
            stripe_refund_id=$10,
            refund_amount=$11,
            release_amount=$12,
            refunded_at=CASE WHEN $11 > 0 THEN NOW() ELSE refunded_at END,
            released_at=CASE WHEN $12 > 0 THEN NOW() ELSE released_at END,
            version = version + 1, updated_at = NOW()
      WHERE id=$1 AND version=$2 AND state='LOCKED_DISPUTE'
        AND task_id=$3 AND amount=$4
        AND platform_fee_cents IS NOT DISTINCT FROM $5
        AND stripe_payment_intent_id IS NOT DISTINCT FROM $6
        AND stripe_transfer_id IS NOT DISTINCT FROM $7
        AND stripe_refund_id IS NOT DISTINCT FROM $8
        AND refund_amount IS NULL AND release_amount IS NULL
      RETURNING *`,
    [
      binding.escrowId,
      binding.escrowVersion,
      binding.taskId,
      binding.escrowAmountCents,
      binding.canonicalPlatformFeeCents,
      binding.paymentIntentId,
      binding.existingTransferId,
      binding.existingRefundId,
      provider.transferId,
      provider.refundId,
      binding.refundAmountCents,
      binding.releaseAmountCents,
    ],
  );
  if ((result.rowCount ?? 0) === 0) {
    return failed(
      PARTIAL_REFUND_RECONCILIATION_CODE,
      `partialRefund: exact T2 compare-and-swap failed for escrow ${binding.escrowId}`,
    );
  }
  await recordExactPartialRefundTerminalTransition(query, binding, exactProvider);
  return { success: true, data: result.rows[0] };
}
