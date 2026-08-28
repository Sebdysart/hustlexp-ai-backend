import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));

import { feedItemForRow } from '../../src/services/TaskDiscoveryOfferService.js';
import { personalizedFeedQuery } from '../../src/services/TaskDiscoveryQueryBuilder.js';

const row = {
  id: '81000000-0000-4000-8000-000000000001',
  title: 'Move two boxes',
  description: 'Move two boxes to storage.',
  requirements: null,
  category: 'moving',
  price: 10_000,
  location: 'Bellevue area',
  rough_location: 'Bellevue area',
  deadline: '2026-08-01T00:00:00.000Z',
  created_at: '2026-07-21T00:00:00.000Z',
  state: 'OPEN',
  requires_proof: true,
  mode: 'STANDARD',
  hustler_payout_cents: 7_500,
  estimated_duration_minutes: 60,
  risk_level: 'LOW',
  required_tools: [],
  scope_hash: 'a'.repeat(64),
  cancellation_policy_version: 'task-template-v2:standard_physical:0',
  late_cancel_pct: 0,
  cancellation_window_hours: 24,
  minimum_provider_net_hourly_cents: 2_000,
  provider_earnings_policy_version: 'hxos-provider-economics-approved-v1',
  matching_score: 0.8,
  relevance_score: 0.75,
  distance_miles: 5,
};

describe('task-discovery provider-economics chain', () => {
  beforeEach(() => mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 }));

  it('loads the exact cell policy into the pre-match allowlist', () => {
    const sql = personalizedFeedQuery(row.id, {}, 20, 0).sql;
    expect(sql).toContain('economics_cell.minimum_provider_net_hourly_cents');
    expect(sql).toContain('economics_cell.provider_earnings_policy_version');
    expect(sql).toContain("cell.provider_earnings_policy_state = 'APPROVED'");
    expect(sql).toContain('cell.provider_earnings_sample_size >= 30');
    expect(sql).not.toContain('featured_listings');
  });

  it('persists travel-adjusted economics bound to that exact policy', async () => {
    const item = await feedItemForRow(
      '81000000-0000-4000-8000-000000000002',
      row,
    );

    expect(item.offer_decision).toMatchObject({
      policyVersion: 'hxos-worker-offer-v3',
      decisionReady: true,
      economics: {
        netPayoutCents: 7_300,
        estimatedNetHourlyCents: 5_840,
        minimumNetHourlyCents: 2_000,
        providerEarningsFloorMet: true,
      },
      logistics: {
        estimatedTravelTimeMinutes: 15,
        travelTimePolicyVersion: 'hxos-conservative-travel-v1',
      },
    });
    const [sql, values] = mocks.query.mock.calls[0]!;
    expect(String(sql)).toContain('minimum_net_hourly_cents');
    expect(String(sql)).toContain('estimated_travel_time_minutes');
    expect(String(sql)).toContain('provider_earnings_floor_met');
    expect(values).toMatchObject({
      2: 'hxos-worker-offer-v3',
      9: 7_300,
      10: 5_840,
      11: 2_000,
      12: 'hxos-provider-economics-approved-v1',
      13: true,
      15: 15,
      16: 'hxos-conservative-travel-v1',
    });
  });
});
