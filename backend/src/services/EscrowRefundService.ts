import { db } from '../db.js';
import { escrowLogger } from '../logger.js';
import type { Escrow, ServiceResult } from '../types.js';
import { XPService } from './XPService.js';
import { StripeService } from './StripeService.js';
import type { RefundContext } from './EscrowRefundTypes.js';
import { prepareRefund, terminalizeRefund } from './EscrowRefundTransaction.js';
import { logEscrowEvent } from './EscrowServiceShared.js';
import type { RefundEscrowParams } from './EscrowServiceShared.js';

function failed(code: string, message: string): Extract<ServiceResult<Escrow>, { success: false }> {
  return { success: false, error: { code, message } };
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
  const result = await StripeService.createTransferReversal(context.stripeTransferId, context.escrowId);
  if (!result.success) {
    return failed(
      'STRIPE_REVERSAL_FAILED',
      `Admin force-refund aborted: transfer reversal for transfer ${context.stripeTransferId} failed — ${result.error.message}. Refund not issued to prevent double-spend.`,
    );
  }
  escrowLogger.info({
    escrowId: context.escrowId,
    stripeTransferId: context.stripeTransferId,
    reversalId: result.data.reversalId,
  }, 'Admin force-refund: transfer reversal succeeded — proceeding with poster refund');
  return null;
}

async function issueStripeRefund(
  context: RefundContext,
  adminOverride: boolean,
): Promise<string | null> {
  if (adminOverride && context.stateBefore === 'RELEASED' && !context.stripePaymentIntentId) {
    throw Object.assign(new Error('Cannot refund: no Stripe payment intent on record — manual refund required'), {
      refundCode: 'MISSING_STRIPE_PI',
    });
  }
  if (!context.stripePaymentIntentId || context.stripeRefundId) return context.stripeRefundId;
  const result = await StripeService.createRefund({
    paymentIntentId: context.stripePaymentIntentId,
    escrowId: context.escrowId,
    amount: context.amount,
    reason: 'requested_by_customer',
    idempotencyKeySuffix: adminOverride ? 'admin_override' : 'svc_refund',
  });
  if (!result.success) throw new Error(`Stripe refund failed — ${result.error.message}`);
  return result.data?.refundId ?? null;
}

async function runRefundEffects(context: RefundContext, params: RefundEscrowParams): Promise<void> {
  await logEscrowEvent(
    context.escrowId,
    context.stateBefore,
    'REFUNDED',
    undefined,
    params.adminOverride ? 'admin' : 'system',
    params.adminOverride && params.reason ? { adminOverride: true, reason: params.reason } : {},
  );
  if (!context.workerId) return;
  try {
    await XPService.clawbackXP(context.workerId, context.escrowId, 'task_refunded');
  } catch (error) {
    escrowLogger.error({
      err: error instanceof Error ? error.message : String(error),
      workerId: context.workerId,
      escrowId: context.escrowId,
    }, 'XP clawback failed during refund — refund proceeds');
  }
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
  try {
    const prepared = await db.transaction((query) => prepareRefund(query, params.escrowId, adminOverride));
    if (!prepared.success) return prepared;
    const reversalError = await reverseReleasedTransfer(prepared.data, adminOverride);
    if (reversalError) return reversalError;
    const stripeRefundId = await issueStripeRefund(prepared.data, adminOverride);
    const terminal = await db.transaction((query) => terminalizeRefund(query, prepared.data, stripeRefundId));
    if (!terminal.success) return terminal;
    await runRefundEffects(prepared.data, params);
    return terminal;
  } catch (error) {
    return refundFailure(error);
  }
}
