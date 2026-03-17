/**
 * RED-TEAM ATTACK: Pricing Abuse & Multiplier Exploitation
 *
 * Probes every exploitable surface in ScoperAIService / TaskTemplateRegistry:
 *   - Multiplier stacking and the 50% cap
 *   - Constitutional cap ($500) before and after multipliers
 *   - Deception override order-of-operations
 *   - Genuine-bizarre cap order-of-operations
 *   - Non-wildcard template pricing
 *   - Zero / negative / null / overflow edge cases
 *   - XP edge cases
 *   - Confidence score edge cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScoperAIService } from '../../src/services/ScoperAIService.js';
import { TEMPLATE_SLUGS, applyWildcardMultipliers, WILDCARD_MULTIPLIERS } from '../../src/services/TaskTemplateRegistry.js';
import type { ComplianceResult } from '../../src/services/ComplianceGuardianService.js';

// ─── DB mock (ScoperAIService.logDecision uses it) ───────────────────────────
vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn() },
}));

// ─── AIClient mock factory ────────────────────────────────────────────────────
// We need to swap between "AI not configured" (heuristic path) and
// "AI configured + returns specific price" (AI path) per test.
const mockCallJSON = vi.fn();
const mockIsConfigured = vi.fn();

vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: {
    isConfigured: () => mockIsConfigured(),
    callJSON:     (...args: unknown[]) => mockCallJSON(...args),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Compliance result where AI fully ran, task is bizarrely genuine, no deception. */
function bizarreClean(overrides: Partial<ComplianceResult> = {}): ComplianceResult {
  return {
    score: 5,
    tier: 'clean',
    triggeredRules: [],
    deception_detected: false,
    is_genuinely_bizarre: true,
    ai_signals_computed: true,
    notes: {
      score: 5,
      tier: 'clean',
      triggered_rules: [],
      suggested_alternative: null,
      admin_review_id: null,
      appeal_status: 'none',
      deception_detected: false,
      is_genuinely_bizarre: true,
      ai_signals_computed: true,
    },
    ...overrides,
  };
}

/** Build a minimal valid AI-style proposal that passes _validateProposal. */
function makeAIProposal(overrides: Partial<{
  suggested_price_cents: number;
  suggested_xp: number;
  confidence_score: number;
  difficulty: 'easy' | 'medium' | 'hard';
  price_reasoning: string;
}> = {}) {
  const price = overrides.suggested_price_cents ?? 6000;
  const xp    = overrides.suggested_xp ?? Math.round(price / 10);
  const difficulty =
    overrides.difficulty ??
    (price <= 5000 ? 'easy' : price <= 15000 ? 'medium' : 'hard');

  return {
    data: {
      suggested_price_cents: price,
      price_reasoning: overrides.price_reasoning ?? 'Adequate rate for complexity and market demand',
      suggested_xp: xp,
      xp_reasoning: 'Standard XP calculation',
      difficulty,
      difficulty_reasoning: 'Matches price tier',
      confidence_score: overrides.confidence_score ?? 0.85,
      flags: ['bizarre_custom'],
      estimated_duration_minutes: 120,
      required_capabilities: [],
    },
    provider: 'openai',
  };
}

/** Convenience: run analyzeTaskScope with AI mocked to return a specific price. */
async function runWithAIPrice(
  priceCents: number,
  extra: {
    templateSlug?: string;
    wildcardFlags?: string[];
    complianceResult?: ComplianceResult;
    xp?: number;
    confidence?: number;
    difficulty?: 'easy' | 'medium' | 'hard';
  } = {}
) {
  mockIsConfigured.mockReturnValue(true);
  mockCallJSON.mockResolvedValue(
    makeAIProposal({
      suggested_price_cents: priceCents,
      suggested_xp: extra.xp ?? Math.round(priceCents / 10),
      confidence_score: extra.confidence ?? 0.85,
      difficulty: extra.difficulty,
    })
  );

  return ScoperAIService.analyzeTaskScope({
    description: 'Red-team probe — exotic custom task',
    templateSlug: extra.templateSlug ?? TEMPLATE_SLUGS.WILDCARD_BIZARRE,
    wildcardFlags: extra.wildcardFlags ?? [],
    complianceResult: extra.complianceResult,
  });
}

