import { config } from '../config.js';
import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import {
  clampFeePercent,
  computeInsuranceContributionCents,
  computePlatformFeeCents,
} from '../lib/money.js';
import { workerLogger } from '../logger.js';
import { StripeService } from '../services/StripeService.js';
import {
  acquireOrLoadPartialRefundCheckpoint,
  acquireOrLoadPartialRefundTransferCheckpoint,
  checkpointPartialRefundTransfer,
  checkpointPartialRefund,
  lockExactPartialRefundBinding,
  lockExactPartialRefundT2Evidence,
  partialRefundReconciliationError,
  persistPartialRefundProviderException,
  persistPartialRefundTransferRecovery,
  requireCurrentPartialRefundTransfer,
  requireExactPartialRefundWitness,
  recordExactPartialRefundTerminalTransition,
} from '../services/EscrowPartialRefundEvidence.js';
import type { PartialRefundBinding } from '../services/EscrowPartialRefundEvidence.js';
import type { StripeTransferWitness } from '../services/EscrowReleaseTypes.js';
import { reconcilePartialRefundPostTerminal } from '../services/EscrowPartialRefundReconciliationService.js';
import { newPaymentCreationFailure } from '../services/NewPaymentCreationGuard.js';
import { loadCurrentTaskPayoutDestination } from '../services/TaskPayoutDestinationService.js';
import { lockEscrowForStripeRestriction, stripeRestrictionCode } from './EscrowActionRestriction.js';
import type { EscrowActionInput, TaskPayoutRow } from './EscrowActionTypes.js';
import { taskPayoutRecipient } from './EscrowActionTypes.js';

const log = workerLogger.child({ worker: 'escrow-action' });

interface SplitMoney {
  refundAmount: number;
  releaseAmount: number;
  netReleaseCents: number;
  platformFeeCents: number;
  platformFeeBasisPoints: number;
  insuranceContributionCents: number;
}

interface SplitProviderResult {
  refundId: string | null;
  transferId: string | null;
  transferWitness: StripeTransferWitness | null;
  transferCreated: boolean;
  restricted: boolean;
}

function splitMoney(action: EscrowActionInput): SplitMoney {
  if (action.escrow.platform_fee_cents != null) {
    throw new Error('CANONICAL_QUOTE_SPLIT_REQUIRES_RECONCILIATION: partial dispute payout is fail-closed');
  }
  const refundAmount = action.refundAmount;
  const releaseAmount = action.releaseAmount;
  if (
    !Number.isInteger(refundAmount)
    || !Number.isInteger(releaseAmount)
    || !refundAmount
    || !releaseAmount
    || refundAmount <= 0
    || releaseAmount <= 0
    || refundAmount + releaseAmount !== action.escrow.amount
  ) {
    throw partialRefundReconciliationError(
      `SPLIT requires positive integer refund/release amounts summing to escrow ${action.escrow.amount}`,
    );
  }
  const feePercent = clampFeePercent(config.stripe.platformFeePercent);
  const beforeInsurance = releaseAmount - computePlatformFeeCents(releaseAmount, feePercent);
  const rawFee = releaseAmount - beforeInsurance;
  const platformFeeCents = rawFee;
  if (refundAmount + beforeInsurance + platformFeeCents !== action.escrow.amount) {
    throw new Error(
      `SPLIT amounts ${refundAmount} + ${beforeInsurance} + fee ${platformFeeCents} !== escrow ${action.escrow.amount}`,
    );
  }
  const insuranceContributionCents = computeInsuranceContributionCents(releaseAmount);
  return {
    refundAmount,
    releaseAmount,
    netReleaseCents: beforeInsurance - insuranceContributionCents,
    platformFeeCents,
    platformFeeBasisPoints: Math.round(feePercent * 100),
    insuranceContributionCents,
  };
}

async function loadTask(taskId: string): Promise<TaskPayoutRow> {
  const result = await db.query<TaskPayoutRow>(
    `SELECT worker_id,payout_recipient_user_id,provider_organization_id,
            provider_assignment_id,poster_id FROM tasks WHERE id=$1`,
    [taskId],
  );
  if (!result.rows[0]) throw new Error(`Task ${taskId} not found`);
  return result.rows[0];
}

