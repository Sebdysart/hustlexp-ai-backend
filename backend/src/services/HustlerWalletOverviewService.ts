import type { ServiceResult } from '../types.js';
import {
  cashOutRecord,
  getProviderSnapshot,
  isActiveCashOutState,
  loadAccount,
  loadCashOutRows,
  loadLocalTestPayoutSummary,
  loadRecentTaskEarnings,
  loadWalletTotals,
  publicDestination,
  type CashOutRow,
  type WalletAccountRow,
  type WalletTotalsRow,
} from './HustlerWalletData.js';
import { localCertificationPayoutEnabled } from './LocalCertificationPayoutProvider.js';
import {
  DEFAULT_WALLET_MINIMUM_CENTS,
  HUSTLER_WALLET_POLICY_VERSION,
  WALLET_ARRIVAL_ESTIMATE,
} from './HustlerWalletPolicy.js';
import {
  loadCategoryPerformance,
  loadPreferredWorkOpportunities,
} from './HustlerWalletGrowthData.js';
import type {
  HustlerWalletOverview,
  WalletLedgerItem,
  WalletProvider,
  WalletProviderSnapshot,
} from './HustlerWalletTypes.js';

function providerPayoutTotals(snapshot: WalletProviderSnapshot) {
  const scheduled = snapshot.payouts.filter((payout) => (
    payout.state === 'submitted' || payout.state === 'provider_processing'
  ));
  const arrivalTimes = scheduled
    .map((payout) => payout.estimatedArrivalAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    scheduledCents: scheduled.reduce((total, payout) => total + payout.amountCents, 0),
    paidCents: snapshot.payouts
      .filter((payout) => payout.state === 'paid')
      .reduce((total, payout) => total + payout.amountCents, 0),
    nextScheduledAt: arrivalTimes[0] ?? null,
  };
}

interface UnavailableOverviewInput {
  account: WalletAccountRow | null;
  totals: WalletTotalsRow;
  earnings: WalletLedgerItem[];
  cashOuts: CashOutRow[];
  growth: Pick<HustlerWalletOverview, 'categoryPerformance' | 'preferredWorkOpportunities'>;
  status: HustlerWalletOverview['availability']['status'];
  reason: string;
}

function unavailableOverview(input: UnavailableOverviewInput): HustlerWalletOverview {
  const active = input.cashOuts.find((row) => isActiveCashOutState(row.state));
  return {
    currency: 'usd',
    balances: {
      availableToCashOutCents: null,
      pendingClearanceCents: null,
      scheduledPayoutCents: null,
      paidOutCents: null,
      paidOutHistoryComplete: false,
      adjustmentsAndHoldsCents: Number(input.totals.adjustments_and_holds_cents),
      lifetimeEarnedCents: Number(input.totals.lifetime_earned_cents),
    },
    availability: {
      status: input.status,
      reason: input.reason,
      recoveryAction: input.status === 'setup_required'
        ? 'Complete Stripe payout setup before trying to cash out.'
        : 'Try again. If this continues, open Stripe payout settings or contact support.',
      providerSnapshotAt: null,
    },
    destination: null,
    nextScheduledPayoutAt: null,
    activeCashOut: active ? cashOutRecord(active) : null,
    recentCashOuts: input.cashOuts.map(cashOutRecord),
    recentTaskEarnings: input.earnings,
    categoryPerformance: input.growth.categoryPerformance,
    preferredWorkOpportunities: input.growth.preferredWorkOpportunities,
    cashOutPolicy: {
      method: 'standard',
      minimumCents: input.account?.minimum_payout_amount_cents ?? DEFAULT_WALLET_MINIMUM_CENTS,
      feeCents: 0,
      arrivalEstimateLabel: WALLET_ARRIVAL_ESTIMATE,
      policyVersion: HUSTLER_WALLET_POLICY_VERSION,
    },
  };
}

