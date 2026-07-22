export type CashOutState =
  | 'initiating'
  | 'submitted'
  | 'provider_processing'
  | 'paid'
  | 'failed'
  | 'reversed';

export type ProviderReportedPayoutState = Exclude<CashOutState, 'initiating' | 'reversed'>;

export type WalletAvailabilityStatus =
  | 'available'
  | 'setup_required'
  | 'restricted'
  | 'temporarily_unavailable';

export interface MaskedPayoutDestination {
  type: 'bank_account' | 'debit_card' | 'test_ledger';
  last4: string;
  label: string;
  providerId: string;
  status: string | null;
}

export interface ProviderBankPayout {
  providerPayoutId: string;
  amountCents: number;
  currency: 'usd';
  state: CashOutState;
  estimatedArrivalAt: string | null;
  createdAt: string;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface WalletProviderSnapshot {
  accountId: string;
  payoutsEnabled: boolean;
  disabledReason: string | null;
  availableCents: number;
  pendingCents: number;
  destination: MaskedPayoutDestination | null;
  payouts: ProviderBankPayout[];
  payoutHistoryComplete: boolean;
  capturedAt: string;
}

export interface WalletProviderPayoutResult {
  providerPayoutId: string;
  state: CashOutState;
  estimatedArrivalAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface WalletProvider {
  isConfigured(): boolean;
  getSnapshot(accountId: string): Promise<WalletProviderSnapshot>;
  createStandardPayout(input: {
    accountId: string;
    amountCents: number;
    destinationId: string;
    idempotencyKey: string;
    requestId: string;
    workerId: string;
  }): Promise<WalletProviderPayoutResult>;
}

export interface WalletLedgerItem {
  id: string;
  taskId: string;
  taskTitle: string;
  category: string | null;
  state: 'held' | 'dispute_locked' | 'connected_balance' | 'paid_local_test' | 'refunded' | 'partial_settlement' | 'unavailable';
  grossTaskCents: number;
  quotedHustlerPayoutCents: number | null;
  platformFeeCents: number;
  insuranceAdjustmentCents: number;
  netReleasedCents: number;
  heldCents: number;
  reason: string;
  occurredAt: string;
}

export interface HustlerCategoryPerformance {
  category: string;
  regionCode: string;
  verifiedAssignments: number;
  verifiedCompletions: number;
  completionRatePercent: number | null;
  proofCompletenessPercent: number | null;
  disputeRatePercent: number | null;
  repeatCustomerCount: number;
  transactionReviewCount: number;
  weightedOverallRating: number | null;
  experienceBand: 'building_history' | 'established';
  evidenceLabel: 'verified_production_transactions';
}

export interface PreferredWorkOpportunity {
  id: string;
  kind: 'preferred_rebook' | 'recurring_route';
  taskId: string;
  taskTitle: string;
  category: string | null;
  payoutCents: number | null;
  scheduledFor: string | null;
  offeredAt: string;
  expiresAt: string | null;
  state: 'open' | 'matching' | 'reservation_pending';
  reason: string;
}

export interface CashOutRecord {
  id: string;
  state: CashOutState;
  amountCents: number;
  feeCents: number;
  netCents: number;
  destination: Omit<MaskedPayoutDestination, 'providerId' | 'status'>;
  estimatedArrivalAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  recoveryAction: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CashOutReview {
  eligible: boolean;
  eligibilityCode:
    | 'ELIGIBLE'
    | 'SETUP_REQUIRED'
    | 'PROVIDER_UNAVAILABLE'
    | 'PAYOUTS_RESTRICTED'
    | 'DESTINATION_REQUIRED'
    | 'DESTINATION_RESTRICTED'
    | 'ACTIVE_CASH_OUT'
    | 'BELOW_MINIMUM'
    | 'INSUFFICIENT_AVAILABLE_BALANCE';
  reason: string;
  amountCents: number;
  feeCents: 0;
  netCents: number;
  availableCents: number | null;
  minimumCents: number;
  destination: Omit<MaskedPayoutDestination, 'providerId' | 'status'> | null;
  method: 'standard';
  arrivalEstimate: {
    label: string;
    source: 'platform_estimate';
    exact: false;
  };
  failureBehavior: string;
  policyVersion: string;
}

export interface HustlerWalletOverview {
  currency: 'usd';
  balances: {
    availableToCashOutCents: number | null;
    pendingClearanceCents: number | null;
    scheduledPayoutCents: number | null;
    paidOutCents: number | null;
    paidOutHistoryComplete: boolean;
    adjustmentsAndHoldsCents: number;
    lifetimeEarnedCents: number;
  };
  availability: {
    status: WalletAvailabilityStatus;
    reason: string;
    recoveryAction: string | null;
    providerSnapshotAt: string | null;
  };
  destination: Omit<MaskedPayoutDestination, 'providerId' | 'status'> | null;
  nextScheduledPayoutAt: string | null;
  activeCashOut: CashOutRecord | null;
  recentCashOuts: CashOutRecord[];
  recentTaskEarnings: WalletLedgerItem[];
  categoryPerformance: HustlerCategoryPerformance[];
  preferredWorkOpportunities: PreferredWorkOpportunity[];
  cashOutPolicy: {
    method: 'standard';
    minimumCents: number;
    feeCents: 0;
    arrivalEstimateLabel: string;
    policyVersion: string;
  };
}

export interface ProviderPayoutEventInput {
  stripeEventId: string;
  providerPayoutId: string;
  state: ProviderReportedPayoutState;
  amountCents: number;
  accountId: string | null;
  requestId: string | null;
  estimatedArrivalAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}
