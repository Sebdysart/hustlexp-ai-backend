import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const transaction = vi.fn(async (work: (q: typeof query) => unknown) => work(query));
  return { query, transaction };
});

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));

import {
  controlledTestOfferReviewEnabled,
  ControlledTestOfferReviewService,
} from '../../src/services/ControlledTestOfferReviewService.js';

const original = { ...process.env };
const enabled = {
  NODE_ENV: 'test',
  HXOS_ALLOW_LOCAL_TEST_OFFER_REVIEW: 'true',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  HXOS_LOCAL_TEST_OFFER_REVIEW_SECRET: 'o'.repeat(64),
};
const taskId = '9feafefb-eb9b-4d02-a42b-5223c3552c0a';
const workerId = '84000000-0000-4000-8000-000000000002';
const offerId = '84000000-0000-4000-8000-000000000077';

const context = {
  id: taskId,
  title: 'Assemble one flat-pack standing desk in Bellevue',
  description: 'Assemble one flat-pack standing desk in Bellevue.',
  requirements: null,
  category: 'furniture_assembly',
  price: 13000,
  hustler_payout_cents: 9750,
  estimated_duration_minutes: 105,
  rough_location: 'Bellevue area',
  risk_level: 'LOW',
  required_tools: [],
  deadline: '2026-08-03T00:00:00.000Z',
  scope_hash: 'a'.repeat(64),
  cancellation_policy_version: 'task-template-v2:standard_physical:0',
  late_cancel_pct: 0,
  cancellation_window_hours: 24,
  automation_classification: 'CONTROLLED_TEST',
  region_code: 'US-WA',
  state: 'OPEN',
  worker_id: null,
  poster_id: '84000000-0000-4000-8000-000000000001',
  duration_evidence_id: '84000000-0000-4000-8000-000000000071',
  duration_min_minutes: 45,
  duration_expected_minutes: 105,
  duration_max_minutes: 150,
  duration_policy_version: 'price-book-duration-v1',
  capability_evidence_id: '84000000-0000-4000-8000-000000000072',
  service_city: 'Bellevue',
  service_state: 'WA',
  service_radius_miles: 15,
  provider_tools: ['allen keys', 'drill', 'screwdriver'],
  liquidity_cell_id: '13d04f7f-d400-44bd-b551-a8f602f41ff1',
  liquidity_witness_id: '84000000-0000-4000-8000-000000000073',
  liquidity_ready: true,
  minimum_provider_net_hourly_cents: 2000,
  provider_earnings_policy_version: 'hxos-provider-economics-test-v1',
  provider_earnings_policy_state: 'TEST_HYPOTHESIS',
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, enabled);
  mocks.transaction.mockImplementation(async (work) => work(mocks.query));
});

afterEach(() => {
  process.env = { ...original };
});

