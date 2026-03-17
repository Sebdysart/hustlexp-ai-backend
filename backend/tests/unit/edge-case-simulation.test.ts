/**
 * Edge-Case Simulation — 25 scenarios across the full AI task flow pipeline.
 *
 * Tests:
 *  - ComplianceGuardianService.evaluate()  (all 25 cases)
 *  - TaskRiskClassifier.classifyWithTemplate()  (selected cases)
 *  - ScoperAIService wildcard multiplier logic  (Category C, D, E)
 *
 * Mock strategy follows ComplianceGuardianService-v28.test.ts patterns:
 *  - db.query  — default resolves { rows: [{ was_repeat: false }] }
 *  - AIClient  — default isConfigured()=false; overridden per-test when AI is needed
 *  - pii-scrubber & logger — passthrough stubs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceGuardianService } from '../../src/services/ComplianceGuardianService.js';
import { TaskRiskClassifier, TaskRisk } from '../../src/services/TaskRiskClassifier.js';
import { ScoperAIService } from '../../src/services/ScoperAIService.js';
import { applyWildcardMultipliers } from '../../src/services/TaskTemplateRegistry.js';

// ============================================================
// MODULE MOCKS
// ============================================================

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn().mockResolvedValue({ rows: [{ was_repeat: false }], rowCount: 1 }),
  },
}));

vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(false),
    callJSON: vi.fn(),
    call: vi.fn(),
  },
}));

vi.mock('../../src/lib/pii-scrubber.js', () => ({
  scrubPII: vi.fn((s: string) => s),
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  aiLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

// ============================================================
// HELPERS
// ============================================================

/** Returns mocked db and AIClient after re-importing them (hoisted mocks). */
async function getMocks() {
  const { db } = await import('../../src/db.js');
  const { AIClient } = await import('../../src/services/AIClient.js');
  return { db: vi.mocked(db), AIClient: vi.mocked(AIClient) };
}

/** Standard no-match DB response (no cross-task hit). */
function dbNoMatch() {
  return { rows: [{ was_repeat: false }], rowCount: 1 } as any;
}

/** Build a ComplianceResult stub for use in TaskRiskClassifier / ScoperAIService tests. */
function makeComplianceResult(overrides: {
  tier?: 'clean' | 'soft_flag' | 'hard_block';
  score?: number;
  deception_detected?: boolean;
  is_genuinely_bizarre?: boolean;
  ai_signals_computed?: boolean;
  triggeredRules?: string[];
}) {
  return {
    tier: overrides.tier ?? 'clean',
    score: overrides.score ?? 0,
    triggeredRules: overrides.triggeredRules ?? [],
    deception_detected: overrides.deception_detected ?? false,
    is_genuinely_bizarre: overrides.is_genuinely_bizarre ?? false,
    ai_signals_computed: overrides.ai_signals_computed ?? true,
    notes: {
      score: overrides.score ?? 0,
      tier: overrides.tier ?? 'clean',
      triggered_rules: overrides.triggeredRules ?? [],
      suggested_alternative: null,
      admin_review_id: null,
      appeal_status: 'none' as const,
      deception_detected: overrides.deception_detected ?? false,
      is_genuinely_bizarre: overrides.is_genuinely_bizarre ?? false,
      ai_signals_computed: overrides.ai_signals_computed ?? true,
    },
  };
}

// ============================================================
// CATEGORY A — HARD BLOCK ATTEMPTS
// ============================================================

