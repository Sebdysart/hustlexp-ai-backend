export const LIQUIDITY_CELL_POLICY_VERSION = 'hxos-launch-cell-v1';

export const LIQUIDITY_CELL_STATES = [
  'CLOSED',
  'SEEDING',
  'LIMITED',
  'OPEN',
  'DENSE',
  'THROTTLED',
  'SUSPENDED',
] as const;

export type LiquidityCellState = (typeof LIQUIDITY_CELL_STATES)[number];

export interface LiquidityCellMetrics {
  completedTasksTotal: number;
  paidTasks30d: number;
  fillRate30d: number;
  activeVerifiedProviders: number;
  anchorDemandAccounts: number;
  averageContributionCents: number;
  providerEarningsSampleSize: number;
  averageProviderNetHourlyCents: number;
  disputeRate30d: number;
  noShowRate30d: number;
  cancellationRate30d: number;
  repeatDemandRate30d: number;
}

export interface LiquidityCellPolicyInput {
  geoZone: string;
  category: string;
  operatingWindow: string | null;
  launchCellEnabled: boolean;
  greenCategory: boolean;
  launchGreenCategoryCount: number;
  minimumProviderNetHourlyCents: number | null;
  providerEarningsPolicyVersion: string | null;
  providerEarningsPolicyApproved: boolean;
  metrics: LiquidityCellMetrics;
  metricsComputedAt: string;
  evaluatedAt: string;
  previousState?: LiquidityCellState;
  stableSince?: string | null;
  suspensionReason?: string | null;
  severeFailure?: 'safety' | 'fraud' | 'regulatory' | 'quality' | null;
}

export interface LiquidityCellDecision {
  policyVersion: typeof LIQUIDITY_CELL_POLICY_VERSION;
  state: LiquidityCellState;
  reasons: string[];
  dispatchAllowed: boolean;
  publicInstantRequestsAllowed: boolean;
  invitationOnly: boolean;
  collectInterest: boolean;
  expansionEligible: boolean;
  maxConcurrentDispatches: number;
  evaluatedAt: string;
}

export const LIQUIDITY_THRESHOLDS = Object.freeze({
  metricsMaxAgeMinutes: 15,
  limitedCompletedTasks: 10,
  limitedFillRate: 0.70,
  openPaidTasks30d: 30,
  openFillRate: 0.85,
  densePaidTasks30d: 100,
  denseFillRate: 0.92,
  openActiveProviders: 5,
  maximumDisputeRate: 0.08,
  maximumNoShowRate: 0.08,
  maximumCancellationRate: 0.15,
  expansionMaximumDisputeRate: 0.05,
  expansionMaximumNoShowRate: 0.05,
  expansionProviderRedundancy: 5,
  expansionRepeatDemandRate: 0.20,
  expansionStableDays: 14,
  providerEarningsSampleSize: 30,
});

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function validLiquidityMetrics(metrics: LiquidityCellMetrics): boolean {
  return finiteNonnegative(metrics.completedTasksTotal)
    && finiteNonnegative(metrics.paidTasks30d)
    && validRate(metrics.fillRate30d)
    && finiteNonnegative(metrics.activeVerifiedProviders)
    && finiteNonnegative(metrics.anchorDemandAccounts)
    && Number.isFinite(metrics.averageContributionCents)
    && finiteNonnegative(metrics.providerEarningsSampleSize)
    && finiteNonnegative(metrics.averageProviderNetHourlyCents)
    && validRate(metrics.disputeRate30d)
    && validRate(metrics.noShowRate30d)
    && validRate(metrics.cancellationRate30d)
    && validRate(metrics.repeatDemandRate30d);
}

function ageMinutes(olderIso: string, newerIso: string): number {
  const older = Date.parse(olderIso);
  const newer = Date.parse(newerIso);
  if (!Number.isFinite(older) || !Number.isFinite(newer) || newer < older) return Number.POSITIVE_INFINITY;
  return (newer - older) / 60_000;
}

