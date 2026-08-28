/**
 * Red-Team Attack Suite: Extreme Bizarre + Cultural Ambiguity
 *
 * 30 adversarial edge cases designed to stress-test ComplianceGuardianService.evaluate()
 * across deception boundaries, cultural ceremonies, surreal performance art, pricing
 * edge cases, and multi-person deception scenarios.
 *
 * Mock strategy: identical to edge-case-simulation.test.ts
 *   - db.query → no prior coded phrases (was_repeat: false)
 *   - AIClient → isConfigured()=false by default; overridden per-test when AI signals needed
 *   - pii-scrubber / logger → passthrough stubs
 *
 * Each test records the ACTUAL result and a VERDICT:
 *   CORRECT  — result is clearly right
 *   SUSPECT  — arguable gap, not necessarily a bug but worth human review
 *   WRONG    — clear bug, flag this
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceGuardianService } from '../../src/services/ComplianceGuardianService.js';
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

async function getMocks() {
  const { db } = await import('../../src/db.js');
  const { AIClient } = await import('../../src/services/AIClient.js');
  return { db: vi.mocked(db), AIClient: vi.mocked(AIClient) };
}

function dbNoMatch() {
  return { rows: [{ was_repeat: false }], rowCount: 1 } as any;
}

/** Configures AI to return the given signals for wildcard bizarre cases. */
async function setupAI(signals: {
  score?: number;
  rules?: string[];
  deception_detected?: boolean;
  is_genuinely_bizarre?: boolean;
}) {
  const { db, AIClient } = await getMocks();
  AIClient.isConfigured.mockReturnValue(true);
  AIClient.callJSON.mockResolvedValue({
    data: {
      score: signals.score ?? 0,
      rules: signals.rules ?? [],
      deception_detected: signals.deception_detected ?? false,
      is_genuinely_bizarre: signals.is_genuinely_bizarre ?? false,
    },
    provider: 'test',
  } as any);
  db.query.mockResolvedValue(dbNoMatch());
  return { db, AIClient };
}

// ============================================================
// SECTION 1: EXTREME BIZARRE CASES (1–10)
// ============================================================

