import { describe, expect, it } from 'vitest';
import {
  evaluateLiquidityCell,
  publicAvailabilityForCell,
  type LiquidityCellMetrics,
  type LiquidityCellPolicyInput,
} from '../../src/services/LiquidityCellPolicy.js';

const now = '2026-07-18T20:00:00.000Z';
const metrics: LiquidityCellMetrics = {
  completedTasksTotal: 30,
  paidTasks30d: 30,
  fillRate30d: 0.85,
  activeVerifiedProviders: 5,
  anchorDemandAccounts: 2,
  averageContributionCents: 1200,
  providerEarningsSampleSize: 30,
  averageProviderNetHourlyCents: 3500,
  disputeRate30d: 0.03,
  noShowRate30d: 0.03,
  cancellationRate30d: 0.08,
  repeatDemandRate30d: 0.25,
};

function input(overrides: Partial<LiquidityCellPolicyInput> = {}): LiquidityCellPolicyInput {
  return {
    geoZone: 'bellevue-kirkland',
    category: 'ground_level_yard_cleanup',
    operatingWindow: 'fri-sun-daytime',
    launchCellEnabled: true,
    greenCategory: true,
    launchGreenCategoryCount: 3,
    minimumProviderNetHourlyCents: 2000,
    providerEarningsPolicyVersion: 'hxos-provider-economics-approved-v1',
    providerEarningsPolicyApproved: true,
    metrics,
    metricsComputedAt: '2026-07-18T19:55:00.000Z',
    evaluatedAt: now,
    previousState: 'OPEN',
    stableSince: '2026-07-01T20:00:00.000Z',
    suspensionReason: null,
    severeFailure: null,
    ...overrides,
  };
}

describe('HX/OS zone-category liquidity policy', () => {
  it('implements every state with deterministic opening thresholds', () => {
    expect(evaluateLiquidityCell(input({ launchCellEnabled: false })).state).toBe('CLOSED');
    expect(evaluateLiquidityCell(input({ launchGreenCategoryCount: 1 })).state).toBe('CLOSED');
    expect(evaluateLiquidityCell(input({ launchGreenCategoryCount: 4 })).state).toBe('CLOSED');
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, completedTasksTotal: 2, paidTasks30d: 2 } })).state).toBe('SEEDING');
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, completedTasksTotal: 10, paidTasks30d: 9, fillRate30d: 0.70 } })).state).toBe('LIMITED');
    expect(evaluateLiquidityCell(input()).state).toBe('OPEN');
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, completedTasksTotal: 150, paidTasks30d: 100, fillRate30d: 0.92 } })).state).toBe('DENSE');
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, cancellationRate30d: 0.16 } })).state).toBe('THROTTLED');
    expect(evaluateLiquidityCell(input({ severeFailure: 'safety' })).state).toBe('SUSPENDED');
  });

  it('fails stale, malformed, nonpositive, unsafe, or uncovered cells closed to dispatch', () => {
    const cases: LiquidityCellPolicyInput[] = [
      input({ metricsComputedAt: '2026-07-18T19:00:00.000Z' }),
      input({ metrics: { ...metrics, fillRate30d: Number.NaN } }),
      input({ metrics: { ...metrics, averageContributionCents: 0 } }),
      input({ metrics: { ...metrics, providerEarningsSampleSize: 30, averageProviderNetHourlyCents: 1999 } }),
      input({ metrics: { ...metrics, providerEarningsSampleSize: 29, averageProviderNetHourlyCents: 3500 } }),
      input({ metrics: { ...metrics, disputeRate30d: 0.09 } }),
      input({ metrics: { ...metrics, activeVerifiedProviders: 0 } }),
    ];
    for (const candidate of cases) {
      expect(evaluateLiquidityCell(candidate).dispatchAllowed).toBe(false);
    }
  });

  it('permits public instant promises only for Open and Dense', () => {
    const limited = evaluateLiquidityCell(input({ metrics: { ...metrics, completedTasksTotal: 10, paidTasks30d: 9, fillRate30d: 0.70 } }));
    expect(limited.dispatchAllowed).toBe(true);
    expect(limited.publicInstantRequestsAllowed).toBe(false);
    expect(evaluateLiquidityCell(input()).publicInstantRequestsAllowed).toBe(true);
  });

  it('blocks adjacent expansion until stability, contribution, quality, redundancy, and repeat demand all pass', () => {
    expect(evaluateLiquidityCell(input()).expansionEligible).toBe(true);
    expect(evaluateLiquidityCell(input({ stableSince: '2026-07-10T20:00:00.000Z' })).expansionEligible).toBe(false);
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, averageContributionCents: 0 } })).expansionEligible).toBe(false);
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, averageProviderNetHourlyCents: 1999 } })).expansionEligible).toBe(false);
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, providerEarningsSampleSize: 29 } })).expansionEligible).toBe(false);
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, activeVerifiedProviders: 4 } })).expansionEligible).toBe(false);
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, repeatDemandRate30d: 0.19 } })).expansionEligible).toBe(false);
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, disputeRate30d: 0.06 } })).expansionEligible).toBe(false);
    expect(evaluateLiquidityCell(input({ metrics: { ...metrics, noShowRate30d: 0.06 } })).expansionEligible).toBe(false);
  });

  it('fails production dispatch closed without an approved provider-earnings policy', () => {
    expect(evaluateLiquidityCell(input({ minimumProviderNetHourlyCents: null })).dispatchAllowed).toBe(false);
    expect(evaluateLiquidityCell(input({ providerEarningsPolicyVersion: null })).dispatchAllowed).toBe(false);
    expect(evaluateLiquidityCell(input({ providerEarningsPolicyApproved: false })).dispatchAllowed).toBe(false);
  });

  it('projects internal states to privacy-safe public promises', () => {
    expect(publicAvailabilityForCell('OPEN')).toBe('AVAILABLE');
    expect(publicAvailabilityForCell('DENSE')).toBe('AVAILABLE');
    expect(publicAvailabilityForCell('LIMITED')).toBe('LIMITED');
    expect(publicAvailabilityForCell('SEEDING')).toBe('LATER_WINDOWS');
    expect(publicAvailabilityForCell('THROTTLED')).toBe('LATER_WINDOWS');
    expect(publicAvailabilityForCell('CLOSED')).toBe('TEMPORARILY_UNAVAILABLE');
    expect(publicAvailabilityForCell('SUSPENDED')).toBe('TEMPORARILY_UNAVAILABLE');
  });
});