async function resolveRefund(binding: PartialRefundBinding): Promise<string> {
  const checkpoint = await acquireOrLoadPartialRefundCheckpoint(binding);
  if (checkpoint) return checkpoint.refundId;
  const result = await StripeService.createRefund({
    paymentIntentId: binding.paymentIntentId,
    escrowId: binding.escrowId,
    amount: binding.refundAmountCents,
    reason: 'requested_by_customer',
    idempotencyKeySuffix: 'partial_refund',
  });
  if (!result.success) throw new Error(`Failed to create refund: ${result.error.message}`);
  const witness = requireExactPartialRefundWitness(result.data, binding);
  await checkpointPartialRefund(binding, witness);
  return witness.refundId;
}

async function loadPayoutDestination(taskId:string,task:TaskPayoutRow,userId:string|null) {
  if (!userId || !task.worker_id) {
    return { ready:false as const,stripeConnectId:null,reason:'TASK_BINDING_MISMATCH' as const };
  }
  const destination=await loadCurrentTaskPayoutDestination(db.query.bind(db),{
    taskId,workerId:task.worker_id,payoutRecipientUserId:userId,
  });
  return destination;
}

async function createSplitTransfer(input: {
  action: EscrowActionInput;
  task: TaskPayoutRow;
  money: SplitMoney;
  payoutRecipientUserId: string;
  stripeAccountId: string;
}): Promise<{ transferId: string | null; restricted: boolean; restrictionCode: string | null }> {
  try {
    const result = await StripeService.createTransfer({
      escrowId: input.action.escrow.id,
      taskId: input.action.taskId,
      workerId: input.payoutRecipientUserId,
      workerStripeAccountId: input.stripeAccountId,
      amount: input.money.netReleaseCents,
      description: `Dispute resolution: ${input.action.reason}`,
      idempotencyKeySuffix: 'partial_refund_transfer',
    });
    if (!result.success) {
      throw Object.assign(new Error(`Failed to create transfer: ${result.error.message}`), {
        code: result.error.code,
      });
    }
    return { transferId: result.data.transferId, restricted: false, restrictionCode: null };
  } catch (error) {
    const code = stripeRestrictionCode(error);
    if (!code) throw error;
    log.error({
      escrowId: input.action.escrow.id,
      workerId: input.task.worker_id,
      payoutRecipientUserId: input.payoutRecipientUserId,
      stripeCode: code,
    }, 'CRITICAL: Stripe account restricted (partial refund path) — locking escrow, NOT retrying');
    await lockEscrowForStripeRestriction({
      escrowId: input.action.escrow.id,
      workerId: input.payoutRecipientUserId,
      stripeCode: code,
    });
    return { transferId: null, restricted: true, restrictionCode: code };
  }
}

async function resolveTransfer(
  action: EscrowActionInput,
  task: TaskPayoutRow,
  money: SplitMoney,
  binding: PartialRefundBinding,
  refundId: string,
): Promise<{
  transferId: string | null;
  transferWitness: StripeTransferWitness | null;
  transferCreated: boolean;
  restricted: boolean;
}> {
  const transferId = action.escrow.stripe_transfer_id;
  const claimedCheckpoint = await acquireOrLoadPartialRefundTransferCheckpoint(binding);
  if (claimedCheckpoint) {
    const witness = await requireCurrentPartialRefundTransfer({
      binding,
      transferId: claimedCheckpoint.witness.transferId,
    });
    return {
      transferId: witness.transferId,
      transferWitness: witness,
      transferCreated: claimedCheckpoint.transferCreated,
      restricted: false,
    };
  }
  if (transferId) {
    const witness = await requireCurrentPartialRefundTransfer({ binding, transferId });
    try {
      await checkpointPartialRefundTransfer({
        binding,
        witness,
        transferCreated: false,
      });
    } catch (error) {
      await persistPartialRefundTransferRecovery({
        binding,
        witness,
        transferCreated: false,
        failureStage: 'TRANSFER_CHECKPOINT_FAILED',
      });
      throw error;
    }
    return {
      transferId,
      transferWitness: witness,
      transferCreated: false,
      restricted: false,
    };
  }
  if (!task.worker_id) throw new Error(`Task ${action.taskId} has no worker_id`);
  const payoutRecipientUserId = taskPayoutRecipient(task);
  if (!binding.destinationAccountId || binding.payoutDestinationError) {
    throw partialRefundReconciliationError(
      `Payout destination ${payoutRecipientUserId} is not current (${binding.payoutDestinationError ?? 'PAYOUT_ACCOUNT_NOT_READY'})`,
    );
  }
  const created = await createSplitTransfer({
    action,
    task,
    money,
    payoutRecipientUserId: payoutRecipientUserId!,
    stripeAccountId: binding.destinationAccountId,
  });
  if (created.restricted) {
    await persistPartialRefundProviderException({
      binding,
      refundId,
      failureStage: 'TRANSFER_RESTRICTED_AFTER_REFUND',
      reasonCode: created.restrictionCode ?? 'unknown_provider_restriction',
    });
    throw partialRefundReconciliationError(
      `partialRefund: refund ${refundId} succeeded but transfer is restricted; escrow ${binding.escrowId} requires reconciliation`,
    );
  }
  if (created.transferId) {
    const witness = await requireCurrentPartialRefundTransfer({
      binding,
      transferId: created.transferId,
    });
    try {
      await checkpointPartialRefundTransfer({
        binding,
        witness,
        transferCreated: true,
      });
    } catch (error) {
      await persistPartialRefundTransferRecovery({
        binding,
        witness,
        transferCreated: true,
        failureStage: 'TRANSFER_CHECKPOINT_FAILED',
      });
      throw error;
    }
    return {
      transferId: created.transferId,
      transferWitness: witness,
      transferCreated: true,
      restricted: false,
    };
  }
  return {
    transferId: null,
    transferWitness: null,
    transferCreated: false,
    restricted: created.restricted,
  };
}

