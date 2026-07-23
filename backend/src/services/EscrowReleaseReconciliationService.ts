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
import { XPTaxService } from './XPTaxService.js';
import { XPService } from './XPService.js';

const log = logger.child({ service: 'EscrowReleaseReconciliationService' });

interface ReconcileReleaseParams {
  escrowId: string;
  expectedStripeTransferId?: string | null;
  fromState?: string;
}

interface ReconciledRelease {
  escrowId: string;
  taskId: string;
  workerId: string;
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
  stripe_transfer_id: string | null;
  worker_id: string | null;
  payment_method: string | null;
};

function failure(code: string, message: string): ServiceResult<ReconciledRelease> {
  return { success: false, error: { code, message } };
}

export const EscrowReleaseReconciliationService = {
  reconcile: async (params: ReconcileReleaseParams): Promise<ServiceResult<ReconciledRelease>> => {
    const { escrowId, expectedStripeTransferId, fromState = 'RELEASE_RECONCILIATION' } = params;

    try {
      const rowResult = await db.query<ReleasedEscrowRow>(
        `SELECT e.id, e.task_id, e.state, e.amount, e.platform_fee_cents,
                e.stripe_transfer_id, t.worker_id, t.payment_method
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
      if (!escrow.worker_id) {
        return failure(ErrorCodes.INVALID_STATE, `Task ${escrow.task_id} has no assigned worker`);
      }
      if (
        expectedStripeTransferId !== undefined
        && expectedStripeTransferId !== null
        && escrow.stripe_transfer_id !== expectedStripeTransferId
      ) {
        return failure(
          ErrorCodes.CONFLICT,
          `Escrow ${escrowId} transfer ${String(escrow.stripe_transfer_id)} does not match ${expectedStripeTransferId}`,
        );
      }

      const breakdown = computeFeeBreakdown(
        escrow.amount,
        config.stripe.platformFeePercent,
        escrow.platform_fee_cents,
      );

      await db.query(
        `INSERT INTO escrow_events (
           escrow_id, from_state, to_state, actor_id, actor_type, metadata, idempotency_key
         ) VALUES ($1, $2, 'RELEASED', NULL, 'system', $3, $4)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [
          escrowId,
          fromState,
          JSON.stringify({ reconciled: true, stripe_transfer_id: escrow.stripe_transfer_id }),
          `escrow.released:${escrowId}`,
        ],
      );

      const insurance = await SelfInsurancePoolService.recordContribution(
        escrow.task_id,
        escrow.worker_id,
        breakdown.insuranceContributionCents,
      );
      if (!insurance.success) {
        return failure(insurance.error.code, `Insurance reconciliation failed: ${insurance.error.message}`);
      }

      const earnings = await EarnedVerificationUnlockService.recordEarnings(
        escrow.worker_id,
        escrow.task_id,
        escrowId,
        breakdown.netPayoutCents,
      );
      if (!earnings.success) {
        return failure(earnings.error.code, `Earnings reconciliation failed: ${earnings.error.message}`);
      }

      if (
        escrow.payment_method === 'offline_cash'
        || escrow.payment_method === 'offline_venmo'
        || escrow.payment_method === 'offline_cashapp'
      ) {
        const tax = await XPTaxService.recordOfflinePayment(
          escrow.worker_id,
          escrow.task_id,
          escrow.payment_method,
          escrow.amount,
        );
        if (!tax.success) {
          return failure(tax.error.code, `Offline-tax reconciliation failed: ${tax.error.message}`);
        }
      }

      const xp = await XPService.awardXP({
        userId: escrow.worker_id,
        taskId: escrow.task_id,
        escrowId,
        baseXP: Math.round(escrow.amount / 10),
      });
      if (!xp.success && xp.error.code !== ErrorCodes.INV_5_VIOLATION) {
        return failure(xp.error.code, `XP reconciliation failed: ${xp.error.message}`);
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
        grossAmountCents: escrow.amount,
        platformFeeCents: breakdown.platformFeeCents,
        insuranceContributionCents: breakdown.insuranceContributionCents,
        netPayoutCents: breakdown.netPayoutCents,
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
