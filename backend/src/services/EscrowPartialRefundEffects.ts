import { db } from '../db.js';
import { escrowLogger } from '../logger.js';
import { RevenueService } from './RevenueService.js';
import { SelfInsurancePoolService } from './SelfInsurancePoolService.js';
import { XPService } from './XPService.js';
import type {
  PartialRefundAmounts,
  PartialRefundContext,
  PartialRefundProviderResult,
} from './EscrowPartialRefundTypes.js';
import { logEscrowEvent } from './EscrowServiceShared.js';

async function reconcileMissingTransfer(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
  provider: PartialRefundProviderResult,
): Promise<void> {
  if (amounts.workerCents === 0 || provider.transferId) return;
  const result = await db.query<{ id: string }>(
    `SELECT id FROM revenue_ledger WHERE escrow_id = $1 AND event_type = 'platform_fee' LIMIT 1`,
    [context.escrowId],
  );
  if (result.rows.length > 0) {
    escrowLogger.warn(
      { escrowId: context.escrowId },
      '[EscrowService.partialRefund] resolvedTransferId is null but platform_fee ledger entry already exists — skipping duplicate ledger write (idempotent retry)',
    );
    return;
  }
  escrowLogger.error({
    escrowId: context.escrowId,
    workerCents: amounts.workerCents,
    txWorkerId: context.workerId,
  }, '[EscrowService.partialRefund] CRITICAL: resolvedTransferId is null and no existing platform_fee ledger entry found — Stripe transfer may have been created but not recorded. Manual reconciliation required via Stripe idempotency key.');
}

async function logPartialRevenue(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
  provider: PartialRefundProviderResult,
): Promise<void> {
  const feeCents = amounts.workerCents - amounts.netWorkerCentsBeforeInsurance;
  if (amounts.workerCents === 0 || !provider.transferId || feeCents === 0) return;
  try {
    await RevenueService.logEvent({
      eventType: 'platform_fee',
      userId: context.posterId ?? context.workerId!,
      taskId: context.taskId || undefined,
      amountCents: feeCents,
      grossAmountCents: amounts.workerCents,
      platformFeeCents: feeCents,
      netAmountCents: amounts.netWorkerCents,
      feeBasisPoints: Math.round(amounts.platformFeePercent * 100),
      escrowId: context.escrowId,
      stripeTransferId: provider.transferId,
      metadata: { event: 'escrow_partial_refund' },
    });
  } catch (error) {
    escrowLogger.error(
      { err: error instanceof Error ? error.message : String(error), escrowId: context.escrowId },
      '[EscrowService.partialRefund] revenue ledger write failed — manual reconciliation required',
    );
  }
}

async function recordPartialInsurance(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
  provider: PartialRefundProviderResult,
): Promise<void> {
  if (!provider.transferId || !context.workerId || !context.taskId || amounts.insuranceContributionCents === 0) return;
  try {
    await SelfInsurancePoolService.recordContribution(
      context.taskId,
      context.workerId,
      amounts.insuranceContributionCents,
    );
  } catch (error) {
    escrowLogger.warn(
      { err: error instanceof Error ? error.message : String(error), escrowId: context.escrowId },
      '[EscrowService.partialRefund] self-insurance pool contribution failed — partial refund proceeds',
    );
  }
}

async function clawbackPartialXp(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
): Promise<void> {
  if (amounts.posterPercent === 0 || !context.workerId) return;
  try {
    await XPService.clawbackXP(
      context.workerId,
      context.escrowId,
      'dispute_lost',
      amounts.posterPercent / 100,
    );
  } catch (error) {
    escrowLogger.error(
      { err: error instanceof Error ? error.message : String(error), escrowId: context.escrowId },
      'XP clawback failed during partialRefund — refund proceeds',
    );
  }
}

export async function runPartialRefundEffects(input: {
  context: PartialRefundContext;
  amounts: PartialRefundAmounts;
  provider: PartialRefundProviderResult;
}): Promise<void> {
  await logEscrowEvent(input.context.escrowId, 'LOCKED_DISPUTE', 'REFUND_PARTIAL');
  await reconcileMissingTransfer(input.context, input.amounts, input.provider);
  await logPartialRevenue(input.context, input.amounts, input.provider);
  await recordPartialInsurance(input.context, input.amounts, input.provider);
  await clawbackPartialXp(input.context, input.amounts);
}
