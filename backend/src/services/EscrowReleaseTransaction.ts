import type { QueryFn } from '../db.js';
import { config } from '../config.js';
import { clampFeePercent, computeFeeBreakdown, feeBasisPoints } from '../lib/money.js';
import { escrowLogger } from '../logger.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { LocalCertificationPayoutProvider } from './LocalCertificationPayoutProvider.js';
import { getEscrowById } from './EscrowReadService.js';
import { loadCurrentTaskPayoutDestination } from './TaskPayoutDestinationService.js';
import type {
  ReleaseEscrowRow,
  ReleasePayoutProvider,
  ReleasePost,
  ReleaseTaskRow,
  ReleaseTransactionResult,
} from './EscrowReleaseTypes.js';
import type { ReleaseEscrowParams } from './EscrowServiceShared.js';
import { isTerminalEscrowState } from './EscrowServiceShared.js';

function failed(code: string, message: string): Extract<ServiceResult<Escrow>, { success: false }> {
  return { success: false, error: { code, message } };
}

async function loadEscrow(query: QueryFn, escrowId: string): Promise<ReleaseEscrowRow | null> {
  const result = await query<ReleaseEscrowRow>(
    `SELECT id,task_id,amount,platform_fee_cents,state,version,stripe_transfer_id
       FROM escrows WHERE id=$1 FOR UPDATE`,
    [escrowId],
  );
  return result.rows[0] ?? null;
}

async function authorizeDispute(
  query: QueryFn,
  escrow: ReleaseEscrowRow,
  adminOverride: boolean,
): Promise<boolean> {
  if (escrow.state !== 'LOCKED_DISPUTE') return true;
  if (adminOverride) {
    await query(`SELECT set_config('hustlexp.dispute_release_override','true',true)`);
    return true;
  }
  const result = await query<{ resolved_dispute_id: string }>(
    `SELECT id::text AS resolved_dispute_id FROM disputes
      WHERE escrow_id=$1 AND state='RESOLVED' AND outcome_escrow_action='RELEASE'
      ORDER BY resolved_at DESC NULLS LAST,id DESC LIMIT 1`,
    [escrow.id],
  );
  return Boolean(result.rows[0]?.resolved_dispute_id);
}

