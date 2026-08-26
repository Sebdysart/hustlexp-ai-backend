import { partialRefundReconciliationError } from './EscrowPartialRefundEvidence.js';
import { reconcilePartialRefundPostTerminal } from './EscrowPartialRefundReconciliationService.js';
import type {
  PartialRefundAmounts,
  PartialRefundContext,
  PartialRefundProviderResult,
} from './EscrowPartialRefundTypes.js';

/**
 * Backward-compatible entry point for callers that still carry the Phase-1
 * context. All effects are delegated to the exact terminal reconciler; this
 * function never applies an uncheckpointed economic side effect directly.
 */
export async function runPartialRefundEffects(input: {
  context: PartialRefundContext;
  amounts: PartialRefundAmounts;
  provider: PartialRefundProviderResult;
}): Promise<void> {
  const reconciled = await reconcilePartialRefundPostTerminal({
    escrowId: input.context.escrowId,
    taskId: input.context.taskId,
    refundAmountCents: input.amounts.posterCents,
    releaseAmountCents: input.amounts.workerCents,
    workerPercent: input.amounts.workerPercent,
    posterPercent: input.amounts.posterPercent,
  });
  if (!reconciled) {
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${input.context.escrowId} is not terminal for effect reconciliation`,
    );
  }
}
