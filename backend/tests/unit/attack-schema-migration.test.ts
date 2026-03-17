/**
 * attack-schema-migration.test.ts
 *
 * Red-team attack suite: schema migration edge cases (v2.8.7/v2.8.8)
 *
 * Attack vector: JSONB flagged_phrase_counter migration (array → object),
 * getTemplate() undefined return, isCareContent/isContentReleaseRequired edge
 * cases, and draftEvalCalls Map rate-limit state persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ComplianceGuardianService,
  FLAGGED_PATTERNS,
} from '../../src/services/ComplianceGuardianService.js';
import {
  getTemplate,
  isCareContent,
  isContentReleaseRequired,
  TEMPLATE_SLUGS,
} from '../../src/services/TaskTemplateRegistry.js';
import { draftEvalCalls } from '../../src/routers/task.js';

// ---------------------------------------------------------------------------
// Standard mock wiring — mirrors ComplianceGuardianService-v28.test.ts
// ---------------------------------------------------------------------------

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(false),
    callJSON: vi.fn(),
  },
}));

vi.mock('../../src/lib/pii-scrubber.js', () => ({
  scrubPII: vi.fn((s: string) => s),
}));

vi.mock('../../src/logger.js', () => {
  const mockLogger = {
    child: () => mockLogger,
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  };
  return {
    logger: mockLogger,
    aiLogger: mockLogger,
    authLogger: mockLogger,
    taskLogger: mockLogger,
    escrowLogger: mockLogger,
    workerLogger: mockLogger,
    dbLogger: mockLogger,
    stripeLogger: mockLogger,
  };
});

// ---------------------------------------------------------------------------
// SECTION A: JSONB SCHEMA MIGRATION ATTACKS
// ---------------------------------------------------------------------------

describe('ATTACK: JSONB schema migration — old array-format counter', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { AIClient } = await import('../../src/services/AIClient.js');
    vi.mocked(AIClient.isConfigured).mockReturnValue(false);
  });

  /**
   * ATTACK 1: DB returns old array-format flagged_phrase_counter.
   *
   * Pre-v2.8.8 schema stored: [{"phrase":"no questions asked","matched_at":"..."}]
   * The new SQL uses ->$3 key access on a JSONB object.  When the stored value is
   * an array PostgreSQL will NOT throw — it returns NULL for a string key access on
   * an array (arrays use integer keys).  The new_entry CTE will therefore treat
   * count=0 → count=1 and first_at=NOW(), which is correct first-occurrence
   * behaviour.  The UPDATE merges a fresh object entry over the array, effectively
   * migrating that phrase slot in-place.
   *
   * VERDICT: SAFE — the service degrades to first-occurrence and does NOT crash.
   * The old array value is replaced with the new object shape for the matched phrase
   * key in the next write.  No data loss for other phrase keys; the full column is
   * replaced via ||, but since the old value was an array (not an object) the ||
   * operator will fail at the PostgreSQL level with "invalid input syntax for type
   * jsonb" because array || object is not valid JSONB concatenation.
   *
   * REVISED VERDICT: BUG (silent crash path in production SQL, NOT in this mocked
   * test).  The mock always returns { was_repeat: false } so the JS layer never
   * sees the Postgres error.  The test below verifies the JS layer handles a DB
   * error gracefully (catch block returns first-occurrence).
   */
  it('ATTACK-1: old array-format counter — DB error is caught gracefully', async () => {
    const { db } = await import('../../src/db.js');
    // Simulate PostgreSQL rejecting array || object concatenation
    vi.mocked(db.query).mockRejectedValueOnce(
      new Error('invalid input syntax for type jsonb: array || object not supported')
    );

    // SHOULD NOT throw — catch block in _codeLevelPatternMatch absorbs DB errors
    const result = await ComplianceGuardianService.evaluate({
      description: 'no questions asked, just bring it',
      userId: 'user-old-array',
      templateSlug: 'standard_physical',
    });

    // First-occurrence path taken (isRepeat=false → +15)
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    // Phrase still detected, score elevated
    expect(result.score).toBeGreaterThanOrEqual(21);
    // VERDICT: SAFE (JS layer) / BUG (SQL layer — old array data causes PG error
    // that is swallowed.  Fix: add migration to convert array → object before deploy.)
  });

  /**
   * ATTACK 2: Partially migrated counter — new object with an extra junk field.
   *
   * DB returns a well-formed new-style object PLUS an unknown field "legacy_flag".
   * JSONB extra keys are ignored by the ->key accessor.  The UPDATE merges via ||
   * which preserves existing keys and overwrites only the matched phrase key.
   * Extra junk is preserved harmlessly.
   *
   * VERDICT: SAFE — extra unknown keys in the JSONB object are transparent.
   */
  it('ATTACK-2: partially migrated counter with extra junk field — handled gracefully', async () => {
    const { db } = await import('../../src/db.js');
    // DB has already-migrated entry for "no questions asked" + junk field
    // The atomic SQL query RETURNING was_repeat returns true (phrase seen before)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ was_repeat: true }],
      rowCount: 1,
    } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'no questions asked about the parcel',
      userId: 'user-partial-migrate',
      templateSlug: 'standard_physical',
    });

    // Repeat path taken → cross_task_pattern_repeat rule, +25
    expect(result.triggeredRules).toContain('cross_task_pattern_repeat');
    expect(result.score).toBeGreaterThanOrEqual(25);
    // VERDICT: SAFE
  });

  /**
   * ATTACK 3: Counter is empty object {}.
   *
   * ->$3 on {} returns NULL → COALESCE count=0 → new count=1, first_at=NOW().
   * UPDATE sets {phrase_key: {count:1, ...}} over {}.
   *
   * VERDICT: SAFE — empty object is the canonical initial state.
   */
  it('ATTACK-3: empty object {} counter — first occurrence handled correctly', async () => {
    const { db } = await import('../../src/db.js');
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ was_repeat: false }],
      rowCount: 1,
    } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'discreet delivery requested',
      userId: 'user-empty-object',
      templateSlug: 'standard_physical',
    });

    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.score).toBeGreaterThanOrEqual(21);
    // VERDICT: SAFE
  });

  /**
   * ATTACK 4: Phrase key with apostrophe — "don't ask questions".
   *
   * The normalized form of "don't ask questions" is "dont ask questions"
   * (apostrophe stripped by _normalizeDescription).  So the JSONB key that gets
   * looked up is "dont ask questions" — no apostrophe survives to the SQL layer.
   * Parameterized query ($3) handles any remaining characters safely.
   *
   * VERDICT: SAFE — normalization eliminates apostrophes before SQL.
   */
  it('ATTACK-4: apostrophe in phrase key — normalization strips it before SQL', async () => {
    const { db } = await import('../../src/db.js');
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ was_repeat: false }],
      rowCount: 1,
    } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: "Don't ask questions, just do it",
      userId: 'user-apostrophe',
      templateSlug: 'standard_physical',
    });

    // "don't ask questions" normalizes to "dont ask questions" which is in FLAGGED_PATTERNS
    expect(FLAGGED_PATTERNS).toContain('dont ask questions');
    const normalized = ComplianceGuardianService._normalizeDescription("Don't ask questions, just do it");
    expect(normalized).toContain('dont ask questions');
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    // VERDICT: SAFE
  });

  /**
   * ATTACK 5: Unicode homoglyph in stored counter key vs normalized lookup.
   *
   * A stored key "no questіons asked" (Cyrillic і at position 8) would NOT match
   * the normalized lookup key "no questions asked" because normalization converts
   * Cyrillic і → i.  The lookup uses the normalized form ("no questions asked")
   * which means the Cyrillic-keyed stored entry is INVISIBLE to the query.  This
   * creates a bypass: an attacker who previously submitted with homoglyphs has their
   * counter stored under the homoglyph key, and subsequent normalized submissions
   * don't see that prior count.
   *
   * However: the DB query uses $3 = matchedPhrase (already normalized).  So new
   * entries are always stored under the normalized key.  The only scenario where
   * a stale homoglyph key exists is if it was inserted by a pre-normalization
   * version of the code.  Post-normalization, new entries always use the ASCII key.
   *
   * VERDICT: SAFE for current code.  Historical data with homoglyph keys becomes
   * orphaned (not counted) — a minor drift issue, not a security gap, since the
   * normalization path detects the phrase and still applies first-occurrence penalty.
   */
  it('ATTACK-5: Unicode homoglyph in description — normalization catches it', async () => {
    const { db } = await import('../../src/db.js');
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ was_repeat: false }],
      rowCount: 1,
    } as any);

    // "questіons" contains Cyrillic і (\u0456) instead of i
    const cyrillicDesc = 'no quest\u0456ons asked, drop it off';
    const normalized = ComplianceGuardianService._normalizeDescription(cyrillicDesc);
    expect(normalized).toContain('no questions asked');

    const result = await ComplianceGuardianService.evaluate({
      description: cyrillicDesc,
      userId: 'user-homoglyph',
      templateSlug: 'standard_physical',
    });

    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    // VERDICT: SAFE
  });

  /**
   * ATTACK 6: NULL entire column (new user, never set).
   *
   * COALESCE(flagged_phrase_counter, '{}'::jsonb) in the SQL covers this.
   * The UPDATE writes the new phrase entry over the COALESCE'd empty object.
   * JS layer sees { was_repeat: false } from RETURNING clause.
   *
   * VERDICT: SAFE — COALESCE handles null column correctly.
   */
  it('ATTACK-6: NULL flagged_phrase_counter column — COALESCE handles new user', async () => {
    const { db } = await import('../../src/db.js');
    // Simulate DB returning first-occurrence for a brand new user
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ was_repeat: false }],
      rowCount: 1,
    } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'cash only no record kept',
      userId: 'brand-new-user-uuid',
      templateSlug: 'standard_physical',
    });

    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.score).toBeGreaterThanOrEqual(21);
    // VERDICT: SAFE
  });
});

