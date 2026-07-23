import { computeInsuranceContributionCents } from '../lib/money.js';

export const WORKER_OFFER_POLICY_VERSION = 'hxos-worker-offer-v3';
export const CONSERVATIVE_TRAVEL_TIME_POLICY_VERSION = 'hxos-conservative-travel-v1';

const CONSERVATIVE_TRAVEL_MINUTES_PER_MILE = 3;

export interface WorkerOfferTaskInput {
  id: string;
  title?: string;
  description?: string;
  requirements?: string | null;
  category?: string | null;
  price: number;
  hustler_payout_cents?: number | null;
  distance_miles?: number | null;
  distance_range_min_miles?: number | null;
  distance_range_max_miles?: number | null;
  distance_estimate_kind?: 'APPROXIMATE_POINT' | 'SERVICE_ZONE_RANGE' | null;
  distance_label?: string | null;
  estimated_travel_time_minutes?: number | null;
  estimated_duration_minutes?: number | null;
  duration_range_min_minutes?: number | null;
  duration_range_max_minutes?: number | null;
  duration_policy_version?: string | null;
  rough_location?: string | null;
  risk_level?: string | null;
  required_tools?: string[] | null;
  deadline?: string | Date | null;
  scope_hash?: string | null;
  cancellation_policy_version?: string | null;
  late_cancel_pct?: number | null;
  cancellation_window_hours?: number | null;
  minimum_provider_net_hourly_cents?: number | null;
  provider_earnings_policy_version?: string | null;
  promotion_boost?: number | null;
}

export interface WorkerOfferRankInput {
  matchingScore?: number | null;
  distanceScore?: number | null;
  categoryMatch?: number | null;
  timeMatch?: number | null;
  trustMatch?: number | null;
}

export interface WorkerOfferDecision {
  policyVersion: typeof WORKER_OFFER_POLICY_VERSION;
  decisionReady: boolean;
  blockingReasons: string[];
  economics: {
    customerTotalCents: number;
    /** Worker share before the disclosed self-insurance adjustment. */
    payoutCents: number | null;
    insuranceAdjustmentCents: number | null;
    netPayoutCents: number | null;
    estimatedNetHourlyCents: number | null;
    minimumNetHourlyCents: number | null;
    providerEarningsFloorMet: boolean | null;
  };
  logistics: {
    distanceMiles: number | null;
    distanceRangeMiles: { minimum: number; maximum: number } | null;
    distanceEstimateKind: 'APPROXIMATE_POINT' | 'SERVICE_ZONE_RANGE' | null;
    distanceLabel: string | null;
    exactAddressDisclosed: false;
    estimatedTravelTimeMinutes: number | null;
    travelTimePolicyVersion: string | null;
    travelTimeDisclosure: string;
    estimatedDurationMinutes: number | null;
    durationRangeMinutes: { minimum: number; maximum: number } | null;
    durationPolicyVersion: string | null;
    area: string | null;
    deadline: string | null;
  };
  payment: {
    availabilityState: 'PENDING_UNTIL_SERVER_CONFIRMED_SETTLEMENT';
    timingDisclosure: string;
    externalDeliveryDisclosure: string;
  };
  scope: {
    title: string;
    summary: string;
    requirements: string | null;
    scopeHash: string | null;
    risk: string;
    requiredTools: string[];
  };
  cancellation: {
    policyVersion: string | null;
    lateCancelPercent: number | null;
    windowHours: number | null;
  };
  ranking: {
    score: number | null;
    reasons: string[];
    paidPromotionAffectsRank: false;
  };
  rights: {
    passingHasRankPenalty: false;
    declineCopy: string;
    appealPath: string;
  };
}

function validPositiveInteger(value: number | null | undefined): value is number {
  return Number.isInteger(value) && (value ?? 0) > 0;
}