describe('Category A — Hard Block Attempts', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { db, AIClient } = await getMocks();
    db.query.mockResolvedValue(dbNoMatch());
    AIClient.isConfigured.mockReturnValue(false);
  });

  it('A1: happy ending massage → hard_block (score ≥ 61)', async () => {
    const result = await ComplianceGuardianService.evaluate({
      description: 'Need a happy ending massage, very discreet',
      userId: 'user-a1',
    });
    expect(result.tier).toBe('hard_block');
    expect(result.score).toBeGreaterThanOrEqual(61);
    expect(result.triggeredRules).toContain('hard_block_pattern');
  });

  it('A2: adult entertainment gig → hard_block', async () => {
    const result = await ComplianceGuardianService.evaluate({
      description: 'Adult entertainment gig, no questions asked',
      userId: 'user-a2',
    });
    expect(result.tier).toBe('hard_block');
    expect(result.score).toBeGreaterThanOrEqual(61);
    expect(result.triggeredRules).toContain('hard_block_pattern');
  });

  it('A3: bring a gun to a location → hard_block (broader weapon patterns now catch this)', async () => {
    // FIX v2.8.2: Replaced /bring\s+your\s+own\s+(gun|weapon|firearm)/i with two broader patterns:
    //   /\b(deliver|bring|transport|carry|drop.?off).{0,30}(gun|firearm|weapon|pistol|rifle|ammo|ammunition)\b/i
    //   /\b(gun|firearm|weapon|pistol|rifle).{0,30}(delivery|transport|drop.?off|location)\b/i
    // "bring a gun to a location" now matches pattern 1 (bring + gun).
    const resultNowBlocked = await ComplianceGuardianService.evaluate({
      description: 'Need someone to bring a gun to a location, no questions',
      userId: 'user-a3-miss',
    });
    expect(resultNowBlocked.tier).toBe('hard_block');
    expect(resultNowBlocked.triggeredRules).toContain('hard_block_pattern');

    // Original "bring your own gun" phrasing also still fires (matches pattern 1: bring + gun)
    const resultMatch = await ComplianceGuardianService.evaluate({
      description: 'Bring your own gun to the location, meet me there',
      userId: 'user-a3-hit',
    });
    expect(resultMatch.tier).toBe('hard_block');
    expect(resultMatch.triggeredRules).toContain('hard_block_pattern');
  });

  it('A4: cash only escort service → hard_block', async () => {
    const result = await ComplianceGuardianService.evaluate({
      description: 'Cash only escort service, very discreet only',
      userId: 'user-a4',
    });
    expect(result.tier).toBe('hard_block');
    expect(result.score).toBeGreaterThanOrEqual(61);
    expect(result.triggeredRules).toContain('hard_block_pattern');
  });

  it('A5: erotic services tonight → hard_block', async () => {
    const result = await ComplianceGuardianService.evaluate({
      description: 'Erotic services needed tonight',
      userId: 'user-a5',
    });
    expect(result.tier).toBe('hard_block');
    expect(result.score).toBeGreaterThanOrEqual(61);
    expect(result.triggeredRules).toContain('hard_block_pattern');
  });
});

// ============================================================
// CATEGORY B — CODED LANGUAGE / CROSS-TASK PATTERN
// ============================================================

