import type { QueryFn } from '../db.js';
import { config } from '../config.js';
import { clampFeePercent, computeFeeBreakdown, feeBasisPoints } from '../lib/money.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { LocalCertificationPayoutProvider } from './LocalCertificationPayoutProvider.js';
import { getEscrowById } from './EscrowReadService.js';
import { loadCurrentTaskPayoutDestination } from './TaskPayoutDestinationService.js';
import type {
  ReleaseEscrowRow,
  ReleasePayoutProvider,
  ReleasePost,
  StripeTransferWitness,
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
    `SELECT worker_id,payout_recipient_user_id,provider_organization_id,
            provider_assignment_id,price,
            payment_method,poster_id,automation_classification,hustler_payout_cents,
            platform_margin_cents FROM tasks WHERE id=$1 FOR UPDATE`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

function payoutProvider(params: ReleaseEscrowParams): {
  provider: ReleasePayoutProvider;
  transferId: string | null;
  stripeTransferId: string | null;
  status: string;
} {
  const stripeTransferId = params.stripeTransferId ?? null;
  const provider: ReleasePayoutProvider = params.localTestTransferId
    ? 'LOCAL_CERTIFICATION_TEST'
    : 'STRIPE';
  return {
    provider,
    transferId: params.localTestTransferId ?? stripeTransferId ?? null,
    stripeTransferId: stripeTransferId ?? null,
    status: provider === 'LOCAL_CERTIFICATION_TEST' ? 'paid' : 'submitted',
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
  if (input.escrow.stripe_transfer_id) {
    return failed(ErrorCodes.INVALID_STATE, 'Local certification payout conflicts with stored Stripe transfer evidence');
  }
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

function witnessMismatch(
  witness: StripeTransferWitness,
  input: {
    transferId: string;
    escrow: ReleaseEscrowRow;
    task: ReleaseTaskRow;
    payoutRecipientUserId: string;
    netPayoutCents: number;
    destinationAccountId: string;
  },
): boolean {
  return witness.provider !== 'STRIPE'
    || witness.transferId !== input.transferId
    || !Number.isInteger(witness.amountCents)
    || witness.amountCents !== input.netPayoutCents
    || witness.currency !== 'usd'
    || witness.destinationAccountId !== input.destinationAccountId
    || witness.reversed
    || !Number.isInteger(witness.amountReversedCents)
    || witness.amountReversedCents !== 0
    || witness.escrowId !== input.escrow.id
    // Legacy transfers without task_id require a separately admitted cutover
    // cohort and immutable admission witness. No such authority exists in D1,
    // so exact task identity remains mandatory even when the transfer ID was
    // already stored on the escrow.
    || witness.taskId !== input.escrow.task_id
    || witness.payoutRecipientUserId !== input.payoutRecipientUserId
    || Number(input.task.price) !== input.escrow.amount
    || (
      input.escrow.stripe_transfer_id !== null
      && input.escrow.stripe_transfer_id !== undefined
      && input.escrow.stripe_transfer_id !== input.transferId
    );
}

async function verifyStripeProvider(
  query: QueryFn,
  input: {
    params: ReleaseEscrowParams;
    escrow: ReleaseEscrowRow;
    task: ReleaseTaskRow;
    workerId: string;
    payoutRecipientUserId: string;
    netPayoutCents: number;
  },
): Promise<ServiceResult<Escrow> | null> {
  const transferId = input.params.stripeTransferId;
  const witness = input.params.stripeTransferWitness;
  if (!transferId || !witness) {
    return failed(ErrorCodes.INVALID_STATE, 'Stripe release requires current exact provider evidence');
  }
  const destination = await loadCurrentTaskPayoutDestination(query,{
    taskId:input.escrow.task_id,
    workerId:input.workerId,
    payoutRecipientUserId:input.payoutRecipientUserId,
  });
  if (!destination.ready || !destination.stripeConnectId) {
    return failed(
      ErrorCodes.INVALID_STATE,
      `Payout destination is not current (${destination.reason}) — cannot release payout`,
    );
  }
  return witnessMismatch(witness, {
    transferId,
    escrow:input.escrow,
    task:input.task,
    payoutRecipientUserId:input.payoutRecipientUserId,
    netPayoutCents:input.netPayoutCents,
    destinationAccountId:destination.stripeConnectId,
  })
    ? failed(
        ErrorCodes.INVALID_STATE,
        'Stripe transfer witness does not match the locked escrow, task, recipient, or payout destination',
      )
    : null;
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
  return {
    error: await verifyStripeProvider(query, input),
    manualRequired: false,
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
  const provider = payoutProvider(params);
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
