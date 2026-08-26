import type { QueryFn } from '../db.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { getEscrowById } from './EscrowReadService.js';
import { loadCurrentTaskPayoutDestination } from './TaskPayoutDestinationService.js';
import type {
  PartialRefundContext,
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
            stripe_transfer_id, stripe_refund_id
       FROM escrows WHERE id = $1 FOR UPDATE`,
    [escrowId],
  );
  return result.rows[0] ?? null;
}

async function loadParticipants(query: QueryFn, taskId: string): Promise<{
  workerId: string | null;
  payoutRecipientUserId: string | null;
  posterId: string | null;
}> {
  if (!taskId) return { workerId: null, payoutRecipientUserId: null, posterId: null };
  const result = await query<{
    worker_id: string | null;
    payout_recipient_user_id: string | null;
    poster_id: string | null;
  }>(
    `SELECT t.worker_id,t.payout_recipient_user_id,t.poster_id FROM tasks t WHERE t.id=$1`,
    [taskId],
  );
  const workerId = result.rows[0]?.worker_id ?? null;
  return {
    workerId,
    payoutRecipientUserId: result.rows[0]?.payout_recipient_user_id ?? workerId,
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
  const participants = await loadParticipants(query, escrow.task_id);
  const destination = await loadPayoutDestination(query,escrow.task_id,participants);
  return {
    success: true,
    data: {
      escrowId,
      taskId: escrow.task_id,
      amount: escrow.amount,
      stripePaymentIntentId: escrow.stripe_payment_intent_id ?? null,
      existingTransferId: escrow.stripe_transfer_id ?? null,
      existingRefundId: escrow.stripe_refund_id ?? null,
      ...participants,
      payoutStripeConnectId: destination.ready ? destination.stripeConnectId : null,
      payoutDestinationError: destination.ready ? null : destination.reason,
    },
  };
}

async function lockTerminalRow(query: QueryFn, escrowId: string): Promise<{
  version: number;
  state: string;
}> {
  try {
    const result = await query<{ id: string; version: number; state: string }>(
      `SELECT id, version, state FROM escrows WHERE id = $1 FOR UPDATE NOWAIT`,
      [escrowId],
    );
    if (!result.rows[0]) throw new Error(`Escrow ${escrowId} disappeared during T2 partial-refund lock — retry`);
    return result.rows[0];
  } catch (error) {
    if (error instanceof Error && error.message.includes('could not obtain lock')) {
      throw new Error(`partialRefund T2: row lock contention on escrow ${escrowId} — retry`);
    }
    throw error;
  }
}

async function terminalStateResult(
  context: PartialRefundContext,
  state: string,
): Promise<ServiceResult<Escrow> | null> {
  if (state === 'LOCKED_DISPUTE') return null;
  if (state === 'REFUND_PARTIAL') return getEscrowById(context.escrowId);
  return failed(
    ErrorCodes.INVALID_STATE,
    `partialRefund: escrow state changed to ${state} during T2 lock — cannot terminalize`,
  );
}

async function classifyTerminalMiss(query: QueryFn, escrowId: string): Promise<ServiceResult<Escrow>> {
  const check = await query<{ state: string }>(`SELECT state FROM escrows WHERE id = $1`, [escrowId]);
  const state = check.rows[0]?.state;
  if (state === 'REFUND_PARTIAL') return getEscrowById(escrowId);
  return failed(
    ErrorCodes.INVALID_STATE,
    `partialRefund: concurrent modification detected (state=${state ?? 'unknown'})`,
  );
}

export async function terminalizePartialRefund(
  query: QueryFn,
  context: PartialRefundContext,
  provider: PartialRefundProviderResult,
): Promise<ServiceResult<Escrow>> {
  const locked = await lockTerminalRow(query, context.escrowId);
  const stateResult = await terminalStateResult(context, locked.state);
  if (stateResult) return stateResult;
  const result = await query<Escrow>(
    `UPDATE escrows
        SET state = 'REFUND_PARTIAL', refunded_at = NOW(),
            stripe_transfer_id = COALESCE($3, stripe_transfer_id),
            stripe_refund_id = COALESCE($4, stripe_refund_id),
            version = version + 1, updated_at = NOW()
      WHERE id = $1 AND version = $2 AND state = 'LOCKED_DISPUTE'
      RETURNING *`,
    [context.escrowId, locked.version, provider.transferId, provider.refundId],
  );
  return (result.rowCount ?? 0) > 0
    ? { success: true, data: result.rows[0] }
    : classifyTerminalMiss(query, context.escrowId);
}
