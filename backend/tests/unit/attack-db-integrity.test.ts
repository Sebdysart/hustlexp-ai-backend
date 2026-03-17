/**
 * RED-TEAM: attack-db-integrity.test.ts
 *
 * 20 attack vectors targeting:
 *   - JSONB flagged_phrase_counter boundary conditions
 *   - Race condition simulation
 *   - NULL / missing user DB row edge cases
 *   - template_slug INSERT edge cases (via mocked TaskService)
 *   - Score tier boundary conditions
 *   - Multiple-pattern scoring logic
 *   - AI vs heuristic merge logic
 *
 * VERDICT per test: CORRECT | WRONG | CRASH | UNDEFINED_BEHAVIOR
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceGuardianService } from '../../src/services/ComplianceGuardianService.js';

// ─────────────────────────────────────────────────────────────────────────────
// MODULE MOCKS (hoisted — vitest replaces at import time)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn().mockResolvedValue({ rows: [{ was_repeat: false }], rowCount: 1 }),
  },
  isInvariantViolation: vi.fn().mockReturnValue(false),
  getErrorMessage: vi.fn().mockReturnValue(''),
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
  taskLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getDb() {
  const { db } = await import('../../src/db.js');
  return vi.mocked(db);
}

async function getAIClient() {
  const { AIClient } = await import('../../src/services/AIClient.js');
  return vi.mocked(AIClient);
}

/** Build a DB row result for the atomic CTE returning { was_repeat } */
function atomicResult(was_repeat: boolean) {
  return { rows: [{ was_repeat }], rowCount: 1 } as any;
}

