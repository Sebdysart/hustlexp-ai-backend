import { scrubPII } from '../lib/pii-scrubber.js';

export type CredentialStatus = 'VERIFIED' | 'UNVERIFIED' | 'NOT_REQUIRED' | 'EXPIRED';
export type ReputationExperienceBand = 'BUILDING_HISTORY' | 'ESTABLISHED';

export interface ReputationSourceRow {
  providerUserId: string;
  category: string;
  regionCode: string;
  verifiedAssignments: number;
  verifiedCompletions: number;
  completionRate: number | null;
  cancellationRate: number | null;
  proofCompletenessRate: number | null;
  disputeRate: number | null;
  repeatCustomerCount: number;
  transactionReviewCount: number;
  weightedOverallRating: number | null;
  communication: number | null;
  scopeAccuracy: number | null;
  punctuality: number | null;
  care: number | null;
  resultQuality: number | null;
  value: number | null;
  nearbyRecommendationCount: number;
  confirmedRiskFlags: number;
  licenseStatus: CredentialStatus;
  insuranceStatus: CredentialStatus;
  backgroundCheckStatus: CredentialStatus;
}

export interface PublicProviderReputation {
  providerUserId: string;
  category: string;
  regionCode: string;
  experienceBand: ReputationExperienceBand;
  explorationEligible: boolean;
  verifiedPerformance: {
    label: 'Verified HustleXP performance';
    category: string;
    regionCode: string;
    assignments: number;
    completions: number;
    completionRate: number | null;
    cancellationRate: number | null;
    proofCompletenessRate: number | null;
    disputeRate: number | null;
    repeatCustomerCount: number;
  };
  transactionReviews: {
    label: 'Verified transaction reviews';
    count: number;
    weightedOverallRating: number | null;
    dimensions: {
      communication: number | null;
      scopeAccuracy: number | null;
      punctuality: number | null;
      care: number | null;
      resultQuality: number | null;
      value: number | null;
    };
  };
  localRecommendations: {
    label: 'Unverified local recommendations';
    nearbyNeighbors: number;
    blendedIntoVerifiedScore: false;
  };
  credentials: {
    licenseStatus: CredentialStatus;
    insuranceStatus: CredentialStatus;
    backgroundCheckStatus: CredentialStatus;
  };
}

const HALF_LIFE_DAYS = 180;

export function reputationRecencyWeight(ageDays: number): number {
  const boundedAge = Number.isFinite(ageDays) ? Math.max(0, ageDays) : Number.MAX_SAFE_INTEGER;
  return 2 ** (-boundedAge / HALF_LIFE_DAYS);
}

export function preparePublicRecommendation(raw: string): string {
  const normalized = raw.trim().replace(/\s+/gu, ' ');
  if (normalized.length < 10 || normalized.length > 500) {
    throw new Error('A local recommendation between 10 and 500 characters is required.');
  }
  const safe = scrubPII(normalized, { names: false, userIds: false }).trim();
  if (safe.length < 10) throw new Error('The recommendation contained no public-safe detail.');
  return safe;
}

export function buildPublicReputation(source: ReputationSourceRow): PublicProviderReputation {
  const experienceBand: ReputationExperienceBand = source.verifiedCompletions < 5
    ? 'BUILDING_HISTORY'
    : 'ESTABLISHED';
  return {
    providerUserId: source.providerUserId,
    category: source.category,
    regionCode: source.regionCode,
    experienceBand,
    explorationEligible: experienceBand === 'BUILDING_HISTORY' && source.confirmedRiskFlags === 0,
    verifiedPerformance: {
      label: 'Verified HustleXP performance',
      category: source.category,
      regionCode: source.regionCode,
      assignments: source.verifiedAssignments,
      completions: source.verifiedCompletions,
      completionRate: source.completionRate,
      cancellationRate: source.cancellationRate,
      proofCompletenessRate: source.proofCompletenessRate,
      disputeRate: source.disputeRate,
      repeatCustomerCount: source.repeatCustomerCount,
    },
    transactionReviews: {
      label: 'Verified transaction reviews',
      count: source.transactionReviewCount,
      weightedOverallRating: source.weightedOverallRating,
      dimensions: {
        communication: source.communication,
        scopeAccuracy: source.scopeAccuracy,
        punctuality: source.punctuality,
        care: source.care,
        resultQuality: source.resultQuality,
        value: source.value,
      },
    },
    localRecommendations: {
      label: 'Unverified local recommendations',
      nearbyNeighbors: source.nearbyRecommendationCount,
      blendedIntoVerifiedScore: false,
    },
    credentials: {
      licenseStatus: source.licenseStatus,
      insuranceStatus: source.insuranceStatus,
      backgroundCheckStatus: source.backgroundCheckStatus,
    },
  };
}