async function buildWorkerBinding(
  action: EscrowActionInput,
  task: TaskPayoutRow,
  money: SplitMoney,
): Promise<PartialRefundBinding> {
  if (!action.disputeId) {
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${action.escrow.id} has no dispute identity`,
    );
  }
  if (action.escrow.task_id !== action.taskId) {
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${action.escrow.id} is not bound to task ${action.taskId}`,
    );
  }
  if (!action.escrow.stripe_payment_intent_id) {
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${action.escrow.id} has no PaymentIntent identity`,
    );
  }
  if (action.escrow.refund_amount != null || action.escrow.release_amount != null) {
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${action.escrow.id} already carries split amounts`,
    );
  }
  const payoutRecipientUserId = taskPayoutRecipient(task);
  const destination = await loadPayoutDestination(
    action.taskId,
    task,
    payoutRecipientUserId,
  );
  return {
    escrowId: action.escrow.id,
    escrowVersion: action.escrow.version,
    taskId: action.taskId,
    disputeId: action.disputeId,
    escrowAmountCents: action.escrow.amount,
    canonicalPlatformFeeCents: action.escrow.platform_fee_cents,
    paymentIntentId: action.escrow.stripe_payment_intent_id,
    existingTransferId: action.escrow.stripe_transfer_id,
    existingRefundId: action.escrow.stripe_refund_id,
    refundAmountCents: money.refundAmount,
    releaseAmountCents: money.releaseAmount,
    splitPlatformFeeCents: money.platformFeeCents,
    platformFeeBasisPoints: money.platformFeeBasisPoints,
    insuranceContributionCents: money.insuranceContributionCents,
    netReleaseAmountCents: money.netReleaseCents,
    xpClawbackFraction: money.refundAmount / action.escrow.amount,
    workerId: task.worker_id,
    payoutRecipientUserId,
    providerOrganizationId: task.provider_organization_id,
    providerAssignmentId: task.provider_assignment_id,
    posterId: task.poster_id,
    destinationAccountId: destination.ready ? destination.stripeConnectId : null,
    payoutDestinationError: destination.ready ? null : destination.reason,
  };
}