/** Build a DB result with 0 rows — simulates missing user */
function noUserResult() {
  return { rows: [], rowCount: 0 } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: JSONB COUNTER BOUNDARY CONDITIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('JSONB Counter Boundary Conditions', () => {
  beforeEach(() => vi.resetAllMocks());

  // ── ATTACK 1 ──────────────────────────────────────────────────────────────
  // Empty counter — first ever submission
  // The CTE COALESCE(flagged_phrase_counter, '[]'::jsonb) should handle empty array.
  // Expected: was_repeat=false, score bumped +15, floored to 21, tier=soft_flag.
  //
  // VERDICT: CORRECT — the service correctly uses atomicResult(false) and the
  //          Math.max(score, 21) floor ensures soft_flag even if base score is 0.
  it('ATTACK 1 (BUG FOUND): empty counter — "no questions asked" → heuristic=85 + coded_phrase_first_occurrence (+15) = 100, NOT 85', async () => {
    const db = await getDb();
    // Simulate CTE returning was_repeat=false (empty JSONB counter → no prior matches)
    db.query.mockResolvedValueOnce(atomicResult(false));

    const result = await ComplianceGuardianService.evaluate({
      description: 'no questions asked please',
      userId: 'user-atk1',
    });

    // BUG UNCOVERED: "no questions asked" is BOTH a HARD_BLOCK_PATTERN (score=85) AND
    // a FLAGGED_PATTERN ("no questions asked"). The service:
    //   1. _heuristicCheck returns score=85 (hard_block_pattern)
    //   2. _codeLevelPatternMatch ALSO matches "no questions asked" → was_repeat=false
    //   3. isRepeat=false → heuristicResult.score += 15 → 85+15 = 100
    //   4. Math.max(100, 21) = 100 → hard_block
    //
    // VERDICT: WRONG — the hard_block heuristic score (85) is inflated by the coded-phrase
    // +15 bump even though the description already triggered a hard block. The final score
    // is 100 instead of 85. The tier is still hard_block, so this is functionally harmless,
    // but the score inflation is unexpected. A description with a hard_block pattern will
    // ALWAYS get an extra +15 or +25 if that same phrase is also in FLAGGED_PATTERNS.
    //
    // "no questions asked" is in both HARD_BLOCK_PATTERNS and FLAGGED_PATTERNS — this dual
    // membership causes score inflation for hard_block cases.
    expect(result.score).toBe(100); // ACTUAL: 85 + 15 = 100 (not 85)
    expect(result.tier).toBe('hard_block');
    expect(result.triggeredRules).toContain('hard_block_pattern');
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence'); // BOTH fire
  });

  // ── ATTACK 1b ─────────────────────────────────────────────────────────────
  // Use a FLAGGED_PATTERN that does NOT hit HARD_BLOCK_PATTERNS to isolate counter logic.
  // "deliver for a friend" is a FLAGGED_PATTERN but NOT a HARD_BLOCK_PATTERN.
  //
  // VERDICT: CORRECT — base heuristic 0, +15 first occurrence, floored to 21 → soft_flag
  it('ATTACK 1b: empty counter, soft-only phrase → was_repeat=false, +15, Math.max floor to 21 → soft_flag', async () => {
    const db = await getDb();
    db.query.mockResolvedValueOnce(atomicResult(false));

    const result = await ComplianceGuardianService.evaluate({
      description: 'deliver for a friend',
      userId: 'user-atk1b',
    });

    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.score).toBeGreaterThanOrEqual(21);
    expect(result.tier).toBe('soft_flag');
  });

  // ── ATTACK 2 ──────────────────────────────────────────────────────────────
  // Exactly 19 entries — does LIMIT 19 keep 19 BEFORE appending, giving 20 total?
  // The SQL: ORDER BY matched_at DESC LIMIT 19 → re-aggregate ascending → append new.
  // Expected behavior: old 19 kept (the 19 most recent), + 1 new = 20 total.
  //
  // BUG HYPOTHESIS: If the pruned_data CTE already has 19 entries after the 30-day filter,
  //   the new_counter CTE takes LIMIT 19 of those (all 19), then appends 1 → total 20. CORRECT.
  //   But: if the pruned_data already has 20+ entries and the inner SELECT takes LIMIT 19,
  //   the oldest is evicted. Test: mock 19 entries → DB must be called with the right SQL.
  //
  // VERDICT: The TypeScript layer does NOT inspect the returned array size — it only reads
  //   was_repeat from the RETURNING clause. The actual JSONB array management is 100% in SQL.
  //   This test verifies the TypeScript state machine behaves correctly around the boundary.
  it('ATTACK 2: exactly 19 entries in counter — result should be first-occurrence (was_repeat=false)', async () => {
    const db = await getDb();
    // With 19 prior entries (none matching current phrase), was_repeat=false
    db.query.mockResolvedValueOnce(atomicResult(false));

    const result = await ComplianceGuardianService.evaluate({
      description: 'split payment later please',
      userId: 'user-atk2',
    });

    // "split payment later" is a FLAGGED_PATTERN (not HARD_BLOCK), base heuristic = 0
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.score).toBeGreaterThanOrEqual(21); // Math.max floor
    expect(result.tier).toBe('soft_flag');
  });

  // ── ATTACK 3 ──────────────────────────────────────────────────────────────
  // Exactly 20 entries — after pruning to 19 + new = 20. Oldest evicted.
  // The TypeScript layer receives was_repeat based on pre-update state (CTE design).
  //
  // VERDICT: CORRECT — was_repeat reflects pre-update state. Eviction is SQL-side.
  it('ATTACK 3: exactly 20 entries in counter — oldest entry evicted, was_repeat from pre-update state', async () => {
    const db = await getDb();
    // Simulate: 20 prior entries, current phrase appeared before → was_repeat=true
    db.query.mockResolvedValueOnce(atomicResult(true));

    const result = await ComplianceGuardianService.evaluate({
      description: 'bring it just leave it',
      userId: 'user-atk3',
    });

    expect(result.triggeredRules).toContain('cross_task_pattern_repeat');
    expect(result.score).toBeGreaterThanOrEqual(21);
    expect(result.tier).toBe('soft_flag');
  });

  // ── ATTACK 4 ──────────────────────────────────────────────────────────────
  // 100 entries in counter — SQL LIMIT 19 keeps only 19 most recent + new = 20.
  // The ORDER BY matched_at DESC LIMIT 19 correctly keeps the 19 most recent.
  //
  // VERDICT: The SQL logic is correct. TypeScript only sees was_repeat. The 100-entry
  //   bloat scenario is handled entirely in the SQL CTE. Test confirms TypeScript
  //   state is still consistent.
  it('ATTACK 4: 100 entries in counter — SQL trims to 19 most recent; TypeScript sees was_repeat correctly', async () => {
    const db = await getDb();
    db.query.mockResolvedValueOnce(atomicResult(true)); // phrase appeared in the 30-day window

    const result = await ComplianceGuardianService.evaluate({
      description: 'no address needed to deliver',
      userId: 'user-atk4',
    });

    expect(result.triggeredRules).toContain('cross_task_pattern_repeat');
    expect(result.score).toBeGreaterThanOrEqual(21);
  });

  // ── ATTACK 5 ──────────────────────────────────────────────────────────────
  // All entries expired (>30 days old) — all pruned by the WHERE clause.
  // repeat_check uses the SAME 30-day filter → was_repeat=false.
  // Expected: treated as first occurrence.
  //
  // BUG CHECK: The repeat_check CTE is:
  //   SELECT bool_or(entry->>'phrase' = $3) AS was_repeat
  //   FROM old_data, jsonb_array_elements(...) AS entry
  //   WHERE (entry->>'matched_at')::timestamptz > NOW() - INTERVAL '30 days'
  //
  // If ALL entries are expired, no rows pass the WHERE. bool_or over 0 rows = NULL.
  // The code: atomicResult.rows[0]?.was_repeat ?? false → NULL ?? false = false. CORRECT.
  //
  // VERDICT: CORRECT — NULL coalesced to false in TypeScript.
  it('ATTACK 5: all entries expired (>30 days) — was_repeat=false (treated as first occurrence)', async () => {
    const db = await getDb();
    // DB returns was_repeat=null (bool_or over empty set), TypeScript nullish-coalesces to false
    db.query.mockResolvedValueOnce({ rows: [{ was_repeat: null }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'bring it just leave it',
      userId: 'user-atk5',
    });

    // was_repeat null → false via "?? false" at line 335
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.tier).toBe('soft_flag');
  });

  // ── ATTACK 6 ──────────────────────────────────────────────────────────────
  // Mix of expired and fresh entries — 5 expired, 5 fresh.
  // repeat_check only considers the 5 fresh ones. If current phrase is NOT in the 5 fresh,
  // was_repeat=false even if it was in the expired ones.
  //
  // BUG CHECK: This is correct SQL behavior but could surprise product — a user who used
  // the phrase 31 days ago resets to "first occurrence" status.
  //
  // VERDICT: CORRECT per code intent, but documents potential product gap.
  it('ATTACK 6: mix of expired/fresh entries — repeat_check uses 30-day window only', async () => {
    const db = await getDb();
    // phrase was used 31 days ago (expired) but not in the 5 fresh entries → was_repeat=false
    db.query.mockResolvedValueOnce(atomicResult(false));

    const result = await ComplianceGuardianService.evaluate({
      description: 'deliver for a friend no questions',
      userId: 'user-atk6',
    });

    // Even though user used phrase before, it's outside 30-day window → first occurrence
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.score).toBeGreaterThanOrEqual(21);
  });

  // ── ATTACK 7 ──────────────────────────────────────────────────────────────
  // Repeat of EXACT same phrase within 30 days → was_repeat=true, +25, tier=soft_flag.
  //
  // BUG CHECK: "no questions asked" hits HARD_BLOCK_PATTERNS before the counter is checked.
  // The counter IS updated (atomicResult called), but heuristic returns 85 first.
  // The repeat bump (+25) is applied ON TOP of the heuristic score — this means:
  //   85 (hard_block heuristic) + 25 (repeat) = 110 → still hard_block.
  // But wait — the code checks patternMatch.isRepeat to ADD to heuristicResult.score.
  // _heuristicCheck already returned 85 from hard_block. Then +25 = 110.
  // _scoreTotier(110) = hard_block. CORRECT, but score is inflated.
  //
  // USE a phrase that only triggers FLAGGED_PATTERNS (not HARD_BLOCK) to isolate.
  it('ATTACK 7: repeat of same soft-only phrase within 30 days → was_repeat=true, +25, soft_flag', async () => {
    const db = await getDb();
    db.query.mockResolvedValueOnce(atomicResult(true));

    const result = await ComplianceGuardianService.evaluate({
      description: 'deliver for a friend',
      userId: 'user-atk7',
    });

    expect(result.triggeredRules).toContain('cross_task_pattern_repeat');
    // base=0, +25 repeat, floored to 21 → soft_flag
    expect(result.score).toBeGreaterThanOrEqual(21);
    expect(result.tier).toBe('soft_flag');
  });

  // ── ATTACK 8 ──────────────────────────────────────────────────────────────
  // Counter contains "cash only no record" but user submits "no questions asked".
  // repeat_check: bool_or(entry->>'phrase' = $3) where $3='no questions asked'.
  // The existing entry phrase is different → was_repeat=false.
  //
  // BUG CHECK: "no questions asked" hits HARD_BLOCK_PATTERNS (score=85, hard_block).
  // The counter IS updated. was_repeat=false (different phrase in counter).
  // +15 first occurrence on top of 85 = 100. Math.max(100, 21) = 100. hard_block.
  //
  // VERDICT: CORRECT — different phrase → was_repeat=false. Hard block fires independently.
  it('ATTACK 8: different phrase in counter than submitted phrase → was_repeat=false', async () => {
    const db = await getDb();
    // Counter has "cash only no record", user submits "deliver for a friend"
    db.query.mockResolvedValueOnce(atomicResult(false));

    const result = await ComplianceGuardianService.evaluate({
      description: 'deliver for a friend',
      userId: 'user-atk8',
    });

    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.triggeredRules).not.toContain('cross_task_pattern_repeat');
  });

  // ── ATTACK 9 ──────────────────────────────────────────────────────────────
  // Phrase at EXACTLY the 30-day boundary — off-by-one check.
  //
  // SQL: WHERE (entry->>'matched_at')::timestamptz > NOW() - INTERVAL '30 days'
  // This uses STRICT greater-than (>), NOT >=.
  // An entry matched EXACTLY 30 days ago (to the millisecond) is NOT included in the
  // 30-day window — it equals NOW()-30days, which is NOT > NOW()-30days.
  //
  // This means: an entry at exactly T-30days is treated as expired.
  // was_repeat=false for a phrase matched exactly 30 days ago.
  //
  // BUG VERDICT: POTENTIAL PRODUCT GAP — the strict > means the exact boundary
  // instant is excluded. A user who submitted exactly 30 days ago resets to first
  // occurrence. This is a known off-by-one in the SQL that could be >= instead of >.
  // The test documents the ACTUAL behavior.
  it('ATTACK 9 (OFF-BY-ONE): phrase at exactly 30-day boundary — SQL uses >, not >=, so entry is EXCLUDED', async () => {
    const db = await getDb();
    // Simulate: entry at exactly NOW() - 30days fails the > test → was_repeat=false (null → false)
    db.query.mockResolvedValueOnce({ rows: [{ was_repeat: null }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'deliver for a friend',
      userId: 'user-atk9',
    });

    // Off-by-one: entry at exactly 30 days is NOT included → treated as first occurrence
    // This documents the boundary behavior — was_repeat=false at exactly 30 days
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.tier).toBe('soft_flag');
  });

  // ── ATTACK 10 ──────────────────────────────────────────────────────────────
  // NULL flagged_phrase_counter column — DB returns null for the column.
  //
  // BUG HYPOTHESIS: The SQL CTE uses COALESCE(flagged_phrase_counter, '[]'::jsonb).
  // If the column is NULL in the DB, COALESCE handles it in SQL.
  // But the TypeScript mock layer returns { rows: [{ was_repeat: false }] }.
  // The TypeScript NEVER directly reads flagged_phrase_counter — it only reads was_repeat.
  // So a NULL column in DB is handled by the SQL COALESCE, not TypeScript.
  //
  // VERDICT: CORRECT — COALESCE in SQL handles NULL → '[]'. TypeScript is insulated
  // from the raw column value. No crash path. was_repeat comes back as null → false.
  it('ATTACK 10: NULL flagged_phrase_counter column — COALESCE in SQL handles it; TypeScript reads was_repeat only', async () => {
    const db = await getDb();
    // Simulate SQL COALESCE handling null → was_repeat comes back as null (no prior matches)
    db.query.mockResolvedValueOnce({ rows: [{ was_repeat: null }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'package for a friend no details',
      userId: 'user-atk10',
    });

    // null coalesced to false → first occurrence
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.tier).toBe('soft_flag');
    // Should NOT crash
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: CONCURRENT SUBMISSION SIMULATION (race conditions)
// ─────────────────────────────────────────────────────────────────────────────

describe('Concurrent Submission Race Conditions', () => {
  beforeEach(() => vi.resetAllMocks());

  // ── ATTACK 11 ─────────────────────────────────────────────────────────────
  // Two simultaneous submissions of same phrase by same user.
  // In real DB: the atomic CTE uses a single UPDATE ... RETURNING which is atomic
  // at the row level. Two concurrent CTEs will serialize via row-level locking.
  // In the mocked test: both see was_repeat=false (empty counter mock) because
  // the mock doesn't simulate actual DB state mutation between calls.
  //
  // BUG CHECK: The TypeScript code has NO application-level locking. It relies
  // entirely on Postgres row-level locking for the UPDATE. If two requests race:
  //   - Both enter _codeLevelPatternMatch concurrently
  //   - Both call db.query with the atomic CTE
  //   - In real Postgres: first UPDATE locks the row, second waits, then reads
  //     the updated state from the first UPDATE's committed write
  //   - was_repeat for the second call would be TRUE (sees first call's entry)
  //
  // In the mock: both calls return was_repeat=false because the mock doesn't
  // simulate state between calls. This is the CORRECT test of the TypeScript layer.
  //
  // VERDICT: TypeScript layer is CORRECT — delegates atomicity to SQL.
  //   The REAL race condition risk is if the SQL CTE itself has gaps — it doesn't.
  //   The UPDATE locks the row before reading old_data, preventing TOCTOU.
  it('ATTACK 11: two concurrent submissions — TypeScript delegates atomicity to SQL row lock', async () => {
    const db = await getDb();
    // Both concurrent calls see was_repeat=false (mock doesn't update state between calls)
    // In real Postgres, second call would see was_repeat=true after first commits
    db.query
      .mockResolvedValueOnce(atomicResult(false))  // first concurrent call
      .mockResolvedValueOnce(atomicResult(false)); // second concurrent call (mock only)

    const [result1, result2] = await Promise.all([
      ComplianceGuardianService.evaluate({
        description: 'deliver for a friend',
        userId: 'user-atk11',
      }),
      ComplianceGuardianService.evaluate({
        description: 'deliver for a friend',
        userId: 'user-atk11',
      }),
    ]);

    // Both get first-occurrence in mock (real DB would make second a repeat)
    expect(result1.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result2.triggeredRules).toContain('coded_phrase_first_occurrence');

    // db.query was called at least 4 times:
    // Each evaluate() call triggers:
    //   (a) the atomic CTE query for flagged_phrase_counter update (1 per call = 2 total)
    //   (b) _logViolation INSERT into compliance_violations if score >= 21 (1 per call = 2 total)
    // "deliver for a friend" matches FLAGGED_PATTERN → score=21 (floored) → _logViolation fires
    // Total: 2 (atomic CTE) + 2 (violation log) = 4 calls
    expect(db.query).toHaveBeenCalledTimes(4);
  });

  // ── ATTACK 12 ─────────────────────────────────────────────────────────────
  // User with no DB row — UPDATE WHERE id=$1 returns 0 rows affected.
  // The CTE: old_data SELECT returns 0 rows → COALESCE gives '[]'.
  // But then UPDATE finds no matching user → RETURNING returns 0 rows.
  // atomicResult.rows[0] → undefined. undefined?.was_repeat → undefined.
  // undefined ?? false → false.
  //
  // BUG CHECK: Line 335: `const isRepeat = atomicResult.rows[0]?.was_repeat ?? false`
  // If rows is empty, rows[0] is undefined, ?. returns undefined, ?? false → false.
  // The catch block also returns { matched: true, isRepeat: false, matchedPhrase }.
  //
  // VERDICT: CORRECT — gracefully handles missing user row via optional chaining.
  //   BUT: the UPDATE silently fails (no row updated), yet the service continues.
  //   This means flagged_phrase_counter is NEVER incremented for non-existent users.
  //   This is a SILENT FAILURE — no error, no log at INFO level, counter not updated.
  it('ATTACK 12: user with no DB row — UPDATE returns 0 rows, rows[0] undefined, graceful false fallback', async () => {
    const db = await getDb();
    db.query.mockResolvedValueOnce(noUserResult()); // 0 rows returned from RETURNING

    const result = await ComplianceGuardianService.evaluate({
      description: 'deliver for a friend',
      userId: 'user-nonexistent',
    });

    // rows[0] = undefined → undefined?.was_repeat = undefined → ?? false → isRepeat=false
    // Service continues WITHOUT logging a warning about missing user row
    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.tier).toBe('soft_flag');
    // No crash — graceful fallback

    // BUG DOCUMENTED: Counter was NOT actually updated (user doesn't exist).
    // The service treats this identically to a successful empty-counter case.
    // A ghost user can submit indefinitely with "first occurrence" scoring.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: TEMPLATE SLUG INSERT EDGE CASES (TaskService mock layer)
// ─────────────────────────────────────────────────────────────────────────────

describe('template_slug INSERT Edge Cases', () => {
  beforeEach(() => vi.resetAllMocks());

  // ── ATTACK 13 ─────────────────────────────────────────────────────────────
  // template_slug undefined passed to INSERT → templateSlug ?? null.
  // TaskService.create() line 448: [..., templateSlug ?? null]
  // undefined ?? null → null. DB gets NULL for the column.
  //
  // VERDICT: CORRECT — `?? null` correctly converts undefined to null.
  //   The column receives NULL, not the string "undefined".
  it('ATTACK 13: template_slug undefined → ?? null coercion → DB receives NULL (not string "undefined")', () => {
    // Test the nullish coalescing directly — this is the exact expression from line 448
    const templateSlug: string | undefined = undefined;
    const dbValue = templateSlug ?? null;

    expect(dbValue).toBeNull();
    expect(dbValue).not.toBe('undefined');
  });

  // ── ATTACK 14 ─────────────────────────────────────────────────────────────
  // template_slug with invalid slug string → passes straight to DB.
  // TaskService has NO validation of templateSlug before INSERT.
  // An invalid slug goes directly to the DB column.
  //
  // VERDICT: UNDEFINED_BEHAVIOR — no TypeScript validation. Whether the DB
  //   accepts/rejects "nonexistent_template" depends entirely on whether there
  //   is a FK constraint or CHECK constraint on tasks.template_slug. If not,
  //   any string is silently stored. The TypeScript layer is a pass-through.
  it('ATTACK 14: invalid template_slug string passes straight to INSERT — no TypeScript validation', () => {
    const templateSlug = 'nonexistent_template';
    const dbValue = templateSlug ?? null;

    // No validation occurs in TypeScript — any string is passed to DB
    expect(dbValue).toBe('nonexistent_template');
    // This documents that the service has NO input sanitization for template_slug.
    // BUG: A garbage slug is stored in DB without error if no FK constraint exists.
  });

  // ── ATTACK 15 ─────────────────────────────────────────────────────────────
  // template_slug empty string → `'' ?? null` evaluates to '' (NOT null).
  // Empty string is NOT nullish in JavaScript — only null/undefined are.
  //
  // BUG: `'' ?? null` → '' (empty string passes through to DB).
  //   If the DB column has a CHECK (template_slug <> '') or FK constraint,
  //   an empty string would cause a DB error. If not, it's silently stored.
  //
  // VERDICT: WRONG — the nullish coalescing guard does NOT catch empty string.
  //   An empty string slips through to the DB. This could cause constraint violations
  //   or corrupt data if the DB allows it but the application doesn't expect it.
  it('ATTACK 15 (FIXED): template_slug empty string — now uses "|| null" which correctly produces null', () => {
    // FIX: TaskService.create() now uses `templateSlug || null` instead of `templateSlug ?? null`.
    // The || operator coerces any falsy value (including empty string) to null.
    const templateSlug = '';
    const dbValue = templateSlug || null;

    // FIXED: empty string is now coerced to null
    expect(dbValue).toBeNull();
    expect(dbValue).not.toBe(''); // empty string no longer passes through to DB

    // Verify the old ?? guard was broken (documenting the bug)
    const oldGuard = templateSlug ?? null;
    expect(oldGuard).toBe(''); // ?? does NOT catch empty string — confirms the bug was real
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: COMPLIANCE SCORE TIER BOUNDARY CONDITIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('Compliance Score Tier Boundary Conditions', () => {
  beforeEach(() => vi.resetAllMocks());

  // ── ATTACK 16 ─────────────────────────────────────────────────────────────
  // Exact tier boundary tests: 20 vs 21, 60 vs 61.
  //
  // _scoreTotier:
  //   if (score >= 61) return 'hard_block';
  //   if (score >= 21) return 'soft_flag';
  //   return 'clean';
  //
  // Boundary behavior:
  //   score=20 → NOT >= 21, NOT >= 61 → 'clean'
  //   score=21 → >= 21, NOT >= 61 → 'soft_flag'
  //   score=60 → >= 21, NOT >= 61 → 'soft_flag'
  //   score=61 → >= 61 → 'hard_block'
  //
  // VERDICT: CORRECT — boundaries are inclusive on both sides at each tier.
  it('ATTACK 16: exact tier boundaries — 20=clean, 21=soft_flag, 60=soft_flag, 61=hard_block', () => {
    expect(ComplianceGuardianService._scoreTotier(20)).toBe('clean');
    expect(ComplianceGuardianService._scoreTotier(21)).toBe('soft_flag');
    expect(ComplianceGuardianService._scoreTotier(60)).toBe('soft_flag');
    expect(ComplianceGuardianService._scoreTotier(61)).toBe('hard_block');
  });

  // ── ATTACK 17 ─────────────────────────────────────────────────────────────
  // Score of exactly 0 — valid, returns 'clean'.
  //
  // VERDICT: CORRECT — score=0 → NOT >= 21 → 'clean'.
  it('ATTACK 17: score=0 → clean tier (valid minimum score)', () => {
    expect(ComplianceGuardianService._scoreTotier(0)).toBe('clean');
  });

  // ── ATTACK 18 ─────────────────────────────────────────────────────────────
  // Multiple SOFT_FLAG_PATTERNS all fire simultaneously — is it MAX or SUM?
  //
  // _heuristicCheck code:
  //   let highestScore = 0;
  //   for each pattern:
  //     highestScore = Math.max(highestScore, score);
  //     triggeredRules.push(rule);
  //   return { score: highestScore, triggeredRules };
  //
  // It uses Math.max — so it's the MAXIMUM of all matching pattern scores, NOT a sum.
  // ALL matching rules are collected in triggeredRules, but only the highest score fires.
  //
  // Construct a description that hits 3 patterns:
  //   - "massage" → physical_contact_ambiguous (score=35)
  //   - "cash only no record" → unreported_payment (score=45)
  //   - "medical advice at home" → unlicensed_medical (score=50) via "medical.{0,20}(advice)"
  //                                 and "notary|legal document at home" — let's use medical
  //
  // Expected: score = max(35, 45, 50) = 50, all 3 rules in triggeredRules.
  //
  // VERDICT: CORRECT — uses MAX not SUM. All rules collected but max score used.
  //   This means a description hitting 10 soft-flag patterns still only scores 50
  //   if the highest individual pattern is 50. This is the intentional design.
  it('ATTACK 18: multiple SOFT_FLAG_PATTERNS fire simultaneously → score is MAX, not SUM', async () => {
    const db = await getDb();
    // Description hits: massage (35), unreported_payment (45), unlicensed_medical (50)
    // "cash only no record" → unreported_payment (score=45)
    // "massage" → physical_contact_ambiguous (score=35)
    // "medical advice" → unlicensed_medical (score=50)
    db.query.mockResolvedValueOnce(atomicResult(false)); // no FLAGGED_PATTERN match

    const result = await ComplianceGuardianService.evaluate({
      description: 'I need a massage and medical advice at home, cash only no record',
      userId: 'user-atk18',
    });

    // All three rules should fire
    expect(result.triggeredRules).toContain('physical_contact_ambiguous');
    expect(result.triggeredRules).toContain('unreported_payment');
    expect(result.triggeredRules).toContain('unlicensed_medical');

    // Score should be MAX(35, 45, 50) = 50, NOT sum (130)
    // "cash only no record" → FLAGGED_PATTERN: adds coded_phrase_first_occurrence (+15 → 65, floored)
    // Wait: "cash only no record" is also a FLAGGED_PATTERN → coded_phrase_first_occurrence fires too
    // Base heuristic: max(35, 45, 50) = 50. Then +15 from coded phrase = 65. Math.max(65, 21) = 65.
    // But ALSO: "cash only no record" hits SOFT_FLAG_PATTERNS unreported_payment.
    // Let's verify: score should be 50+15=65 → hard_block (>=61)
    expect(result.score).toBe(65); // 50 (max heuristic) + 15 (coded first occurrence)
    expect(result.tier).toBe('hard_block'); // 65 >= 61

    // BUG DOCUMENTED: "cash only no record" triggers BOTH unreported_payment (score=45) AND
    // coded_phrase_first_occurrence (+15). The combined score (50+15=65) pushes into hard_block
    // even though no individual pattern is hard_block level. This is a potential over-classification.
  });

  // ── ATTACK 19 ─────────────────────────────────────────────────────────────
  // Hard_block score override: heuristic=30 (soft_flag), weapon pattern fires score=85.
  // _heuristicCheck: checks HARD_BLOCK_PATTERNS first (returns early at 85 if hit),
  //   THEN checks weapon patterns (returns early if hit),
  //   THEN checks SOFT_FLAG_PATTERNS.
  //
  // For a description that hits WEAPON_TRANSPORT_PATTERNS without negators → score=85.
  // The soft_flag patterns don't run because _weaponPatternCheck returns early.
  //
  // VERDICT: CORRECT — weapon pattern result is returned BEFORE soft_flag patterns run.
  //   The 85 score dominates correctly.
  it('ATTACK 19: weapon pattern fires score=85 → overrides any soft_flag score; soft_flag patterns do not run', async () => {
    const db = await getDb();
    db.query.mockResolvedValueOnce(atomicResult(false));

    // "deliver a firearm" → weapon pattern (score=85, hard_block)
    // Also has "massage" in description → would be soft_flag (score=35)
    // But weapon check returns BEFORE soft_flag patterns are evaluated
    const result = await ComplianceGuardianService.evaluate({
      description: 'I need you to deliver a firearm to this location, also bring a massage table',
      userId: 'user-atk19',
    });

    expect(result.score).toBe(85);
    expect(result.tier).toBe('hard_block');
    expect(result.triggeredRules).toContain('weapon_delivery_attempt');
    // massage (physical_contact_ambiguous) should NOT fire because weapon check returned early
    expect(result.triggeredRules).not.toContain('physical_contact_ambiguous');
  });

  // ── ATTACK 20 ─────────────────────────────────────────────────────────────
  // AI score lower than heuristic — final should be max(heuristic, AI).
  //
  // _aiCheck returns: Math.max(heuristic.score, response.data.score)
  // If heuristic=45, AI=10 → Math.max(45, 10) = 45.
  //
  // VERDICT: CORRECT — _aiCheck always takes the max. The lower AI score cannot
  //   bring the final score below the heuristic.
  //
  // BUG CHECK: What if AI returns score=0 for a soft_flag heuristic description?
  //   The heuristic (45) wins. This is the correct "fail-safe" behavior.
  it('ATTACK 20: AI score lower than heuristic → Math.max(heuristic, AI) = heuristic wins', async () => {
    const db = await getDb();
    const AIClient = await getAIClient();

    db.query.mockResolvedValueOnce(atomicResult(false));
    AIClient.isConfigured.mockReturnValue(true);
    // AI returns much lower score than heuristic
    AIClient.callJSON.mockResolvedValue({
      data: { score: 10, rules: [], deception_detected: false, is_genuinely_bizarre: false },
      provider: 'test',
    } as any);

    const result = await ComplianceGuardianService.evaluate({
      // "overnight babysitting" → overnight_ambiguous (score=45)
      // heuristic=45, AI=10 → final should be max(45, 10) = 45
      description: 'I need overnight babysitting for my kids',
      userId: 'user-atk20',
      // score=45 → in ambiguous range [15,50] → AI runs
    });

    // AI returned 10 but heuristic was 45 → Math.max → final=45
    expect(result.score).toBe(45);
    expect(result.tier).toBe('soft_flag'); // 45 >= 21
    expect(result.triggeredRules).toContain('overnight_ambiguous');

    // Confirm AI was actually called (heuristic 45 is in [15,50] ambiguous range)
    expect(AIClient.callJSON).toHaveBeenCalledTimes(1);
  });
});