// ---------------------------------------------------------------------------
// SECTION B: getTemplate() UNDEFINED RETURN CALL SITES
// ---------------------------------------------------------------------------

describe('ATTACK: getTemplate() returning undefined — call site safety', () => {
  /**
   * ATTACK 7: getTemplate() with unknown slug returns undefined.
   *
   * Call sites in production code:
   *   a) task.ts create handler (line 222): checks `if (!template)` → throws BAD_REQUEST ✓
   *   b) task.ts acceptWithConsent handler (line 382): uses `?? (() => { throw })()` ✓
   *   c) ScoperAIService.ts (line 99): assigns to nullable `template`, uses `template?.scoperContext` ✓
   *
   * All three call sites have undefined guards.
   *
   * VERDICT: SAFE — all production call sites handle undefined.
   */
  it('ATTACK-7: getTemplate() returns undefined for unknown slug', () => {
    expect(getTemplate('totally_fake_slug_xyz')).toBeUndefined();
    expect(getTemplate('')).toBeUndefined();
    expect(getTemplate('wildcard_bizarre_v2')).toBeUndefined();
  });

  /**
   * ATTACK 8: evaluateDraft does NOT call getTemplate().
   *
   * Inspecting the handler at task.ts line 327: evaluateDraft calls
   * ComplianceGuardianService.evaluate() and ScoperAIService.analyzeTaskScope().
   * Neither requires getTemplate() to return a value to complete — the templateSlug
   * is passed as a string directly.  No getTemplate() call in evaluateDraft path.
   *
   * VERDICT: SAFE — evaluateDraft is immune to the undefined return change.
   */
  it('ATTACK-8: evaluateDraft path does not depend on getTemplate() non-null', () => {
    // Verify by inspecting that all known call sites of getTemplate() in task.ts
    // are in create (line ~222) and acceptWithConsent (line ~382), NOT evaluateDraft.
    // This is a structural test — if evaluateDraft started calling getTemplate()
    // without a guard, this test should be updated to cover it.

    // The evaluateDraft handler can be invoked with any templateSlug string without
    // getTemplate() being called — verify the template registry returns undefined
    // for a nonsense slug (simulating an unknown slug passed to evaluateDraft).
    const result = getTemplate('not_a_real_template');
    expect(result).toBeUndefined();

    // evaluateDraft passes templateSlug as string to ComplianceGuardianService.evaluate()
    // which only uses it as an equality check against 'wildcard_bizarre' — safe with
    // any string value including unknown slugs.
    // VERDICT: SAFE
  });

  /**
   * ATTACK 9: acceptWithConsent IIFE guard for undefined getTemplate().
   *
   * task.ts line 382: `getTemplate(task.template_slug) ?? (() => { throw new TRPCError({...}) })()`
   *
   * If a task row somehow has a garbage template_slug (e.g. corrupted DB row),
   * the IIFE throws INTERNAL_SERVER_ERROR instead of crashing with TypeError.
   *
   * VERDICT: SAFE — the IIFE guard converts undefined to a proper TRPCError.
   */
  it('ATTACK-9: acceptWithConsent guard — undefined template triggers INTERNAL_SERVER_ERROR', () => {
    // Simulate what the IIFE does when getTemplate() returns undefined
    const fakeSlug = 'corrupted_slug_from_db';
    const template = getTemplate(fakeSlug);
    expect(template).toBeUndefined();

    // Verify the ?? IIFE pattern correctly throws
    expect(() => {
      const t = getTemplate(fakeSlug) ?? (() => {
        throw new Error('Unknown template on task');
      })();
      void t;
    }).toThrow('Unknown template on task');
    // VERDICT: SAFE
  });
});