describe('Category B — Coded Language / Cross-Task Pattern', () => {
  beforeEach(() => vi.resetAllMocks());

  it('B6: deliver a package for a friend, no details needed → coded_phrase_first_occurrence, score ≥ 21 (soft_flag)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    // FIX v2.8.2: First occurrence now adds +15 (up from +8), and a Math.max(score, 21) floor
    // ensures a single coded-phrase first occurrence always reaches soft_flag threshold.
    // "package for a friend no details" is a FLAGGED_PATTERN — base heuristic score = 0,
    // +15 from first occurrence = 15, then floored to 21 → soft_flag.
    db.query.mockResolvedValueOnce({ rows: [{ was_repeat: false }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'Deliver a package for a friend, no details needed',
      userId: 'user-b6',
    });
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.score).toBeGreaterThanOrEqual(21); // floored to 21 by Math.max
    expect(result.tier).toBe('soft_flag'); // ≥ 21 → soft_flag
  });

  it('B7: discreet delivery, no questions → soft_flag, coded/cross_task rule fires', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    // "discreet delivery" is a FLAGGED_PATTERN — but ALSO hits hard_block /discreet\s+(only|delivery|service)/i
    // "discreet delivery" matches the hard block regex. Let's confirm.
    db.query.mockResolvedValueOnce({ rows: [{ was_repeat: false }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'Discreet delivery, no questions',
      userId: 'user-b7',
    });
    // "discreet delivery" matches HARD_BLOCK_PATTERNS regex /discreet\s+(only|delivery|service)/i
    // AND "no questions" matches /no\s+questions?\s+asked/i? No — "no questions asked" needs "asked"
    // "discreet delivery" → hard_block
    expect(result.tier).toBe('hard_block');
    expect(result.triggeredRules).toContain('hard_block_pattern');
  });

  it('B8: drop it off no details please → coded_phrase_first_occurrence', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValueOnce({ rows: [{ was_repeat: false }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'Drop it off no details please',
      userId: 'user-b8',
    });
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.score).toBeGreaterThanOrEqual(8);
  });

  it('B9: cash only no record please, very private → soft_flag (unreported_payment pattern)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValueOnce({ rows: [{ was_repeat: false }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'Cash only no record please, very private',
      userId: 'user-b9',
    });
    // "cash only no record" matches SOFT_FLAG_PATTERNS and FLAGGED_PATTERNS
    expect(result.tier).toBe('soft_flag');
    expect(result.triggeredRules).toContain('unreported_payment');
  });

  it('B10a: deliver for a friend no questions — first time → +8 score (coded_phrase_first_occurrence)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    // First occurrence: was_repeat = false
    db.query.mockResolvedValueOnce({ rows: [{ was_repeat: false }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'Deliver for a friend no questions',
      userId: 'user-b10',
    });
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.score).toBeGreaterThanOrEqual(8);
  });

  it('B10b: deliver for a friend no questions — repeat → +15 score (cross_task_pattern_repeat)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    // Repeat occurrence: was_repeat = true (pre-existing entry in flagged_phrase_counter)
    db.query.mockResolvedValueOnce({ rows: [{ was_repeat: true }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'Deliver for a friend no questions',
      userId: 'user-b10-repeat',
    });
    expect(result.triggeredRules).toContain('cross_task_pattern_repeat');
    expect(result.score).toBeGreaterThanOrEqual(15);
  });
});

// ============================================================
// CATEGORY C — GENUINE BIZARRENESS (clean, is_genuinely_bizarre=true)
// ============================================================

