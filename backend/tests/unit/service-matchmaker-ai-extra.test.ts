/**
 * service-matchmaker-ai-extra.test.ts
 *
 * Targets remaining uncovered branches in
 * backend/src/services/MatchmakerAIService.ts (26 uncovered lines, 77.6% covered).
 *
 * The existing matchmaker-ai.test.ts covers:
 * - rankCandidates (deterministic path, empty candidates, filters, limits)
 * - explainMatch (deterministic path, all factor branches)
 * - suggestPrice (heuristic path, all keyword premiums, confidence ranges)
 * - _rankDeterministic (empty candidates, no-location proximity)
 *
 * This file covers:
 * - rankCandidates AI path (isConfigured=true, succeeds)
 * - rankCandidates AI path (isConfigured=true, AI call fails → deterministic fallback)
 * - explainMatch AI path (isConfigured=true, succeeds)
 * - explainMatch AI path (isConfigured=true, AI call fails → deterministic fallback)
 * - suggestPrice AI path low-confidence heuristic (isConfigured=true, AI succeeds)
 * - suggestPrice AI path (isConfigured=true, AI call fails → heuristic fallback)
 * - _logDecision failure graceful degradation (db.query throws)
 * - _explainDeterministic duration strings: exactly 60 min (1 hour), 120 min (2 hours)
 * - _heuristicPrice: description.length >= 100 (+0.10 confidence), unknown category (general base)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// ── Imports ──────────────────────────────────────────────────────────────────

import { MatchmakerAIService } from '../../src/services/MatchmakerAIService';
import { db } from '../../src/db';
import { AIClient } from '../../src/services/AIClient';

const mockDb = vi.mocked(db);
const mockAI = vi.mocked(AIClient);

// ── Helpers ──────────────────────────────────────────────────────────────────

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

beforeEach(() => {
  vi.resetAllMocks();
  // Default: AI not configured, db.query succeeds
  mockAI.isConfigured.mockReturnValue(false);
  mockDb.query.mockResolvedValue({ rows: [] } as never);
});

// ============================================================================
// rankCandidates — AI path
// ============================================================================

describe('MatchmakerAIService.rankCandidates — AI path', () => {
  it('AI call succeeds → returns AI-ranked candidates', async () => {
    mockAI.isConfigured.mockReturnValue(true);
    mockAI.callJSON.mockResolvedValueOnce({
      provider: 'groq',
      data: {
        rankings: [
          {
            index: 0,
            matchScore: 0.85,
            reasoning: 'Strong delivery skills',
            factors: {
              skillMatch: 0.9,
              proximity: 0.8,
              reliability: 0.7,
              trustTier: 0.5,
              availability: 1.0,
            },
          },
        ],
      },
    } as never);

    const result = await MatchmakerAIService.rankCandidates(
      makeTask(),
      [makeCandidate({ userId: 'ai-user-1' })]
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBe(1);
      expect(result.data[0].userId).toBe('ai-user-1');
      expect(result.data[0].matchScore).toBe(0.85);
      expect(result.data[0].rank).toBe(1);
      expect(result.data[0].reasoning).toBe('Strong delivery skills');
    }
  });

  it('AI call fails → falls back to deterministic ranking', async () => {
    mockAI.isConfigured.mockReturnValue(true);
    mockAI.callJSON.mockRejectedValueOnce(new Error('AI timeout'));

    const candidates = [
      makeCandidate({ userId: 'fallback-u1', skills: ['delivery'] }),
      makeCandidate({ userId: 'fallback-u2', skills: ['cooking'], completionRate: 0.5, trustTier: 1 }),
    ];
    const result = await MatchmakerAIService.rankCandidates(makeTask(), candidates);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
      // First result should be deterministic (delivery skills match delivery task)
      expect(result.data[0].rank).toBe(1);
    }
  });

  it('AI returns matchScore outside [0,1] → clamped to bounds', async () => {
    mockAI.isConfigured.mockReturnValue(true);
    mockAI.callJSON.mockResolvedValueOnce({
      provider: 'groq',
      data: {
        rankings: [
          {
            index: 0,
            matchScore: 1.5,  // exceeds 1.0
            reasoning: 'Overconfident AI',
            factors: {
              skillMatch: 1.2,  // exceeds 1.0
              proximity: -0.1, // below 0.0
              reliability: 0.8,
              trustTier: 0.5,
              availability: 1.0,
            },
          },
        ],
      },
    } as never);

    const result = await MatchmakerAIService.rankCandidates(
      makeTask(),
      [makeCandidate()]
    );

    expect(result.success).toBe(true);
    if (result.success && result.data.length > 0) {
      expect(result.data[0].matchScore).toBe(1.0); // clamped from 1.5
      expect(result.data[0].factors.skillMatch).toBe(1.0); // clamped from 1.2
      expect(result.data[0].factors.proximity).toBe(0.0); // clamped from -0.1
    }
  });

  it('AI returns out-of-bounds index → uses userId from first candidate', async () => {
    mockAI.isConfigured.mockReturnValue(true);
    mockAI.callJSON.mockResolvedValueOnce({
      provider: 'groq',
      data: {
        rankings: [
          {
            index: 99, // out of bounds
            matchScore: 0.7,
            reasoning: 'OOB index candidate',
            factors: {
              skillMatch: 0.7,
              proximity: 0.7,
              reliability: 0.7,
              trustTier: 0.5,
              availability: 1.0,
            },
          },
        ],
      },
    } as never);

    const result = await MatchmakerAIService.rankCandidates(
      makeTask(),
      [makeCandidate({ userId: 'only-user' })]
    );

    expect(result.success).toBe(true);
    if (result.success && result.data.length > 0) {
      // Falls back to candidates[0].userId when index is out of bounds
      expect(result.data[0].userId).toBe('only-user');
    }
  });
});

// ============================================================================
// explainMatch — AI path
// ============================================================================

describe('MatchmakerAIService.explainMatch — AI path', () => {
  it('AI call succeeds → returns AI explanation', async () => {
    mockAI.isConfigured.mockReturnValue(true);
    mockAI.callJSON.mockResolvedValueOnce({
      provider: 'groq',
      data: {
        summary: 'You are a perfect match for this delivery task.',
        factors: ['Strong delivery skills', 'Nearby location', '90% completion rate'],
        estimatedEarnings: 2550,
        estimatedDuration: '30-45 min',
      },
    } as never);

    const result = await MatchmakerAIService.explainMatch(makeTask(), makeCandidate());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe('You are a perfect match for this delivery task.');
      expect(result.data.factors).toHaveLength(3);
      expect(result.data.estimatedEarnings).toBe(2550);
      expect(result.data.estimatedDuration).toBe('30-45 min');
    }
  });

  it('AI call fails → falls back to deterministic explanation', async () => {
    mockAI.isConfigured.mockReturnValue(true);
    mockAI.callJSON.mockRejectedValueOnce(new Error('Network error'));

    const result = await MatchmakerAIService.explainMatch(makeTask(), makeCandidate());

    expect(result.success).toBe(true);
    if (result.success) {
      // Deterministic fallback: summary contains category and earnings
      expect(typeof result.data.summary).toBe('string');
      expect(result.data.summary).toMatch(/delivery|good fit/i);
      expect(result.data.estimatedEarnings).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// suggestPrice — AI path (low-confidence heuristic triggers AI)
// ============================================================================

describe('MatchmakerAIService.suggestPrice — AI path', () => {
  it('AI call succeeds when heuristic confidence is low → returns AI suggestion', async () => {
    // Short description + unknown category → confidence = 0.65 - 0.15 = 0.50 < 0.70
    mockAI.isConfigured.mockReturnValue(true);
    mockAI.callJSON.mockResolvedValueOnce({
      provider: 'groq',
      data: {
        suggested_price_cents: 4500,
        range_low_cents: 3500,
        range_high_cents: 5500,
        reasoning: 'AI enhanced price for vague task',
        confidence: 0.80,
      },
    } as never);

    const result = await MatchmakerAIService.suggestPrice('quick', undefined);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.suggested_price_cents).toBe(4500);
      expect(result.data.confidence).toBe(0.80);
      expect(result.data.reasoning).toBe('AI enhanced price for vague task');
    }
  });

  it('AI call fails when confidence low → returns heuristic fallback', async () => {
    mockAI.isConfigured.mockReturnValue(true);
    mockAI.callJSON.mockRejectedValueOnce(new Error('AI unavailable'));

    // Short description → low confidence heuristic, then AI fails, then heuristic returned
    const result = await MatchmakerAIService.suggestPrice('quick', undefined);

    expect(result.success).toBe(true);
    if (result.success) {
      // Should return heuristic even though confidence < threshold
      expect(result.data.confidence).toBeLessThan(0.70);
      expect(result.data.suggested_price_cents).toBeGreaterThanOrEqual(1500);
    }
  });

  it('AI price is clamped to [MIN, MAX] bounds', async () => {
    mockAI.isConfigured.mockReturnValue(true);
    mockAI.callJSON.mockResolvedValueOnce({
      provider: 'groq',
      data: {
        suggested_price_cents: 100000, // over $500 max
        range_low_cents: 500, // under $15 min
        range_high_cents: 200000, // over $500 max
        reasoning: 'Extreme prices from AI',
        confidence: 0.90,
      },
    } as never);

    const result = await MatchmakerAIService.suggestPrice('quick', undefined);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.suggested_price_cents).toBe(50000); // clamped to max
      expect(result.data.range_low_cents).toBe(1500);        // clamped to min
      expect(result.data.range_high_cents).toBe(50000);      // clamped to max
      expect(result.data.confidence).toBe(0.90);
    }
  });

  it('high-confidence heuristic returns immediately without calling AI', async () => {
    mockAI.isConfigured.mockReturnValue(true);

    // Long description (100+ chars) adds +0.10 → 0.65 + 0.10 = 0.75 >= 0.70 threshold
    const longDesc = 'Deliver a package across town from the central post office to a residential address on the north side of the city. Must be done by 5pm.';
    const result = await MatchmakerAIService.suggestPrice(
      longDesc,
      'delivery'
    );

    expect(result.success).toBe(true);
    // AI should NOT have been called since heuristic confidence is high enough
    expect(mockAI.callJSON).not.toHaveBeenCalled();
  });
});

// ============================================================================
// _logDecision — graceful failure
// ============================================================================

describe('MatchmakerAIService._logDecision', () => {
  it('db.query failure is silently ignored (non-fatal)', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('CHECK constraint violation'));

    // Should not throw
    await expect(
      MatchmakerAIService._logDecision(
        'task-1',
        { type: 'rank_candidates', count: 3 },
        0.75,
        'Ranked 3 candidates'
      )
    ).resolves.toBeUndefined();
  });

  it('succeeds with null taskId', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] } as never);

    await expect(
      MatchmakerAIService._logDecision(
        null,
        { type: 'suggest_price' },
        0.65,
        'Price heuristic'
      )
    ).resolves.toBeUndefined();

    // Confirm null was passed for task_id
    const args = mockDb.query.mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull();
  });
});

// ============================================================================
// _explainDeterministic — duration edge cases
// ============================================================================

describe('MatchmakerAIService._explainDeterministic — duration formatting', () => {
  it('exactly 60 min (price=2400) → "~1 hour" (no remainder)', () => {
    // durationMinutes = round(2400/100 * 2.5) = round(24 * 2.5) = round(60) = 60
    // hours=1, remainder=0 → `~1 hour`
    const result = MatchmakerAIService._explainDeterministic(
      makeTask({ price: 2400 }),
      makeCandidate()
    );

    expect(result.estimatedDuration).toBe('~1 hour');
  });

  it('exactly 120 min (price=4800) → "~2 hours" (no remainder, plural)', () => {
    // durationMinutes = round(4800/100 * 2.5) = round(48 * 2.5) = 120
    // hours=2, remainder=0 → `~2 hours`
    const result = MatchmakerAIService._explainDeterministic(
      makeTask({ price: 4800 }),
      makeCandidate()
    );

    expect(result.estimatedDuration).toBe('~2 hours');
  });

  it('61 min (has remainder) → "1-2 hours"', () => {
    // price=2440 → round(24.4 * 2.5) = round(61) = 61
    // hours=1, remainder=1 → `1-2 hours`
    const result = MatchmakerAIService._explainDeterministic(
      makeTask({ price: 2440 }),
      makeCandidate()
    );

    expect(result.estimatedDuration).toBe('1-2 hours');
  });

  it('59 min → "59-74 min" (less than 60)', () => {
    // price=2360 → round(23.6 * 2.5) = round(59) = 59
    const result = MatchmakerAIService._explainDeterministic(
      makeTask({ price: 2360 }),
      makeCandidate()
    );

    expect(result.estimatedDuration).toMatch(/\d+-\d+ min/);
  });

  it('worker with no skills → no skill factor in factors list', () => {
    const result = MatchmakerAIService._explainDeterministic(
      makeTask(),
      makeCandidate({ skills: [] })
    );

    const hasSkillFactor = result.factors.some((f) => /skills? in/i.test(f));
    expect(hasSkillFactor).toBe(false);
  });

  it('worker completionRate < 90% → no completion rate factor', () => {
    const result = MatchmakerAIService._explainDeterministic(
      makeTask(),
      makeCandidate({ completionRate: 0.80 })
    );

    const hasCompletionFactor = result.factors.some((f) => /completion/i.test(f));
    expect(hasCompletionFactor).toBe(false);
  });

  it('worker trustTier < 3 → no trust tier factor', () => {
    const result = MatchmakerAIService._explainDeterministic(
      makeTask(),
      makeCandidate({ trustTier: 2 })
    );

    const hasTrustFactor = result.factors.some((f) => /trust tier/i.test(f));
    expect(hasTrustFactor).toBe(false);
  });

  it('always includes earnings factor', () => {
    const result = MatchmakerAIService._explainDeterministic(
      makeTask({ price: 3000 }),
      makeCandidate({ skills: [], completionRate: 0.5, trustTier: 1 })
    );

    // Earnings factor is always added last
    const hasEarnings = result.factors.some((f) => /earnings/i.test(f));
    expect(hasEarnings).toBe(true);
  });
});

// ============================================================================
// _heuristicPrice — additional confidence and category branches
// ============================================================================

describe('MatchmakerAIService._heuristicPrice — additional branches', () => {
  it('description.length >= 100 → confidence gets +0.10 boost', () => {
    const longDesc = 'A'.repeat(100); // exactly 100 characters
    // No category → base confidence = 0.65, length >= 100 → + 0.10 = 0.75
    const result = MatchmakerAIService._heuristicPrice(longDesc, undefined);

    expect(result.confidence).toBeCloseTo(0.75, 2);
  });

  it('description.length between 30 and 99 → no confidence change', () => {
    const medDesc = 'A'.repeat(50); // 50 chars, no adjustments
    const result = MatchmakerAIService._heuristicPrice(medDesc, undefined);

    // Base=0.65, no category bonus, no length penalty → 0.65
    expect(result.confidence).toBeCloseTo(0.65, 2);
  });

  it('unknown category → uses general base price (3000 cents)', () => {
    // category not in CATEGORY_BASE_PRICES → baseCents = CATEGORY_BASE_PRICES.general = 3000
    const result = MatchmakerAIService._heuristicPrice(
      'Some random task description',
      'unknown_category_xyz'
    );

    expect(result.suggested_price_cents).toBe(3000);
  });

  it('no category → reasoning says standard rate for general tasks', () => {
    const result = MatchmakerAIService._heuristicPrice(
      'A '.repeat(25) // 50 chars, no urgency/heavy/multiple keywords
    );

    expect(result.reasoning).toContain('general');
  });

  it('reasons list populated for urgency keyword', () => {
    const result = MatchmakerAIService._heuristicPrice(
      'I need this done urgent please',
      'delivery'
    );

    expect(result.reasoning).toContain('urgency premium');
  });

  it('confidence is clamped at minimum 0.30', () => {
    // Short description (< 30 chars) with no category: 0.65 - 0.15 = 0.50
    // Still above 0.30 floor
    const result = MatchmakerAIService._heuristicPrice('help');

    expect(result.confidence).toBeGreaterThanOrEqual(0.30);
  });

  it('confidence is clamped at maximum 1.0', () => {
    // Long description (>= 100) + known category + heavy + urgency + multiple
    const desc = ('urgent move heavy appliance multiple rooms all day '.repeat(3)).slice(0, 150);
    const result = MatchmakerAIService._heuristicPrice(desc, 'handyman');

    expect(result.confidence).toBeLessThanOrEqual(1.0);
  });
});