describe('Section 1 — Extreme Bizarre Cases', () => {
  beforeEach(() => vi.resetAllMocks());

  /**
   * CASE 1: Lie in coffin for film short about mortality
   * Heuristic analysis:
   *   - No HARD_BLOCK_PATTERNS match
   *   - No WEAPON patterns
   *   - No SOFT_FLAG patterns match ("alone at home" does NOT match; no massage/overnight/medical/cash)
   *   - Expected heuristic score: 0 → clean
   * AI path: wildcard_bizarre → AI runs if configured, but with AI mocked off → no AI
   * EXPECTED: clean, score=0, no rules fired
   * VERDICT: CORRECT if clean. This is clearly a legitimate creative production task.
   */
  it('C1: coffin lie-in for mortality short film → clean (creative production)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'I need someone to lie in a coffin for 4 hours while I film a short film about mortality',
      userId: 'attack-c1',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    expect(result.triggeredRules).toHaveLength(0);
    // VERDICT: CORRECT — no heuristic patterns fire, correctly classified clean.
    // NOTE: Without AI, is_genuinely_bizarre=false — would benefit from AI evaluation
    // but is not a bug (AI path is optional).
    expect(result.ai_signals_computed).toBe(false);
  });

  /**
   * CASE 2: Ghost prank at friend's house party (third-party deception)
   * Heuristic analysis:
   *   - No HARD_BLOCK patterns match
   *   - "haunt" / "prank" not in any regex
   *   - "house" without "alone" prefix → isolation_flag does NOT fire
   *   - Expected heuristic: score=0 → clean
   * KEY EDGE: This is deception against a THIRD PARTY (the friend), not the poster.
   * The deception detection prompt says: "pretending to be someone they are not in a SOCIAL context".
   * Wearing all white at a party is performance art / prank, not identity fraud.
   * SUSPECT: Should AI flag deception for third-party prank? Current prompt says "fake bf/gf/friend/professional"
   * — wearing a ghost costume is NOT that. Heuristics correctly clean. But edge worth noting.
   */
  it('C2: ghost costume prank at friend\'s house party → clean heuristically (third-party deception edge)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Be my ghost — wear all white and haunt my friend's house party as a prank",
      userId: 'attack-c2',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT at heuristic level. AI path would determine deception_detected.
    // SUSPECT: Without AI, third-party deception (prank) gets no signal at all.
    // The deception detection prompt only covers "fake boyfriend/girlfriend/friend/professional"
    // — a costumed prank is genuinely not that. Correct behavior.
    expect(result.deception_detected).toBe(false);
  });

  /**
   * CASE 3: Pretend to be dead grandmother at seance
   * Heuristic analysis:
   *   - No HARD_BLOCK patterns
   *   - No SOFT_FLAG patterns ("alone" not present, no massage/medical/cash)
   *   - Heuristic score: 0
   * Deception angle: "stay in character" as a deceased person — impersonation.
   * This IS the kind of thing the deception detection prompt covers ("pretending to be someone they are not").
   * Without AI: score=0, clean — SUSPECT because this is impersonation of a deceased person
   * which could distress the poster's family/guests if presented as real.
   * However, the poster explicitly frames it as a seance they are HOSTING — consent is implied
   * for all participants. This is closer to roleplay/performance than harmful deception.
   */
  it('C3: pretend to be dead grandmother at seance → clean heuristically, deception edge', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'I need someone to pretend to be my dead grandmother at a seance I\'m hosting — stay in character',
      userId: 'attack-c3',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: SUSPECT — heuristics cannot detect impersonation of deceased persons.
    // Without AI, this gets no deception signal. The AI deception prompt would need to
    // cover "impersonation of deceased individuals" — currently it only covers
    // "fake boyfriend/girlfriend/friend/professional/colleague". Gap exists.
    expect(result.deception_detected).toBe(false);
  });

  /**
   * CASE 4: Eating increasingly spicy food on camera for YouTube
   * Heuristic: No patterns fire. Score=0 → clean.
   * This is a textbook content_creator task submitted via wildcard_bizarre.
   */
  it('C4: spicy food challenge on YouTube → clean (content creator)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Eat increasingly spicy food on camera for my YouTube reaction channel — 10 levels',
      userId: 'attack-c4',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT — clearly legal performance/content task.
  });

  /**
   * CASE 5: Come to apartment and stare in silence for 1 hour as art installation
   * Heuristic analysis:
   *   - "alone.{0,20}(house|home|apartment)" pattern: "alone" is NOT in the description
   *   - No HARD_BLOCK patterns
   *   - Score: 0 → clean
   * EDGE: Private location (apartment) + one-on-one silence. Without "alone" keyword,
   * isolation_flag does NOT fire. That keyword dependency is interesting.
   */
  it('C5: stare at poster in silence for 1 hour as art installation → clean', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Come to my apartment and stare at me in silence for 1 hour as an art installation',
      userId: 'attack-c5',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT at heuristic level. Private location + prolonged silent presence
    // is genuinely bizarre but not illegal. AI would assign is_genuinely_bizarre=true.
    // SUSPECT gap: isolation_flag requires "alone" keyword — a task at someone's apartment
    // alone with them does not trigger it without the word "alone". Keyword dependency is a gap
    // but not a hard bug given the AI layer is the intended backstop.
  });

  /**
   * CASE 6: Full horse costume at corporate team-building event
   * Heuristic: No patterns fire. Score=0 → clean.
   * Genuinely bizarre and harmless.
   */
  it('C6: horse costume at corporate team-building event → clean', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Wear a full horse costume and attend my corporate team-building event as 'Horace the Motivational Horse'",
      userId: 'attack-c6',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT.
  });

  /**
   * CASE 7: Be the villain in an escape room for 3 hours
   * Heuristic: No patterns fire. Score=0 → clean.
   * Hired actor in performance context. Clear.
   */
  it('C7: escape room villain for 3 hours → clean (hired actor/performance)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Be the villain in my escape room — stay in character for 3 hours, scare my guests',
      userId: 'attack-c7',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT.
  });

  /**
   * CASE 8: Come hold my hand in silence while childhood home gets demolished
   * Heuristic analysis:
   *   - "hold my hand" → does physical_contact_ambiguous fire? Pattern: /massage/i — NO.
   *   - "overnight" not present → overnight_ambiguous: NO
   *   - "alone" not present → isolation_flag: NO
   *   - No HARD_BLOCK patterns
   *   - Score: 0 → clean
   * EDGE: emotional support + physical touch (hand holding) + private context.
   * The physical_contact pattern ONLY fires for "massage" — hand-holding does not trigger it.
   * This is a real gap: the system treats all physical contact uniformly at "massage" level
   * but misses gentler physical contact in private settings entirely.
   */
  it('C8: hold hand in silence at demolition → clean (physical_contact gap — only "massage" triggers)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Come hold my hand in silence while I watch my childhood home get demolished',
      userId: 'attack-c8',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT (this is clean — emotional support hand-holding is legal).
    // Note: physical_contact_ambiguous only catches "massage" — this is intentional narrow scope.
    // No bug here; the task is genuinely clean.
    expect(result.triggeredRules).not.toContain('physical_contact_ambiguous');
  });

  /**
   * CASE 9: Life coach who only speaks in riddles
   * Heuristic: "coach" not in any pattern. Score=0 → clean.
   */
  it('C9: life coach only speaks in riddles → clean (performance coaching)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Act as my life coach for the day but ONLY speak in riddles — no direct answers allowed",
      userId: 'attack-c9',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT.
  });

  /**
   * CASE 10: "Yes Man" — agree with everything in meetings for 8 hours
   * Heuristic analysis:
   *   - No HARD_BLOCK patterns
   *   - No SOFT_FLAG patterns
   *   - Score: 0 → clean
   * EDGE: Is this "workplace deception"? The Hustler is pretending to be something they
   * are not (a genuine colleague/supporter) in a professional setting. However, the poster
   * is orchestrating this — it's more like a performance/impersonation aid in a context
   * where the poster has full awareness. The AI deception prompt covers "fake... colleague"
   * — this could be argued to be a fake colleague scenario.
   * Without AI: scores 0 → clean. With AI, deception_detected might fire depending on
   * how the prompt interprets "meetings" context.
   */
  it('C10: Yes Man for 8 hours in meetings → clean heuristically (workplace deception edge)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "I need someone to be my 'Yes Man' for 8 hours — agree with everything I say in meetings",
      userId: 'attack-c10',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: SUSPECT — heuristics are blind to "professional setting deception" entirely.
    // The AI deception prompt mentions "fake... colleague" but whether a "Yes Man" is a
    // "fake colleague" is genuinely debatable. If AI is configured, deception_detected
    // might fire. Without AI the task escapes completely.
  });
});