async function terminalize(query: QueryFn, input: {
  binding: PartialRefundBinding;
  provider: SplitProviderResult;
}): Promise<void> {
  await lockExactPartialRefundBinding(query, input.binding, true);
  const exactProvider = await lockExactPartialRefundT2Evidence(
    query,
    input.binding,
    input.provider,
  );
  const updated = await query<{ id: string; state: string }>(
    `UPDATE escrows
        SET state='REFUND_PARTIAL',stripe_refund_id=$9,stripe_transfer_id=$10,
            refund_amount=$11,release_amount=$12,
            refunded_at=NOW(),released_at=NOW(),version=version+1,updated_at=NOW()
      WHERE id=$1 AND version=$2 AND state='LOCKED_DISPUTE'
        AND task_id=$3 AND amount=$4
        AND platform_fee_cents IS NOT DISTINCT FROM $5
        AND stripe_payment_intent_id IS NOT DISTINCT FROM $6
        AND stripe_transfer_id IS NOT DISTINCT FROM $7
        AND stripe_refund_id IS NOT DISTINCT FROM $8
        AND refund_amount IS NULL AND release_amount IS NULL
      RETURNING id,state`,
    [
      input.binding.escrowId,
      input.binding.escrowVersion,
      input.binding.taskId,
      input.binding.escrowAmountCents,
      input.binding.canonicalPlatformFeeCents,
      input.binding.paymentIntentId,
      input.binding.existingTransferId,
      input.binding.existingRefundId,
      input.provider.refundId,
      input.provider.transferId,
      input.binding.refundAmountCents,
      input.binding.releaseAmountCents,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw partialRefundReconciliationError(
      `partialRefund: exact T2 compare-and-swap failed for escrow ${input.binding.escrowId}`,
    );
  }
  await recordExactPartialRefundTerminalTransition(
    query,
    input.binding,
    exactProvider,
  );
}

function assertProviderEvidence(action: EscrowActionInput, money: SplitMoney, provider: SplitProviderResult): void {
  if (money.refundAmount > 0 && !provider.refundId) {
    throw new Error(`Cannot terminalize SPLIT: refundAmount > 0 (${money.refundAmount}) but refundId is missing for escrow ${action.escrow.id}`);
  }
  if (money.releaseAmount > 0 && !provider.transferId) {
    throw new Error(`Cannot terminalize SPLIT: releaseAmount > 0 (${money.releaseAmount}) but transferId is missing for escrow ${action.escrow.id}`);
  }
}

export async function handlePartialRefundRequest(action: EscrowActionInput): Promise<void> {
  const money = splitMoney(action);
  if (action.escrow.stripe_transfer_id) {
    log.error({
      escrowId: action.escrow.id,
      existingTransferId: action.escrow.stripe_transfer_id,
    }, 'Released-origin partial refund blocked before refund: proportional transfer reversal is not certified');
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${action.escrow.id} already has transfer ${action.escrow.stripe_transfer_id}; `
      + 'released-origin SPLIT requires certified proportional transfer reversal before any refund',
    );
  }
  const task = await loadTask(action.taskId);
  const binding = await buildWorkerBinding(action, task, money);
  const frozen = newPaymentCreationFailure('settlement_transfer');
  if (frozen && money.releaseAmount > 0 && !action.escrow.stripe_transfer_id) {
    log.warn({
      escrowId: action.escrow.id,
      releaseAmount: money.releaseAmount,
    }, 'Partial settlement blocked before every provider leg because its positive transfer is frozen');
    throw Object.assign(new Error(frozen.error.message), {
      code: frozen.error.code,
      details: frozen.error.details,
    });
  }
  const refundId = await resolveRefund(binding);
  const transfer = await resolveTransfer(action, task, money, binding, refundId);
  const provider: SplitProviderResult = {
    refundId,
    transferId: transfer.transferId,
    transferWitness: transfer.transferWitness,
    transferCreated: transfer.transferCreated,
    restricted: false,
  };
  assertProviderEvidence(action, money, provider);
  try {
    await db.transaction((query) => terminalize(query, { binding, provider }));
  } catch (error) {
    if (provider.transferWitness) {
      await persistPartialRefundTransferRecovery({
        binding,
        witness: provider.transferWitness,
        transferCreated: provider.transferCreated,
        failureStage: 'CANONICAL_T2_FAILED',
      });
    }
    throw error;
  }
  await reconcilePartialRefundPostTerminal({
    escrowId: action.escrow.id,
    taskId: action.taskId,
    disputeId: action.disputeId,
    refundAmountCents: money.refundAmount,
    releaseAmountCents: money.releaseAmount,
  });
  log.info({
    escrowId: action.escrow.id,
    refundAmount: money.refundAmount,
    releaseAmount: money.releaseAmount,
  }, 'Escrow set to REFUND_PARTIAL');
}
