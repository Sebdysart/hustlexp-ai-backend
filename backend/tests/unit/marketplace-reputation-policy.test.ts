import { describe, expect, it } from 'vitest';
import {
  buildPublicReputation,
  reputationRecencyWeight,
  type ReputationSourceRow,
} from '../../src/services/MarketplaceReputationPolicy';

const source: ReputationSourceRow = {
  providerUserId: '11111111-1111-4111-8111-111111111111',
  category: 'yard_help',
  regionCode: 'US-WA',
  verifiedAssignments: 4,
  verifiedCompletions: 3,
  completionRate: 0.75,
  cancellationRate: 0.25,
  proofCompletenessRate: 1,
  disputeRate: 0,
  repeatCustomerCount: 1,
  transactionReviewCount: 2,
  weightedOverallRating: 4.6,
  communication: 5,
  scopeAccuracy: 4.5,
  punctuality: 4,
  care: 5,
  resultQuality: 4.5,
  value: 4,
  nearbyRecommendationCount: 4,
  confirmedRiskFlags: 0,
  licenseStatus: 'NOT_REQUIRED',
  insuranceStatus: 'UNVERIFIED',
  backgroundCheckStatus: 'UNVERIFIED',
};

describe('marketplace reputation policy', () => {
  it('weights recent verified reviews more heavily with a 180-day half-life', () => {
    expect(reputationRecencyWeight(0)).toBe(1);
    expect(reputationRecencyWeight(180)).toBeCloseTo(0.5, 6);
    expect(reputationRecencyWeight(720)).toBeCloseTo(0.0625, 6);
  });

  it('keeps verified performance, transaction reviews, and local recommendations separate', () => {
    const result = buildPublicReputation(source);
    expect(result.verifiedPerformance).toMatchObject({
      label: 'Verified HustleXP performance',
      completions: 3,
      category: 'yard_help',
      regionCode: 'US-WA',
    });
    expect(result.transactionReviews).toMatchObject({
      label: 'Verified transaction reviews',
      count: 2,
      weightedOverallRating: 4.6,
    });
    expect(result.localRecommendations).toEqual({
      label: 'Unverified local recommendations',
      nearbyNeighbors: 4,
      blendedIntoVerifiedScore: false,
    });
  });

  it('marks low-volume providers as building history without inventing poor performance', () => {
    const result = buildPublicReputation({
      ...source,
      verifiedAssignments: 0,
      verifiedCompletions: 0,
      completionRate: null,
      cancellationRate: null,
      proofCompletenessRate: null,
      disputeRate: null,
      transactionReviewCount: 0,
      weightedOverallRating: null,
    });
    expect(result.experienceBand).toBe('BUILDING_HISTORY');
    expect(result.explorationEligible).toBe(true);
    expect(result.transactionReviews.weightedOverallRating).toBeNull();
  });

  it('keeps credentials separate and never exposes earnings or XP as reliability', () => {
    const result = buildPublicReputation(source);
    const serialized = JSON.stringify(result).toLocaleLowerCase();
    expect(result.credentials).toEqual({
      licenseStatus: 'NOT_REQUIRED',
      insuranceStatus: 'UNVERIFIED',
      backgroundCheckStatus: 'UNVERIFIED',
    });
    expect(serialized).not.toMatch(/earnings|payout|income|xp_total|platform_margin/);
  });
});