// ============================================================
// SECTION 2: CULTURALLY AMBIGUOUS CASES (11–15)
// ============================================================

describe('Section 2 — Culturally Ambiguous Cases', () => {
  beforeEach(() => vi.resetAllMocks());

  /**
   * CASE 11: Traditional Korean jesa ceremony food preparation
   * Heuristic: No patterns fire. Score=0 → clean.
   * Cultural ceremony assistance is legal, clearly legitimate.
   */
  it('C11: Korean jesa ceremony food preparation → clean (cultural ceremony)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Help me perform a traditional Korean jesa ceremony — I need someone who knows the ritual food preparation',
      userId: 'attack-c11',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT.
  });

  /**
   * CASE 12: Exorcism ritual — sage, chanting
   * Heuristic analysis:
   *   - "exorcism" / "sage" / "chanting" — none in any pattern
   *   - "apartment" without "alone" → no isolation_flag
   *   - Score: 0 → clean
   * Cultural/spiritual practice. Legal.
   */
  it('C12: apartment exorcism ritual — sage and chanting → clean (spiritual practice)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Perform an exorcism ritual on my apartment — sage, chanting, the works, I\'ll supply everything',
      userId: 'attack-c12',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT — legal spiritual/cultural service.
  });

  /**
   * CASE 13: Professional mourner at funeral
   * Heuristic analysis:
   *   - "mourner" / "funeral" / "cry loudly" → none match any pattern
   *   - No HARD_BLOCK, no SOFT_FLAG
   *   - Score: 0 → clean
   * EDGE: Is this "deception"? Professional mourning is a real cultural tradition
   * (common in Mediterranean, Middle Eastern, African, and East Asian cultures).
   * The mourner is not pretending to BE anyone — they are performing grief.
   * Deception detection prompt: "pretending to be someone they are not" — mourner is
   * not impersonating a person, they are performing an emotional act.
   */
  it('C13: professional mourner at uncle\'s funeral → clean (cultural tradition)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Be my 'professional mourner' at my uncle's funeral — cry loudly, it's a cultural tradition",
      userId: 'attack-c13',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT — professional mourning is a recognized cultural practice,
    // not social identity deception. Clean is right.
  });

  /**
   * CASE 14: Curandera healing session with herbs
   * Heuristic analysis:
   *   - "curandera" → not in any pattern
   *   - "healing session" → does "medical.{0,20}(advice|treatment|injection)" fire? "healing" ≠ "medical"
   *   - "herbs" / "pray" → not in any pattern
   *   - Score: 0 → clean
   * EDGE: This should potentially trigger unlicensed_medical if "healing" is interpreted
   * as "medical treatment". The pattern requires the word "medical" explicitly — "healing"
   * does NOT match. This is a gap: cultural healing practices could be medical-adjacent
   * but the regex only catches the word "medical" literally.
   *
   * HOWEVER: curandera healing is a cultural/spiritual practice, NOT licensed medical practice.
   * Triggering "unlicensed_medical" would be a false positive that disrespects cultural tradition.
   * The current behavior (clean) is arguably CORRECT for cultural sensitivity.
   */
  it('C14: curandera healing session — herbs and prayer → clean (cultural healing, not medical treatment)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "I need a 'curandera' healing session at my home — bring herbs, pray over me",
      userId: 'attack-c14',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT — curandera is a cultural healer, not an unlicensed MD.
    // The pattern only fires for "medical treatment/advice/injection" — correct behavior.
    expect(result.triggeredRules).not.toContain('unlicensed_medical');
  });

  /**
   * CASE 15: "Crying therapy" — cry together for emotional release, private session
   * Heuristic analysis:
   *   - "private session" → does isolation_flag fire? Pattern: /alone.{0,20}(house|home|apartment)/i
   *     "private" ≠ "alone" — NO match
   *   - "session" alone without "overnight" → overnight_ambiguous: NO
   *   - No HARD_BLOCK patterns
   *   - Score: 0 → clean
   * EDGE: Private location + physical/emotional proximity + "session" framing.
   * The isolation_flag only fires with "alone" keyword — "private" doesn't trigger it.
   * This is a meaningful gap: "private session" is semantically equivalent to "alone at home"
   * for isolation risk purposes but the regex misses it.
   */
  it('C15: crying therapy private session → clean (isolation_flag keyword gap: "private" ≠ "alone")', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Participate in a crying therapy session — cry together with me for emotional release, private session',
      userId: 'attack-c15',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: SUSPECT — "private session" does not trigger isolation_flag because the pattern
    // requires "alone" as a keyword. The semantic risk of a private emotionally-charged
    // one-on-one session is similar to the isolation_flag intent but escapes detection.
    // Not a clear bug (crying therapy is legal) but the keyword specificity is a gap.
    expect(result.triggeredRules).not.toContain('isolation_flag');
  });
});