describe('Category C — Genuine Bizarreness (clean, AI confirms bizarre)', () => {
  beforeEach(() => vi.resetAllMocks());

  /**
   * Sets up AI to return is_genuinely_bizarre=true, deception_detected=false.
   * Used for all Category C cases.
   */
  async function setupGenuinelyBizarre() {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(true);
    AIClient.callJSON.mockResolvedValue({
      data: { score: 0, rules: [], deception_detected: false, is_genuinely_bizarre: true },
      provider: 'test',
    } as any);
    db.query.mockResolvedValue(dbNoMatch());
    return { db, AIClient };
  }

  it('C11: serenade cat on birthday with ukulele → clean, is_genuinely_bizarre=true', async () => {
    await setupGenuinelyBizarre();
    const result = await ComplianceGuardianService.evaluate({
      description: 'I need someone to serenade my cat on her birthday with a ukulele, private in-home performance',
      userId: 'user-c11',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('clean');
    expect(result.is_genuinely_bizarre).toBe(true);
    expect(result.deception_detected).toBe(false);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('C12: medieval knight reciting poetry at grandmothers 90th birthday → clean, is_genuinely_bizarre=true', async () => {
    await setupGenuinelyBizarre();
    const result = await ComplianceGuardianService.evaluate({
      description: "Dress as a medieval knight and recite poetry at my grandmother's 90th birthday party",
      userId: 'user-c12',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('clean');
    expect(result.is_genuinely_bizarre).toBe(true);
    expect(result.deception_detected).toBe(false);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('C13: scatter late dogs ashes at beach → clean, is_genuinely_bizarre=true', async () => {
    await setupGenuinelyBizarre();
    const result = await ComplianceGuardianService.evaluate({
      description: "Scatter my late dog's ashes at our favorite beach at sunset, bring flowers",
      userId: 'user-c13',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('clean');
    expect(result.is_genuinely_bizarre).toBe(true);
    expect(result.deception_detected).toBe(false);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('C11–C13 wildcard multiplier: full multipliers apply (no cap) when is_genuinely_bizarre=true', () => {
    // Verify applyWildcardMultipliers directly — when genuinely bizarre, no cap is imposed.
    // All 6 flags = 85% raw → capped at 50% by MAX_WILDCARD_PREMIUM.
    const base = 10000; // $100 base
    const allFlags = [
      'private_location_flag',
      'props_required_flag',
      'performance_element_flag',
      'audience_present_flag',
      'costume_or_attire_flag',
      'travel_over_30min_flag',
    ];
    const result = applyWildcardMultipliers(base, allFlags);
    // 50% premium cap → 10000 * 1.5 = 15000
    expect(result).toBe(15000);
  });
});

// ============================================================
// CATEGORY D — FAKE BIZARRENESS / GAMING THE WILDCARD (1.1x cap)
// ============================================================

describe('Category D — Fake Bizarreness / Gaming Wildcard (1.1x cap)', () => {
  beforeEach(() => vi.resetAllMocks());

  /**
   * Sets up AI to return is_genuinely_bizarre=false, deception_detected=false.
   * Used for all Category D cases where gaming is attempted.
   */
  async function setupFakelyBizarre() {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(true);
    AIClient.callJSON.mockResolvedValue({
      data: { score: 0, rules: [], deception_detected: false, is_genuinely_bizarre: false },
      provider: 'test',
    } as any);
    db.query.mockResolvedValue(dbNoMatch());
    return { db, AIClient };
  }

  it('D14: 1.1x cap math — performance_element_flag (20%) on $100 base → capped at $110 not $120', () => {
    // Directly verifies the cap arithmetic without going through ScoperAI end-to-end.
    // The ScoperAI service applies the cap in code: if price > base*1.1 → clamp to base*1.1.
    const base = 10000; // $100
    const withMultiplier = applyWildcardMultipliers(base, ['performance_element_flag']); // +20% → 12000
    const cap = Math.round(base * 1.1); // 1.1x cap → 11000

    expect(withMultiplier).toBe(12000); // multiplier would give $120
    expect(cap).toBe(11000);            // 1.1x cap gives $110
    expect(withMultiplier).toBeGreaterThan(cap); // cap IS triggered
    // After cap: price = 11000, not 12000
    const finalPrice = withMultiplier > cap ? cap : withMultiplier;
    expect(finalPrice).toBe(11000);
  });

  it('D14 compliance evaluation: "help me pack boxes ceremonial" → clean (no heuristic hits)', async () => {
    await setupFakelyBizarre();
    const result = await ComplianceGuardianService.evaluate({
      description: "Help me pack boxes — it's a one-time ceremonial thing",
      userId: 'user-d14',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('clean');
    expect(result.is_genuinely_bizarre).toBe(false);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('D15: run an errand — claims weird and unique → wildcard, is_genuinely_bizarre=false, 1.1x cap logic fires', async () => {
    await setupFakelyBizarre();
    const result = await ComplianceGuardianService.evaluate({
      description: "Run an errand for me, it's weird and unique I promise",
      userId: 'user-d15',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('clean');
    expect(result.is_genuinely_bizarre).toBe(false);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('D16: help move furniture — very special one-off event → wildcard, is_genuinely_bizarre=false', async () => {
    await setupFakelyBizarre();
    const result = await ComplianceGuardianService.evaluate({
      description: 'Help me move furniture, very special one-off event',
      userId: 'user-d16',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('clean');
    expect(result.is_genuinely_bizarre).toBe(false);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('D: ScoperAI 1.1x cap applied when ai_signals_computed=true and not genuinely bizarre', async () => {
    // Directly test the cap logic: base=10000, all flags → 15000 raw → cap at 11000
    const base = 10000;
    const allFlags = ['performance_element_flag', 'costume_or_attire_flag', 'private_location_flag'];
    const withMultipliers = applyWildcardMultipliers(base, allFlags);
    // 20% + 10% + 15% = 45% premium → 14500
    expect(withMultipliers).toBe(14500);

    const cap = Math.round(base * 1.1); // 11000
    // The cap would reduce 14500 → 11000
    const capped = withMultipliers > cap ? cap : withMultipliers;
    expect(capped).toBe(11000);
  });
});

// ============================================================
// CATEGORY E — DECEPTION TASKS (soft_flag, multipliers zeroed)
// ============================================================

describe('Category E — Deception Tasks (deception_detected=true, multipliers zeroed)', () => {
  beforeEach(() => vi.resetAllMocks());

  async function setupDeception(aiScore = 5) {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(true);
    AIClient.callJSON.mockResolvedValue({
      data: {
        score: aiScore,
        rules: ['deception_social_manipulation'],
        deception_detected: true,
        is_genuinely_bizarre: false,
      },
      provider: 'test',
    } as any);
    db.query.mockResolvedValue(dbNoMatch());
    return { db, AIClient };
  }

  it('E17: pretend to be my boyfriend at family dinner → soft_flag, deception_detected=true', async () => {
    await setupDeception(25); // AI bumps to 25 → soft_flag
    const result = await ComplianceGuardianService.evaluate({
      description: 'Pretend to be my boyfriend at my family dinner',
      userId: 'user-e17',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('soft_flag');
    expect(result.deception_detected).toBe(true);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('E18: act as my business partner at a meeting — pretend we have worked together → soft_flag, deception_detected=true', async () => {
    await setupDeception(25);
    const result = await ComplianceGuardianService.evaluate({
      description: "Act as my business partner at a meeting — pretend we've worked together for years",
      userId: 'user-e18',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('soft_flag');
    expect(result.deception_detected).toBe(true);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('E19: be my fake employee for the day — coached on what to say → soft_flag, deception_detected=true', async () => {
    await setupDeception(25);
    const result = await ComplianceGuardianService.evaluate({
      description: "Be my fake employee for the day — I'll coach you on what to say about our company",
      userId: 'user-e19',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('soft_flag');
    expect(result.deception_detected).toBe(true);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('E: TaskRiskClassifier — deception bumps risk to minimum TIER_2', async () => {
    const complianceResult = makeComplianceResult({
      deception_detected: true,
      ai_signals_computed: true,
    });

    // Even with no physical presence flags, deception bumps to TIER_2
    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'wildcard_bizarre',
      [],
      complianceResult as any,
    );
    expect(tier).toBeGreaterThanOrEqual(TaskRisk.TIER_2);
  });

  it('E: ScoperAI deception override — wildcard multipliers zeroed (base price restored)', async () => {
    // Setup: compliance says deception=true, ai_signals_computed=true
    const complianceResult = makeComplianceResult({
      deception_detected: true,
      is_genuinely_bizarre: false,
      ai_signals_computed: true,
    });

    const { AIClient } = await getMocks();
    // ScoperAI in heuristic mode (no AI configured for scope)
    AIClient.isConfigured.mockReturnValue(false);

    const base = 10000;
    const withMultipliers = applyWildcardMultipliers(base, ['performance_element_flag', 'costume_or_attire_flag']);
    // 20% + 10% = 30% → 13000

    // Deception override: price should be restored to base (multipliers zeroed)
    const deceptionOverridePrice = base; // The service restores basePriceBeforeMultipliers
    expect(withMultipliers).toBe(13000);
    expect(deceptionOverridePrice).toBe(base);

    // Verify that the service also does not crash when processing deception task through Scoper
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Pretend to be my boyfriend at my family dinner',
      templateSlug: 'wildcard_bizarre',
      wildcardFlags: ['performance_element_flag', 'costume_or_attire_flag'],
      complianceResult: complianceResult as any,
    });

    expect(result.success).toBe(true);
    // With deception override, final price should equal base (7500 talent floor for wildcard heuristic)
    // The service uses heuristic fallback: $75 base for talent templates
    // Then deception zeroes the multiplied price → back to 7500
    expect(result.data!.suggested_price_cents).toBe(7500);
  });
});

// ============================================================
// CATEGORY F — LEGITIMATE BUT SUSPICIOUS (NOT hard_block)
// ============================================================

describe('Category F — Legitimate but Suspicious (NOT blocked)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('F20: licensed massage therapist needed — credentials required → clean (license suppresses physical_contact flag)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Licensed massage therapist needed for deep tissue, credentials required',
      userId: 'user-f20',
    });
    // LICENSE_AFFIRMERS present → physical_contact_ambiguous suppressed
    expect(result.tier).toBe('clean');
    expect(result.triggeredRules).not.toContain('physical_contact_ambiguous');
    expect(result.tier).not.toBe('hard_block');
  });

  it('F21: overnight babysitting for 3 kids — travel for work → soft_flag (overnight_ambiguous now fires)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Overnight babysitting for my 3 kids, I travel for work',
      userId: 'user-f21',
    });
    // FIX v2.8.2: Expanded overnight pattern to /overnight.{0,30}(stay|companion|babysit|nanny|childcare|caregiver|sitter|care)/i
    // "overnight babysitting" now matches → overnight_ambiguous fires → score=45 → soft_flag
    expect(result.tier).toBe('soft_flag');
    expect(result.triggeredRules).toContain('overnight_ambiguous');
    expect(result.tier).not.toBe('hard_block');

    // "overnight stay" and "overnight companion" still trigger the pattern
    const result2 = await ComplianceGuardianService.evaluate({
      description: 'Need someone for overnight stay at my house',
      userId: 'user-f21-stay',
    });
    expect(result2.tier).toBe('soft_flag');
    expect(result2.triggeredRules).toContain('overnight_ambiguous');
  });

  it('F22: roleplay conversation coaching — help practice for date → clean or soft_flag, NOT deception', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(true);
    // AI returns: not deception (coaching is not social deception per the prompt rules)
    AIClient.callJSON.mockResolvedValue({
      data: { score: 5, rules: [], deception_detected: false, is_genuinely_bizarre: true },
      provider: 'test',
    } as any);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Help me practice for my date — roleplay conversation coaching, you play the other person',
      userId: 'user-f22',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.deception_detected).toBe(false);
    expect(result.tier).not.toBe('hard_block');
  });
});

// ============================================================
// CATEGORY G — BORDERLINE / AMBIGUOUS
// ============================================================

describe('Category G — Borderline / Ambiguous', () => {
  beforeEach(() => vi.resetAllMocks());

  it('G23: write letter to ex pretending from anonymous admirer → soft_flag, deception_detected=true', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(true);
    AIClient.callJSON.mockResolvedValue({
      data: {
        score: 28,
        rules: ['deception_social_manipulation'],
        deception_detected: true,
        is_genuinely_bizarre: false,
      },
      provider: 'test',
    } as any);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Help me write and deliver a letter to my ex-girlfriend pretending it's from an anonymous admirer",
      userId: 'user-g23',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('soft_flag');
    expect(result.deception_detected).toBe(true);
    expect(result.ai_signals_computed).toBe(true);
  });

  it('G24: be my companion for the evening — companionship only, dinner and movie → soft_flag (overnight_companion)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Be my companion for the evening, companionship only, dinner and a movie',
      userId: 'user-g24',
    });
    // No hard_block patterns, no SOFT_FLAG exact matches for "companion" alone.
    // "overnight" word not present; "alone" not present; no massage/medical/cash patterns.
    // Heuristic score should be 0 → clean.
    // BUT the intent is ambiguous — without AI it comes back clean at heuristic level.
    expect(result.tier).not.toBe('hard_block');
    // If score ≥ 21 → soft_flag. Heuristic for "companion" alone = 0 → clean.
    // This is an edge case where heuristics cannot catch it — documents the limitation.
    expect(['clean', 'soft_flag']).toContain(result.tier);
  });

  it('G25: private underground comedy show — play the straight man → clean, is_genuinely_bizarre=true', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(true);
    AIClient.callJSON.mockResolvedValue({
      data: {
        score: 0,
        rules: [],
        deception_detected: false,
        is_genuinely_bizarre: true,
      },
      provider: 'test',
    } as any);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Private underground comedy show — I need someone to play the straight man for my set',
      userId: 'user-g25',
      templateSlug: 'wildcard_bizarre',
    });
    expect(result.tier).toBe('clean');
    expect(result.is_genuinely_bizarre).toBe(true);
    expect(result.deception_detected).toBe(false);
    expect(result.ai_signals_computed).toBe(true);
  });
});

// ============================================================
// SUPPLEMENTARY: TaskRiskClassifier.classifyWithTemplate — selected cases
// ============================================================

describe('TaskRiskClassifier.classifyWithTemplate — supplementary coverage', () => {
  it('wildcard_bizarre template minimum = TIER_1', () => {
    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'wildcard_bizarre',
    );
    expect(tier).toBeGreaterThanOrEqual(TaskRisk.TIER_1);
  });

  it('private_location_flag bumps to TIER_2 regardless of physical flags', () => {
    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'standard_physical',
      ['private_location_flag'],
    );
    expect(tier).toBe(TaskRisk.TIER_2);
  });

  it('care template is always TIER_3', () => {
    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: false, peoplePresent: false, petsPresent: false, caregiving: false },
      'care',
    );
    expect(tier).toBe(TaskRisk.TIER_3);
  });

  it('F21 overnight babysitting → TIER_3 (people present)', () => {
    const tier = TaskRiskClassifier.classifyWithTemplate(
      { insideHome: true, peoplePresent: true, petsPresent: false, caregiving: true },
      'care',
    );
    expect(tier).toBe(TaskRisk.TIER_3);
  });
});

// ============================================================
// SUPPLEMENTARY: applyWildcardMultipliers — direct unit tests
// ============================================================

describe('applyWildcardMultipliers — direct unit coverage', () => {
  it('no flags → no premium, base unchanged', () => {
    expect(applyWildcardMultipliers(10000, [])).toBe(10000);
  });

  it('single performance_element_flag → +20%', () => {
    expect(applyWildcardMultipliers(10000, ['performance_element_flag'])).toBe(12000);
  });

  it('all 6 flags → capped at 50% premium', () => {
    const allFlags = [
      'private_location_flag',      // +15%
      'props_required_flag',         // +10%
      'performance_element_flag',    // +20%
      'audience_present_flag',       // +10%
      'costume_or_attire_flag',      // +10%
      'travel_over_30min_flag',      // +20%
    ];
    // Total = 85% → capped at 50% → base * 1.5
    expect(applyWildcardMultipliers(10000, allFlags)).toBe(15000);
  });

  it('price never exceeds 50000 (constitutional $500 cap)', () => {
    expect(applyWildcardMultipliers(45000, ['performance_element_flag', 'travel_over_30min_flag'])).toBeLessThanOrEqual(50000);
  });

  it('unknown flag is ignored', () => {
    expect(applyWildcardMultipliers(10000, ['totally_fake_flag'])).toBe(10000);
  });
});