function validNonnegative(value: number | null | undefined): value is number {
  return Number.isFinite(value) && (value ?? -1) >= 0;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function rankReasons(rank: WorkerOfferRankInput): string[] {
  const reasons: string[] = [];
  if (validNonnegative(rank.distanceScore)) reasons.push(`Distance fit ${percent(Math.min(1, rank.distanceScore))}`);
  if (validNonnegative(rank.categoryMatch)) reasons.push(`Category fit ${percent(Math.min(1, rank.categoryMatch))}`);
  if (validNonnegative(rank.timeMatch)) reasons.push(`Schedule fit ${percent(Math.min(1, rank.timeMatch))}`);
  if (validNonnegative(rank.trustMatch)) reasons.push(`Eligibility fit ${percent(Math.min(1, rank.trustMatch))}`);
  return reasons;
}

function deadline(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

interface PreparedOffer {
  payout: number | null;
  distanceMiles: number | null;
  distanceRangeMiles: { minimum: number; maximum: number } | null;
  distanceEstimateKind: 'APPROXIMATE_POINT' | 'SERVICE_ZONE_RANGE' | null;
  distanceLabel: string | null;
  estimatedTravelTimeMinutes: number | null;
  travelTimePolicyVersion: string | null;
  duration: number | null;
  durationRangeMinutes: { minimum: number; maximum: number } | null;
  durationPolicyVersion: string | null;
  cancellation: WorkerOfferDecision['cancellation'];
  cancellationReady: boolean;
  normalizedRank: number | null;
  rankReasons: string[];
  minimumNetHourlyCents: number | null;
  providerEarningsPolicyVersion: string | null;
}

function prepareCancellation(task: WorkerOfferTaskInput): {
  terms: WorkerOfferDecision['cancellation'];
  ready: boolean;
} {
  const policyVersion = task.cancellation_policy_version ?? null;
  const lateCancelPercent = validNonnegative(task.late_cancel_pct) ? task.late_cancel_pct : null;
  const windowHours = validNonnegative(task.cancellation_window_hours)
    ? task.cancellation_window_hours
    : null;
  return {
    terms: { policyVersion, lateCancelPercent, windowHours },
    ready: Boolean(policyVersion) && lateCancelPercent !== null && windowHours !== null,
  };
}

function prepareOffer(task: WorkerOfferTaskInput, rank: WorkerOfferRankInput): PreparedOffer {
  const cancellation = prepareCancellation(task);
  const distanceMiles = validNonnegative(task.distance_miles) ? task.distance_miles : null;
  const distanceMinimum = validNonnegative(task.distance_range_min_miles)
    ? task.distance_range_min_miles
    : null;
  const distanceMaximum = validNonnegative(task.distance_range_max_miles)
    ? task.distance_range_max_miles
    : null;
  const distanceRangeMiles = distanceMiles === null
    && distanceMinimum !== null
    && distanceMaximum !== null
    && distanceMinimum <= distanceMaximum
    && distanceMaximum > 0
    && distanceMaximum <= 100
    ? { minimum: distanceMinimum, maximum: distanceMaximum }
    : null;
  const distanceEstimateKind = distanceMiles !== null
    ? 'APPROXIMATE_POINT' as const
    : distanceRangeMiles && task.distance_estimate_kind === 'SERVICE_ZONE_RANGE'
      ? 'SERVICE_ZONE_RANGE' as const
      : null;
  const distanceLabel = task.distance_label?.trim()
    || (distanceMiles !== null ? `${distanceMiles.toFixed(1)} miles estimated` : null);
  const attributableDistanceMiles = distanceMiles ?? distanceRangeMiles?.maximum ?? null;
  const providedTravelTime = validPositiveInteger(task.estimated_travel_time_minutes)
    ? task.estimated_travel_time_minutes
    : null;
  const estimatedTravelTimeMinutes = providedTravelTime
    ?? (attributableDistanceMiles !== null
      ? Math.max(1, Math.ceil(attributableDistanceMiles * CONSERVATIVE_TRAVEL_MINUTES_PER_MILE))
      : null);
  const travelTimePolicyVersion = providedTravelTime !== null
    ? 'provided-travel-estimate-v1'
    : estimatedTravelTimeMinutes !== null
      ? CONSERVATIVE_TRAVEL_TIME_POLICY_VERSION
      : null;
  const duration = validPositiveInteger(task.estimated_duration_minutes)
    ? task.estimated_duration_minutes
    : null;
  const durationMinimum = validPositiveInteger(task.duration_range_min_minutes)
    ? task.duration_range_min_minutes
    : null;
  const durationMaximum = validPositiveInteger(task.duration_range_max_minutes)
    ? task.duration_range_max_minutes
    : null;
  const durationRangeMinutes = duration !== null
    && durationMinimum !== null
    && durationMaximum !== null
    && durationMinimum <= duration
    && duration <= durationMaximum
    ? { minimum: durationMinimum, maximum: durationMaximum }
    : null;
  return {
    payout: validPositiveInteger(task.hustler_payout_cents) ? task.hustler_payout_cents : null,
    distanceMiles,
    distanceRangeMiles,
    distanceEstimateKind,
    distanceLabel,
    estimatedTravelTimeMinutes,
    travelTimePolicyVersion,
    duration,
    durationRangeMinutes,
    durationPolicyVersion: durationRangeMinutes ? task.duration_policy_version?.trim() || null : null,
    cancellation: cancellation.terms,
    cancellationReady: cancellation.ready,
    normalizedRank: validNonnegative(rank.matchingScore) ? Math.min(1, rank.matchingScore) : null,
    rankReasons: rankReasons(rank),
    minimumNetHourlyCents: validPositiveInteger(task.minimum_provider_net_hourly_cents)
      ? task.minimum_provider_net_hourly_cents
      : null,
    providerEarningsPolicyVersion: task.provider_earnings_policy_version?.trim() || null,
  };
}

function validScopeHash(value: string | null | undefined): boolean {
  return Boolean(value) && /^[a-f0-9]{64}$/i.test(value ?? '');
}

function offerBlockingReasons(
  task: WorkerOfferTaskInput,
  offer: PreparedOffer,
  economics: WorkerOfferDecision['economics'],
): string[] {
  const blockingReasons: string[] = [];
  if (offer.payout === null) blockingReasons.push('exact_payout_missing');
  if (offer.payout !== null && offer.payout <= computeInsuranceContributionCents(task.price)) {
    blockingReasons.push('net_payout_nonpositive');
  }
  if (offer.distanceMiles === null && offer.distanceRangeMiles === null) blockingReasons.push('distance_missing');
  if ((offer.distanceMiles !== null || offer.distanceRangeMiles !== null)
    && (!offer.distanceEstimateKind || !offer.distanceLabel)) {
    blockingReasons.push('distance_provenance_missing');
  }
  if (offer.estimatedTravelTimeMinutes === null || !offer.travelTimePolicyVersion) {
    blockingReasons.push('travel_time_estimate_missing');
  }
  if (offer.duration === null) blockingReasons.push('duration_missing');
  if (offer.minimumNetHourlyCents === null) blockingReasons.push('provider_earnings_floor_missing');
  if (!offer.providerEarningsPolicyVersion) blockingReasons.push('provider_earnings_policy_missing');
  if (economics.providerEarningsFloorMet === false) {
    blockingReasons.push('provider_net_hourly_below_floor');
  }
  if (!validScopeHash(task.scope_hash)) blockingReasons.push('versioned_scope_missing');
  if (!['LOW', 'MEDIUM', 'HIGH', 'IN_HOME'].includes(task.risk_level ?? '')) {
    blockingReasons.push('risk_level_missing_or_invalid');
  }
  if (!offer.cancellationReady) blockingReasons.push('cancellation_terms_missing');
  if ((task.promotion_boost ?? 0) !== 0) blockingReasons.push('paid_promotion_rank_input_prohibited');
  if (offer.normalizedRank !== null && offer.rankReasons.length === 0) {
    blockingReasons.push('ranking_reasons_missing');
  }
  return blockingReasons;
}

function offerEconomics(task: WorkerOfferTaskInput, offer: PreparedOffer): WorkerOfferDecision['economics'] {
  const insuranceAdjustmentCents = offer.payout === null
    ? null
    : computeInsuranceContributionCents(task.price);
  const netPayoutCents = offer.payout === null || insuranceAdjustmentCents === null
    ? null
    : offer.payout - insuranceAdjustmentCents;
  return {
    customerTotalCents: task.price,
    payoutCents: offer.payout,
    insuranceAdjustmentCents,
    netPayoutCents,
    estimatedNetHourlyCents: netPayoutCents && netPayoutCents > 0
      && offer.duration && offer.estimatedTravelTimeMinutes
      ? Math.floor((netPayoutCents * 60) / (offer.duration + offer.estimatedTravelTimeMinutes))
      : null,
    minimumNetHourlyCents: offer.minimumNetHourlyCents,
    providerEarningsFloorMet: netPayoutCents && netPayoutCents > 0
      && offer.duration && offer.estimatedTravelTimeMinutes && offer.minimumNetHourlyCents
      ? Math.floor((netPayoutCents * 60) / (offer.duration + offer.estimatedTravelTimeMinutes))
        >= offer.minimumNetHourlyCents
      : null,
  };
}

function offerLogistics(task: WorkerOfferTaskInput, offer: PreparedOffer): WorkerOfferDecision['logistics'] {
  return {
    distanceMiles: offer.distanceMiles,
    distanceRangeMiles: offer.distanceRangeMiles,
    distanceEstimateKind: offer.distanceEstimateKind,
    distanceLabel: offer.distanceLabel,
    exactAddressDisclosed: false,
    estimatedTravelTimeMinutes: offer.estimatedTravelTimeMinutes,
    travelTimePolicyVersion: offer.travelTimePolicyVersion,
    travelTimeDisclosure: offer.estimatedTravelTimeMinutes === null
      ? 'Travel time is not yet available because the exact location remains private until assignment.'
      : `Estimated travel time is ${offer.estimatedTravelTimeMinutes} minutes.`,
    estimatedDurationMinutes: offer.duration,
    durationRangeMinutes: offer.durationRangeMinutes,
    durationPolicyVersion: offer.durationPolicyVersion,
    area: task.rough_location ?? null,
    deadline: deadline(task.deadline),
  };
}

function offerScope(task: WorkerOfferTaskInput): WorkerOfferDecision['scope'] {
  return {
    title: task.title ?? 'Task',
    summary: task.description ?? '',
    requirements: task.requirements ?? null,
    scopeHash: task.scope_hash ?? null,
    risk: task.risk_level ?? 'UNKNOWN',
    requiredTools: [...(task.required_tools ?? [])],
  };
}

export function buildWorkerOfferDecision(
  task: WorkerOfferTaskInput,
  rank: WorkerOfferRankInput = {},
): WorkerOfferDecision {
  const offer = prepareOffer(task, rank);
  const economics = offerEconomics(task, offer);
  const blockingReasons = offerBlockingReasons(task, offer, economics);

  return {
    policyVersion: WORKER_OFFER_POLICY_VERSION,
    decisionReady: blockingReasons.length === 0,
    blockingReasons,
    economics,
    logistics: offerLogistics(task, offer),
    payment: {
      availabilityState: 'PENDING_UNTIL_SERVER_CONFIRMED_SETTLEMENT',
      timingDisclosure: 'Earnings enter pending clearance only after server-confirmed completion, any required approval, and settlement.',
      externalDeliveryDisclosure: 'Cash-out fees, destination, eligibility, and provider timing are shown before a payout request. A payout request is not a paid payout.',
    },
    scope: offerScope(task),
    cancellation: offer.cancellation,
    ranking: {
      score: offer.normalizedRank,
      reasons: offer.rankReasons,
      paidPromotionAffectsRank: false,
    },
    rights: {
      passingHasRankPenalty: false,
      declineCopy: 'Pass on this opportunity without a matching-rank penalty.',
      appealPath: `/worker/decision-appeals?task=${encodeURIComponent(task.id)}`,
    },
  };
}
