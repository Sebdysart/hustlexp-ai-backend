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
import { RevenueService } from './RevenueService.js';
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
  poster_id: string | null;
  provider_organization_id: string | null;
  payment_method: string | null;
  payout_recipient_user_id: string | null;
  payout_provider: string | null;
  provider_transfer_id: string | null;
  provider_transfer_status: string | null;
};

type PlatformFeeRow = {
  id: string;
  user_id: string | null;
  task_id: string | null;
  amount_cents: number;
  currency: string;
  gross_amount_cents: number;
  platform_fee_cents: number;
  net_amount_cents: number;
  escrow_id: string | null;
  stripe_transfer_id: string | null;
};

type ReleaseWitnessReadback = {
  release_event: {
    escrow_id: string;
    from_state: string;
    to_state: string;
    actor_id: string | null;
    actor_type: string;
    idempotency_key: string;
    metadata: unknown;
  } | null;
  insurance: {
    task_id: string;
    hustler_id: string;
    contribution_cents: number;
    contribution_percentage: number;
  } | null;
  earnings: {
    user_id: string;
    task_id: string | null;
    escrow_id: string;
    net_payout_cents: number;
  } | null;
  offline_tax: {
    user_id: string;
    task_id: string;
    gross_payout_cents: number;
    tax_percentage: number;
    tax_amount_cents: number;
    net_payout_cents: number;
    payment_method: string;
    xp_held_back: boolean;
  } | null;
  xp: Array<{
    user_id: string;
    task_id: string;
    escrow_id: string;
    base_xp: number;
    effective_xp: number;
    reason: string;
  }>;
  progress_state: string | null;
};

function failure<T = ReconciledRelease>(
  code: string,
  message: string,
): Extract<ServiceResult<T>, { success: false }> {
  return { success: false, error: { code, message } };
}

function exactJsonRecord(actual: unknown, expected: Record<string, unknown>): boolean {
  let parsed = actual;
  try {
    if (typeof actual === 'string') parsed = JSON.parse(actual) as unknown;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(record).sort();
  return expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index]
      && Object.is(record[key], expected[key]));
}

function releaseEventMetadata(escrow: ReleasedEscrowRow): Record<string, unknown> {
  return {
    payout_provider: escrow.payout_provider,
    payout_recipient_user_id: escrow.payout_recipient_user_id ?? escrow.worker_id,
    provider_transfer_id: escrow.provider_transfer_id,
    provider_transfer_status: escrow.payout_provider === 'LOCAL_CERTIFICATION_TEST'
      ? 'paid' : 'submitted',
  };
}

function canonicalReleaseProviderFacts(escrow: ReleasedEscrowRow): boolean {
  const payee = escrow.payout_recipient_user_id ?? escrow.worker_id;
  if (!payee || !escrow.provider_transfer_id) return false;
  if (escrow.payout_provider === 'STRIPE') {
    return escrow.stripe_transfer_id === escrow.provider_transfer_id
      && ['submitted', 'processing', 'paid'].includes(escrow.provider_transfer_status ?? '');
  }
  return escrow.payout_provider === 'LOCAL_CERTIFICATION_TEST'
    && escrow.stripe_transfer_id === null
    && escrow.provider_transfer_status === 'paid';
}

function releaseEventMatches(
  event: ReleaseWitnessReadback['release_event'],
  escrow: ReleasedEscrowRow,
  fromState: string,
): boolean {
  if (!event) return false;
  const idempotencyKey = `escrow.released:${escrow.id}`;
  return event.escrow_id === escrow.id
    && event.from_state === fromState
    && event.to_state === 'RELEASED'
    && event.actor_id === null
    && event.actor_type === 'system'
    && event.idempotency_key === idempotencyKey
    && exactJsonRecord(event.metadata, releaseEventMetadata(escrow));
}

function platformFeeMatches(
  row: PlatformFeeRow | undefined,
  escrow: ReleasedEscrowRow,
  platformFeeCents: number,
): boolean {
  if (!row) return false;
  return row.user_id === (escrow.poster_id ?? escrow.worker_id)
    && row.task_id === escrow.task_id
    && Number(row.amount_cents) === platformFeeCents
    && row.currency === 'usd'
    && Number(row.gross_amount_cents) === escrow.amount
    && Number(row.platform_fee_cents) === platformFeeCents
    && Number(row.net_amount_cents) === escrow.amount - platformFeeCents
    && row.escrow_id === escrow.id
    && row.stripe_transfer_id === escrow.stripe_transfer_id;
}