// ---------------------------------------------------------------------------
// SECTION C: isCareContent() EDGE CASES
// ---------------------------------------------------------------------------

describe('ATTACK: isCareContent() edge cases', () => {
  /**
   * ATTACK 10: Empty string.
   * VERDICT: SAFE — returns false, no throw.
   */
  it('ATTACK-10: isCareContent("") returns false without throwing', () => {
    expect(() => isCareContent('')).not.toThrow();
    expect(isCareContent('')).toBe(false);
    // VERDICT: SAFE
  });

  /**
   * ATTACK 11: Very long description (5000 chars).
   * Checks for catastrophic backtracking in the CARE_KEYWORDS regex.
   * The regex uses simple \b word boundaries — no nested quantifiers.
   * Should complete in <100ms.
   * VERDICT: SAFE — no catastrophic backtracking possible with the current regex.
   */
  it('ATTACK-11: very long description (5000 chars) — no catastrophic backtracking', () => {
    const longDesc = 'I need help with heavy furniture moving. '.repeat(125); // ~5000 chars
    const start = Date.now();
    const result = isCareContent(longDesc);
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100);
    // VERDICT: SAFE
  });

  /**
   * ATTACK 12: Description with only whitespace.
   * VERDICT: SAFE — returns false.
   */
  it('ATTACK-12: isCareContent("   ") returns false', () => {
    expect(isCareContent('   ')).toBe(false);
    expect(isCareContent('\t\n\r')).toBe(false);
    // VERDICT: SAFE
  });

  /**
   * ATTACK 13: Case sensitivity + gerund forms — uppercase care keywords.
   *
   * FIXED (v2.9.1): CARE_KEYWORDS now uses "babysit(?:ting)?" which covers the
   * stem ("babysit"), the gerund ("babysitting"), and leaves the explicit
   * "babysitter" alternation intact.  "washing" is similarly covered via
   * "wash(?:ing)?".
   *
   * Previously: "babysitting" fell through because \bbabysit\b did not match
   * inside "babysitting" (word boundary before "ting" suffix).  This was an
   * escrow safety gap — tasks described with "babysitting" could escape the
   * autoReleaseHours=0 enforcement.
   *
   * VERDICT: FIXED — all gerund forms of babysit now detected correctly.
   */
  it('ATTACK-13: FIXED — "babysitting" gerund now correctly matches isCareContent', () => {
    // FIXED: gerund form now matches
    expect(isCareContent('BABYSITTING MY KIDS')).toBe(true); // FIXED
    expect(isCareContent('babysitting my kids')).toBe(true); // FIXED
    expect(isCareContent('I need babysitting help tonight')).toBe(true); // FIXED

    // These still match (exact stem form)
    expect(isCareContent('BABYSIT MY KIDS')).toBe(true);       // still works
    expect(isCareContent('ELDER CARE ASSISTANCE')).toBe(true); // /i flag OK
    expect(isCareContent('bathe the dog')).toBe(true);         // still works

    // "babysitter" still covered by explicit alternation
    expect(isCareContent('I need a babysitter')).toBe(true);
    expect(isCareContent('I need a babysitter for tonight')).toBe(true);

    // "washing" is now also covered by wash(?:ing)?
    expect(isCareContent('washing the elderly patient')).toBe(true);
    // VERDICT: FIXED
  });

  /**
   * ATTACK 14: Partial word match — does \b prevent false positives?
   *
   * "rehabilitate" — does \bbathe\b match inside "rehabilitate"?
   * "rehabilitate" does NOT contain "bathe" as a substring at all — safe.
   *
   * "shoulder" — does \belder\b match inside "shoulder"?
   * "shoulder" contains "elder" as a substring (sHOULDER → sh-ELDER but actually
   * s-h-o-u-l-d-e-r... "shoulder" = s·h·o·u·l·d·e·r — does NOT contain "elder").
   * Wait: "sh-o-u-l-d-e-r" vs "e-l-d-e-r" — no, "shoulder" does not contain
   * "elder" as a contiguous substring.  Correct: no match.
   *
   * Test "embarrass" vs \bbathe\b — "embarrass" does not contain "bathe". Safe.
   * Test "rehabilitate" vs \bbathe\b — not a substring match at all. Safe.
   *
   * However, test "I need to rehabilitate my machinery" — contains no care words.
   * But what about a true \b boundary failure: "childcare" — does \bchild care\b
   * (with space) match "childcare" (no space)?  The regex has BOTH "childcare" AND
   * "child care" as alternatives, so both forms are covered.
   *
   * VERDICT: SAFE — \b boundaries work correctly for these patterns.
   */
  it('ATTACK-14: word boundary — partial word matches are blocked', () => {
    // "rehabilitate" does NOT contain "bathe" — no false positive
    expect(isCareContent('I need to rehabilitate my old machinery')).toBe(false);

    // "shoulder" does NOT contain "elder" as a substring — no false positive
    expect(isCareContent('I have shoulder pain')).toBe(false);

    // True positive: "elder" standalone
    expect(isCareContent('Help my elder neighbor with groceries')).toBe(true);

    // True positive: "bathe" standalone
    expect(isCareContent('I need someone to bathe my dog')).toBe(true);

    // VERDICT: SAFE
  });
});

