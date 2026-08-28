import { config } from '../config.js';
import { db } from '../db.js';
import { computeFeeBreakdown } from '../lib/money.js';
import type {
  CashOutRecord,
  CashOutState,
  MaskedPayoutDestination,
  WalletLedgerItem,
  WalletProvider,
  WalletProviderSnapshot,
} from './HustlerWalletTypes.js';

export interface WalletAccountRow {
  stripe_connect_id: string | null;
  minimum_payout_amount_cents: number | null;
  local_test_destination_id?: string | null;
}

interface TaskEarningRow {
  escrow_id: string;
  task_id: string;
  title: string;
  category: string | null;
  escrow_state: string;
  amount: number;
  platform_fee_cents: number | null;
  hustler_payout_cents: number | null;
  release_amount: number | null;
  refund_amount: number | null;
  stripe_transfer_id: string | null;
  payout_provider: string | null;
  provider_transfer_status: string | null;
  occurred_at: Date | string;
}

export interface CashOutRow {
  id: string;
  worker_id: string | null;
  provider_account_id: string;
  provider_destination_id: string;
  provider_payout_id: string | null;
  idempotency_key: string;
  request_hash: string;
  state: string;
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  destination_type: string;
  destination_last4: string;
  destination_label: string;
  estimated_arrival_at: Date | string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface WalletTotalsRow {
  lifetime_earned_cents: string | number;
  adjustments_and_holds_cents: string | number;
}

export interface LocalTestPayoutSummary {
  paid_cents: string | number;
  last_paid_at: Date | string | null;
}

export const CASH_OUT_ROW_COLUMNS = `
  id,worker_id,provider_account_id,provider_destination_id,provider_payout_id,
  idempotency_key,request_hash,state,amount_cents,fee_cents,net_cents,
  destination_type,destination_last4,destination_label,estimated_arrival_at,
  failure_code,failure_message,created_at,updated_at`;

export function isActiveCashOutState(state: string): boolean {
  return ['INITIATING', 'SUBMITTED', 'PROVIDER_PROCESSING'].includes(state);
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function publicDestination(
  destination: MaskedPayoutDestination | null,
): Omit<MaskedPayoutDestination, 'providerId' | 'status'> | null {
  if (!destination) return null;
  return { type: destination.type, last4: destination.last4, label: destination.label };
}

function recoveryAction(row: CashOutRow): string | null {
  if (row.state !== 'FAILED' && row.state !== 'REVERSED') return null;
  return 'Update the payout destination in Stripe, then start a new cash-out. Contact support if the balance does not return.';
}

export function cashOutRecord(row: CashOutRow): CashOutRecord {
  return {
    id: row.id,
    state: row.state.toLowerCase() as CashOutState,
    amountCents: row.amount_cents,
    feeCents: row.fee_cents,
    netCents: row.net_cents,
    destination: {
      type: row.destination_type === 'DEBIT_CARD' ? 'debit_card' : 'bank_account',
      last4: row.destination_last4,
      label: row.destination_label,
    },
    estimatedArrivalAt: iso(row.estimated_arrival_at),
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    recoveryAction: recoveryAction(row),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function earningAmounts(row: TaskEarningRow) {
  const grossShare = row.escrow_state === 'REFUND_PARTIAL'
    ? Math.max(0, row.release_amount ?? 0)
    : row.amount;
  const canonicalFee = row.escrow_state === 'REFUND_PARTIAL' ? null : row.platform_fee_cents;
  const breakdown = computeFeeBreakdown(
    grossShare,
    config.stripe.platformFeePercent,
    canonicalFee,
  );
  return {
    platformFeeCents: breakdown.platformFeeCents,
    insuranceCents: breakdown.insuranceContributionCents,
    netCents: breakdown.netPayoutCents,
  };
}

function earningState(row: TaskEarningRow): WalletLedgerItem['state'] {
  if (row.escrow_state === 'FUNDED') return 'held';
  if (row.escrow_state === 'LOCKED_DISPUTE') return 'dispute_locked';
  if (row.escrow_state === 'REFUNDED') return 'refunded';
  if (row.escrow_state === 'REFUND_PARTIAL') {
    return row.stripe_transfer_id ? 'partial_settlement' : 'unavailable';
  }
  if (row.escrow_state === 'RELEASED') {
    if (
      row.payout_provider === 'LOCAL_CERTIFICATION_TEST'
      && row.provider_transfer_status === 'paid'
    ) return 'paid_local_test';
    return row.stripe_transfer_id ? 'connected_balance' : 'unavailable';
  }
  return 'unavailable';
}

function earningReason(row: TaskEarningRow, state: WalletLedgerItem['state']): string {
  if (state === 'held') return 'Customer funds are held in escrow; this is not available to cash out.';
  if (state === 'dispute_locked') return 'This earning is locked while the dispute is reviewed.';
  if (state === 'refunded') return 'Customer funds were refunded; no Hustler payout was released.';
  if (state === 'partial_settlement') {
    return `A partial settlement released funds to the connected balance; ${row.refund_amount ?? 0} cents was refunded.`;
  }
  if (state === 'connected_balance') {
    return 'Provider transfer evidence confirms release to the connected balance, not bank receipt.';
  }
  if (state === 'paid_local_test') {
    return 'The local certification TEST provider confirms payment. This is TEST evidence, not Stripe or real bank settlement.';
  }
  return 'No provider transfer proves that this task reached the connected balance.';
}

function taskLedgerItem(row: TaskEarningRow): WalletLedgerItem {
  const amounts = earningAmounts(row);
  const state = earningState(row);
  const connected = state === 'connected_balance'
    || state === 'partial_settlement'
    || state === 'paid_local_test';
  const held = state === 'held' || state === 'dispute_locked';
  return {
    id: row.escrow_id,
    taskId: row.task_id,
    taskTitle: row.title,
    category: row.category,
    state,
    grossTaskCents: row.amount,
    quotedHustlerPayoutCents: row.hustler_payout_cents,
    platformFeeCents: amounts.platformFeeCents,
    insuranceAdjustmentCents: amounts.insuranceCents,
    netReleasedCents: connected ? amounts.netCents : 0,
    heldCents: held ? amounts.netCents : 0,
    reason: earningReason(row, state),
    occurredAt: iso(row.occurred_at)!,
  };
}

export async function loadAccount(workerId: string): Promise<WalletAccountRow | null> {
  const result = await db.query<WalletAccountRow>(
    `SELECT u.stripe_connect_id,wps.minimum_payout_amount_cents,
            destination.id AS local_test_destination_id
     FROM users u
     LEFT JOIN worker_payout_settings wps ON wps.worker_id=u.id
     LEFT JOIN hxos_local_test_payout_destinations destination
       ON destination.worker_id=u.id
      AND destination.status='ACTIVE'
      AND destination.is_test IS TRUE
     WHERE u.id=$1`,
    [workerId],
  );
  return result.rows[0] ?? null;
}

export async function loadRecentTaskEarnings(workerId: string): Promise<WalletLedgerItem[]> {
  const result = await db.query<TaskEarningRow>(
    `SELECT e.id AS escrow_id,e.task_id,t.title,t.category,
            e.state AS escrow_state,e.amount,e.platform_fee_cents,
            t.hustler_payout_cents,e.release_amount,e.refund_amount,
            e.stripe_transfer_id,e.payout_provider,e.provider_transfer_status,
            COALESCE(e.released_at,e.refunded_at,e.funded_at,e.created_at) AS occurred_at
     FROM escrows e
     JOIN tasks t ON t.id=e.task_id
     WHERE t.worker_id=$1
     ORDER BY COALESCE(e.released_at,e.refunded_at,e.funded_at,e.created_at) DESC
     LIMIT 50`,
    [workerId],
  );
  return result.rows.map(taskLedgerItem);
}

export async function loadWalletTotals(workerId: string): Promise<WalletTotalsRow> {
  const feePercent = Math.min(100, Math.max(0, config.stripe.platformFeePercent ?? 20));
  const result = await db.query<WalletTotalsRow>(
    `SELECT
       COALESCE(SUM(CASE
         WHEN e.state='RELEASED' AND (
           e.stripe_transfer_id IS NOT NULL
           OR (e.payout_provider='LOCAL_CERTIFICATION_TEST' AND e.provider_transfer_status='paid')
         ) THEN
           e.amount-COALESCE(e.platform_fee_cents,ROUND(e.amount*$2/100.0)::integer)
                   -ROUND(e.amount*0.02)::integer
         WHEN e.state='REFUND_PARTIAL' AND e.stripe_transfer_id IS NOT NULL THEN
           COALESCE(e.release_amount,0)
             -ROUND(COALESCE(e.release_amount,0)*$2/100.0)::integer
             -ROUND(COALESCE(e.release_amount,0)*0.02)::integer
         ELSE 0 END),0) AS lifetime_earned_cents,
       COALESCE(SUM(CASE
         WHEN e.state IN ('FUNDED','LOCKED_DISPUTE') THEN
           e.amount-COALESCE(e.platform_fee_cents,ROUND(e.amount*$2/100.0)::integer)
                   -ROUND(e.amount*0.02)::integer
         ELSE 0 END),0) AS adjustments_and_holds_cents
     FROM escrows e
     JOIN tasks t ON t.id=e.task_id
     WHERE t.worker_id=$1`,
    [workerId, feePercent],
  );
  return result.rows[0] ?? { lifetime_earned_cents: 0, adjustments_and_holds_cents: 0 };
}

export async function loadCashOutRows(workerId: string): Promise<CashOutRow[]> {
  const result = await db.query<CashOutRow>(
    `SELECT ${CASH_OUT_ROW_COLUMNS}
     FROM worker_cash_out_requests
     WHERE worker_id=$1
     ORDER BY created_at DESC
     LIMIT 20`,
    [workerId],
  );
  return result.rows;
}

export async function loadLocalTestPayoutSummary(workerId: string): Promise<LocalTestPayoutSummary> {
  const result = await db.query<LocalTestPayoutSummary>(
    `SELECT COALESCE(SUM(amount_cents),0) AS paid_cents,
            MAX(paid_at) AS last_paid_at
     FROM hxos_local_test_payout_transfers
     WHERE worker_id=$1 AND status='paid' AND is_test IS TRUE`,
    [workerId],
  );
  return result.rows[0] ?? { paid_cents: 0, last_paid_at: null };
}

export async function getProviderSnapshot(
  accountId: string,
  provider: WalletProvider,
): Promise<WalletProviderSnapshot | null> {
  if (!provider.isConfigured()) return null;
  try {
    return await provider.getSnapshot(accountId);
  } catch {
    return null;
  }
}
