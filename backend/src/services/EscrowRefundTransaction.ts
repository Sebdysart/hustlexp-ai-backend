import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { escrowLogger } from '../logger.js';
import type { Escrow, EscrowState, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { notifyAdmins } from './AdminNotificationHelper.js';
import { getEscrowById } from './EscrowReadService.js';
import type { RefundContext, RefundEscrowRow, RefundPreparation } from './EscrowRefundTypes.js';
import { isTerminalEscrowState } from './EscrowServiceShared.js';

function failed(code: string, message: string): Extract<ServiceResult<Escrow>, { success: false }> {
  return { success: false, error: { code, message } };
}

async function loadRefundEscrow(query: QueryFn, escrowId: string): Promise<RefundEscrowRow | null> {
  const result = await query<RefundEscrowRow>(
    `SELECT task_id, version, state, stripe_payment_intent_id, stripe_refund_id, stripe_transfer_id, amount
       FROM escrows WHERE id = $1 FOR UPDATE`,
    [escrowId],
  );
  return result.rows[0] ?? null;
}

async function loadRefundWorker(
  query: QueryFn,
  taskId: string,
): Promise<{ worker_id: string | null; state: string } | null> {
  const result = await query<{ worker_id: string | null; state: string }>(
    `SELECT worker_id, state FROM tasks WHERE id = $1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

function workerStateError(
  task: { worker_id: string | null; state: string } | null,
): Extract<ServiceResult<Escrow>, { success: false }> | null {
  const assignedStates = ['ACCEPTED', 'MATCHING', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED'];
  if (!task?.state || !assignedStates.includes(task.state)) return null;
  return failed(ErrorCodes.INVALID_STATE, 'Cannot refund escrow for a task that has been accepted by a worker');
}

function refundEscrowError(
  escrow: RefundEscrowRow,
  adminOverride: boolean,
): Extract<ServiceResult<Escrow>, { success: false }> | null {
  if (escrow.state !== 'LOCKED_DISPUTE' || adminOverride) return null;
  return failed(
    ErrorCodes.INVALID_STATE,
    'Cannot refund escrow: state is LOCKED_DISPUTE — admin override required to refund a disputed escrow',
  );
}

function refundContext(input: {
  escrowId: string;
  escrow: RefundEscrowRow;
  task: { worker_id: string | null; state: string } | null;
  adminOverride: boolean;
}): RefundContext {
  return {
    escrowId: input.escrowId,
    workerId: input.task?.worker_id ?? null,
    stateBefore: input.escrow.state || 'FUNDED',
    stripePaymentIntentId: input.escrow.stripe_payment_intent_id,
    stripeRefundId: input.escrow.stripe_refund_id,
    stripeTransferId: input.escrow.stripe_transfer_id,
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
  const task = escrow.task_id ? await loadRefundWorker(query, escrow.task_id) : null;
  const taskError = workerStateError(task);
  if (taskError) return taskError;
  return { success: true, data: refundContext({ escrowId, escrow, task, adminOverride }) };
}

async function lockRefundRow(query: QueryFn, escrowId: string): Promise<{
  id: string;
  version: number;
  state: string;
} | null> {
  try {
    const result = await query<{ id: string; version: number; state: string }>(
      `SELECT id, version, state FROM escrows WHERE id = $1 FOR UPDATE NOWAIT`,
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

async function stateChangedResult(
  context: RefundContext,
  state: string,
): Promise<ServiceResult<Escrow>> {
  if (state === 'REFUNDED') {
    const existing = await getEscrowById(context.escrowId);
    if (existing.success) return existing;
  }
  return failed(
    isTerminalEscrowState(state as EscrowState) ? ErrorCodes.ESCROW_TERMINAL : ErrorCodes.INVALID_STATE,
    `Cannot refund escrow: state changed to ${state} between T1 and T2`,
  );
}

function notifyRefundRace(context: RefundContext, stripeRefundId: string): void {
  const stripeChargeId = context.stripePaymentIntentId ?? 'unknown';
  notifyAdmins({
    title: 'REFUND RACE CONDITION — Manual Reconciliation Required',
    body: `Escrow ${context.escrowId}: release() raced with refund(). Stripe refund ${stripeRefundId} already issued (charge: ${stripeChargeId}). Worker received transfer AND poster received refund. Amount: ${context.amount} cents. Investigate immediately.`,
    deepLink: `/admin/escrows/${context.escrowId}`,
    priority: 'CRITICAL',
    metadata: {
      escrow_id: context.escrowId,
      stripe_refund_id: stripeRefundId,
      stripe_charge_id: stripeChargeId,
      amount_cents: context.amount,
    },
  }).catch((error) => escrowLogger.error(
    { err: error instanceof Error ? error.message : String(error), escrowId: context.escrowId },
    'Failed to send admin notification for REFUND_RACE_CONDITION — manual intervention still required',
  ));
}

async function refundRaceResult(
  context: RefundContext,
  stripeRefundId: string,
): Promise<ServiceResult<Escrow>> {
  escrowLogger.error({
    escrowId: context.escrowId,
    stripeRefundId,
    stripeChargeId: context.stripePaymentIntentId ?? 'unknown',
    escrowState: 'RELEASED',
    amountCents: context.amount,
  }, 'CRITICAL: REFUND_RACE_CONDITION — release() won the race between T1 and T2. Stripe refund already issued. Worker received transfer AND poster received refund. Manual reconciliation required.');
  try {
    await db.query(`UPDATE escrows SET manual_reconciliation_required = true WHERE id = $1`, [context.escrowId]);
  } catch (error) {
    escrowLogger.error(
      { escrowId: context.escrowId, err: error instanceof Error ? error.message : String(error) },
      'CRITICAL: failed to set manual_reconciliation_required flag — ops must manually identify this escrow',
    );
  }
  notifyRefundRace(context, stripeRefundId);
  return failed(
    'REFUND_RACE_CONDITION',
    `Escrow ${context.escrowId}: concurrent release detected between T1 and T2. Stripe refund ${stripeRefundId} was already issued. Manual reconciliation required — escrow flagged.`,
  );
}

async function classifyMiss(
  context: RefundContext,
  stripeRefundId: string | null,
): Promise<ServiceResult<Escrow>> {
  const existing = await getEscrowById(context.escrowId);
  if (!existing.success) return existing;
  if (existing.data.state === 'RELEASED' && stripeRefundId) {
    return refundRaceResult(context, stripeRefundId);
  }
  if (isTerminalEscrowState(existing.data.state)) {
    return failed(
      ErrorCodes.ESCROW_TERMINAL,
      `Escrow ${context.escrowId} is in terminal state ${existing.data.state}`,
    );
  }
  return failed(
    ErrorCodes.INVALID_STATE,
    `Cannot refund escrow: concurrent modification detected (state=${existing.data.state ?? 'unknown'})`,
  );
}

export async function terminalizeRefund(
  query: QueryFn,
  context: RefundContext,
  stripeRefundId: string | null,
): Promise<ServiceResult<Escrow>> {
  const locked = await lockRefundRow(query, context.escrowId);
  if (!locked) {
    return failed(ErrorCodes.NOT_FOUND, `Escrow ${context.escrowId} not found during T2 lock`);
  }
  if (!context.allowedStates.includes(locked.state)) return stateChangedResult(context, locked.state);
  const result = await query<Escrow>(
    `UPDATE escrows
        SET state = 'REFUNDED', refunded_at = NOW(),
            stripe_refund_id = COALESCE($3, stripe_refund_id),
            version = version + 1, updated_at = NOW()
      WHERE id = $1 AND state = ANY($4::text[]) AND version = $2
      RETURNING *`,
    [context.escrowId, locked.version, stripeRefundId, context.allowedStates],
  );
  return (result.rowCount ?? 0) > 0
    ? { success: true, data: result.rows[0] }
    : classifyMiss(context, stripeRefundId);
}