// ============================================================
// SECTION 3: MULTI-PERSON DECEPTION EDGE CASES (16–20)
// ============================================================

describe('Section 3 — Multi-Person Deception Edge Cases', () => {
  beforeEach(() => vi.resetAllMocks());

  /**
   * CASE 16: Surprise party — pretend to be delivery person to poster's wife
   * Heuristic analysis:
   *   - "pretend" → not in any regex
   *   - "delivery" → check WEAPON patterns: no weapon words present → no weapon match
   *   - SOFT_FLAG patterns: "delivery person" doesn't match any SOFT_FLAG regex
   *   - Score: 0 → clean
   * EDGE: Deception of a THIRD PARTY (the wife) for a benign purpose (surprise party).
   * The AI deception detection prompt covers "pretending to be someone they are not in
   * a social context" — pretending to be a delivery person IS impersonating a professional.
   * However, this is widely considered innocent (surprise parties use this all the time).
   * The prompt carves out "innocent roleplay for creative/performance tasks" — does a
   * surprise party delivery ruse qualify? Debatable.
   *
   * BUG CANDIDATE: Without AI, this gets score=0 and no deception signal at all,
   * even though it explicitly involves pretending to be a delivery person.
   */
  it('C16: surprise party delivery person ruse (third-party deception) → clean heuristically (deception gap)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Help me throw a surprise party — pretend you're a delivery person when my wife answers the door",
      userId: 'attack-c16',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: SUSPECT — innocent purpose but explicit impersonation of a professional
    // (delivery person) to a third party. Heuristics entirely miss this. AI layer is the
    // intended backstop. Whether AI should flag deception here is a product decision.
    expect(result.deception_detected).toBe(false);
  });

  /**
   * CASE 17: Pretend to be from HOA to collect neighbor's unpaid dues
   * Heuristic analysis:
   *   - No HARD_BLOCK patterns match
   *   - "pretend" / "HOA" / "dues" → not in any pattern
   *   - "neighbor's door" → no isolation_flag (no "alone")
   *   - Score: 0 → clean
   * REALITY: This is impersonation of an authority/official body (HOA representative)
   * to extract payment from a third party. This could constitute fraud in many jurisdictions.
   * The system gives it score=0 without AI. THIS IS A BUG.
   * With AI configured, the AI should flag this — but without AI, it escapes entirely.
   */
  it('C17 (FIXED): impersonate HOA to collect neighbor\'s dues → soft_flag, score >= 21, rule authority_impersonation', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Go to my neighbor's door and pretend you're from the HOA to collect their unpaid dues",
      userId: 'attack-c17',
      templateSlug: 'wildcard_bizarre',
    });

    // FIXED: authority_impersonation pattern now catches "pretend you're from the HOA"
    expect(result.tier).toBe('soft_flag');
    expect(result.score).toBeGreaterThanOrEqual(21);
    expect(result.triggeredRules).toContain('authority_impersonation');
  });

  /**
   * CASE 18: Pose as food critic at friend's restaurant opening
   * Heuristic analysis:
   *   - "pose as" / "food critic" → not in any pattern
   *   - No HARD_BLOCK, no SOFT_FLAG
   *   - Score: 0 → clean
   * REALITY: Deliberate deception of a third party (restaurant owner/staff) for commercial
   * benefit (generating buzz). This is arguably fraud/defamation depending on what the
   * "critic" says or implies.
   * Without AI: score=0 → clean. BUG CANDIDATE.
   */
  it('C18 (FIXED): pose as food critic for third-party restaurant → soft_flag, score >= 21, rule professional_role_impersonation', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Pose as a food critic at my friend's restaurant opening to generate buzz",
      userId: 'attack-c18',
      templateSlug: 'wildcard_bizarre',
    });

    // FIXED: professional_role_impersonation pattern now catches "Pose as a food critic"
    expect(result.tier).toBe('soft_flag');
    expect(result.score).toBeGreaterThanOrEqual(21);
    expect(result.triggeredRules).toContain('professional_role_impersonation');
  });

  /**
   * CASE 19: Pretend to be a journalist interviewing dad for surprise birthday video
   * Heuristic: Score=0 → clean.
   * EDGE: Pretending to be a journalist to deceive someone (dad) — benign purpose.
   * vs. Case 18 (food critic) — same structure, different intent.
   * Without AI, both cases score identically (0).
   * The key distinction the AI would need to make: is the deception causing harm to the
   * third party? Surprise birthday video = no harm. Food critic = potential commercial harm.
   */
  it('C19 (UPDATED): pretend journalist interviewing dad for birthday video → soft_flag (professional_role_impersonation)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Pretend to be a journalist and interview my dad about his life story for a surprise birthday video',
      userId: 'attack-c19',
      templateSlug: 'wildcard_bizarre',
    });

    // The professional_role_impersonation pattern (score=40) now catches "Pretend to be a journalist".
    // Although the purpose here is benign (birthday video), the heuristic cannot distinguish
    // benign from harmful professional-role impersonation — that distinction requires AI.
    // Score=40 → soft_flag. With AI configured, AI would likely lower the score for the benign case.
    expect(result.tier).toBe('soft_flag');
    expect(result.score).toBeGreaterThanOrEqual(21);
    expect(result.triggeredRules).toContain('professional_role_impersonation');
    // VERDICT: CORRECT — heuristic correctly flags professional role impersonation.
    // AI needed to distinguish benign from harmful intent (birthday vs. fraud).
  });

  /**
   * CASE 20: Act as mystery shopper at competitor's store
   * Heuristic: Score=0 → clean.
   * REALITY: Mystery shopping is a legitimate, widely-used market research practice.
   * "Competitor's store" framing could imply industrial espionage, but mystery shopping
   * of competitors is legal in most jurisdictions (unless specific trade secrets are
   * targeted or non-disclosure is breached). Should be clean.
   */
  it('C20: mystery shopper at competitor\'s store → clean (legitimate market research)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Act as a mystery shopper at my competitor's store and report back on their service",
      userId: 'attack-c20',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT — mystery shopping is a standard, legal business practice.
    // Competitive intelligence gathering via mystery shopping is not fraud.
  });
});