function stableDays(input: LiquidityCellPolicyInput): number {
  if (!input.stableSince) return 0;
  return ageMinutes(input.stableSince, input.evaluatedAt) / (60 * 24);
}

function launchBlockers(input: LiquidityCellPolicyInput): string[] {
  const blockers: string[] = [];
  if (!input.launchCellEnabled) blockers.push('launch_cell_disabled');
  if (!input.greenCategory) blockers.push('category_not_green');
  if (!input.operatingWindow) blockers.push('operating_window_missing');
  if (input.launchGreenCategoryCount < 2 || input.launchGreenCategoryCount > 3) {
    blockers.push('launch_requires_two_or_three_green_categories');
  }
  if (!Number.isInteger(input.minimumProviderNetHourlyCents)
    || (input.minimumProviderNetHourlyCents ?? 0) <= 0) {
    blockers.push('provider_earnings_floor_missing');
  }
  if (!input.providerEarningsPolicyVersion?.trim()) {
    blockers.push('provider_earnings_policy_missing');
  }
  if (!input.providerEarningsPolicyApproved) {
    blockers.push('provider_earnings_policy_unapproved');
  }
  return blockers;
}

function performanceBlockers(input: LiquidityCellPolicyInput): string[] {
  const { metrics } = input;
  const blockers: string[] = [];
  if (metrics.averageContributionCents <= 0) blockers.push('nonpositive_contribution');
  if (metrics.paidTasks30d >= LIQUIDITY_THRESHOLDS.providerEarningsSampleSize) {
    if (metrics.providerEarningsSampleSize < LIQUIDITY_THRESHOLDS.providerEarningsSampleSize) {
      blockers.push('provider_earnings_sample_incomplete');
    } else if (input.minimumProviderNetHourlyCents !== null
      && metrics.averageProviderNetHourlyCents < input.minimumProviderNetHourlyCents) {
      blockers.push('provider_net_hourly_below_floor');
    }
  }
  if (metrics.disputeRate30d > LIQUIDITY_THRESHOLDS.maximumDisputeRate) blockers.push('dispute_rate_high');
  if (metrics.noShowRate30d > LIQUIDITY_THRESHOLDS.maximumNoShowRate) blockers.push('no_show_rate_high');
  if (metrics.cancellationRate30d > LIQUIDITY_THRESHOLDS.maximumCancellationRate) blockers.push('cancellation_rate_high');
  return blockers;
}

function thresholdState(metrics: LiquidityCellMetrics): LiquidityCellState {
  if (
    metrics.paidTasks30d >= LIQUIDITY_THRESHOLDS.densePaidTasks30d
    && metrics.fillRate30d >= LIQUIDITY_THRESHOLDS.denseFillRate
    && metrics.activeVerifiedProviders >= LIQUIDITY_THRESHOLDS.openActiveProviders
  ) return 'DENSE';
  if (
    metrics.paidTasks30d >= LIQUIDITY_THRESHOLDS.openPaidTasks30d
    && metrics.fillRate30d >= LIQUIDITY_THRESHOLDS.openFillRate
    && metrics.activeVerifiedProviders >= LIQUIDITY_THRESHOLDS.openActiveProviders
  ) return 'OPEN';
  if (
    metrics.completedTasksTotal >= LIQUIDITY_THRESHOLDS.limitedCompletedTasks
    && metrics.fillRate30d >= LIQUIDITY_THRESHOLDS.limitedFillRate
  ) return 'LIMITED';
  return 'SEEDING';
}

function suspensionState(input: LiquidityCellPolicyInput, reasons: string[]): LiquidityCellState | null {
  if (input.suspensionReason || input.severeFailure) {
    reasons.push(input.severeFailure ? `severe_${input.severeFailure}_failure` : 'manual_suspension');
    return 'SUSPENDED';
  }
  return null;
}

