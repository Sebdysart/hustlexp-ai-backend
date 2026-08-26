import { config } from '../config.js';
import {
  clampFeePercent,
  computeInsuranceContributionCents,
  computePlatformFeeCents,
} from '../lib/money.js';
import { escrowLogger } from '../logger.js';
import {
  acquireOrLoadPartialRefundTransferCheckpoint,
  checkpointPartialRefundTransfer,
  persistPartialRefundTransferRecovery,
  requireCurrentPartialRefundTransfer,
  requireExactPartialRefundWitness,
} from './EscrowPartialRefundEvidence.js';
import type {
  PartialRefundBinding,
  PartialRefundProcessorWitness,
} from './EscrowPartialRefundEvidence.js';
import { newPaymentCreationFailure } from './NewPaymentCreationGuard.js';
import { StripeService } from './StripeService.js';
import type { StripeTransferWitness } from './EscrowReleaseTypes.js';
import type {
  PartialRefundAmounts,
  PartialRefundContext,
  PartialRefundProviderResult,
} from './EscrowPartialRefundTypes.js';

interface PartialRefundRecovery {
  acquireOrLoad(): Promise<PartialRefundProcessorWitness | null>;
  checkpoint(witness: PartialRefundProcessorWitness): Promise<void>;
}

interface PosterRefundResult {
  refundId: string | null;
  created: boolean;
  witness: PartialRefundProcessorWitness | null;
}

interface WorkerTransferResult {
  transferId: string | null;
  witness: StripeTransferWitness | null;
  created: boolean;
}

export function computePartialRefundAmounts(input: {
  amount: number;
  workerPercent: number;
  posterPercent: number;
}): PartialRefundAmounts {
  const workerCents = Math.round(input.amount * (input.workerPercent / 100));
  const posterCents = input.amount - workerCents;
  const platformFeePercent = clampFeePercent(config.stripe.platformFeePercent);
  const netWorkerCentsBeforeInsurance = workerCents
    - computePlatformFeeCents(workerCents, platformFeePercent);
  const insuranceContributionCents = computeInsuranceContributionCents(workerCents);
  return {
    workerPercent: input.workerPercent,
    posterPercent: input.posterPercent,
    workerCents,
    posterCents,
    platformFeePercent,
    netWorkerCentsBeforeInsurance,
    insuranceContributionCents,
    netWorkerCents: netWorkerCentsBeforeInsurance - insuranceContributionCents,
  };
}

async function issuePosterRefund(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
  binding: PartialRefundBinding,
  checkpoint: PartialRefundProcessorWitness | null,
): Promise<PosterRefundResult> {
  if (amounts.posterCents === 0) {
    return { refundId: context.existingRefundId, created: false, witness: null };
  }
  if (checkpoint) {
    escrowLogger.info(
      { escrowId: context.escrowId, stripeRefundId: checkpoint.refundId },
      'partialRefund: exact refund checkpoint exists — skipping duplicate Stripe refund',
    );
    return { refundId: checkpoint.refundId, created: false, witness: checkpoint };
  }
  if (!context.stripePaymentIntentId) {
    throw new Error('partialRefund: no stripe_payment_intent_id — manual refund required');
  }
  const result = await StripeService.createRefund({
    paymentIntentId: context.stripePaymentIntentId,
    escrowId: context.escrowId,
    amount: amounts.posterCents,
    reason: 'requested_by_customer',
    idempotencyKeySuffix: 'partial_refund',
  });
  if (!result.success) throw new Error(`partialRefund: Stripe refund failed — ${result.error.message}`);
  const witness = requireExactPartialRefundWitness(result.data, binding);
  return { refundId: witness.refundId, created: true, witness };
}

async function issueWorkerTransfer(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
  binding: PartialRefundBinding,
): Promise<WorkerTransferResult> {
  if (amounts.workerCents === 0) {
    return { transferId: context.existingTransferId, witness: null, created: false };
  }
  const claimedCheckpoint = await acquireOrLoadPartialRefundTransferCheckpoint(binding);
  if (claimedCheckpoint) {
    const witness = await requireCurrentPartialRefundTransfer({
      binding,
      transferId: claimedCheckpoint.witness.transferId,
    });
    return {
      transferId: witness.transferId,
      witness,
      created: claimedCheckpoint.transferCreated,
    };
  }
  if (context.existingTransferId) {
    const witness = await requireCurrentPartialRefundTransfer({
      binding,
      transferId: context.existingTransferId,
    });
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
    escrowLogger.info(
      { escrowId: context.escrowId, stripeTransferId: context.existingTransferId },
      'partialRefund: exact current transfer witness exists — skipping duplicate Stripe transfer',
    );
    return { transferId: context.existingTransferId, witness, created: false };
  }
  if (!context.workerId) throw new Error('partialRefund: no worker_id — cannot issue worker transfer');
  if (!context.payoutRecipientUserId || !context.payoutStripeConnectId) {
    throw new Error(
      `partialRefund: payout destination ${context.payoutRecipientUserId} is not current (${context.payoutDestinationError ?? 'PAYOUT_ACCOUNT_NOT_READY'}) — cannot issue transfer of ${amounts.workerCents} cents. Escrow remains LOCKED_DISPUTE for recovery.`,
    );
  }
  const result = await StripeService.createTransfer({
    escrowId: context.escrowId,
    taskId: context.taskId,
    workerId: context.payoutRecipientUserId,
    workerStripeAccountId: context.payoutStripeConnectId,
    amount: amounts.netWorkerCents,
    description: `Dispute partial resolution: worker ${amounts.workerPercent}%`,
    idempotencyKeySuffix: 'partial_refund_transfer',
  });
  if (!result.success) throw new Error(`partialRefund: Stripe transfer failed — ${result.error.message}`);
  const witness = await requireCurrentPartialRefundTransfer({
    binding,
    transferId: result.data.transferId,
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
  return { transferId: result.data.transferId, witness, created: true };
}

export async function executePartialRefundProviders(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
  binding: PartialRefundBinding,
  recovery: PartialRefundRecovery,
): Promise<PartialRefundProviderResult> {
  const frozen = newPaymentCreationFailure('settlement_transfer');
  const frozenSplit = frozen && amounts.workerCents > 0 && !context.existingTransferId;
  if (frozenSplit) {
    throw Object.assign(new Error(frozen.error.message), {
      code: frozen.error.code,
      details: frozen.error.details,
    });
  }
  const checkpoint = amounts.posterCents > 0
    ? await recovery.acquireOrLoad()
    : null;
  const posterRefund = await issuePosterRefund(context, amounts, binding, checkpoint);
  if (posterRefund.created && posterRefund.witness) {
    await recovery.checkpoint(posterRefund.witness);
  }

  const transfer = await issueWorkerTransfer(context, amounts, binding);
  return {
    transferId: transfer.transferId,
    refundId: posterRefund.refundId,
    transferWitness: transfer.witness,
    transferCreated: transfer.created,
  };
}