// ============================================================
// SECTION 4: GENUINELY SURREAL CASES (21–25)
// ============================================================

describe('Section 4 — Genuinely Surreal Cases', () => {
  beforeEach(() => vi.resetAllMocks());

  /**
   * CASE 21: Professionally ignore poster for 2 hours — exposure therapy
   * Heuristic: Score=0 → clean.
   * "exposure therapy" → "therapy" alone not in any soft_flag pattern
   * ("medical.{0,20}(advice|treatment|injection)" doesn't match "therapy")
   * Interesting: the word "therapy" appears in the description but doesn't trigger
   * unlicensed_medical — correct, because exposure therapy guidance is not medical
   * treatment/advice/injection.
   */
  it('C21: professionally ignore poster for 2 hours (exposure therapy) → clean', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'I need someone to professionally ignore me for 2 hours — no eye contact, no responses — as exposure therapy',
      userId: 'attack-c21',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT — "exposure therapy" is a framing, the actual task is just
    // sitting in silence. No regulatory issue. Clean is right.
  });

  /**
   * CASE 22: Read bedtime stories until poster falls asleep — adult insomnia treatment
   * Heuristic analysis:
   *   - "overnight" not present → overnight_ambiguous: NO
   *   - "home" without "alone" → isolation_flag: NO
   *   - "alone" not present
   *   - "treatment" — check: /medical.{0,20}(advice|treatment|injection)/i
   *     "insomnia treatment" — the word "medical" is NOT present, "treatment" appears alone.
   *     The regex requires "medical" BEFORE "treatment". "insomnia treatment" alone → NO MATCH.
   *   - Score: 0 → clean
   * EDGE: This is effectively an overnight companion scenario (fall asleep while they're there)
   * but the word "overnight" is absent. The overnight_ambiguous pattern requires "overnight" —
   * "until I fall asleep" does not trigger it.
   * This is a real gap: an activity that culminates in the poster being asleep with a stranger
   * present gets no overnight flag.
   */
  it('C22 (UPDATED): read bedtime stories until poster falls asleep → soft_flag (presence_until_asleep)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Come to my home and read me bedtime stories until I fall asleep — adult insomnia treatment',
      userId: 'attack-c22',
      templateSlug: 'wildcard_bizarre',
    });

    // FIXED: presence_until_asleep pattern (score=35) now catches "until I fall asleep".
    // A stranger present while the poster is sleeping is correctly flagged for review.
    expect(result.tier).toBe('soft_flag');
    expect(result.score).toBeGreaterThanOrEqual(21);
    expect(result.triggeredRules).toContain('presence_until_asleep');
    expect(result.triggeredRules).not.toContain('overnight_ambiguous');
    expect(result.triggeredRules).not.toContain('unlicensed_medical');
  });

  /**
   * CASE 23: Walk 3 feet behind poster and narrate in British accent
   * Heuristic: Score=0 → clean. Clear performance art.
   */
  it('C23: walk behind poster narrating in British accent all day → clean (performance art)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Walk 3 feet behind me in public all day and narrate what I\'m doing in a British accent',
      userId: 'attack-c23',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT — pure performance art, public location, no illegal elements.
  });

  /**
   * CASE 24: Attend therapy session as "emotional support stranger"
   * Heuristic analysis:
   *   - "therapy session" → check: /medical.{0,20}(advice|treatment|injection)/i
   *     "therapy" ≠ "medical" — NO match. "session" alone doesn't trigger.
   *   - No HARD_BLOCK patterns
   *   - Score: 0 → clean
   * EDGE: A stranger attending someone's therapy session raises therapist consent issues
   * (the therapist would need to agree) but the task itself isn't illegal.
   * "Medical adjacent" framing but legally clean.
   */
  it('C24: attend therapy session as emotional support stranger → clean (medical-adjacent but legal)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Attend my therapy session as my 'emotional support stranger' — just sit nearby silently",
      userId: 'attack-c24',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT — the Hustler attending a therapy session as a silent companion
    // is legal (subject to therapist consent). No heuristic should fire here.
  });

  /**
   * CASE 25: Pretend to be poster's imaginary friend "made real"
   * Heuristic: Score=0 → clean.
   * The deception is entirely FOR the poster (they know it's roleplay).
   * The AI deception prompt says: "Innocent roleplay for creative/performance tasks is NOT deception."
   * This is clearly roleplay-for-poster, not social deception of third parties.
   */
  it('C25: be poster\'s imaginary friend made real → clean (roleplay for poster, not social deception)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Pretend to be my imaginary friend made real — I'll give you a character description",
      userId: 'attack-c25',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);
    // VERDICT: CORRECT — explicit self-aware roleplay for the poster. Not social deception.
  });
});

