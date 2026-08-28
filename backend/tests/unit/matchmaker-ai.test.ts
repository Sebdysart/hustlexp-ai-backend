import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/services/AIClient', () => ({
  AIClient: { isConfigured: vi.fn().mockReturnValue(false), callJSON: vi.fn() },
}));
vi.mock('../../src/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { aiLogger: { child }, logger: { child } };
});
vi.mock('../../src/lib/pii-scrubber', () => ({ scrubPII: (s: string) => s }));
vi.mock('../../src/lib/ai-response-schemas', () => ({
  MatchmakerRankingsSchema: {},
  MatchExplanationSchema: {},
  PriceSuggestionSchema: {},
}));

import { MatchmakerAIService } from '../../src/services/MatchmakerAIService';
import { db } from '../../src/db';

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------
function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Deliver package',
    description: 'Pick up at 123 Main St, deliver to 456 Oak Ave',
    category: 'delivery',
    location: '123 Main St, LA, CA',
    price: 3000,
    requirements: undefined,
    ...overrides,
  };
}

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    skills: ['delivery', 'driving'],
    location: { latitude: 34.0, longitude: -118.0 },
    trustTier: 2,
    completedTasks: 10,
    completionRate: 0.90,
    averageRating: 4.5,
    isAvailable: true,
    ...overrides,
  };
}