/** Convenience: run using the heuristic path (no AI). */
async function runHeuristic(extra: {
  templateSlug?: string;
  wildcardFlags?: string[];
  complianceResult?: ComplianceResult;
  description?: string;
} = {}) {
  mockIsConfigured.mockReturnValue(false);

  return ScoperAIService.analyzeTaskScope({
    description: extra.description ?? 'Heuristic probe task',
    templateSlug: extra.templateSlug,
    wildcardFlags: extra.wildcardFlags ?? [],
    complianceResult: extra.complianceResult,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConfigured.mockReturnValue(false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — MULTIPLIER STACKING
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-1 — Multiplier stacking: all 6 flags at once', () => {
  const ALL_FLAGS = [
    'costume_or_attire_flag',   // 0.10
    'travel_over_30min_flag',   // 0.20
    'private_location_flag',    // 0.15
    'audience_present_flag',    // 0.10
    'props_required_flag',      // 0.10
    'performance_element_flag', // 0.20
  ];
  // Totals 0.85 raw → capped at 0.50

  it('ATTACK-1a: cap clamps 85% raw premium to 50% max', async () => {
    // base $60 (6000 cents)
    // uncapped: 6000 * 1.85 = 11100
    // capped at 50%: 6000 * 1.50 = 9000
    const result = await runWithAIPrice(6000, {
      wildcardFlags: ALL_FLAGS,
      complianceResult: bizarreClean(),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const price = result.data.suggested_price_cents;

    // VERDICT: should be exactly 9000 — not 11100 (uncapped) and not 6000 (no multipliers)
    expect(price).toBe(9000);
  });

  it('ATTACK-1b: unit-level applyWildcardMultipliers math is correct', () => {
    const base = 6000;
    const result = applyWildcardMultipliers(base, [
      'costume_or_attire_flag',
      'travel_over_30min_flag',
      'private_location_flag',
      'audience_present_flag',
      'props_required_flag',
      'performance_element_flag',
    ]);

    // Raw sum: 0.10+0.20+0.15+0.10+0.10+0.20 = 0.85 → cap 0.50 → 6000 * 1.50 = 9000
    expect(result).toBe(9000);
  });

  it('ATTACK-1c: 50% cap fires BEFORE constitutional $500 cap (base $60 → $90, not $500)', async () => {
    // base $60 → after 50% cap → $90 — constitutional cap ($500) must NOT replace the 50% cap
    const result = await runWithAIPrice(6000, {
      wildcardFlags: ALL_FLAGS,
      complianceResult: bizarreClean(),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.suggested_price_cents).toBe(9000);
    // Absolutely must not be $500 (50000)
    expect(result.data.suggested_price_cents).not.toBe(50000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — CONSTITUTIONAL CAP ABUSE ($500 = 50000 cents)
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-2 — Constitutional cap ($500) abuse', () => {
  it('ATTACK-2a: AI returning $600 base is REJECTED before multipliers even run', async () => {
    // $600 (60000 cents) violates Rule 1 — _validateProposal should block it
    const result = await runWithAIPrice(60000, {
      wildcardFlags: ['performance_element_flag'],
      complianceResult: bizarreClean(),
    });

    // Expect a validation failure — price above $500 must not pass
    expect(result.success).toBe(false);
    if (result.success) {
      // Bug: accepted a $600 proposal — constitutional cap not enforced pre-multiplier
      const price = result.data.suggested_price_cents;
      // If it somehow passed, it should at least be capped at $500
      expect(price).toBeLessThanOrEqual(50000);
    }
  });

  it('ATTACK-2b: $400 base + all 6 flags → multiplied to $600 pre-cap → clamped to $500 by applyWildcardMultipliers', async () => {
    // base $400 (40000 cents) passes validation
    // after 50%-premium cap: 40000 * 1.50 = 60000 — exceeds $500
    // applyWildcardMultipliers clamps to maxPriceCents=50000
    const ALL_FLAGS = [
      'costume_or_attire_flag',
      'travel_over_30min_flag',
      'private_location_flag',
      'audience_present_flag',
      'props_required_flag',
      'performance_element_flag',
    ];

    const result = await runWithAIPrice(40000, {
      wildcardFlags: ALL_FLAGS,
      complianceResult: bizarreClean(),
      difficulty: 'hard',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Must be clamped to exactly $500 (50000 cents)
    expect(result.data.suggested_price_cents).toBe(50000);
  });

  it('ATTACK-2c: exactly $500 base + any multiplier → stays at $500 (no breach)', async () => {
    const result = await runWithAIPrice(50000, {
      wildcardFlags: ['performance_element_flag'], // +20%
      complianceResult: bizarreClean(),
      difficulty: 'hard',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // 50000 * 1.20 = 60000 — must be clamped back to 50000
    expect(result.data.suggested_price_cents).toBe(50000);
  });

  it('ATTACK-2d: $499 base + performance element (+20%) = $598.80 → clamped to $500', async () => {
    const result = await runWithAIPrice(49900, {
      wildcardFlags: ['performance_element_flag'], // +20%
      complianceResult: bizarreClean(),
      difficulty: 'hard',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // 49900 * 1.20 = 59880 → clamped to 50000
    expect(result.data.suggested_price_cents).toBe(50000);
  });

  it('ATTACK-2e: unit-level — applyWildcardMultipliers clamps to 50000 by default', () => {
    const result = applyWildcardMultipliers(40000, ['travel_over_30min_flag', 'performance_element_flag']);
    // 40000 * 1.40 = 56000 → clamped to 50000
    expect(result).toBe(50000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — DECEPTION OVERRIDE EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-3 — Deception override edge cases', () => {
  it('ATTACK-3a: deception + all 6 flags → all multipliers stripped, price equals pre-multiplier base', async () => {
    const compliance = bizarreClean({ deception_detected: true, is_genuinely_bizarre: true });

    const result = await runWithAIPrice(7500, {
      wildcardFlags: [
        'costume_or_attire_flag',
        'travel_over_30min_flag',
        'private_location_flag',
        'audience_present_flag',
        'props_required_flag',
        'performance_element_flag',
      ],
      complianceResult: compliance,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Deception zeroes all multipliers → must equal the validated base: 7500
    expect(result.data.suggested_price_cents).toBe(7500);
  });

  it('ATTACK-3b: ai_signals_computed=false + deception_detected=true → multipliers NOT stripped', async () => {
    const compliance = bizarreClean({
      deception_detected: true,
      ai_signals_computed: false,
      is_genuinely_bizarre: false,
    });

    const result = await runWithAIPrice(7500, {
      wildcardFlags: ['performance_element_flag', 'audience_present_flag'], // +0.30
      complianceResult: compliance,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Without AI confirmation, deception override must NOT fire.
    // 7500 * 1.30 = 9750; ai_signals_computed=false also means bizarre cap doesn't fire.
    expect(result.data.suggested_price_cents).toBe(9750);
  });

  it('ATTACK-3c: deception with base $50, constitutional cap is $500 — after strip, price is exactly $50 base', async () => {
    const compliance = bizarreClean({ deception_detected: true });

    const result = await runWithAIPrice(5000, {
      wildcardFlags: ['performance_element_flag', 'travel_over_30min_flag'], // +0.40
      complianceResult: compliance,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Deception strip → base 5000. Constitutional cap irrelevant.
    expect(result.data.suggested_price_cents).toBe(5000);
    // Must not be 7000 (with multipliers) or 50000 (cap)
    expect(result.data.suggested_price_cents).not.toBe(7000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — GENUINE BIZARRE CAP EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-4 — Genuine bizarre cap edge cases', () => {
  it('ATTACK-4a: not bizarre + all 6 flags → cap at 1.1x; $60 base → cap $66, multiplied $90 reduced to $66', async () => {
    const compliance = bizarreClean({ is_genuinely_bizarre: false });

    const result = await runWithAIPrice(6000, {
      wildcardFlags: [
        'costume_or_attire_flag',
        'travel_over_30min_flag',
        'private_location_flag',
        'audience_present_flag',
        'props_required_flag',
        'performance_element_flag',
      ],
      complianceResult: compliance,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const cap = Math.round(6000 * 1.1); // 6600
    expect(result.data.suggested_price_cents).toBe(cap);
    // Must be LESS than the uncapped multiplied value (9000)
    expect(result.data.suggested_price_cents).toBeLessThan(9000);
  });

  it('ATTACK-4b: ai_signals_computed=false + is_genuinely_bizarre=false → bizarre cap does NOT apply (full multipliers pass through)', async () => {
    const compliance = bizarreClean({
      ai_signals_computed: false,
      is_genuinely_bizarre: false,
      deception_detected: false,
    });

    const result = await runWithAIPrice(6000, {
      wildcardFlags: ['performance_element_flag', 'travel_over_30min_flag'], // +0.40 → 8400
      complianceResult: compliance,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // cap would be 6600, but ai_signals_computed=false → no cap → 8400
    expect(result.data.suggested_price_cents).toBe(8400);
    expect(result.data.suggested_price_cents).toBeGreaterThan(6600);
  });

  it('ATTACK-4c: not bizarre + $50 base → 1.1x cap = $55, constitutional cap ($500) is irrelevant here', async () => {
    const compliance = bizarreClean({ is_genuinely_bizarre: false });

    const result = await runWithAIPrice(5000, {
      wildcardFlags: ['performance_element_flag', 'travel_over_30min_flag'], // +0.40 → 7000
      complianceResult: compliance,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const cap = Math.round(5000 * 1.1); // 5500
    expect(result.data.suggested_price_cents).toBe(cap);
    expect(result.data.suggested_price_cents).not.toBe(50000);
  });

  it('ATTACK-4d: is_genuinely_bizarre=true AND deception_detected=true → deception override fires first; bizarre cap is moot', async () => {
    // Order of operations in ScoperAIService:
    //   1. applyWildcardMultipliers() → multiplied value
    //   2. deception override → reset to base
    //   3. bizarre cap → only if NOT deception
    // So with deception: result = base (bizarre cap code is skipped by the deception reset already done)
    const compliance = bizarreClean({ is_genuinely_bizarre: true, deception_detected: true });

    const result = await runWithAIPrice(7500, {
      wildcardFlags: ['performance_element_flag', 'audience_present_flag'],
      complianceResult: compliance,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Deception override fires → 7500. Bizarre cap also requires deception_detected=false — so it can't fire.
    expect(result.data.suggested_price_cents).toBe(7500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — NON-WILDCARD TEMPLATE PRICING
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-5 — Non-wildcard template pricing', () => {
  it('ATTACK-5a: in_home template — AI returning price at $500 cap passes validation', async () => {
    // in_home has no wildcard multipliers; constitutional cap still applies
    const result = await runWithAIPrice(50000, {
      templateSlug: TEMPLATE_SLUGS.IN_HOME,
      wildcardFlags: [],
      difficulty: 'hard',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // No wildcard multipliers for in_home — price stays at the validated base
    expect(result.data.suggested_price_cents).toBe(50000);
  });

  it('ATTACK-5b: in_home template — AI returning $501 base (60100 cents) is blocked by validator', async () => {
    const result = await runWithAIPrice(50100, {
      templateSlug: TEMPLATE_SLUGS.IN_HOME,
      wildcardFlags: [],
      difficulty: 'hard',
    });

    // Validator must reject this
    expect(result.success).toBe(false);
  });

  it('ATTACK-5c: care template — autoReleaseHours=0 does not affect pricing; AI price goes through', async () => {
    // care has autoReleaseHours=0 but that is escrow release timing — not a pricing constraint
    const result = await runWithAIPrice(8000, {
      templateSlug: TEMPLATE_SLUGS.CARE,
      wildcardFlags: [],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Price flows through unchanged (no wildcard block for care template)
    expect(result.data.suggested_price_cents).toBe(8000);
  });

  it('ATTACK-5d: specialized_licensed — AI returning $1000/hr rate would be $100/hr = $10000 per session; still capped at $500', async () => {
    // Even specialized_licensed obeys the $500 constitutional cap
    const result = await runWithAIPrice(50000, {
      templateSlug: TEMPLATE_SLUGS.SPECIALIZED_LICENSED,
      wildcardFlags: [],
      difficulty: 'hard',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.suggested_price_cents).toBeLessThanOrEqual(50000);
  });

  it('ATTACK-5e: specialized_licensed — AI returning $50001 is rejected', async () => {
    const result = await runWithAIPrice(50001, {
      templateSlug: TEMPLATE_SLUGS.SPECIALIZED_LICENSED,
      wildcardFlags: [],
      difficulty: 'hard',
    });

    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — ZERO AND NEGATIVE EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-6 — Zero and negative price edge cases', () => {
  it('ATTACK-6a: AI returning $0 (0 cents) is REJECTED — below $15 minimum', async () => {
    const result = await runWithAIPrice(0, {
      difficulty: 'easy',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      // Bug: $0 task accepted
      expect(result.data.suggested_price_cents).toBeGreaterThanOrEqual(1500);
    }
  });

  it('ATTACK-6b: AI returning negative price (-500 cents) is REJECTED — below $15 minimum', async () => {
    const result = await runWithAIPrice(-500, {
      difficulty: 'easy',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      // Bug: negative price accepted
      expect(result.data.suggested_price_cents).toBeGreaterThanOrEqual(1500);
    }
  });

  it('ATTACK-6c: AI returning null suggested_price_cents — handled gracefully (no crash)', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockCallJSON.mockResolvedValue({
      data: {
        suggested_price_cents: null,
        price_reasoning: 'Null price test scenario for edge case validation',
        suggested_xp: 500,
        xp_reasoning: 'XP calc',
        difficulty: 'medium',
        difficulty_reasoning: 'Standard',
        confidence_score: 0.85,
        flags: [],
      },
      provider: 'openai',
    });

    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Null price attack probe task',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
    });

    // Must not throw — either fail gracefully or reject the proposal
    if (result.success) {
      // If accepted, price must be within valid bounds
      expect(result.data.suggested_price_cents).toBeGreaterThanOrEqual(1500);
      expect(result.data.suggested_price_cents).toBeLessThanOrEqual(50000);
    } else {
      // Correctly rejected
      expect(result.success).toBe(false);
    }
  });

  it('ATTACK-6d: AI returning 999999999 (integer overflow territory) — constitutional cap catches it', async () => {
    const result = await runWithAIPrice(999999999, {
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      wildcardFlags: [],
      difficulty: 'hard',
    });

    // Validator Rule 1 must reject this — price above $500
    expect(result.success).toBe(false);
    if (result.success) {
      // If somehow accepted, cap must hold
      expect(result.data.suggested_price_cents).toBeLessThanOrEqual(50000);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — XP EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-7 — XP edge cases', () => {
  it('ATTACK-7a: AI returning suggested_xp=0 — fails ±20% XP tolerance check (expected ~300 for $30)', async () => {
    // Base price $30 (3000 cents) → expected XP = 300 ± 20% (60) → valid range 240–360
    // XP=0 is far outside — should fail SCOPER-ERR-003
    mockIsConfigured.mockReturnValue(true);
    mockCallJSON.mockResolvedValue({
      data: {
        suggested_price_cents: 3000,
        price_reasoning: 'Market rate for basic task, reasonable compensation',
        suggested_xp: 0,
        xp_reasoning: 'Zero XP test',
        difficulty: 'easy',
        difficulty_reasoning: 'Easy tier',
        confidence_score: 0.85,
        flags: [],
      },
      provider: 'openai',
    });

    const result = await ScoperAIService.analyzeTaskScope({
      description: 'XP zero attack test probe scenario',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      // Bug: 0 XP was accepted
      expect(result.data.suggested_xp).toBeGreaterThan(0);
    }
  });

  it('ATTACK-7b: AI returning suggested_xp=-100 — negative XP fails tolerance check', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockCallJSON.mockResolvedValue({
      data: {
        suggested_price_cents: 3000,
        price_reasoning: 'Market rate for basic task, reasonable compensation',
        suggested_xp: -100,
        xp_reasoning: 'Negative XP test',
        difficulty: 'easy',
        difficulty_reasoning: 'Easy tier',
        confidence_score: 0.85,
        flags: [],
      },
      provider: 'openai',
    });

    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Negative XP attack probe test',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      // Bug: negative XP was accepted
      expect(result.data.suggested_xp).toBeGreaterThanOrEqual(0);
    }
  });

  it('ATTACK-7c: AI returning suggested_xp=999999 — wildly out of tolerance, rejected', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockCallJSON.mockResolvedValue({
      data: {
        suggested_price_cents: 3000,
        price_reasoning: 'Market rate for basic task, reasonable compensation',
        suggested_xp: 999999,
        xp_reasoning: 'Overflow XP test',
        difficulty: 'easy',
        difficulty_reasoning: 'Easy tier',
        confidence_score: 0.85,
        flags: [],
      },
      provider: 'openai',
    });

    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Overflow XP attack probe scenario',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      // Bug: 999999 XP was accepted
      const expectedXp = Math.round(3000 / 10);
      const tolerance = expectedXp * 0.20;
      expect(Math.abs(result.data.suggested_xp - expectedXp)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('ATTACK-7d: wildcard multiplier post-processing re-syncs XP to new price', async () => {
    // Base $75 (7500) + travel+performance (0.40) = $105 (10500). XP should sync to 1050.
    const result = await runWithAIPrice(7500, {
      wildcardFlags: ['travel_over_30min_flag', 'performance_element_flag'],
      complianceResult: bizarreClean(),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const expectedPrice = 10500;
    const expectedXp    = Math.round(expectedPrice / 10); // 1050

    expect(result.data.suggested_price_cents).toBe(expectedPrice);
    expect(result.data.suggested_xp).toBe(expectedXp);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — CONFIDENCE SCORE EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-8 — Confidence score edge cases', () => {
  it('ATTACK-8a: confidence_score=0 — below 0.60 threshold → rejected (SCOPER-ERR-004)', async () => {
    const result = await runWithAIPrice(3000, {
      confidence: 0,
      difficulty: 'easy',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      // Bug: zero confidence proposal was accepted
      expect(result.data.confidence_score).toBeGreaterThanOrEqual(0.60);
    }
  });

  it('ATTACK-8b: confidence_score=0.59 — just below 0.60 threshold → rejected', async () => {
    const result = await runWithAIPrice(3000, {
      confidence: 0.59,
      difficulty: 'easy',
    });

    expect(result.success).toBe(false);
  });

  it('ATTACK-8c: confidence_score=0.60 — exactly at threshold → accepted', async () => {
    const result = await runWithAIPrice(3000, {
      confidence: 0.60,
      difficulty: 'easy',
    });

    expect(result.success).toBe(true);
  });

  it('ATTACK-8d: confidence_score=1.5 (above 1.0 maximum) — upper bound validation added, now REJECTED', async () => {
    // FIX: _validateProposal now checks confidence_score > 1.0 in addition to < 0.60.
    // A value of 1.5 must be rejected with SCOPER-ERR-004.
    const result = await runWithAIPrice(3000, {
      confidence: 1.5,
      difficulty: 'easy',
    });

    // Must now be rejected — upper bound of 1.0 enforced
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — APPLYWILDCARDMULTIPLIERS UNIT ATTACK
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-9 — applyWildcardMultipliers unit-level edge cases', () => {
  it('ATTACK-9a: unknown flag names are silently ignored (no extra premium)', () => {
    const result = applyWildcardMultipliers(6000, ['fake_flag', 'hacker_flag', 'overflow_flag']);
    // No matching flags → multiplier = 0 → 6000 * 1.0 = 6000
    expect(result).toBe(6000);
  });

  it('ATTACK-9b: duplicate flags are deduplicated before processing — same as 1 travel flag (0.20x)', () => {
    // FIX: applyWildcardMultipliers now deduplicates flags via Set before summing multipliers.
    // Duplicate travel_over_30min_flag: deduplicated to 1 → 0.20 (not 0.40)
    // 6000 * 1.20 = 7200
    const result = applyWildcardMultipliers(6000, ['travel_over_30min_flag', 'travel_over_30min_flag']);
    expect(result).toBe(7200);
  });

  it('ATTACK-9c: many duplicate flags deduplicated — treated as single flag, no cap needed', () => {
    // FIX: 5× performance_element_flag deduplicated to 1 → multiplier = 0.20 only
    // 6000 * 1.20 = 7200 (not 9000 after cap)
    const result = applyWildcardMultipliers(6000, [
      'performance_element_flag',
      'performance_element_flag',
      'performance_element_flag',
      'performance_element_flag',
      'performance_element_flag',
    ]);
    expect(result).toBe(7200);
  });

  it('ATTACK-9d: empty flags array → no multiplier applied, price unchanged', () => {
    const result = applyWildcardMultipliers(7500, []);
    expect(result).toBe(7500);
  });

  it('ATTACK-9e: custom maxPriceCents override respected', () => {
    // Base 40000, +50% = 60000, but custom cap = 45000
    const result = applyWildcardMultipliers(40000, ['travel_over_30min_flag', 'performance_element_flag'], 45000);
    // 40000 * 1.40 = 56000 → clamped to 45000
    expect(result).toBe(45000);
  });

  it('ATTACK-9f: single maximum multiplier flag (travel=0.20) — correct math', () => {
    const result = applyWildcardMultipliers(10000, ['travel_over_30min_flag']);
    // 10000 * 1.20 = 12000
    expect(result).toBe(12000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — HEURISTIC PATH EDGE CASES (AI not configured)
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-10 — Heuristic path edge cases', () => {
  it('ATTACK-10a: wildcard_bizarre heuristic floor is $75 (7500 cents) for talent template', async () => {
    const result = await runHeuristic({
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      description: 'Some weird custom one-off performance task for a client',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Talent template floor is $75 per heuristic
    expect(result.data.suggested_price_cents).toBeGreaterThanOrEqual(7500);
  });

  it('ATTACK-10b: heuristic wildcard + multipliers + bizarre cap fires correctly', async () => {
    const compliance = bizarreClean({ is_genuinely_bizarre: false });

    const result = await runHeuristic({
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      wildcardFlags: ['performance_element_flag', 'travel_over_30min_flag'],
      complianceResult: compliance,
      description: 'Performative task with travel requirements',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Heuristic base = 7500. Not bizarre → cap at 1.1x = 8250.
    // travel+performance = 0.40 → 7500 * 1.40 = 10500 → capped to 8250.
    expect(result.data.suggested_price_cents).toBeLessThanOrEqual(8250);
  });

  it('ATTACK-10c: heuristic with urgency keyword applies 50% premium before bounds clamping', async () => {
    // Urgency: default $30 * 1.5 = $45 (4500 cents) — within bounds
    const result = await runHeuristic({
      description: 'urgent task needed asap please help',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.flags).toContain('urgent');
    expect(result.data.suggested_price_cents).toBeGreaterThanOrEqual(1500);
    expect(result.data.suggested_price_cents).toBeLessThanOrEqual(50000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — COMPOUND ATTACKS (multi-vector)
// ═══════════════════════════════════════════════════════════════════════════════

describe('ATTACK-11 — Compound attack scenarios', () => {
  it('ATTACK-11a: $500 base + 6 flags + bizarre cap (not bizarre) → cap at 1.1x = $500 (already at max)', async () => {
    // base=50000. Not bizarre → cap = round(50000*1.1) = 55000. But const cap=50000 inside applyWildcardMultipliers.
    // After multipliers: 50000 * 1.50 = 75000 → clamped to 50000.
    // Then bizarre cap: 55000 > 50000 → no change (50000 already <= 55000).
    const compliance = bizarreClean({ is_genuinely_bizarre: false });

    const result = await runWithAIPrice(50000, {
      wildcardFlags: [
        'costume_or_attire_flag',
        'travel_over_30min_flag',
        'private_location_flag',
        'audience_present_flag',
        'props_required_flag',
        'performance_element_flag',
      ],
      complianceResult: compliance,
      difficulty: 'hard',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.suggested_price_cents).toBe(50000);
  });

  it('ATTACK-11b: deception + constitutional-cap-territory base → strip zeroes all multipliers', async () => {
    // base $450 (45000 cents) + all flags (50% cap) = $675 → but deception zeroes → back to $450
    const compliance = bizarreClean({ deception_detected: true });

    const result = await runWithAIPrice(45000, {
      wildcardFlags: [
        'costume_or_attire_flag',
        'travel_over_30min_flag',
        'private_location_flag',
        'audience_present_flag',
        'props_required_flag',
        'performance_element_flag',
      ],
      complianceResult: compliance,
      difficulty: 'hard',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.suggested_price_cents).toBe(45000);
  });

  it('ATTACK-11c: non-wildcard template + wildcardFlags provided → multipliers do NOT apply (wrong template slug)', async () => {
    // ScoperAIService only applies multipliers when templateSlug === WILDCARD_BIZARRE
    const result = await runWithAIPrice(6000, {
      templateSlug: TEMPLATE_SLUGS.IN_HOME,
      wildcardFlags: [
        'costume_or_attire_flag',
        'travel_over_30min_flag',
        'performance_element_flag',
      ],
      complianceResult: bizarreClean(),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // No multipliers for non-wildcard template — price stays at base
    expect(result.data.suggested_price_cents).toBe(6000);
  });
});