async function loadPlatformFee(escrowId: string): Promise<PlatformFeeRow | undefined> {
  const result = await db.query<PlatformFeeRow>(
    `SELECT id,user_id,task_id,amount_cents,currency,gross_amount_cents,
            platform_fee_cents,net_amount_cents,escrow_id,stripe_transfer_id
       FROM revenue_ledger
      WHERE event_type='platform_fee' AND escrow_id=$1
      LIMIT 1`,
    [escrowId],
  );
  return result.rows[0];
}

async function ensurePlatformFee(
  escrow: ReleasedEscrowRow,
  platformFeeCents: number,
): Promise<ServiceResult<void>> {
  const existing = await loadPlatformFee(escrow.id);
  if (platformFeeCents === 0) {
    return existing
      ? failure<void>(ErrorCodes.CONFLICT, `Zero-margin escrow ${escrow.id} has a platform-fee witness`)
      : { success: true, data: undefined };
  }
  if (existing) {
    return platformFeeMatches(existing, escrow, platformFeeCents)
      ? { success: true, data: undefined }
      : failure<void>(ErrorCodes.CONFLICT, `Platform-fee witness for escrow ${escrow.id} is not exact`);
  }

  const recorded = await RevenueService.logEvent({
    eventType: 'platform_fee',
    userId: escrow.poster_id ?? escrow.worker_id,
    taskId: escrow.task_id,
    amountCents: platformFeeCents,
    grossAmountCents: escrow.amount,
    platformFeeCents,
    netAmountCents: escrow.amount - platformFeeCents,
    feeBasisPoints: Math.round((platformFeeCents / escrow.amount) * 10_000),
    escrowId: escrow.id,
    stripeTransferId: escrow.stripe_transfer_id ?? undefined,
    metadata: {
      event: 'escrow_release_reconciliation',
      stripe_processing_fee_status: 'unknown',
    },
  });
  if (recorded.success) return { success: true, data: undefined };

  // A concurrent reconciler can win the escrow-scoped unique index. Accept
  // that race only after re-reading an exact immutable economic witness.
  const raced = await loadPlatformFee(escrow.id);
  return platformFeeMatches(raced, escrow, platformFeeCents)
    ? { success: true, data: undefined }
    : failure<void>(
        recorded.error.code,
        `Platform-fee reconciliation failed: ${recorded.error.message}`,
      );
}

function exactReleaseWitnesses(
  readback: ReleaseWitnessReadback | undefined,
  escrow: ReleasedEscrowRow,
  breakdown: ReturnType<typeof computeFeeBreakdown>,
  fromState: string,
): boolean {
  if (!readback || !escrow.worker_id) return false;
  if (!releaseEventMatches(readback.release_event, escrow, fromState)) return false;
  const insurance = readback.insurance;
  if (
    !insurance
    || insurance.task_id !== escrow.task_id
    || insurance.hustler_id !== escrow.worker_id
    || Number(insurance.contribution_cents) !== breakdown.insuranceContributionCents
    || Number(insurance.contribution_percentage) !== 2
  ) return false;

  if (escrow.provider_organization_id) {
    if (readback.earnings !== null) return false;
  } else {
    const earnings = readback.earnings;
    if (
      !earnings
      || earnings.user_id !== escrow.worker_id
      || earnings.task_id !== escrow.task_id
      || earnings.escrow_id !== escrow.id
      || Number(earnings.net_payout_cents) !== breakdown.netPayoutCents
    ) return false;
  }

  const offline = ['offline_cash','offline_venmo','offline_cashapp'].includes(
    escrow.payment_method ?? '',
  );
  if (offline) {
    const tax = readback.offline_tax;
    if (
      !tax
      || tax.user_id !== escrow.worker_id
      || tax.task_id !== escrow.task_id
      || Number(tax.gross_payout_cents) !== escrow.amount
      || Number(tax.tax_percentage) !== 10
      || Number(tax.tax_amount_cents) !== Math.round(escrow.amount * 0.1)
      || Number(tax.net_payout_cents) !== escrow.amount
      || tax.payment_method !== escrow.payment_method
      || tax.xp_held_back !== true
    ) return false;
  } else if (readback.offline_tax !== null) {
    return false;
  }

  const xp = readback.xp[0];
  return readback.xp.length === 1
    && xp.user_id === escrow.worker_id
    && xp.task_id === escrow.task_id
    && xp.escrow_id === escrow.id
    && Number(xp.base_xp) === Math.round(escrow.amount / 10)
    && Number(xp.effective_xp) > 0
    && xp.reason === 'task_completion'
    && readback.progress_state === 'CLOSED';
}

