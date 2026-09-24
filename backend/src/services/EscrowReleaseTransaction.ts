import { notifyPaymentReleased } from '../lib/task-lifecycle-notifications.js';
import type { QueryFn } from '../db.js';
import { config } from '../config.js';
import { clampFeePercent, computeFeeBreakdown, feeBasisPoints } from '../lib/money.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { LocalCertificationPayoutProvider } from './LocalCertificationPayoutProvider.js';
import { getEscrowById } from './EscrowReadService.js';
import { loadEscrowPaymentBinding } from './EscrowPaymentBindingService.js';
import type {
  ReleaseEscrowRow,
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
    `SELECT id,task_id,amount,platform_fee_cents,state,version,provider_payment_id
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
        `SELECT state, worker_id,
            payout_recipient_user_id,
            provider_organization_id,
            business_fulfiller_organization_id,
            orchestration_mode,
            price,
            payment_method,
            poster_id,
            automation_classification,
            hustler_payout_cents,
            platform_margin_cents
    FROM tasks
    WHERE id=$1`,
    [taskId],
  );
  return result.rows[0] ?? null;
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
    return failed(
      ErrorCodes.INVALID_STATE,
      'Local certification payout cannot release a production-classified task',
    );
  }

  if (
    input.task.orchestration_mode === 'OPS_MANUAL'
    && input.task.business_fulfiller_organization_id
    && !input.task.worker_id
  ) {
    const verified =
      await LocalCertificationPayoutProvider.verifyPaidBusinessTransfer(query, {
        transferId,
        taskId: input.escrow.task_id,
        escrowId: input.escrow.id,
        organizationId: input.task.business_fulfiller_organization_id,
        payoutRecipientUserId: input.payoutRecipientUserId,
        amountCents: input.netPayoutCents,
      });

    return verified
      ? null
      : failed(
          ErrorCodes.INVALID_STATE,
          'Business local certification payout is not provider-confirmed for the exact net amount',
        );
  }

  if (!input.task.worker_id) {
    return failed(
      ErrorCodes.INVALID_STATE,
      `Task ${input.escrow.task_id} has no recognized payout fulfiller`,
    );
  }

  const verified =
    await LocalCertificationPayoutProvider.verifyPaidTransfer(query, {
      transferId,
      taskId: input.escrow.task_id,
      escrowId: input.escrow.id,
      workerId: input.task.worker_id,
      amountCents: input.netPayoutCents,
    });

  return verified
    ? null
    : failed(
        ErrorCodes.INVALID_STATE,
        'Local certification payout is not provider-confirmed for the exact net amount',
      );
}

async function transitionEscrow(query: QueryFn, escrow: ReleaseEscrowRow, transferId: string | null, internalOnly: boolean): Promise<ServiceResult<Escrow>> {
  const result = await query<Escrow>(
    `UPDATE escrows SET state='RELEASED', payout_provider=$3,
      provider_transfer_id=$4, provider_transfer_status=$5,
      provider_transfer_paid_at=CASE WHEN $5='paid' THEN NOW() ELSE NULL END,
      released_at=NOW(), version=version+1, updated_at=NOW()
      WHERE id=$1 AND state IN ('FUNDED','LOCKED_DISPUTE') AND version=$2 RETURNING *`,
    [escrow.id, escrow.version, internalOnly ? 'TILLED' : 'LOCAL_CERTIFICATION_TEST', transferId,
      internalOnly ? 'not_applicable' : 'paid'],
  );
  if ((result.rowCount ?? 0) > 0) return { success: true, data: result.rows[0] };
  const existing = await getEscrowById(escrow.id);
  if (!existing.success) return existing;
  return failed(isTerminalEscrowState(existing.data.state) ? ErrorCodes.ESCROW_TERMINAL : ErrorCodes.INVALID_STATE,
    'Escrow changed before completion bookkeeping');
}

export async function executeReleaseTransaction(
  query: QueryFn,
  params: ReleaseEscrowParams,
): Promise<ReleaseTransactionResult> {
  const escrow = await loadEscrow(query, params.escrowId);
  if (!escrow) return failed(ErrorCodes.NOT_FOUND, `Escrow ${params.escrowId} not found`);
  if (isTerminalEscrowState(escrow.state as Escrow['state'])) return failed(ErrorCodes.ESCROW_TERMINAL, 'Escrow is already terminal');
  if (!await authorizeDispute(query, escrow, params.adminOverride ?? false)) {
    return failed(ErrorCodes.INVALID_STATE, 'Cannot release dispute-locked escrow without a resolved worker-favor dispute');
  }
  const task = await loadTask(query, escrow.task_id);
  if (!task) {
    return failed(
      ErrorCodes.NOT_FOUND,
      `Task ${escrow.task_id} not found`,
    );
  }

  const payment = await loadEscrowPaymentBinding(query, escrow.id);
  const internalOnly = payment?.provider === 'tilled';
  if (internalOnly && (payment.status !== 'SUCCEEDED' || !payment.organizationId
      || payment.organizationId !== task.business_fulfiller_organization_id || params.localTestTransferId)) {
    return failed(ErrorCodes.INVALID_STATE, 'Tilled completion requires the exact successful business payment');
  }
  if (task.state !== 'COMPLETED' && escrow.state !== 'LOCKED_DISPUTE') {
    return failed(ErrorCodes.INVALID_STATE, 'Task must be completed before completion bookkeeping');
  }
  if (!internalOnly && (payment && payment.provider !== 'local_test' || !params.localTestTransferId)) {
    return failed(ErrorCodes.INVALID_STATE, 'No supported verified completion provider evidence');
  }
  const isManualBusiness = Boolean(task.business_fulfiller_organization_id) && (internalOnly || !task.worker_id);
  if (!task.worker_id && !isManualBusiness) return failed(ErrorCodes.INVALID_STATE, 'Task has no recognized fulfiller');
  let payoutRecipientUserId: string | null = task.payout_recipient_user_id ?? task.worker_id;
  if (!internalOnly && isManualBusiness) {
    const destination = await query<{ payout_recipient_user_id: string }>(
      `SELECT payout_recipient_user_id FROM hxos_local_test_business_payout_destinations
       WHERE organization_id=$1 AND status='ACTIVE' AND is_test IS TRUE`, [task.business_fulfiller_organization_id],
    );
    if (destination.rows.length !== 1) return failed(ErrorCodes.INVALID_STATE, 'Business payout destination is not uniquely resolved');
    payoutRecipientUserId = destination.rows[0].payout_recipient_user_id;
  }
  // A live merchant-direct charge already used these frozen task economics.
  // Completion must never recalculate its fee from today's platform settings.
  if (internalOnly && (task.platform_margin_cents == null || task.hustler_payout_cents == null
      || (escrow.platform_fee_cents != null && escrow.platform_fee_cents !== task.platform_margin_cents))) {
    return failed(ErrorCodes.INVALID_STATE, 'Tilled completion requires consistent frozen task economics');
  }
  const breakdown = computeFeeBreakdown(escrow.amount, clampFeePercent(config.payments.platformFeePercent),
    internalOnly ? task.platform_margin_cents : escrow.platform_fee_cents);
  const payoutCents = isManualBusiness ? breakdown.netBeforeInsuranceCents : breakdown.netPayoutCents;
  if (isManualBusiness && task.hustler_payout_cents !== payoutCents) {
    return failed(ErrorCodes.INVALID_STATE, 'Business payout does not match frozen task economics');
  }
  if (!internalOnly) {
    const error = await verifyLocalProvider(query, { params, escrow, task,
      payoutRecipientUserId: payoutRecipientUserId!, netPayoutCents: payoutCents });
    if (error) return error as Extract<ServiceResult<Escrow>, { success: false }>;
  }
  const transferId = internalOnly ? null : params.localTestTransferId!;
  const transitioned = await transitionEscrow(query, escrow, transferId, internalOnly);
  if (!transitioned.success) return transitioned;
  if (!internalOnly && payoutRecipientUserId) {
    await notifyPaymentReleased(payoutRecipientUserId, escrow.task_id, payoutCents,
      query, escrow.id, isManualBusiness ? task.business_fulfiller_organization_id ?? undefined : undefined);
  }
  const post: ReleasePost = {
    workerId: task.worker_id, businessFulfillerOrganizationId: task.business_fulfiller_organization_id,
    payoutRecipientUserId, serviceBusinessProvider: task.provider_organization_id != null,
    grossPayoutCents: escrow.amount, netPayoutCents: payoutCents, platformFeeCents: breakdown.platformFeeCents,
    platformFeePercent: feeBasisPoints(escrow.amount, breakdown.platformFeeCents) / 100,
    insuranceContributionCents: isManualBusiness ? 0 : breakdown.insuranceContributionCents,
    taskId: escrow.task_id, paymentMethod: task.payment_method ?? 'escrow', escrowStateBefore: escrow.state,
    adminManualPayoutRequired: false, posterId: task.poster_id,
    payoutProvider: internalOnly ? 'TILLED' : 'LOCAL_CERTIFICATION_TEST', providerTransferId: transferId,
  };
  return { success: true, data: transitioned.data, post };
}
