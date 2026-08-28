import { config } from '../config.js';
import {
  clampFeePercent,
  computeInsuranceContributionCents,
  computePlatformFeeCents,
} from '../lib/money.js';
import { escrowLogger } from '../logger.js';
import { StripeService } from './StripeService.js';
import type {
  PartialRefundAmounts,
  PartialRefundContext,
  PartialRefundProviderResult,
} from './EscrowPartialRefundTypes.js';

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
): Promise<string | null> {
  if (amounts.posterCents === 0) return context.existingRefundId;
  if (context.existingRefundId) {
    escrowLogger.info(
      { escrowId: context.escrowId, stripeRefundId: context.existingRefundId },
      'partialRefund: stripe_refund_id already set — skipping duplicate Stripe refund',
    );
    return context.existingRefundId;
  }
  if (!context.stripePaymentIntentId) {
    throw new Error('partialRefund: no stripe_payment_intent_id — manual refund required');
  }
  const result = await StripeService.createRefund({
    paymentIntentId: context.stripePaymentIntentId,
    escrowId: context.escrowId,
    amount: amounts.posterCents,
    reason: 'requested_by_customer',
    idempotencyKeySuffix: 'svc_partial_refund',
  });
  if (!result.success) throw new Error(`partialRefund: Stripe refund failed — ${result.error.message}`);
  return result.data.refundId;
}

async function issueWorkerTransfer(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
): Promise<string | null> {
  if (amounts.workerCents === 0) return context.existingTransferId;
  if (context.existingTransferId) {
    escrowLogger.info(
      { escrowId: context.escrowId, stripeTransferId: context.existingTransferId },
      'partialRefund: stripe_transfer_id already set — skipping duplicate Stripe transfer',
    );
    return context.existingTransferId;
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
    idempotencyKeySuffix: 'svc_partial_refund',
  });
  if (!result.success) throw new Error(`partialRefund: Stripe transfer failed — ${result.error.message}`);
  return result.data.transferId;
}

export async function executePartialRefundProviders(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
): Promise<PartialRefundProviderResult> {
  const refundId = await issuePosterRefund(context, amounts);
  const transferId = await issueWorkerTransfer(context, amounts);
  return { transferId, refundId };
}