async function readReleaseWitnesses(
  escrow: ReleasedEscrowRow,
): Promise<ReleaseWitnessReadback | undefined> {
  const result = await db.query<ReleaseWitnessReadback>(
    `SELECT
       (SELECT jsonb_build_object(
          'escrow_id',escrow_id::text,'from_state',from_state,'to_state',to_state,
          'actor_id',actor_id::text,'actor_type',actor_type,
          'idempotency_key',idempotency_key,'metadata',metadata)
          FROM escrow_events
         WHERE idempotency_key=$4) AS release_event,
       (SELECT jsonb_build_object(
          'task_id',task_id,'hustler_id',hustler_id,
          'contribution_cents',contribution_cents,
          'contribution_percentage',contribution_percentage)
          FROM insurance_contributions
         WHERE task_id=$1 AND hustler_id=$2) AS insurance,
       (SELECT jsonb_build_object(
          'user_id',user_id,'task_id',task_id,'escrow_id',escrow_id,
          'net_payout_cents',net_payout_cents)
          FROM verification_earnings_ledger
         WHERE escrow_id=$3) AS earnings,
       (SELECT jsonb_build_object(
          'user_id',user_id,'task_id',task_id,'gross_payout_cents',gross_payout_cents,
          'tax_percentage',tax_percentage,'tax_amount_cents',tax_amount_cents,
          'net_payout_cents',net_payout_cents,'payment_method',payment_method,
          'xp_held_back',xp_held_back)
          FROM xp_tax_ledger
         WHERE task_id=$1 AND user_id=$2) AS offline_tax,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'user_id',user_id,'task_id',task_id,'escrow_id',escrow_id,
          'base_xp',base_xp,'effective_xp',effective_xp,'reason',reason)
          ORDER BY awarded_at), '[]'::jsonb)
          FROM xp_ledger
         WHERE escrow_id=$3 AND reason='task_completion') AS xp,
       (SELECT progress_state FROM tasks WHERE id=$1) AS progress_state`,
    [escrow.task_id, escrow.worker_id, escrow.id, `escrow.released:${escrow.id}`],
  );
  return result.rows[0];
}

export const EscrowReleaseReconciliationService = {
  reconcile: async (params: ReconcileReleaseParams): Promise<ServiceResult<ReconciledRelease>> => {
    const { escrowId, expectedStripeTransferId, fromState = 'RELEASE_RECONCILIATION' } = params;

    try {
      const rowResult = await db.query<ReleasedEscrowRow>(
        `SELECT e.id, e.task_id, e.state, e.amount, e.platform_fee_cents,
                e.stripe_transfer_id, e.payout_provider, e.provider_transfer_id,
                e.provider_transfer_status, t.worker_id, t.poster_id,
                t.provider_organization_id, t.payment_method,
                t.payout_recipient_user_id
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

      if (!canonicalReleaseProviderFacts(escrow)) {
        return failure(
          ErrorCodes.CONFLICT,
          `Escrow ${escrowId} has no exact canonical payout-provider release facts`,
        );
      }

      const eventMetadata = releaseEventMetadata(escrow);

      await db.query(
        `INSERT INTO escrow_events (
           escrow_id, from_state, to_state, actor_id, actor_type, metadata, idempotency_key
         ) VALUES ($1, $2, 'RELEASED', NULL, 'system', $3, $4)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [
          escrowId,
          fromState,
          JSON.stringify(eventMetadata),
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

      const platformFee = await ensurePlatformFee(escrow, breakdown.platformFeeCents);
      if (!platformFee.success) return platformFee;

      if (!escrow.provider_organization_id) {
        const earnings = await EarnedVerificationUnlockService.recordEarnings(
          escrow.worker_id,
          escrow.task_id,
          escrowId,
          breakdown.netPayoutCents,
        );
        if (!earnings.success) {
          return failure(earnings.error.code, `Earnings reconciliation failed: ${earnings.error.message}`);
        }
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

      const witnesses = await readReleaseWitnesses(escrow);
      if (!exactReleaseWitnesses(witnesses, escrow, breakdown, fromState)) {
        return failure(
          ErrorCodes.CONFLICT,
          `Escrow ${escrowId} release witnesses do not match canonical economics and lifecycle`,
        );
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
