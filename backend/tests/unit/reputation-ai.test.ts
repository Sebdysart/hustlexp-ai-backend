import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/services/AIClient', () => ({
  AIClient: { isConfigured: vi.fn().mockReturnValue(false), callJSON: vi.fn() },
}));
vi.mock('../../src/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { aiLogger: { child }, logger: { child } };
});

import { ReputationAIService } from '../../src/services/ReputationAIService';
import { db } from '../../src/db';
import { AIClient } from '../../src/services/AIClient';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const baseUser = {
  id: 'u1',
  trust_tier: 1,
  xp_total: 100,
  current_streak: 2,
  is_verified: false,
  account_status: 'active',
  created_at: new Date('2025-01-01'),
};

const baseTaskStats = {
  total_completed: '5',
  total_cancelled: '1',
  total_tasks: '6',
  avg_completion_hours: null,
};

const baseDisputeStats = {
  total_disputes: '0',
  open_disputes: '0',
  recent_disputes: '0',
};

// Helper: mock the 5 Promise.all queries + 1 _logDecision INSERT for calculateTrustScore
function mockTrustScoreQueries(
  userRow: object | null,
  ratingsRows: object[],
  taskStatsRow: object,
  disputeStatsRow: object,
  recentRatingsRows: object[]
) {
  (db.query as any)
    .mockResolvedValueOnce({ rows: userRow ? [userRow] : [] })
    .mockResolvedValueOnce({ rows: ratingsRows })
    .mockResolvedValueOnce({ rows: [taskStatsRow] })
    .mockResolvedValueOnce({ rows: [disputeStatsRow] })
    .mockResolvedValueOnce({ rows: recentRatingsRows })
    .mockResolvedValueOnce({ rows: [] }); // _logDecision INSERT
}

