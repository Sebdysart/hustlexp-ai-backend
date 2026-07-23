import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../src/db', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import { MarketplaceReputationService } from '../../src/services/MarketplaceReputationService';

const PROVIDER_ID = '11111111-1111-4111-8111-111111111111';
const RECOMMENDER_ID = '22222222-2222-4222-8222-222222222222';
const RECOMMENDATION_ID = '33333333-3333-4333-8333-333333333333';
const SIGNAL_ID = '44444444-4444-4444-8444-444444444444';
const rowResult = (rows: unknown[] = []) => ({ rows });

describe('MarketplaceReputationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback: (query: typeof mocks.query) => unknown) => callback(mocks.query));
  });

  it('returns category-specific public signals without earnings or XP', async () => {
    mocks.query.mockResolvedValueOnce(rowResult([{
      provider_user_id: PROVIDER_ID,
      category: 'yard_help',
      region_code: 'US-WA',
      verified_assignments: '4',
      verified_completions: '3',
      completion_rate: '0.75',
      cancellation_rate: '0.25',
      proof_completeness_rate: '1',
      dispute_rate: '0',
      repeat_customer_count: '1',
      transaction_review_count: '2',
      weighted_overall_rating: '4.6',
      communication: '5', scope_accuracy: '4.5', punctuality: '4', care: '5',
      result_quality: '4.5', value: '4', nearby_recommendation_count: '4',
      confirmed_risk_flags: '0', license_status: 'NOT_REQUIRED',
      insurance_status: 'UNVERIFIED', background_check_status: 'UNVERIFIED',
    }]));

    const result = await MarketplaceReputationService.getPublicSummary(PROVIDER_ID, 'yard_help', 'US-WA');
    expect(result).toMatchObject({
      success: true,
      data: {
        verifiedPerformance: { category: 'yard_help', completions: 3 },
        localRecommendations: { nearbyNeighbors: 4, blendedIntoVerifiedScore: false },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/payout|earnings|xp_total/i);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('provider_reputation_public'),
      [PROVIDER_ID, 'yard_help', 'US-WA'],
    );
  });

  it('requires an active verified-local membership and creates a moderation-pending recommendation', async () => {
    mocks.query
      .mockResolvedValueOnce(rowResult([{}]))
      .mockResolvedValueOnce(rowResult([]))
      .mockResolvedValueOnce(rowResult([{ region_code: 'US-WA' }]))
      .mockResolvedValueOnce(rowResult([]))
      .mockResolvedValueOnce(rowResult([{
        id: RECOMMENDATION_ID, state: 'PENDING_MODERATION', collusion_hold: false,
      }]));

    const result = await MarketplaceReputationService.submitLocalRecommendation({
      recommenderId: RECOMMENDER_ID,
      providerUserId: PROVIDER_ID,
      category: 'yard_help',
      regionCode: 'US-WA',
      body: 'Reliable help with seasonal yard cleanup.',
      relationship: 'NEIGHBOR',
      idempotencyKey: 'local-rec-0001',
    });
    expect(result).toMatchObject({ success: true, data: { id: RECOMMENDATION_ID, state: 'PENDING_MODERATION' } });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('verified_region_memberships'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO local_provider_recommendations'))).toBe(true);
  });

  it('holds reciprocal recommendations and records a collusion signal for human review', async () => {
    mocks.query
      .mockResolvedValueOnce(rowResult([{}]))
      .mockResolvedValueOnce(rowResult([]))
      .mockResolvedValueOnce(rowResult([{ region_code: 'US-WA' }]))
      .mockResolvedValueOnce(rowResult([{ id: 'reciprocal-rec' }]))
      .mockResolvedValueOnce(rowResult([{
        id: RECOMMENDATION_ID, state: 'HELD_FOR_REVIEW', collusion_hold: true,
      }]))
      .mockResolvedValueOnce(rowResult([{ id: SIGNAL_ID }]));

    const result = await MarketplaceReputationService.submitLocalRecommendation({
      recommenderId: RECOMMENDER_ID,
      providerUserId: PROVIDER_ID,
      category: 'yard_help', regionCode: 'US-WA',
      body: 'Consistently helpful and careful.', relationship: 'NEIGHBOR',
      idempotencyKey: 'local-rec-0002',
    });
    expect(result).toMatchObject({ success: true, data: { state: 'HELD_FOR_REVIEW', collusion_hold: true } });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO reputation_signal_flags'))).toBe(true);
  });

  it('allows only the affected provider to create one immutable appeal', async () => {
    mocks.query
      .mockResolvedValueOnce(rowResult([{ id: SIGNAL_ID, provider_user_id: PROVIDER_ID, status: 'OPEN' }]))
      .mockResolvedValueOnce(rowResult([{ id: 'appeal-1', status: 'PENDING' }]));
    const result = await MarketplaceReputationService.appealSignal({
      signalId: SIGNAL_ID, providerUserId: PROVIDER_ID,
      reason: 'These accounts are unrelated and the recommendation is genuine.',
    });
    expect(result).toMatchObject({ success: true, data: { status: 'PENDING' } });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO reputation_signal_appeals'))).toBe(true);
  });
});