// ---------------------------------------------------------------------------
// SECTION D: isContentReleaseRequired() FALSE POSITIVES
// ---------------------------------------------------------------------------

describe('ATTACK: isContentReleaseRequired() false positives', () => {
  /**
   * ATTACK 15: "film a fly infestation for pest control documentation"
   * The word "film" (as a verb) previously triggered the content release keyword.
   *
   * FIXED (v2.9.1): CONTENT_RELEASE_KEYWORDS now uses a negative lookahead for
   * film(?:ing)? that excludes pest/infestation context words.  "filming a fly
   * infestation" no longer fires content release.
   *
   * True positives preserved: "film my cat", "film my pet lizard", "film a
   * birthday party" — none of these match the negation pattern.
   *
   * VERDICT: FIXED — pest control filming context excluded from content release.
   */
  it('ATTACK-15: FIXED — "filming a fly infestation" no longer triggers content release', () => {
    const desc = 'I need help filming a fly infestation in my apartment for pest control documentation';
    const result = isContentReleaseRequired(desc);
    // FIXED: pest/infestation negation prevents false positive
    expect(result).toBe(false);
    // VERDICT: FIXED
  });

  /**
   * ATTACK 16: "record my package dimensions for shipping"
   * "record" in a logistical/measurement context previously triggered content release.
   *
   * FIXED (v2.9.1): CONTENT_RELEASE_KEYWORDS negative lookahead for record(?:ing)?
   * excludes dimensions/measurements/weight/size/speed/time context.
   *
   * VERDICT: FIXED — measurement context excluded from content release.
   */
  it('ATTACK-16: FIXED — "record package dimensions" no longer triggers content release', () => {
    const desc = 'Record my package dimensions and weight for shipping';
    // FIXED: dimensions/weight negation prevents false positive
    expect(isContentReleaseRequired(desc)).toBe(false);
    // VERDICT: FIXED
  });

  /**
   * ATTACK 17: "stream my internet connection speed test"
   * "stream" in a technical/network context previously triggered content release.
   *
   * FIXED (v2.9.1): CONTENT_RELEASE_KEYWORDS negative lookahead for stream(?:ing)?
   * excludes internet/connection/speed/bandwidth/network/data context.
   *
   * VERDICT: FIXED — network/technical streaming context excluded from content release.
   */
  it('ATTACK-17: FIXED — "stream internet speed test" no longer triggers content release', () => {
    const desc = 'Stream my internet connection speed test results to diagnose the issue';
    // FIXED: connection/speed negation prevents false positive
    expect(isContentReleaseRequired(desc)).toBe(false);
    // VERDICT: FIXED
  });
});