describe('ReputationAIService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // 1. calculateTrustScore
  // ==========================================================================
  describe('calculateTrustScore', () => {
    it('returns NOT_FOUND when user does not exist', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await ReputationAIService.calculateTrustScore('missing-user');

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe('NOT_FOUND');
    });

    it('returns trust score for a basic user with no ratings', async () => {
      mockTrustScoreQueries(
        baseUser,
        [],
        baseTaskStats,
        baseDisputeStats,
        []
      );

      const result = await ReputationAIService.calculateTrustScore('u1');

      expect(result.success).toBe(true);
      expect(typeof (result as any).data.trust_score).toBe('number');
      expect((result as any).data.trend).toBe('stable');
    });

    it('computes improving trend when recent ratings > older ratings', async () => {
      // 12 ratings: first 6 are stars:5 (recent), last 6 are stars:3 (older)
      const recentRatings = [
        ...Array(6).fill(null).map(() => ({ stars: 5, created_at: new Date() })),
        ...Array(6).fill(null).map(() => ({ stars: 3, created_at: new Date('2024-01-01') })),
      ];

      mockTrustScoreQueries(
        baseUser,
        [],
        baseTaskStats,
        baseDisputeStats,
        recentRatings
      );

      const result = await ReputationAIService.calculateTrustScore('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.trend).toBe('improving');
    });

    it('computes declining trend when recent ratings < older ratings', async () => {
      // 12 ratings: first 6 are stars:2 (recent), last 6 are stars:5 (older)
      const recentRatings = [
        ...Array(6).fill(null).map(() => ({ stars: 2, created_at: new Date() })),
        ...Array(6).fill(null).map(() => ({ stars: 5, created_at: new Date('2024-01-01') })),
      ];

      mockTrustScoreQueries(
        baseUser,
        [],
        baseTaskStats,
        baseDisputeStats,
        recentRatings
      );

      const result = await ReputationAIService.calculateTrustScore('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.trend).toBe('declining');
    });

    it('returns error when db throws', async () => {
      (db.query as any).mockRejectedValueOnce(new Error('DB crash'));

      const result = await ReputationAIService.calculateTrustScore('u1');

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe('TRUST_SCORE_FAILED');
    });
  });

  // ==========================================================================
  // 2. detectAnomalies
  // ==========================================================================
  describe('detectAnomalies', () => {
    it('returns NOT_FOUND when user does not exist', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await ReputationAIService.detectAnomalies('missing-user');

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe('NOT_FOUND');
    });

    it('returns empty anomalies for clean user', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })                                    // Q1: user check
        .mockResolvedValueOnce({ rows: [{ stars: 5, count: '3' }] })                        // Q2: rating dist (only 3, <5 total)
        .mockResolvedValueOnce({ rows: [{ recent_count: '2', prior_count: '2' }] })          // Q3: volume
        .mockResolvedValueOnce({ rows: [{ cancel_count: '0', total_count: '3' }] })          // Q4: cancellation
        .mockResolvedValueOnce({ rows: [] })                                                 // Q5: self-dealing
        .mockResolvedValueOnce({ rows: [] });                                                // Q6: _logDecision

      const result = await ReputationAIService.detectAnomalies('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.anomalies.length).toBe(0);
    });

    it('detects suspicious_rating_pattern when >95% five-star ratings', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })                                    // Q1: user check
        .mockResolvedValueOnce({ rows: [{ stars: 5, count: '20' }] })                       // Q2: 20/20 five-star
        .mockResolvedValueOnce({ rows: [{ recent_count: '2', prior_count: '2' }] })          // Q3: volume
        .mockResolvedValueOnce({ rows: [{ cancel_count: '0', total_count: '5' }] })          // Q4: cancellation
        .mockResolvedValueOnce({ rows: [] })                                                 // Q5: self-dealing
        .mockResolvedValueOnce({ rows: [] });                                                // Q6: _logDecision

      const result = await ReputationAIService.detectAnomalies('u1');

      expect(result.success).toBe(true);
      expect(
        (result as any).data.anomalies.some((a: any) => a.type === 'suspicious_rating_pattern')
      ).toBe(true);
    });

    it('detects high_cancellation_rate when cancellations > 40% and total >= 3', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })                                    // Q1: user check
        .mockResolvedValueOnce({ rows: [{ stars: 4, count: '2' }] })                        // Q2: rating dist
        .mockResolvedValueOnce({ rows: [{ recent_count: '2', prior_count: '2' }] })          // Q3: volume
        .mockResolvedValueOnce({ rows: [{ cancel_count: '3', total_count: '5' }] })          // Q4: 60% cancellation
        .mockResolvedValueOnce({ rows: [] })                                                 // Q5: self-dealing
        .mockResolvedValueOnce({ rows: [] });                                                // Q6: _logDecision

      const result = await ReputationAIService.detectAnomalies('u1');

      expect(result.success).toBe(true);
      expect(
        (result as any).data.anomalies.some((a: any) => a.type === 'high_cancellation_rate')
      ).toBe(true);
    });

    it('detects self_dealing when partner has >= 10 completed tasks', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })                                    // Q1: user check
        .mockResolvedValueOnce({ rows: [{ stars: 4, count: '2' }] })                        // Q2: rating dist
        .mockResolvedValueOnce({ rows: [{ recent_count: '2', prior_count: '2' }] })          // Q3: volume
        .mockResolvedValueOnce({ rows: [{ cancel_count: '0', total_count: '5' }] })          // Q4: cancellation
        .mockResolvedValueOnce({ rows: [{ partner_id: 'p1', pair_count: '10' }] })           // Q5: self-dealing
        .mockResolvedValueOnce({ rows: [] });                                                // Q6: _logDecision

      const result = await ReputationAIService.detectAnomalies('u1');

      expect(result.success).toBe(true);
      const selfDealing = (result as any).data.anomalies.find((a: any) => a.type === 'self_dealing');
      expect(selfDealing).toBeDefined();
      expect(selfDealing.severity).toBe('critical');
    });

    it('returns error when db throws', async () => {
      (db.query as any).mockRejectedValueOnce(new Error('DB crash'));

      const result = await ReputationAIService.detectAnomalies('u1');

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe('ANOMALY_DETECTION_FAILED');
    });
  });

  // ==========================================================================
  // 3. generateUserInsight
  // ==========================================================================
  describe('generateUserInsight', () => {
    const insightUser = {
      id: 'u1',
      trust_tier: 2,
      xp_total: 500,
      current_streak: 2,
      is_verified: true,
      account_status: 'active',
      created_at: new Date('2024-01-01'),
    };

    const insightRatings = { avg_rating: '4.5', total_ratings: '15' };
    const insightTaskStats = {
      total_completed: '10',
      total_cancelled: '1',
      total_tasks: '11',
      avg_completion_hours: '1.5',
    };
    const insightDisputeStats = { total_disputes: '0', open_disputes: '0', recent_disputes: '0' };

    function mockInsightQueries(
      userRow: object | null,
      ratingsRows: object[],
      taskStatsRow: object,
      disputeStatsRow: object
    ) {
      (db.query as any)
        .mockResolvedValueOnce({ rows: userRow ? [userRow] : [] })
        .mockResolvedValueOnce({ rows: ratingsRows })
        .mockResolvedValueOnce({ rows: [taskStatsRow] })
        .mockResolvedValueOnce({ rows: [disputeStatsRow] })
        .mockResolvedValueOnce({ rows: [] }); // _logDecision INSERT
    }

    it('returns NOT_FOUND when user does not exist', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await ReputationAIService.generateUserInsight('missing-user');

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe('NOT_FOUND');
    });

    it('generates heuristic insight for user with no disputes and zero streak', async () => {
      mockInsightQueries(
        insightUser,
        [insightRatings],
        insightTaskStats,
        insightDisputeStats
      );

      const result = await ReputationAIService.generateUserInsight('u1');

      expect(result.success).toBe(true);
      // Zero disputes path produces "zero disputes" or "Clean record"
      expect((result as any).data.summary.toLowerCase()).toMatch(/dispute/);
    });

    it('generates insight with streak line when streak > 5', async () => {
      mockInsightQueries(
        { ...insightUser, current_streak: 8 },
        [insightRatings],
        insightTaskStats,
        insightDisputeStats
      );

      const result = await ReputationAIService.generateUserInsight('u1');

      expect(result.success).toBe(true);
      // Should include streak reference
      expect((result as any).data.summary).toMatch(/streak|8-day/i);
    });

    it('generates elevated cancellation line when cancellation rate > 30%', async () => {
      mockInsightQueries(
        insightUser,
        [insightRatings],
        { total_completed: '3', total_cancelled: '5', total_tasks: '8', avg_completion_hours: null },
        insightDisputeStats
      );

      const result = await ReputationAIService.generateUserInsight('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.summary.toLowerCase()).toMatch(/cancellation/i);
    });
  });

  // ==========================================================================
  // 4. shouldPromoteTier
  // ==========================================================================
  describe('shouldPromoteTier', () => {
    it('returns NOT_FOUND when user does not exist', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await ReputationAIService.shouldPromoteTier('missing-user');

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe('NOT_FOUND');
    });

    it('returns not eligible at max tier (4)', async () => {
      (db.query as any).mockResolvedValueOnce({
        rows: [{ trust_tier: 4, is_verified: true, created_at: new Date() }],
      });

      const result = await ReputationAIService.shouldPromoteTier('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.eligible).toBe(false);
      expect((result as any).data.blockers.some((b: string) => b.includes('maximum tier'))).toBe(true);
    });

    it('returns eligible for tier 1 -> 2 with sufficient tasks and rating', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [{ trust_tier: 1, is_verified: false, created_at: new Date('2024-01-01') }] })
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })           // 5 completed tasks (>=3)
        .mockResolvedValueOnce({ rows: [{ avg_rating: '4.5' }] })    // 4.5 rating (>=4.0)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });          // no active disputes

      const result = await ReputationAIService.shouldPromoteTier('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.eligible).toBe(true);
      expect((result as any).data.nextTier).toBe(2);
    });

    it('blocks tier 2 when insufficient tasks', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [{ trust_tier: 1, is_verified: false, created_at: new Date('2024-01-01') }] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })           // only 1 task (needs 3)
        .mockResolvedValueOnce({ rows: [{ avg_rating: '4.5' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const result = await ReputationAIService.shouldPromoteTier('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.eligible).toBe(false);
      expect((result as any).data.blockers.some((b: string) => b.includes('3 completed tasks'))).toBe(true);
    });

    it('blocks tier 2 when low rating', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [{ trust_tier: 1, is_verified: false, created_at: new Date('2024-01-01') }] })
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })
        .mockResolvedValueOnce({ rows: [{ avg_rating: '3.5' }] })    // 3.5 < 4.0 required
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const result = await ReputationAIService.shouldPromoteTier('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.eligible).toBe(false);
      expect((result as any).data.blockers.some((b: string) => b.includes('rating'))).toBe(true);
    });

    it('blocks tier 3 when active disputes exist', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [{ trust_tier: 2, is_verified: true, created_at: new Date('2024-01-01') }] })
        .mockResolvedValueOnce({ rows: [{ count: '15' }] })           // enough tasks
        .mockResolvedValueOnce({ rows: [{ avg_rating: '4.4' }] })     // good rating
        .mockResolvedValueOnce({ rows: [{ count: '1' }] });           // 1 active dispute

      const result = await ReputationAIService.shouldPromoteTier('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.eligible).toBe(false);
      expect((result as any).data.blockers.some((b: string) => b.includes('dispute'))).toBe(true);
    });

    it('blocks tier 4 when account < 180 days old', async () => {
      // Tier 3 -> 4: minTasks=25, minRating=4.5, noDisputes=false, identityVerified=true
      (db.query as any)
        .mockResolvedValueOnce({ rows: [{ trust_tier: 3, is_verified: true, created_at: new Date() }] }) // 0 days old
        .mockResolvedValueOnce({ rows: [{ count: '30' }] })           // 30 tasks (>=25)
        .mockResolvedValueOnce({ rows: [{ avg_rating: '4.6' }] })     // 4.6 (>=4.5)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });           // no active disputes

      const result = await ReputationAIService.shouldPromoteTier('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.eligible).toBe(false);
      expect((result as any).data.blockers.some((b: string) => b.includes('6+ months'))).toBe(true);
    });

    it('returns error when db throws', async () => {
      (db.query as any).mockRejectedValueOnce(new Error('DB crash'));

      const result = await ReputationAIService.shouldPromoteTier('u1');

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe('PROMOTION_CHECK_FAILED');
    });
  });

  // ==========================================================================
  // TDD: Fix #2 — TrustScoreSchema + NaN guard
  // ==========================================================================
  describe('calculateTrustScore — AI path validation (fix #2)', () => {
    it('returns finite trust_score even when AI callJSON resolves with non-numeric trust_score', async () => {
      // Simulate a hallucinated AI response where trust_score is a string.
      // Before fix: Math.max(0, Math.min(100, 'garbage')) = NaN — passes silently.
      // After fix:  service detects non-finite value, throws, falls back to heuristic.
      (AIClient.isConfigured as any).mockReturnValue(true);
      (AIClient.callJSON as any).mockResolvedValue({
        data: {
          trust_score: 'not-a-number',   // ← hallucinated string
          trend: 'stable',
          risk_factors: [],
          strengths: [],
          recommended_tier: 2,
        },
        provider: 'openai',
        latencyMs: 50,
        cached: false,
        content: '{}',
      });

      mockTrustScoreQueries(baseUser, [], baseTaskStats, baseDisputeStats, []);

      const result = await ReputationAIService.calculateTrustScore('u1');

      expect(result.success).toBe(true);
      expect(Number.isFinite((result as any).data.trust_score)).toBe(true);
    });

    it('returns finite trust_score even when AI callJSON resolves with out-of-range recommended_tier', async () => {
      // Simulate a hallucinated recommended_tier of 99.
      // After fix: bounds-clamped to [1,4] — should be 4, not 99.
      (AIClient.isConfigured as any).mockReturnValue(true);
      (AIClient.callJSON as any).mockResolvedValue({
        data: {
          trust_score: 85,
          trend: 'improving',
          risk_factors: [],
          strengths: ['good'],
          recommended_tier: 99,   // ← hallucinated out of [1,4]
        },
        provider: 'openai',
        latencyMs: 50,
        cached: false,
        content: '{}',
      });

      mockTrustScoreQueries(baseUser, [], baseTaskStats, baseDisputeStats, []);

      const result = await ReputationAIService.calculateTrustScore('u1');

      expect(result.success).toBe(true);
      expect((result as any).data.recommended_tier).toBeGreaterThanOrEqual(1);
      expect((result as any).data.recommended_tier).toBeLessThanOrEqual(4);
    });

    it('falls back to heuristic when callJSON rejects (simulates ZodError from schema)', async () => {
      // After fix, callJSON is called with TrustScoreSchema.
      // When schema validation fails, callJSON throws — service must fall back.
      (AIClient.isConfigured as any).mockReturnValue(true);
      (AIClient.callJSON as any).mockRejectedValue(
        new Error('ZodError: trust_score must be a number')
      );

      mockTrustScoreQueries(baseUser, [], baseTaskStats, baseDisputeStats, []);

      const result = await ReputationAIService.calculateTrustScore('u1');

      expect(result.success).toBe(true);
      expect(Number.isFinite((result as any).data.trust_score)).toBe(true);
    });
  });
});