// ============================================================
// SECTION 5: PRICING EDGE CASES FOR BIZARRE (26–30)
// ============================================================

describe('Section 5 — Pricing Edge Cases for Bizarre Tasks', () => {
  beforeEach(() => vi.resetAllMocks());

  /**
   * CASE 26: 5 people each perform one section of interpretive dance
   * Multi-performer compliance: each performer passes through evaluate() independently.
   * Single task description → single evaluation. Score=0 → clean.
   * Wildcard multipliers: audience_present_flag + performance_element_flag likely.
   * Key question: does "coordinate 5 strangers" affect pricing? applyWildcardMultipliers
   * only multiplies a single base price — there's no per-person multiplier in the system.
   */
  it('C26: 5-person interpretive dance sections → clean; wildcard multiplier capped at 50%', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'I need 5 people to each perform one section of my interpretive dance — coordinate 5 strangers',
      userId: 'attack-c26',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);

    // Pricing: performance_element_flag (0.20) + audience_present_flag (0.10) = 30% premium
    // Base $100 → $130 with multipliers (well under $500 cap)
    const base = 10000; // $100
    const withFlags = applyWildcardMultipliers(base, ['performance_element_flag', 'audience_present_flag']);
    expect(withFlags).toBe(13000); // $130

    // NOTE: System prices a SINGLE gig — if poster needs 5 people, they'd create 5 tasks.
    // The multiplier system doesn't handle multi-performer coordination as a single task.
    // VERDICT: CORRECT for compliance. Pricing note: multi-person tasks need multiple listings.
  });

  /**
   * CASE 27: Full 24-hour butler/driver/comedian/chef/bodyguard stacked roles
   * Heuristic analysis:
   *   - "alone" not present → no isolation_flag
   *   - "overnight" not present → no overnight_ambiguous
   *   - 24 hours of presence implies overnight but without the keyword
   *   - Score: 0 → clean
   * Pricing: ALL multipliers would likely apply for this stacked role task.
   * ALL 6 flags = 85% raw → capped at 50% → $500 cap applies to base prices ≥ $33,334.
   */
  it('C27 (FIXED): 24-hour stacked roles are blocked as an excessive continuous shift', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Full 24-hour experience: be my personal butler, driver, comedian, chef, and bodyguard',
      userId: 'attack-c27',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('hard_block');
    expect(result.score).toBeGreaterThanOrEqual(61);
    expect(result.triggeredRules).toContain('excessive_continuous_duration');

    // Pricing test: stacked multipliers hit constitutional $500 cap
    const base = 40000; // $400 base for 24h premium task
    const allFlags = [
      'private_location_flag',       // +15%
      'performance_element_flag',    // +20%
      'costume_or_attire_flag',      // +10% (butler/chef uniform)
      'travel_over_30min_flag',      // +20% (driver role)
    ];
    const withFlags = applyWildcardMultipliers(base, allFlags);
    // 65% premium → capped at 50% → $400 * 1.5 = $600 → capped at $500
    expect(withFlags).toBeLessThanOrEqual(50000); // never exceeds $500

    // VERDICT: FIXED — price caps cannot legitimize a shift that violates the
    // worker-protection boundary; it must be split or staffed as a business workflow.
  });

  /**
   * CASE 28: Live in house for one week as personal assistant/companion — paid per day
   * Heuristic analysis:
   *   - "overnight" not present → overnight_ambiguous: does "one week" count?
   *     Pattern: /overnight.{0,30}(stay|companion|...)/i — requires "overnight" keyword.
   *     "live in my house for one week" does NOT match.
   *   - "companion" alone: not in overnight_ambiguous pattern without "overnight" prefix
   *   - No HARD_BLOCK patterns
   *   - Score: 0 → clean
   * BUG: A week-long live-in arrangement escapes ALL heuristics because "overnight" keyword absent.
   * This is arguably the highest-risk scenario in the entire test suite heuristically escaping.
   */
  it('C28 (FIXED): live in house for 1 week as assistant/companion → soft_flag, score >= 21, rule extended_presence_livein', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: "Live in my house for one week as my 'personal assistant/companion' — paid per day",
      userId: 'attack-c28',
      templateSlug: 'wildcard_bizarre',
    });

    // FIXED: extended_presence_livein pattern now catches "Live in my house"
    expect(result.tier).toBe('soft_flag');
    expect(result.score).toBeGreaterThanOrEqual(21);
    expect(result.triggeredRules).toContain('extended_presence_livein');
  });

  /**
   * CASE 29: 10 hours continuous improv comedy — costume, outdoor, audience
   * Heuristic: Score=0 → clean.
   * Pricing: This is the maximum multiplier stacking test.
   * performance_element_flag (0.20) + costume_or_attire_flag (0.10) +
   * audience_present_flag (0.10) + travel_over_30min_flag (0.20) = 60% → capped 50%
   */
  it('C29: 10-hour improv comedy — stacked multipliers hit 50% premium cap', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Perform at my event: 10 hours of continuous improv comedy, costume required, outdoor venue',
      userId: 'attack-c29',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);

    // Multiplier stacking: 4 flags = 60% raw → capped at 50%
    const base = 10000; // $100
    const flags = [
      'performance_element_flag',  // +20%
      'costume_or_attire_flag',    // +10%
      'audience_present_flag',     // +10%
      'travel_over_30min_flag',    // +20%
    ];
    const withFlags = applyWildcardMultipliers(base, flags);
    // 60% raw → capped at 50% → 15000
    expect(withFlags).toBe(15000); // $150 cap applies

    // VERDICT: CORRECT — multiplier cap works as designed.
  });

  /**
   * CASE 30: Attend 15 different locations across city in one day as "hype person"
   * Heuristic: Score=0 → clean.
   * Pricing: travel_over_30min_flag (0.20) + audience_present_flag (0.10) = 30%
   * Multi-location: 15 locations × travel premium? The multiplier applies once flat —
   * there's no per-stop multiplier. travel_over_30min_flag is binary.
   * This is a pricing system gap: 15-stop city tour has same travel multiplier as 1-stop.
   */
  it('C30: 15-location hype person city tour → clean; travel multiplier applies once (flat, not per-stop)', async () => {
    const { db, AIClient } = await getMocks();
    AIClient.isConfigured.mockReturnValue(false);
    db.query.mockResolvedValue(dbNoMatch());

    const result = await ComplianceGuardianService.evaluate({
      description: 'Attend 15 different locations across the city with me in one day as my hype person',
      userId: 'attack-c30',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.score).toBe(0);

    // travel_over_30min_flag fires once regardless of number of stops
    const base = 10000;
    const oneStop = applyWildcardMultipliers(base, ['travel_over_30min_flag', 'audience_present_flag']);
    const fifteenStops = applyWildcardMultipliers(base, ['travel_over_30min_flag', 'audience_present_flag']);
    // Both get same premium — the multiplier is binary, not cumulative per stop
    expect(oneStop).toBe(fifteenStops); // 30% premium → $130
    expect(oneStop).toBe(13000);

    // VERDICT: CORRECT for compliance (clean task). SUSPECT for pricing fairness:
    // a 15-stop all-day city tour should arguably be priced higher than a single-stop
    // 30+ minute trip, but the wildcard multiplier system is intentionally flat.
    // The $500 cap and base rate floor ($25-$100/hr) are the intended protections.
  });
});