describe('MatchmakerAIService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: _logDecision INSERT always succeeds
    (db.query as any).mockResolvedValue({ rows: [] });
  });

  // ==========================================================================
  // rankCandidates
  // ==========================================================================
  describe('rankCandidates', () => {
    it('returns empty array when no candidates provided', async () => {
      const result = await MatchmakerAIService.rankCandidates(makeTask(), []);

      expect(result.success).toBe(true);
      expect((result as any).data).toEqual([]);
    });

    it('ranks candidates using deterministic scoring', async () => {
      const candidates = [
        makeCandidate({ userId: 'u1', skills: ['delivery'] }),
        makeCandidate({ userId: 'u2', skills: ['cooking'], completionRate: 0.50, trustTier: 1 }),
        makeCandidate({ userId: 'u3', skills: ['delivery', 'driving'], trustTier: 3 }),
      ];

      const result = await MatchmakerAIService.rankCandidates(makeTask(), candidates);

      expect(result.success).toBe(true);
      expect((result as any).data.length).toBeGreaterThanOrEqual(1);
      expect((result as any).data[0].rank).toBe(1);
      expect((result as any).data[0].matchScore).toBeGreaterThan(0);

      // Should be sorted descending by matchScore
      const scores = (result as any).data.map((c: any) => c.matchScore);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
      }
    });

    it('filters candidates below 0.30 match threshold', async () => {
      // isAvailable:false(0), completionRate:0(0), completedTasks:0, trustTier:1, skills:[]
      // matchScore = 0.5*0.30 + 0.5*0.20 + 0*0.25 + 0.25*0.15 + 0*0.10 = 0.15+0.10+0+0.0375+0 = 0.2875 < 0.30
      const weakCandidate = makeCandidate({
        userId: 'weak',
        isAvailable: false,
        completionRate: 0,
        completedTasks: 0,
        trustTier: 1,
        skills: [],
        location: undefined,  // no location → proximity=0.5 to keep score below 0.30
      });

      const result = await MatchmakerAIService.rankCandidates(makeTask(), [weakCandidate]);

      expect(result.success).toBe(true);
      expect((result as any).data.find((c: any) => c.userId === 'weak')).toBeUndefined();
    });

    it('limits results to max 10 candidates', async () => {
      // 15 strong candidates
      const candidates = Array.from({ length: 15 }, (_, i) =>
        makeCandidate({ userId: `user-${i}`, skills: ['delivery'], trustTier: 3 })
      );

      const result = await MatchmakerAIService.rankCandidates(makeTask(), candidates);

      expect(result.success).toBe(true);
      expect((result as any).data.length).toBeLessThanOrEqual(10);
    });

    it('skills overlap boosts skill score — delivery candidate ranks higher than cooking', async () => {
      const deliveryCandidate = makeCandidate({ userId: 'delivery-user', skills: ['delivery'] });
      const cookingCandidate = makeCandidate({ userId: 'cooking-user', skills: ['cooking'] });

      const result = await MatchmakerAIService.rankCandidates(
        makeTask({ title: 'Deliver package', category: 'delivery' }),
        [cookingCandidate, deliveryCandidate]
      );

      expect(result.success).toBe(true);
      const ranked = (result as any).data;
      const deliveryIdx = ranked.findIndex((c: any) => c.userId === 'delivery-user');
      const cookingIdx = ranked.findIndex((c: any) => c.userId === 'cooking-user');
      // delivery candidate should be ranked higher (lower index = higher rank)
      if (deliveryIdx !== -1 && cookingIdx !== -1) {
        expect(deliveryIdx).toBeLessThan(cookingIdx);
      }
    });

    it('sets rank starting from 1', async () => {
      const result = await MatchmakerAIService.rankCandidates(
        makeTask(),
        [makeCandidate({ userId: 'u1' })]
      );

      expect(result.success).toBe(true);
      if ((result as any).data.length > 0) {
        expect((result as any).data[0].rank).toBe(1);
      }
    });

    it('candidate with no skills gets neutral skill score (0.5) and may still pass threshold', async () => {
      // skills=[] → skillOverlap=0.5 (neutral), with location and good completionRate should pass
      const noSkillsCandidate = makeCandidate({
        userId: 'no-skills',
        skills: [],
        completionRate: 0.95,
        trustTier: 3,
        isAvailable: true,
      });

      const result = await MatchmakerAIService.rankCandidates(makeTask(), [noSkillsCandidate]);

      // matchScore = 0.5*0.30 + 0.7*0.20 + (0.95*0.7+0.5*0.3)*0.25 + (3/4)*0.15 + 1*0.10
      //           = 0.15 + 0.14 + ~0.22 + 0.1125 + 0.10 = ~0.72 — passes threshold
      expect(result.success).toBe(true);
      expect((result as any).data.find((c: any) => c.userId === 'no-skills')).toBeDefined();
    });

    it('available candidate beats unavailable one when all else is equal', async () => {
      const availableCandidate = makeCandidate({ userId: 'avail', isAvailable: true });
      const unavailableCandidate = makeCandidate({ userId: 'unavail', isAvailable: false });

      const result = await MatchmakerAIService.rankCandidates(
        makeTask(),
        [unavailableCandidate, availableCandidate]
      );

      expect(result.success).toBe(true);
      const ranked = (result as any).data;
      const availIdx = ranked.findIndex((c: any) => c.userId === 'avail');
      const unavailIdx = ranked.findIndex((c: any) => c.userId === 'unavail');
      if (availIdx !== -1 && unavailIdx !== -1) {
        expect(availIdx).toBeLessThan(unavailIdx);
      }
    });

    it('returns error on unexpected exception', async () => {
      // Pass null as candidates to cause a TypeError inside the service
      const result = await MatchmakerAIService.rankCandidates(makeTask(), null as any);

      expect(result.success).toBe(false);
      expect((result as any).error.code).toBe('RANK_CANDIDATES_FAILED');
    });
  });

  // ==========================================================================
  // explainMatch
  // ==========================================================================
  describe('explainMatch', () => {
    it('returns deterministic explanation when AI not configured', async () => {
      const result = await MatchmakerAIService.explainMatch(makeTask(), makeCandidate());

      expect(result.success).toBe(true);
      expect(typeof (result as any).data.summary).toBe('string');
      expect((result as any).data.summary.toLowerCase()).toMatch(/good fit|delivery/i);
      expect(Array.isArray((result as any).data.factors)).toBe(true);
      expect((result as any).data.factors.length).toBeGreaterThanOrEqual(1);
      // estimatedEarnings = round(3000 * 0.85) = 2550
      expect((result as any).data.estimatedEarnings).toBe(2550);
    });

    it('includes skill alignment in factors when worker has skills', async () => {
      const result = await MatchmakerAIService.explainMatch(
        makeTask(),
        makeCandidate({ skills: ['delivery'] })
      );

      expect(result.success).toBe(true);
      const factors: string[] = (result as any).data.factors;
      expect(factors.some((f) => /delivery/i.test(f))).toBe(true);
    });

    it('includes completion rate in factors when >= 90%', async () => {
      const result = await MatchmakerAIService.explainMatch(
        makeTask(),
        makeCandidate({ completionRate: 0.95 })
      );

      expect(result.success).toBe(true);
      const factors: string[] = (result as any).data.factors;
      expect(factors.some((f) => /completion/i.test(f) || /90/.test(f) || /95/.test(f))).toBe(true);
    });

    it('includes trust tier priority in factors when trustTier >= 3', async () => {
      const result = await MatchmakerAIService.explainMatch(
        makeTask(),
        makeCandidate({ trustTier: 3 })
      );

      expect(result.success).toBe(true);
      const factors: string[] = (result as any).data.factors;
      expect(factors.some((f) => /trust tier|priority/i.test(f))).toBe(true);
    });

    it('returns short duration string for low-price tasks (< 60 min)', async () => {
      // price: 1500 → durationMinutes = round(15 * 2.5) = 38 → "38-53 min"
      const result = await MatchmakerAIService.explainMatch(
        makeTask({ price: 1500 }),
        makeCandidate()
      );

      expect(result.success).toBe(true);
      expect((result as any).data.estimatedDuration).toMatch(/\d+.*min/);
    });

    it('returns hour duration string for high-price tasks', async () => {
      // price: 6000 → durationMinutes = round(60 * 2.5) = 150 → "2-3 hours"
      const result = await MatchmakerAIService.explainMatch(
        makeTask({ price: 6000 }),
        makeCandidate()
      );

      expect(result.success).toBe(true);
      expect((result as any).data.estimatedDuration).toMatch(/hour/i);
    });
  });

  // ==========================================================================
  // suggestPrice
  // ==========================================================================
  describe('suggestPrice', () => {
    it('returns price for delivery category', async () => {
      // delivery: base=2500, confidence=0.65+0.10=0.75 >= 0.70 → immediate heuristic return
      const result = await MatchmakerAIService.suggestPrice(
        'Deliver a package across town',
        'delivery'
      );

      expect(result.success).toBe(true);
      expect((result as any).data.suggested_price_cents).toBe(2500);
      // range_low = max(1500, round(2500*0.75)) = max(1500, 1875) = 1875
      expect((result as any).data.range_low_cents).toBe(1875);
      // range_high = min(50000, round(2500*1.25)) = 3125
      expect((result as any).data.range_high_cents).toBe(3125);
    });

    it('applies urgency premium +40% for urgent tasks', async () => {
      // delivery base=2500, urgent → 2500 * 1.4 = 3500
      const result = await MatchmakerAIService.suggestPrice(
        'urgent delivery needed asap',
        'delivery'
      );

      expect(result.success).toBe(true);
      expect((result as any).data.suggested_price_cents).toBe(3500);
    });

    it('applies heavy lifting premium +30%', async () => {
      // moving base=8000, heavy → 8000 * 1.3 = 10400
      const result = await MatchmakerAIService.suggestPrice(
        'move heavy furniture upstairs',
        'moving'
      );

      expect(result.success).toBe(true);
      expect((result as any).data.suggested_price_cents).toBe(10400);
    });

    it('applies extended scope premium +50%', async () => {
      // cleaning base=4000, multiple → 4000 * 1.5 = 6000
      const result = await MatchmakerAIService.suggestPrice(
        'clean multiple rooms all day',
        'cleaning'
      );

      expect(result.success).toBe(true);
      expect((result as any).data.suggested_price_cents).toBe(6000);
    });

    it('applies both urgency and heavy premiums stacked', async () => {
      // moving base=8000, urgent → 8000*1.4=11200, heavy → 11200*1.3=14560
      const result = await MatchmakerAIService.suggestPrice(
        'urgent move heavy furniture',
        'moving'
      );

      expect(result.success).toBe(true);
      expect((result as any).data.suggested_price_cents).toBe(14560);
    });

    it('range_low is at least minimum $15 (1500 cents)', async () => {
      const result = await MatchmakerAIService.suggestPrice(
        'general task',
        'general'
      );

      expect(result.success).toBe(true);
      expect((result as any).data.range_low_cents).toBeGreaterThanOrEqual(1500);
    });

    it('range_high does not exceed maximum $500 (50000 cents)', async () => {
      // Use handyman (10000) + urgent (1.4) + heavy (1.3) + multiple (1.5): would be huge
      const result = await MatchmakerAIService.suggestPrice(
        'urgent move heavy furniture multiple rooms all day this week asap please rush order needed immediately for new home setup full house clearance',
        'handyman'
      );

      expect(result.success).toBe(true);
      expect((result as any).data.range_high_cents).toBeLessThanOrEqual(50000);
    });

    it('returns lower confidence for short descriptions', async () => {
      // description: 'quick' (5 chars) — length < 30 → confidence -= 0.15
      // unknown category → no +0.10 → base=0.65-0.15=0.50 < 0.70 (fallback heuristic)
      const result = await MatchmakerAIService.suggestPrice('quick', undefined);

      expect(result.success).toBe(true);
      // Confidence should be below HEURISTIC_CONFIDENCE_THRESHOLD (0.70)
      expect((result as any).data.confidence).toBeLessThan(0.70);
    });
  });

  // ==========================================================================
  // _rankDeterministic (internal, but accessible via the service object)
  // ==========================================================================
  describe('_rankDeterministic', () => {
    it('returns empty array for empty candidates', () => {
      const result = MatchmakerAIService._rankDeterministic(makeTask(), []);
      expect(result).toEqual([]);
    });

    it('handles candidate with no location (proximity defaults to 0.5)', () => {
      const candidate = makeCandidate({ location: undefined });
      const result = MatchmakerAIService._rankDeterministic(makeTask(), [candidate]);

      // proximity=0.5 when no location
      if (result.length > 0) {
        expect(result[0].factors.proximity).toBe(0.50);
      }
    });
  });
});