async function loadTask(query: QueryFn, taskId: string): Promise<ReleaseTaskRow | null> {
  const result = await query<ReleaseTaskRow>(
    `SELECT worker_id,payout_recipient_user_id,provider_organization_id,price,
            payment_method,poster_id,automation_classification,hustler_payout_cents,
            platform_margin_cents FROM tasks WHERE id=$1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

function payoutProvider(params: ReleaseEscrowParams, escrow: ReleaseEscrowRow): {
  provider: ReleasePayoutProvider;
  transferId: string | null;
  stripeTransferId: string | null;
  status: string;
} {
  const stripeTransferId = params.stripeTransferId ?? escrow.stripe_transfer_id;
  const provider = params.localTestTransferId
    ? 'LOCAL_CERTIFICATION_TEST'
    : stripeTransferId ? 'STRIPE' : 'MANUAL_RECONCILIATION';
  return {
    provider,
    transferId: params.localTestTransferId ?? stripeTransferId ?? null,
    stripeTransferId: stripeTransferId ?? null,
    status: provider === 'LOCAL_CERTIFICATION_TEST'
      ? 'paid' : provider === 'STRIPE' ? 'submitted' : 'manual_reconciliation',
  };
}

async function verifyLocalProvider(query: QueryFn, input: {
  params: ReleaseEscrowParams;
  escrow: ReleaseEscrowRow;
  task: ReleaseTaskRow;
  payoutRecipientUserId: string;
  netPayoutCents: number;
}): Promise<ServiceResult<Escrow> | null> {
  const transferId = input.params.localTestTransferId;
  if (!transferId) return null;
  if (input.task.automation_classification !== 'CONTROLLED_TEST') {
    return failed(ErrorCodes.INVALID_STATE, 'Local certification payout cannot release a production-classified task');
  }
  const verified = await LocalCertificationPayoutProvider.verifyPaidTransfer(query, {
    transferId,
    taskId: input.escrow.task_id,
    escrowId: input.escrow.id,
    workerId: input.payoutRecipientUserId,
    amountCents: input.netPayoutCents,
  });
  return verified
    ? null
    : failed(ErrorCodes.INVALID_STATE, 'Local certification payout is not provider-confirmed for the exact net amount');
}

async function verifyStripeRecipient(
  query: QueryFn,
  input: { taskId:string;workerId:string;payoutRecipientUserId:string },
): Promise<ServiceResult<Escrow> | null> {
  const destination = await loadCurrentTaskPayoutDestination(query,input);
  return destination.ready
    ? null
    : failed(
        ErrorCodes.INVALID_STATE,
        `Payout destination is not current (${destination.reason}) — cannot release payout`,
      );
}

async function adminManualPayoutRequired(
  query: QueryFn,
  input: { escrowId: string; workerId: string; payoutRecipientUserId: string; stripeTransferId: string | null },
): Promise<boolean> {
  const result = await query<{ stripe_connect_id: string | null }>(
    `SELECT stripe_connect_id FROM users WHERE id=$1`,
    [input.payoutRecipientUserId],
  );
  if (input.stripeTransferId) return false;
  escrowLogger.error({
    workerId: input.workerId,
    payoutRecipientUserId: input.payoutRecipientUserId,
    escrowId: input.escrowId,
    adminOverride: true,
    hasStripeAccount: Boolean(result.rows[0]?.stripe_connect_id),
  }, 'CRITICAL: adminOverride release lacks provider transfer evidence — manual payout reconciliation required');
  return true;
}

async function validateProvider(query: QueryFn, input: {
  params: ReleaseEscrowParams;
  escrow: ReleaseEscrowRow;
  task: ReleaseTaskRow;
  workerId: string;
  payoutRecipientUserId: string;
  netPayoutCents: number;
  stripeTransferId: string | null;
}): Promise<{ error: ServiceResult<Escrow> | null; manualRequired: boolean }> {
  const localError = await verifyLocalProvider(query, input);
  if (localError) return { error: localError, manualRequired: false };
  if (input.params.localTestTransferId) return { error: null, manualRequired: false };
  if (!input.params.adminOverride) {
    return { error: await verifyStripeRecipient(query, {
      taskId:input.escrow.task_id,workerId:input.workerId,
      payoutRecipientUserId:input.payoutRecipientUserId,
    }), manualRequired: false };
  }
  return {
    error: null,
    manualRequired: await adminManualPayoutRequired(query, {
      escrowId: input.escrow.id,
      workerId: input.workerId,
      payoutRecipientUserId: input.payoutRecipientUserId,
      stripeTransferId: input.stripeTransferId,
    }),
  };
}

async function transitionEscrow(query: QueryFn, input: {
  params: ReleaseEscrowParams;
  escrow: ReleaseEscrowRow;
  provider: ReturnType<typeof payoutProvider>;
}): Promise<ServiceResult<Escrow>> {
  const result = await query<Escrow>(
    `UPDATE escrows SET state='RELEASED',stripe_transfer_id=$2,payout_provider=$4,
      provider_transfer_id=$5,provider_transfer_status=$6,
      provider_transfer_paid_at=CASE WHEN $6='paid' THEN NOW() ELSE NULL END,
      released_at=NOW(),version=version+1,updated_at=NOW()
      WHERE id=$1 AND state IN ('FUNDED', 'LOCKED_DISPUTE') AND version=$3 RETURNING *`,
    [input.escrow.id,
      input.provider.provider === 'STRIPE' ? input.provider.stripeTransferId : null,
      input.escrow.version,input.provider.provider,input.provider.transferId,input.provider.status],
  );
  if ((result.rowCount ?? 0) > 0) return { success: true, data: result.rows[0] };
  const existing = await getEscrowById(input.escrow.id);
  if (!existing.success) return existing;
  return isTerminalEscrowState(existing.data.state)
    ? failed(ErrorCodes.ESCROW_TERMINAL, `Escrow ${input.escrow.id} is in terminal state ${existing.data.state}`)
    : failed(
        ErrorCodes.INVALID_STATE,
        `Cannot release escrow: current state is ${existing.data.state}, expected FUNDED or an authorized resolved dispute`,
      );
}

export async function executeReleaseTransaction(
  query: QueryFn,
  params: ReleaseEscrowParams,
): Promise<ReleaseTransactionResult> {
  const escrow = await loadEscrow(query, params.escrowId);
  if (!escrow) return failed(ErrorCodes.NOT_FOUND, `Escrow ${params.escrowId} not found`);
  if (!await authorizeDispute(query, escrow, params.adminOverride ?? false)) {
    return failed(ErrorCodes.INVALID_STATE, 'Cannot release dispute-locked escrow without a resolved worker-favor dispute');
  }
  const task = await loadTask(query, escrow.task_id);
  if (!task?.worker_id) return failed(ErrorCodes.INVALID_STATE, `Task ${escrow.task_id} has no assigned worker`);
  const workerId = task.worker_id;
  const payoutRecipientUserId = task.payout_recipient_user_id ?? workerId;
  const breakdown = computeFeeBreakdown(
    escrow.amount,
    clampFeePercent(config.stripe.platformFeePercent),
    escrow.platform_fee_cents,
  );
  const provider = payoutProvider(params, escrow);
  const validation = await validateProvider(query, {
    params,escrow,task,workerId,payoutRecipientUserId,
    netPayoutCents: breakdown.netPayoutCents,
    stripeTransferId: provider.stripeTransferId,
  });
  if (validation.error) return validation.error as Extract<ServiceResult<Escrow>, { success: false }>;
  const transitioned = await transitionEscrow(query, { params, escrow, provider });
  if (!transitioned.success) return transitioned;
  const post: ReleasePost = {
    workerId,
    payoutRecipientUserId,
    serviceBusinessProvider: task.provider_organization_id != null,
    grossPayoutCents: escrow.amount,
    netPayoutCents: breakdown.netPayoutCents,
    platformFeeCents: breakdown.platformFeeCents,
    platformFeePercent: feeBasisPoints(escrow.amount, breakdown.platformFeeCents) / 100,
    insuranceContributionCents: breakdown.insuranceContributionCents,
    taskId: escrow.task_id,
    paymentMethod: task.payment_method ?? 'escrow',
    escrowStateBefore: escrow.state,
    adminManualPayoutRequired: validation.manualRequired,
    posterId: task.poster_id,
    payoutProvider: provider.provider,
    providerTransferId: provider.transferId,
  };
  return { success: true, data: transitioned.data, post };
}