function availableOverview(input: {
  account: WalletAccountRow;
  snapshot: WalletProviderSnapshot;
  totals: WalletTotalsRow;
  earnings: WalletLedgerItem[];
  cashOuts: CashOutRow[];
  growth: Pick<HustlerWalletOverview, 'categoryPerformance' | 'preferredWorkOpportunities'>;
}): HustlerWalletOverview {
  const payoutTotals = providerPayoutTotals(input.snapshot);
  const active = input.cashOuts.find((row) => isActiveCashOutState(row.state));
  return {
    currency: 'usd',
    balances: {
      availableToCashOutCents: input.snapshot.availableCents,
      pendingClearanceCents: input.snapshot.pendingCents,
      scheduledPayoutCents: payoutTotals.scheduledCents,
      paidOutCents: payoutTotals.paidCents,
      paidOutHistoryComplete: input.snapshot.payoutHistoryComplete,
      adjustmentsAndHoldsCents: Number(input.totals.adjustments_and_holds_cents),
      lifetimeEarnedCents: Number(input.totals.lifetime_earned_cents),
    },
    availability: {
      status: input.snapshot.payoutsEnabled ? 'available' : 'restricted',
      reason: input.snapshot.payoutsEnabled
        ? 'Connected-account balances and bank-payout history were verified with Stripe.'
        : input.snapshot.disabledReason || 'Stripe has restricted payouts for this account.',
      recoveryAction: input.snapshot.payoutsEnabled
        ? null
        : 'Open Stripe payout settings and complete the listed requirements.',
      providerSnapshotAt: input.snapshot.capturedAt,
    },
    destination: publicDestination(input.snapshot.destination),
    nextScheduledPayoutAt: payoutTotals.nextScheduledAt,
    activeCashOut: active ? cashOutRecord(active) : null,
    recentCashOuts: input.cashOuts.map(cashOutRecord),
    recentTaskEarnings: input.earnings,
    categoryPerformance: input.growth.categoryPerformance,
    preferredWorkOpportunities: input.growth.preferredWorkOpportunities,
    cashOutPolicy: {
      method: 'standard',
      minimumCents: input.account.minimum_payout_amount_cents ?? DEFAULT_WALLET_MINIMUM_CENTS,
      feeCents: 0,
      arrivalEstimateLabel: WALLET_ARRIVAL_ESTIMATE,
      policyVersion: HUSTLER_WALLET_POLICY_VERSION,
    },
  };
}

async function localTestOverview(input: {
  workerId: string;
  account: WalletAccountRow;
  totals: WalletTotalsRow;
  earnings: WalletLedgerItem[];
  cashOuts: CashOutRow[];
  growth: Pick<HustlerWalletOverview, 'categoryPerformance' | 'preferredWorkOpportunities'>;
}): Promise<HustlerWalletOverview> {
  const summary = await loadLocalTestPayoutSummary(input.workerId);
  const active = input.cashOuts.find((row) => isActiveCashOutState(row.state));
  return {
    currency: 'usd',
    balances: {
      availableToCashOutCents: 0,
      pendingClearanceCents: 0,
      scheduledPayoutCents: 0,
      paidOutCents: Number(summary.paid_cents),
      paidOutHistoryComplete: true,
      adjustmentsAndHoldsCents: Number(input.totals.adjustments_and_holds_cents),
      lifetimeEarnedCents: Number(input.totals.lifetime_earned_cents),
    },
    availability: {
      status: 'available',
      reason: 'Local certification TEST payout evidence is available. No Stripe or real bank settlement is claimed.',
      recoveryAction: null,
      providerSnapshotAt: summary.last_paid_at
        ? new Date(summary.last_paid_at).toISOString()
        : null,
    },
    destination: {
      type: 'test_ledger',
      last4: 'TEST',
      label: 'Local certification TEST ledger',
    },
    nextScheduledPayoutAt: null,
    activeCashOut: active ? cashOutRecord(active) : null,
    recentCashOuts: input.cashOuts.map(cashOutRecord),
    recentTaskEarnings: input.earnings,
    categoryPerformance: input.growth.categoryPerformance,
    preferredWorkOpportunities: input.growth.preferredWorkOpportunities,
    cashOutPolicy: {
      method: 'standard',
      minimumCents: input.account.minimum_payout_amount_cents ?? DEFAULT_WALLET_MINIMUM_CENTS,
      feeCents: 0,
      arrivalEstimateLabel: 'Local TEST provider only — no external arrival estimate',
      policyVersion: HUSTLER_WALLET_POLICY_VERSION,
    },
  };
}

export async function getHustlerWalletOverview(
  workerId: string,
  provider: WalletProvider,
): Promise<ServiceResult<HustlerWalletOverview>> {
  try {
    const [account, totals, earnings, cashOuts, categoryPerformance, preferredWorkOpportunities] = await Promise.all([
      loadAccount(workerId),
      loadWalletTotals(workerId),
      loadRecentTaskEarnings(workerId),
      loadCashOutRows(workerId),
      loadCategoryPerformance(workerId),
      loadPreferredWorkOpportunities(workerId),
    ]);
    const growth = { categoryPerformance, preferredWorkOpportunities };
    if (
      localCertificationPayoutEnabled()
      && account?.local_test_destination_id
    ) {
      return {
        success: true,
        data: await localTestOverview({
          workerId,
          account,
          totals,
          earnings,
          cashOuts,
          growth,
        }),
      };
    }
    if (!account?.stripe_connect_id) return {
      success: true,
      data: unavailableOverview({
        account, totals, earnings, cashOuts, growth,
        status: 'setup_required',
        reason: 'No Stripe payout account is connected.',
      }),
    };
    const snapshot = await getProviderSnapshot(account.stripe_connect_id, provider);
    if (!snapshot) return {
      success: true,
      data: unavailableOverview({
        account, totals, earnings, cashOuts, growth,
        status: 'temporarily_unavailable',
        reason: 'Stripe balance and payout history could not be verified.',
      }),
    };
    return {
      success: true,
      data: availableOverview({ account, snapshot, totals, earnings, cashOuts, growth }),
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'WALLET_QUERY_FAILED',
        message: error instanceof Error ? error.message : 'Wallet data could not be loaded.',
      },
    };
  }
}