function coverageState(metrics: LiquidityCellMetrics, reasons: string[]): LiquidityCellState | null {
  if (metrics.activeVerifiedProviders === 0 || metrics.anchorDemandAccounts === 0) {
    reasons.push('no_credible_coverage');
    return 'CLOSED';
  }
  if (metrics.activeVerifiedProviders < 2 || metrics.anchorDemandAccounts < 2) {
    reasons.push('initial_supply_or_anchor_demand_incomplete');
    return 'SEEDING';
  }
  return null;
}

function baseState(input: LiquidityCellPolicyInput, reasons: string[]): LiquidityCellState {
  const suspended = suspensionState(input, reasons);
  if (suspended) return suspended;
  const launchReasons = launchBlockers(input);
  if (launchReasons.length > 0) {
    reasons.push(...launchReasons);
    return 'CLOSED';
  }
  if (!validLiquidityMetrics(input.metrics)) {
    reasons.push('invalid_metrics');
    return 'THROTTLED';
  }
  if (ageMinutes(input.metricsComputedAt, input.evaluatedAt) > LIQUIDITY_THRESHOLDS.metricsMaxAgeMinutes) {
    reasons.push('stale_metrics');
    return 'THROTTLED';
  }
  const coverage = coverageState(input.metrics, reasons);
  if (coverage) return coverage;
  const metricReasons = performanceBlockers(input);
  reasons.push(...metricReasons);
  if (metricReasons.length > 0) return 'THROTTLED';
  const state = thresholdState(input.metrics);
  if (state === 'SEEDING') reasons.push('seed_thresholds_not_met');
  return state;
}

function canExpand(input: LiquidityCellPolicyInput, state: LiquidityCellState): boolean {
  const metrics = input.metrics;
  return (state === 'OPEN' || state === 'DENSE')
    && stableDays(input) >= LIQUIDITY_THRESHOLDS.expansionStableDays
    && metrics.fillRate30d >= LIQUIDITY_THRESHOLDS.openFillRate
    && metrics.averageContributionCents > 0
    && metrics.providerEarningsSampleSize >= LIQUIDITY_THRESHOLDS.providerEarningsSampleSize
    && input.minimumProviderNetHourlyCents !== null
    && metrics.averageProviderNetHourlyCents >= input.minimumProviderNetHourlyCents
    && metrics.disputeRate30d <= LIQUIDITY_THRESHOLDS.expansionMaximumDisputeRate
    && metrics.noShowRate30d <= LIQUIDITY_THRESHOLDS.expansionMaximumNoShowRate
    && metrics.activeVerifiedProviders >= LIQUIDITY_THRESHOLDS.expansionProviderRedundancy
    && metrics.repeatDemandRate30d >= LIQUIDITY_THRESHOLDS.expansionRepeatDemandRate;
}

export function evaluateLiquidityCell(input: LiquidityCellPolicyInput): LiquidityCellDecision {
  const reasons: string[] = [];
  const state = baseState(input, reasons);
  const dispatchAllowed = ['LIMITED', 'OPEN', 'DENSE'].includes(state)
    && input.metrics.averageContributionCents > 0;
  return {
    policyVersion: LIQUIDITY_CELL_POLICY_VERSION,
    state,
    reasons,
    dispatchAllowed,
    publicInstantRequestsAllowed: state === 'OPEN' || state === 'DENSE',
    invitationOnly: state === 'SEEDING',
    collectInterest: state !== 'SUSPENDED',
    expansionEligible: canExpand(input, state),
    maxConcurrentDispatches: state === 'LIMITED' ? 1 : state === 'OPEN' ? 5 : state === 'DENSE' ? 10 : 0,
    evaluatedAt: input.evaluatedAt,
  };
}

export function publicAvailabilityForCell(state: LiquidityCellState):
  'AVAILABLE' | 'LIMITED' | 'LATER_WINDOWS' | 'TEMPORARILY_UNAVAILABLE' {
  if (state === 'OPEN' || state === 'DENSE') return 'AVAILABLE';
  if (state === 'LIMITED') return 'LIMITED';
  if (state === 'SUSPENDED' || state === 'CLOSED') return 'TEMPORARILY_UNAVAILABLE';
  return 'LATER_WINDOWS';
}
