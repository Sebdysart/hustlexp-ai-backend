/**
 * Converges every RELEASED escrow onto its required durable witnesses.
 *
 * The database emits an escrow.released outbox event atomically with the state
 * transition. Every operation below is idempotent, so a retry repairs partial
 * post-commit work without double-crediting the worker or platform ledgers.
 */
import { config } from '../config.js';
import { db } from '../db.js';
import { computeFeeBreakdown } from '../lib/money.js';
import { logger } from '../logger.js';
import { ErrorCodes } from '../types.js';
import type { ServiceResult } from '../types.js';
import { EarnedVerificationUnlockService } from './EarnedVerificationUnlockService.js';
import { SelfInsurancePoolService } from './SelfInsurancePoolService.js';
import { TaskProgressService } from './TaskProgressService.js';
import { XPService } from './XPService.js';

const log = logger.child({ service: 'EscrowReleaseReconciliationService' });

interface ReconcileReleaseParams {
  escrowId: string;
  expectedProviderTransferId?: string | null;
  fromState?: string;
}

interface ReconciledRelease {
  escrowId: string;
  taskId: string;
  workerId: string | null;
  businessFulfillerOrganizationId: string | null;
  grossAmountCents: number;
  platformFeeCents: number;
  insuranceContributionCents: number;
  netPayoutCents: number;
}

type ReleasedEscrowRow = {
  id: string;
  task_id: string;
  state: string;
  amount: number;
  platform_fee_cents: number | null;
  provider_transfer_id: string | null;
  worker_id: string | null;
  business_fulfiller_organization_id: string | null;
  orchestration_mode: string | null;
  payment_method: string | null;
  payout_provider: string | null;
  platform_margin_cents: number | null;
  hustler_payout_cents: number | null;
};

function failure(code: string, message: string): ServiceResult<ReconciledRelease> {
  return { success: false, error: { code, message } };
}

export const EscrowReleaseReconciliationService = {
  reconcile: async (params: ReconcileReleaseParams): Promise<ServiceResult<ReconciledRelease>> => {
    const { escrowId, expectedProviderTransferId, fromState = 'RELEASE_RECONCILIATION' } = params;

    try {
    const rowResult = await db.query<ReleasedEscrowRow>(
      `SELECT
          e.id,
          e.task_id,
          e.state,
          e.amount,
          e.platform_fee_cents,
          e.provider_transfer_id,
          e.payout_provider,
          t.worker_id,
          t.business_fulfiller_organization_id,
          t.orchestration_mode,
          t.payment_method,
          t.platform_margin_cents,
          t.hustler_payout_cents
      FROM escrows e
      JOIN tasks t ON t.id = e.task_id
      WHERE e.id = $1`,
      [escrowId],
    );
      const escrow = rowResult.rows[0];
      if (!escrow) {
        return failure(ErrorCodes.NOT_FOUND, `Escrow ${escrowId} not found`);
      }
      if (escrow.state !== 'RELEASED') {
        return failure(
          ErrorCodes.INVALID_STATE,
          `Escrow ${escrowId} is ${escrow.state}; release reconciliation requires RELEASED`,
        );
      }
      const internalOnly = escrow.payout_provider === 'TILLED';
      const isManualBusiness = Boolean(escrow.business_fulfiller_organization_id)
        && (internalOnly || (escrow.orchestration_mode === 'OPS_MANUAL' && !escrow.worker_id));
      if (internalOnly && (!isManualBusiness || escrow.platform_margin_cents == null
          || escrow.hustler_payout_cents == null
          || escrow.amount - escrow.platform_margin_cents !== escrow.hustler_payout_cents
          || (escrow.platform_fee_cents != null && escrow.platform_fee_cents !== escrow.platform_margin_cents))) {
        return failure(ErrorCodes.INVALID_STATE, 'Tilled completion requires consistent frozen task economics');
      }

      if (!escrow.worker_id && !isManualBusiness) {
        return failure(
          ErrorCodes.INVALID_STATE,
          `Task ${escrow.task_id} has no recognized fulfiller`,
        );
      }
      if (
        expectedProviderTransferId !== undefined
        && expectedProviderTransferId !== null
        && escrow.provider_transfer_id !== expectedProviderTransferId
      ) {
        return failure(
          ErrorCodes.CONFLICT,
          `Escrow ${escrowId} transfer ${String(escrow.provider_transfer_id)} does not match ${expectedProviderTransferId}`,
        );
      }

      const breakdown = computeFeeBreakdown(
        escrow.amount,
        config.payments.platformFeePercent,
        internalOnly ? escrow.platform_margin_cents : escrow.platform_fee_cents,
      );
      const payoutCents = isManualBusiness
        ? breakdown.netBeforeInsuranceCents : breakdown.netPayoutCents;

      await db.query(
        `INSERT INTO escrow_events (
           escrow_id, from_state, to_state, actor_id, actor_type, metadata, idempotency_key
         ) VALUES ($1, $2, 'RELEASED', NULL, 'system', $3, $4)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [
          escrowId,
          fromState,
          JSON.stringify({ reconciled: true, provider_transfer_id: escrow.provider_transfer_id }),
          `escrow.released:${escrowId}`,
        ],
      );

      if (escrow.worker_id && !internalOnly) {
        const insurance = await SelfInsurancePoolService.recordContribution(
          escrow.task_id,
          escrow.worker_id,
          breakdown.insuranceContributionCents,
        );

        if (!insurance.success) {
          return failure(
            insurance.error.code,
            `Insurance reconciliation failed: ${insurance.error.message}`,
          );
        }

        const earnings = await EarnedVerificationUnlockService.recordEarnings(
          escrow.worker_id,
          escrow.task_id,
          escrowId,
          breakdown.netPayoutCents,
        );

        if (!earnings.success) {
          return failure(
            earnings.error.code,
            `Earnings reconciliation failed: ${earnings.error.message}`,
          );
        }

        const xp = await XPService.awardXP({
          userId: escrow.worker_id,
          taskId: escrow.task_id,
          escrowId,
          baseXP: Math.round(escrow.amount / 10),
        });

        if (
          !xp.success
          && xp.error.code !== ErrorCodes.INV_5_VIOLATION
        ) {
          return failure(
            xp.error.code,
            `XP reconciliation failed: ${xp.error.message}`,
          );
        }
      }

      const progress = await TaskProgressService.advanceProgress({
        taskId: escrow.task_id,
        to: 'CLOSED',
        actor: { type: 'system' },
      });
      if (!progress.success) {
        return failure(progress.error.code, `Progress reconciliation failed: ${progress.error.message}`);
      }

      const data: ReconciledRelease = {
        escrowId,
        taskId: escrow.task_id,
        workerId: escrow.worker_id,
        businessFulfillerOrganizationId:
          escrow.business_fulfiller_organization_id,
        grossAmountCents: escrow.amount,
        platformFeeCents: breakdown.platformFeeCents,
        insuranceContributionCents:
          escrow.worker_id && !internalOnly
            ? breakdown.insuranceContributionCents
            : 0,
        netPayoutCents: payoutCents,
      };
      log.info(data, 'Escrow release witnesses reconciled');
      return { success: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: message, escrowId }, 'Escrow release reconciliation failed');
      return failure(ErrorCodes.INTERNAL_ERROR, message);
    }
  },
};