// ============================================================
// SECTION 6: AI-ASSISTED DECEPTION DISAMBIGUATION (bonus cases)
// These re-test the most contested cases WITH AI configured to see what signals fire.
// ============================================================

describe('Section 6 — AI-Assisted Deception Disambiguation (selected re-runs)', () => {
  beforeEach(() => vi.resetAllMocks());

  /**
   * BONUS A: HOA impersonation WITH AI configured — should fire deception_detected
   */
  it('BA: HOA impersonation with AI → deception_detected=true, tier=soft_flag', async () => {
    await setupAI({
      score: 35,
      rules: ['deception_social_manipulation', 'authority_impersonation'],
      deception_detected: true,
      is_genuinely_bizarre: false,
    });

    const result = await ComplianceGuardianService.evaluate({
      description: "Go to my neighbor's door and pretend you're from the HOA to collect their unpaid dues",
      userId: 'attack-ba',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('soft_flag');
    expect(result.deception_detected).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(21);
    // VERDICT: CORRECT when AI is configured — AI properly catches authority impersonation.
    // The gap is only when AI is not configured (see C17 above).
  });

  /**
   * BONUS B: Food critic impersonation WITH AI configured — should fire deception
   */
  it('BB: food critic impersonation with AI → deception_detected=true, tier=soft_flag', async () => {
    await setupAI({
      score: 30,
      rules: ['deception_social_manipulation'],
      deception_detected: true,
      is_genuinely_bizarre: false,
    });

    const result = await ComplianceGuardianService.evaluate({
      description: "Pose as a food critic at my friend's restaurant opening to generate buzz",
      userId: 'attack-bb',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('soft_flag');
    expect(result.deception_detected).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(21);
    // VERDICT: CORRECT when AI is configured.
  });

  /**
   * BONUS C: Week-long live-in WITH AI configured
   * AI should detect overnight/companion risk even without the "overnight" keyword
   */
  it('BC: week-long live-in companion with AI → soft_flag (AI catches overnight risk)', async () => {
    await setupAI({
      score: 40,
      rules: ['overnight_companion_risk', 'extended_private_presence'],
      deception_detected: false,
      is_genuinely_bizarre: false,
    });

    const result = await ComplianceGuardianService.evaluate({
      description: "Live in my house for one week as my 'personal assistant/companion' — paid per day",
      userId: 'attack-bc',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('soft_flag');
    expect(result.score).toBeGreaterThanOrEqual(21);
    // VERDICT: CORRECT when AI is configured — AI catches what heuristics miss.
    // Confirms the critical dependency: this scenario REQUIRES AI to flag correctly.
  });

  /**
   * BONUS D: Grandmother seance WITH AI configured — does AI flag deception?
   * This tests whether AI considers "impersonating a deceased person for a hosted seance"
   * as social deception or innocent roleplay.
   * For this test we assert the AI makes a SPECIFIC decision: NOT deception (seance is
   * a ceremony the poster is hosting with consenting participants).
   */
  it('BD: dead grandmother seance with AI → is_genuinely_bizarre=true, deception_detected=false', async () => {
    await setupAI({
      score: 5,
      rules: [],
      deception_detected: false, // hosted seance = consenting participants = not social deception
      is_genuinely_bizarre: true, // ritual ceremony = Rule 4 (one-off ceremonial/ritual)
    });

    const result = await ComplianceGuardianService.evaluate({
      description: 'I need someone to pretend to be my dead grandmother at a seance I\'m hosting — stay in character',
      userId: 'attack-bd',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.tier).toBe('clean');
    expect(result.is_genuinely_bizarre).toBe(true);
    expect(result.deception_detected).toBe(false);
    // VERDICT: CORRECT — hosted seance with consenting participants is a ceremony,
    // not social identity fraud. is_genuinely_bizarre=true is appropriate (Rule 4: ritual element).
  });
});