function reviewQueries(overrides: Record<string, unknown> = {}) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM hxos_local_test_offer_actions') && sql.includes('idempotency_key')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM tasks task') && sql.includes('duration_evidence')) {
      return { rows: [{ ...context, ...overrides }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO worker_offer_decisions')) return { rows: [{ id: offerId }], rowCount: 1 };
    if (sql.includes('INSERT INTO worker_offer_events')) return { rows: [{ id: 'event-viewed' }], rowCount: 1 };
    if (sql.includes('INSERT INTO hxos_local_test_offer_actions')) {
      return { rows: [{ id: 'action-viewed' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
}

describe('ControlledTestOfferReviewService', () => {
  it('is disabled by default and for production-shaped environments', () => {
    expect(controlledTestOfferReviewEnabled(enabled)).toBe(true);
    for (const override of [
      { NODE_ENV: 'production' },
      { HXOS_ALLOW_LOCAL_TEST_OFFER_REVIEW: 'false' },
      { ENGINE_API_MODE: 'live' },
      { STRIPE_MODE: 'live' },
      { HXOS_LOCAL_TEST_OFFER_REVIEW_SECRET: 'short' },
    ]) expect(controlledTestOfferReviewEnabled({ ...enabled, ...override })).toBe(false);
  });

  it('records a complete worker-viewed offer with ranges and no fabricated point distance', async () => {
    reviewQueries();
    const result = await ControlledTestOfferReviewService.review({
      taskId,
      workerId,
      idempotencyKey: 'offer-review-0001',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        offerDecisionId: offerId,
        taskId,
        workerId,
        eventType: 'VIEWED',
        decision: {
          decisionReady: true,
          economics: {
            payoutCents: 9750,
            insuranceAdjustmentCents: 260,
            netPayoutCents: 9490,
            estimatedNetHourlyCents: 3796,
            minimumNetHourlyCents: 2000,
            providerEarningsFloorMet: true,
          },
          logistics: {
            distanceMiles: null,
            distanceRangeMiles: { minimum: 0, maximum: 15 },
            distanceEstimateKind: 'SERVICE_ZONE_RANGE',
            exactAddressDisclosed: false,
            estimatedTravelTimeMinutes: 45,
            travelTimePolicyVersion: 'hxos-conservative-travel-v1',
            travelTimeDisclosure: expect.stringMatching(/45 minutes/i),
            estimatedDurationMinutes: 105,
            durationRangeMinutes: { minimum: 45, maximum: 150 },
            durationPolicyVersion: 'price-book-duration-v1',
          },
          payment: {
            availabilityState: 'PENDING_UNTIL_SERVER_CONFIRMED_SETTLEMENT',
            timingDisclosure: expect.stringMatching(/server-confirmed completion/i),
            externalDeliveryDisclosure: expect.stringMatching(/not a paid payout/i),
          },
          evidence: {
            durationEvidenceId: context.duration_evidence_id,
            providerCapabilityEvidenceId: context.capability_evidence_id,
            liquidityWitnessId: context.liquidity_witness_id,
          },
        },
      },
    });
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO worker_offer_decisions'));
    expect(String(insert?.[0])).toContain('distance_miles');
    expect(String(insert?.[0])).toContain('provider_earnings_floor_met');
    expect(String(insert?.[0])).toContain('travel_time_policy_version');
    expect(String(insert?.[0])).not.toContain('DO UPDATE');
    expect(insert?.[1]).toContain(null);
  });

  it.each([
    ['missing duration evidence', { duration_evidence_id: null }],
    ['stale liquidity', { liquidity_ready: false }],
    ['duration conflict', { estimated_duration_minutes: 90 }],
    ['wrong environment', { automation_classification: 'PRODUCTION' }],
    ['missing earnings floor', { minimum_provider_net_hourly_cents: null }],
    ['unapproved earnings policy', { provider_earnings_policy_state: 'APPROVED' }],
  ])('fails closed for %s', async (_label, override) => {
    reviewQueries(override);
    await expect(ControlledTestOfferReviewService.review({
      taskId,
      workerId,
      idempotencyKey: `offer-review-${String(_label).replaceAll(' ', '-')}`,
    })).resolves.toMatchObject({ success: false });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes(
      'INSERT INTO worker_offer_decisions',
    ))).toBe(false);
  });

  it('records explicit worker acceptance only for the current reviewed decision', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM hxos_local_test_offer_actions') && sql.includes('idempotency_key')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM worker_offer_decisions offer')) {
        return { rows: [{
          offer_decision_id: offerId,
          task_id: taskId,
          worker_id: workerId,
          decision_ready: true,
          expires_at: '2099-01-01T00:00:00.000Z',
          snapshot: { decisionReady: true },
          review_action_id: '84000000-0000-4000-8000-000000000076',
          task_state: 'OPEN',
          task_worker_id: null,
          automation_classification: 'CONTROLLED_TEST',
          liquidity_ready: true,
          exact_evidence_current: true,
          offer_current: true,
          duration_evidence_id: context.duration_evidence_id,
          provider_capability_evidence_id: context.capability_evidence_id,
          liquidity_witness_id: context.liquidity_witness_id,
        }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO worker_offer_events')) return { rows: [{ id: 'event-accepted' }], rowCount: 1 };
      if (sql.includes('INSERT INTO hxos_local_test_offer_actions')) return { rows: [{ id: 'action-accepted' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await expect(ControlledTestOfferReviewService.accept({
      taskId,
      offerDecisionId: offerId,
      workerId,
      idempotencyKey: 'offer-accept-0001',
    })).resolves.toMatchObject({
      success: true,
      data: { taskId, workerId, offerDecisionId: offerId, eventType: 'ACCEPTED' },
    });
  });

  it('rejects acceptance when the exact reviewed evidence is stale even if other liquidity is current', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM hxos_local_test_offer_actions') && sql.includes('idempotency_key')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM worker_offer_decisions offer')) {
        return { rows: [{
          offer_decision_id: offerId,
          task_id: taskId,
          worker_id: workerId,
          decision_ready: true,
          expires_at: '2099-01-01T00:00:00.000Z',
          snapshot: { decisionReady: true },
          review_action_id: '84000000-0000-4000-8000-000000000076',
          task_state: 'OPEN',
          task_worker_id: null,
          automation_classification: 'CONTROLLED_TEST',
          liquidity_ready: true,
          exact_evidence_current: false,
          offer_current: true,
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(ControlledTestOfferReviewService.accept({
      taskId,
      offerDecisionId: offerId,
      workerId,
      idempotencyKey: 'offer-accept-stale-0001',
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'LOCAL_TEST_OFFER_ACCEPT_NOT_READY' },
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes(
      'INSERT INTO worker_offer_events',
    ))).toBe(false);
  });
});