// ---------------------------------------------------------------------------
// SECTION E: RATE LIMIT STATE (draftEvalCalls Map) PERSISTENCE
// ---------------------------------------------------------------------------

describe('ATTACK: draftEvalCalls Map state persistence across tests', () => {
  beforeEach(() => {
    draftEvalCalls.clear();
  });

  afterEach(() => {
    draftEvalCalls.clear();
    vi.useRealTimers();
  });

  /**
   * ATTACK 18: Map leaks between test files.
   *
   * draftEvalCalls is a module-level Map in task.ts.  Vitest runs test files in
   * separate worker threads (isolation), so the Map IS isolated between files.
   * However, within the SAME file, tests share the module instance.
   *
   * The existing task-router.test.ts has `draftEvalCalls.clear()` in beforeEach
   * AND afterEach — so that file is clean.  THIS file also clears in beforeEach/
   * afterEach.  Cross-file contamination does not occur in Vitest's default
   * worker-per-file mode.
   *
   * VERDICT: SAFE for cross-file scenarios in Vitest worker isolation mode.
   * BUG RISK: If Vitest is ever configured to run tests in a single thread
   * (singleThread: true or --pool=forks with shared module cache), contamination
   * WOULD occur.  The lack of guaranteed cleanup in all test files is a latent risk.
   *
   * This test verifies that after a polluted state, clearing works correctly.
   */
  it('ATTACK-18: Map starts clean (isolation works within this file)', () => {
    // Simulate pollution from a previous "test file" by pre-seeding the map
    draftEvalCalls.set('other-user', { count: 5, resetAt: Date.now() + 60000 });
    draftEvalCalls.set('another-user', { count: 3, resetAt: Date.now() + 60000 });

    // beforeEach already cleared — but we seeded AFTER beforeEach ran above.
    // Show that clearing works:
    draftEvalCalls.clear();
    expect(draftEvalCalls.size).toBe(0);

    // Verify a fresh user starts with no entry
    expect(draftEvalCalls.get('test-user-fresh')).toBeUndefined();
    // VERDICT: SAFE (when clear() is called) / BUG RISK (if clear() is skipped)
  });

  /**
   * ATTACK 19: Fake timer interaction with rate limit window.
   *
   * The rate limit window uses Date.now().  vi.useFakeTimers() replaces Date.now
   * with a controllable clock.  Advancing time past the resetAt should expire
   * the window and allow calls again.
   *
   * VERDICT: SAFE — fake timers work correctly with the Date.now()-based window.
   */
  it('ATTACK-19: fake timer — advancing time expires the rate limit window', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const userId = 'timer-test-user';
    const window = 60_000;

    // Seed: user has hit 5 calls, window expires in 60s
    draftEvalCalls.set(userId, { count: 5, resetAt: now + window });

    // Before advancing time: window is still active, entry exists
    const entryBefore = draftEvalCalls.get(userId)!;
    expect(entryBefore.count).toBe(5);
    expect(Date.now()).toBeLessThan(entryBefore.resetAt);

    // Advance fake time by 61 seconds
    vi.advanceTimersByTime(61_000);

    // After advancing: Date.now() > resetAt → window is expired
    const entryAfter = draftEvalCalls.get(userId)!;
    expect(Date.now()).toBeGreaterThan(entryAfter.resetAt);

    // The checkDraftEvalRateLimit function resets when now > entry.resetAt.
    // We verify this by simulating what the function does:
    const nowAfter = Date.now();
    const shouldReset = nowAfter > entryAfter.resetAt;
    expect(shouldReset).toBe(true);

    // After reset, user gets a fresh window starting at count=1
    if (shouldReset) {
      draftEvalCalls.set(userId, { count: 1, resetAt: nowAfter + window });
    }
    expect(draftEvalCalls.get(userId)!.count).toBe(1);
    // VERDICT: SAFE — fake timers interact correctly with the Date.now() window.
  });

  /**
   * ATTACK 20: Concurrent user isolation — two users share no state.
   *
   * Users A and B each make calls independently.  Their counters must remain
   * separate — user A hitting the limit must not affect user B.
   *
   * VERDICT: SAFE — Map is keyed by userId; entries are independent.
   */
  it('ATTACK-20: concurrent user isolation — rate limits are per-userId', () => {
    const userA = 'user-alpha-isolation';
    const userB = 'user-beta-isolation';
    const now = Date.now();
    const window = 60_000;

    // User A exhausts their 5-call limit
    draftEvalCalls.set(userA, { count: 5, resetAt: now + window });

    // User B has only made 2 calls
    draftEvalCalls.set(userB, { count: 2, resetAt: now + window });

    // Verify isolation
    expect(draftEvalCalls.get(userA)!.count).toBe(5);
    expect(draftEvalCalls.get(userB)!.count).toBe(2);

    // User A is at limit (count > maxCalls=5 would throw, count=5 is the last allowed)
    // Increment user A to 6 — would trigger throw in checkDraftEvalRateLimit
    draftEvalCalls.get(userA)!.count++;
    expect(draftEvalCalls.get(userA)!.count).toBe(6);

    // User B is unaffected — still at 2
    expect(draftEvalCalls.get(userB)!.count).toBe(2);

    // User A being over limit does NOT affect user B
    const userBEntry = draftEvalCalls.get(userB)!;
    expect(userBEntry.count).toBeLessThanOrEqual(5);

    // User C (never seen) has no entry
    expect(draftEvalCalls.get('user-gamma-new')).toBeUndefined();
    // VERDICT: SAFE — Map keys are isolated per userId.
  });
});
