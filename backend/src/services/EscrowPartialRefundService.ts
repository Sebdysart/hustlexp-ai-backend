import { db } from '../db.js';
import { escrowLogger } from '../logger.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import {
  acquireOrLoadPartialRefundCheckpoint,
  checkpointPartialRefund,
  isPartialRefundControlError,
  PARTIAL_REFUND_RECONCILIATION_CODE,
  partialRefundReconciliationError,
  persistPartialRefundTransferRecovery,
} from './EscrowPartialRefundEvidence.js';
import type { PartialRefundBinding } from './EscrowPartialRefundEvidence.js';
import { reconcilePartialRefundPostTerminal } from './EscrowPartialRefundReconciliationService.js';
import {
  computePartialRefundAmounts,
  executePartialRefundProviders,
} from './EscrowPartialRefundProvider.js';
import type {
  PartialRefundAmounts,
  PartialRefundContext,
} from './EscrowPartialRefundTypes.js';
import {
  preparePartialRefund,
  terminalizePartialRefund,
} from './EscrowPartialRefundTransaction.js';
import type { PartialRefundParams } from './EscrowServiceShared.js';

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function knownControlFailure(
  error: unknown,
): Extract<ServiceResult<Escrow>, { success: false }> | null {
  if (!(error instanceof Error)) return null;
  const candidate = error as Error & { code?: unknown; details?: unknown };
  if (candidate.code !== 'PAYMENT_CREATION_FROZEN'
    && !isPartialRefundControlError(candidate)) return null;
  return {
    success: false,
    error: {
      code: String(candidate.code),
      message: candidate.message,
      details: metadataRecord(candidate.details) ?? undefined,
    },
  };
}

function invalidPercentages(params: PartialRefundParams): ServiceResult<Escrow> | null {
  if (
    params.workerPercent <= 0 || params.workerPercent >= 100
    || params.posterPercent <= 0 || params.posterPercent >= 100
  ) {
    return {
      success: false,
      error: {
        code: 'INVALID_PERCENT',
        message: 'Partial refund requires two positive settlement legs below 100%',
      },
    };
  }
  if (params.workerPercent + params.posterPercent !== 100) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_STATE,
        message: 'Worker and poster percentages must sum to 100',
      },
    };
  }
  return null;
}

function partialRefundBinding(
  context: PartialRefundContext,
  amounts: PartialRefundAmounts,
): PartialRefundBinding {
  if (!context.stripePaymentIntentId) {
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${context.escrowId} has no exact PaymentIntent binding`,
    );
  }
  if (context.existingRefundAmount !== null || context.existingReleaseAmount !== null) {
    throw partialRefundReconciliationError(
      `partialRefund: escrow ${context.escrowId} already carries partial-settlement amounts`,
    );
  }
  if (amounts.posterCents === 0 && context.existingRefundId) {
    throw partialRefundReconciliationError(
      `partialRefund: zero-refund split has canonical refund ${context.existingRefundId}`,
    );
  }
  if (amounts.workerCents === 0 && context.existingTransferId) {
    throw partialRefundReconciliationError(
      `partialRefund: zero-release split has canonical transfer ${context.existingTransferId}`,
    );
  }
  return {
    escrowId: context.escrowId,
    escrowVersion: context.escrowVersion,
    taskId: context.taskId,
    disputeId: null,
    escrowAmountCents: context.amount,
    canonicalPlatformFeeCents: context.canonicalPlatformFeeCents,
    paymentIntentId: context.stripePaymentIntentId,
    existingTransferId: context.existingTransferId,
    existingRefundId: context.existingRefundId,
    refundAmountCents: amounts.posterCents,
    releaseAmountCents: amounts.workerCents,
    splitPlatformFeeCents: amounts.workerCents - amounts.netWorkerCentsBeforeInsurance,
    platformFeeBasisPoints: Math.round(amounts.platformFeePercent * 100),
    insuranceContributionCents: amounts.insuranceContributionCents,
    netReleaseAmountCents: amounts.netWorkerCents,
    xpClawbackFraction: amounts.posterPercent / 100,
    workerId: context.workerId,
    payoutRecipientUserId: context.payoutRecipientUserId,
    providerOrganizationId: context.providerOrganizationId,
    providerAssignmentId: context.providerAssignmentId,
    posterId: context.posterId,
    destinationAccountId: context.payoutStripeConnectId,
    payoutDestinationError: context.payoutDestinationError,
  };
}

export async function partialRefundEscrow(
  params: PartialRefundParams,
): Promise<ServiceResult<Escrow>> {
  const invalid = invalidPercentages(params);
  if (invalid) return invalid;
  try {
    const replay = await reconcilePartialRefundPostTerminal({
      escrowId: params.escrowId,
      workerPercent: params.workerPercent,
      posterPercent: params.posterPercent,
    });
    if (replay) {
      const canonical = await db.query<Escrow>(
        `SELECT * FROM escrows
          WHERE id=$1 AND version=$2 AND state='REFUND_PARTIAL'
            AND task_id=$3 AND amount=$4
            AND stripe_refund_id=$5 AND stripe_transfer_id=$6
            AND refund_amount=$7 AND release_amount=$8`,
        [
          replay.binding.escrowId,
          replay.binding.escrowVersion + 1,
          replay.binding.taskId,
          replay.binding.escrowAmountCents,
          replay.provider.refundWitness.refundId,
          replay.provider.transferWitness.transferId,
          replay.binding.refundAmountCents,
          replay.binding.releaseAmountCents,
        ],
      );
      if (canonical.rows.length !== 1) {
        throw partialRefundReconciliationError(
          `partialRefund: terminal escrow ${params.escrowId} changed after effect reconciliation`,
        );
      }
      return { success: true, data: canonical.rows[0] };
    }
    const prepared = await db.transaction((query) => preparePartialRefund(query, params.escrowId));
    if (!prepared.success) return prepared;
    const amounts = computePartialRefundAmounts({
      amount: prepared.data.amount,
      workerPercent: params.workerPercent,
      posterPercent: params.posterPercent,
    });
    const binding = partialRefundBinding(prepared.data, amounts);
    const provider = await executePartialRefundProviders(
      prepared.data,
      amounts,
      binding,
      {
        acquireOrLoad: () => acquireOrLoadPartialRefundCheckpoint(binding),
        checkpoint: (witness) => checkpointPartialRefund(binding, witness),
      },
    );
    let terminal: Awaited<ReturnType<typeof terminalizePartialRefund>>;
    try {
      terminal = await db.transaction((query) =>
        terminalizePartialRefund(query, binding, provider));
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
    if (!terminal.success) {
      if (provider.transferWitness) {
        await persistPartialRefundTransferRecovery({
          binding,
          witness: provider.transferWitness,
          transferCreated: provider.transferCreated,
          failureStage: 'CANONICAL_T2_FAILED',
        });
      }
      return terminal;
    }
    await reconcilePartialRefundPostTerminal({
      escrowId: params.escrowId,
      workerPercent: params.workerPercent,
      posterPercent: params.posterPercent,
    });
    return terminal;
  } catch (error) {
    const controlFailure = knownControlFailure(error);
    if (controlFailure) return controlFailure;
    escrowLogger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'EscrowService partial-refund error',
    );
    return {
      success: false,
      error: {
        code: PARTIAL_REFUND_RECONCILIATION_CODE,
        message: 'Partial refund could not prove exact provider and canonical convergence.',
      },
    };
  }
}
