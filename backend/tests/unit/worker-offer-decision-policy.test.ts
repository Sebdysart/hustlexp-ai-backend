import { describe, expect, it } from 'vitest';
import { buildWorkerOfferDecision } from '../../src/services/WorkerOfferDecisionPolicy.js';

const task = {
  id: 'task-1', title: 'Move two boxes', description: 'Move two boxes upstairs.',
  requirements: 'Bring a hand truck', category: 'moving', price: 7500,
  hustler_payout_cents: 6000, distance_miles: 3.2, estimated_travel_time_minutes: 12,
  estimated_duration_minutes: 90,
  minimum_provider_net_hourly_cents: 2000,
  provider_earnings_policy_version: 'hxos-provider-economics-test-v1',
  rough_location: 'Bellevue area', risk_level: 'MEDIUM', required_tools: ['hand truck'],
  deadline: '2026-07-19T20:00:00.000Z', scope_hash: 'a'.repeat(64),
  cancellation_policy_version: 'cancel-v1', late_cancel_pct: 25, cancellation_window_hours: 24,
};
const rank = { matchingScore: 0.86, distanceScore: 0.8, categoryMatch: 1, timeMatch: 0.9, trustMatch: 0.75 };

describe('worker offer decision rights policy', () => {
  it.each(['LOW', 'MEDIUM', 'HIGH', 'IN_HOME'])('returns a decision-complete, explainable %s risk offer', (risk) => {
    const decision = buildWorkerOfferDecision({ ...task, risk_level: risk }, rank);
    expect(decision).toMatchObject({
      decisionReady: true,
      blockingReasons: [],
      economics: {
        customerTotalCents: 7500,
        payoutCents: 6000,
        insuranceAdjustmentCents: 150,
        netPayoutCents: 5850,
        estimatedNetHourlyCents: 3441,
        minimumNetHourlyCents: 2000,
        providerEarningsFloorMet: true,
      },
      logistics: { distanceMiles: 3.2, estimatedTravelTimeMinutes: 12, estimatedDurationMinutes: 90 },
      payment: { availabilityState: 'PENDING_UNTIL_SERVER_CONFIRMED_SETTLEMENT' },
      scope: { risk, requiredTools: ['hand truck'] },
      cancellation: { policyVersion: 'cancel-v1', lateCancelPercent: 25, windowHours: 24 },
      rights: { passingHasRankPenalty: false },
    });
    expect(decision.ranking.reasons).toEqual([
      'Distance fit 80%', 'Category fit 100%', 'Schedule fit 90%', 'Eligibility fit 75%',
    ]);
  });

  it('exposes rational economics, logistics, scope, terms, and ranking reasons before acceptance', () => {
    const decision = buildWorkerOfferDecision(task, rank);
    expect(decision.decisionReady).toBe(true);
    expect(decision.economics).toEqual({
      customerTotalCents: 7500,
      payoutCents: 6000,
      insuranceAdjustmentCents: 150,
      netPayoutCents: 5850,
      estimatedNetHourlyCents: 3441,
      minimumNetHourlyCents: 2000,
      providerEarningsFloorMet: true,
    });
    expect(decision.logistics).toMatchObject({ distanceMiles: 3.2, estimatedDurationMinutes: 90, area: 'Bellevue area' });
    expect(decision.payment.timingDisclosure).toMatch(/server-confirmed completion/i);
    expect(decision.payment.externalDeliveryDisclosure).toMatch(/not a paid payout/i);
    expect(decision.scope).toMatchObject({ scopeHash: 'a'.repeat(64), risk: 'MEDIUM', requiredTools: ['hand truck'] });
    expect(decision.cancellation.policyVersion).toBe('cancel-v1');
    expect(decision.ranking.reasons).toHaveLength(4);
  });

  it('fails closed when the gross payout cannot cover the disclosed insurance adjustment', () => {
    const decision = buildWorkerOfferDecision({
      ...task,
      price: 7500,
      hustler_payout_cents: 150,
    }, rank);
    expect(decision.decisionReady).toBe(false);
    expect(decision.blockingReasons).toContain('net_payout_nonpositive');
    expect(decision.economics).toMatchObject({
      payoutCents: 150,
      insuranceAdjustmentCents: 150,
      netPayoutCents: 0,
      estimatedNetHourlyCents: null,
    });
  });

  it('fails closed when any required decision field is missing', () => {
    const cases = [
      { hustler_payout_cents: null }, { distance_miles: null }, { estimated_duration_minutes: null },
      { scope_hash: null }, { cancellation_policy_version: null }, { risk_level: null },
      { minimum_provider_net_hourly_cents: null }, { provider_earnings_policy_version: null },
    ];
    for (const override of cases) {
      expect(buildWorkerOfferDecision({ ...task, ...override }, rank).decisionReady).toBe(false);
    }
  });

  it('includes travel in net-hourly economics and blocks an offer below the policy floor', () => {
    const decision = buildWorkerOfferDecision({
      ...task,
      hustler_payout_cents: 3000,
      estimated_duration_minutes: 120,
    }, rank);

    expect(decision.economics).toMatchObject({
      netPayoutCents: 2850,
      estimatedNetHourlyCents: 1295,
      minimumNetHourlyCents: 2000,
      providerEarningsFloorMet: false,
    });
    expect(decision.decisionReady).toBe(false);
    expect(decision.blockingReasons).toContain('provider_net_hourly_below_floor');
  });

  it('derives a conservative attributable travel estimate when only a service-zone range is known', () => {
    const decision = buildWorkerOfferDecision({
      ...task,
      distance_miles: null,
      estimated_travel_time_minutes: null,
      distance_range_min_miles: 0,
      distance_range_max_miles: 10,
      distance_estimate_kind: 'SERVICE_ZONE_RANGE',
      distance_label: 'Within your 10-mile service zone',
    }, rank);

    expect(decision.decisionReady).toBe(true);
    expect(decision.logistics).toMatchObject({
      estimatedTravelTimeMinutes: 30,
      travelTimePolicyVersion: 'hxos-conservative-travel-v1',
    });
    expect(decision.economics.estimatedNetHourlyCents).toBe(2925);
  });

  it('fails closed for an unrecognized risk lane', () => {
    const decision = buildWorkerOfferDecision({ ...task, risk_level: 'UNCLASSIFIED' }, rank);
    expect(decision.decisionReady).toBe(false);
    expect(decision.blockingReasons).toContain('risk_level_missing_or_invalid');
  });

  it('prohibits paid promotion from rank and guarantees a neutral pass', () => {
    const clean = buildWorkerOfferDecision(task, rank);
    expect(clean.ranking.paidPromotionAffectsRank).toBe(false);
    expect(clean.rights.passingHasRankPenalty).toBe(false);
    expect(clean.rights.declineCopy).toMatch(/without a matching-rank penalty/i);
    expect(clean.rights.appealPath).toContain('decision-appeals');

    const promoted = buildWorkerOfferDecision({ ...task, promotion_boost: 0.01 }, rank);
    expect(promoted.decisionReady).toBe(false);
    expect(promoted.blockingReasons).toContain('paid_promotion_rank_input_prohibited');
  });

  it('requires attributable reasons whenever a ranking score is present', () => {
    const decision = buildWorkerOfferDecision(task, { matchingScore: 0.8 });
    expect(decision.decisionReady).toBe(false);
    expect(decision.blockingReasons).toContain('ranking_reasons_missing');
  });
});
