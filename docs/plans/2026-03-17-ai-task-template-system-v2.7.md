# HustleXP AI Task Flow — MAX TIER Bulletproof Template System v2.7
*(Final Architectural Decision Locked — Contradiction & Gaming Path Closed, Engineering Handoff Ready)*

---

## What This Document Is

This is the canonical engineering spec for the AI Task Template System v2.7.
It supersedes v2.1 (implemented Mar 2026). All v2.1 foundation remains; this document describes
the six targeted additions that close every identified edge case.

---

## ✅ What We Kept From v2.1 (Foundation — Do Not Touch)

- Wildcard template + deterministic flag multipliers
- Required Mutual Consent Checklist (content_creator + wildcard_bizarre)
- 75% late-cancel protection (content_creator)
- "Vibe wasn't right" = auto-reject
- Hard/soft illegal_risk_score tiers
- Compliance Guardian heuristic + AI check pipeline
- TaskRiskClassifier.classifyWithTemplate (flags only raise tier, never lower)
- ScoperAI template context injection
- ProofService.validateProofForCriteria (type-aware)
- tRPC procedures: evaluateDraft, acceptWithConsent, getComplianceStatus

---

## v2.7 Additions — Six Changes, Zero Architecture Modifications

### Change 1: FLAGGED_PATTERNS Code-First Matcher (Fix 3 — Deterministic)

**Location:** `ComplianceGuardianService.ts`

Before the LLM call, run exact normalized string matching (lowercase, trim, strip all
punctuation including unicode variants, collapse whitespace) on the task description against
`ComplianceGuardianService.FLAGGED_PATTERNS` — a constant of 12 high-signal patterns and
their common surface variants.

```
FLAGGED_PATTERNS = [
  "no questions asked",
  "dont ask questions",
  "no questions",
  "drop it off no details",
  "deliver for a friend no questions",
  "discreet delivery",
  "cash only no record",
  "split payment later",
  "deliver for a friend",
  "bring it just leave it",
  "no address needed",
  "package for a friend no details"
]
```

If any pattern matches the current task description (after normalization):
1. Fetch the poster's `flagged_phrase_counter` JSONB from `users` table.
2. Prune entries older than 30 days (on-write, before append).
3. Append `{ phrase: <matched_pattern>, matched_at: <ISO timestamp> }`.
4. Write back the pruned + appended array.
5. If the counter (after pruning) already contained the same phrase → bump compliance
   score +15 and add `cross_task_pattern_repeat` to triggeredRules.

**Grounded claim:** Cross-task detection for known patterns is 100% deterministic string match.
The LLM only augments for novel patterns not in the list. The counter behaves exactly as written.

---

### Change 2: Guardian Returns `deception_detected` + `is_genuinely_bizarre` (Fix 2 + Fix 8)

**Location:** `ComplianceGuardianService.ts` — `ComplianceResult` interface + `_aiCheck` method

Add two new boolean fields to `ComplianceResult` and `ComplianceNotes`:
- `deception_detected: boolean` — Guardian detects social deception (fake identity, fake relationship, pretend professional)
- `is_genuinely_bizarre: boolean` — LLM-heuristic evaluation of five rules (see below)

**Updated `_aiCheck` system prompt** includes:

```
DECEPTION DETECTION:
Return deception_detected: true if the task involves the Hustler pretending to be someone
they are not in a social context (fake boyfriend/girlfriend/friend/professional/colleague).
Innocent roleplay for creative/performance tasks is NOT deception.

GENUINE BIZARRENESS HEURISTIC (5 rules):
Evaluate is_genuinely_bizarre using active + corroborating logic:
  Active rules (at least one must fire):
    Rule 1: Task requires acting, roleplay, or scripted dialogue
    Rule 3: Task requires audience interaction or performance for an audience
    Rule 4: Task is a one-off ceremonial or ritual element (e.g., scattering ashes,
            cultural ceremony, unique life-event ritual)
  Corroborating rules (at least one must also fire alongside an active rule):
    Rule 2: Task has no standard physical labor outcome (not delivery/assembly/cleaning/repair)
    Rule 5: Task is explicitly a performance in a private setting (private show, private
            ceremony, private serenade) — NOT simply "a task that takes place at home"

is_genuinely_bizarre = true ONLY IF: (Rule1 OR Rule3 OR Rule4) AND (Rule2 OR Rule5)
Rule 2 and Rule 5 cannot satisfy the threshold on their own.

Examples:
  "Scatter my grandfather's ashes at a hiking peak" → Rule4 + Rule2 → true
  "Pack my grandmother's antiques — it's a ceremonial one-off" → Rule4 only → false
  "Come cheer me up after my breakup at my apartment" → Rule2 + Rule5 → false (no active rule)
  "Pretend to be my boyfriend at grandma's party" → Rule1 + Rule2 → true (but deception_detected
   also true, so ScoperAI will zero the multiplier regardless)
```

**Updated JSON response shape:**
```json
{ "score": number, "rules": string[], "deception_detected": boolean, "is_genuinely_bizarre": boolean }
```

**Important:** `is_genuinely_bizarre` is evaluated as a heuristic-guided LLM judgment inside
the Guardian prompt. It is NOT code-level keyword matching (unlike the 12-pattern counter).
This keeps the decision inside the single existing Guardian call and lets the LLM apply full
context (e.g., "private-location performance" only triggers for actual performance tasks, not
routine home cleaning). The aggregation threshold is enforced by the LLM following the embedded
logic, not by code.

**Grounded claim:** Rule 4 + Rule 5 gaming is significantly harder with LLM evaluation.
Casual framing fails. Determined actors using explicit performance language may still trigger it,
but expected value of gaming is negative for rational actors.

> **Note for future engineering:** Guardian handles four outputs in one call (compliance score,
> deception detection, cross-task novel patterns, bizarre heuristic). If Guardian reliability
> degrades in production, the first split should be bizarre heuristic into a separate lightweight call.

---

### Change 3: ScoperAI Reads Guardian Outputs for Multiplier Decisions (Fix 2 + Fix 8)

**Location:** `ScoperAIService.ts` — `analyzeTaskScope` input + multiplier block

Add optional `complianceResult?: ComplianceResult` to `ScoperInput`.

After wildcard multiplier block, apply these two deterministic overrides:

```
if (complianceResult?.deception_detected) {
  // Zero all bonuses — deception gets no premium
  proposal.suggested_price_cents = basePriceBeforeMultipliers;
  // re-sync XP + difficulty
}

if (
  input.templateSlug === TEMPLATE_SLUGS.WILDCARD_BIZARRE &&
  !complianceResult?.is_genuinely_bizarre
) {
  // Not genuinely bizarre — cap total premium at 1.1x
  const capPrice = Math.round(basePriceBeforeMultipliers * 1.1);
  proposal.suggested_price_cents = Math.min(proposal.suggested_price_cents, capPrice);
  // re-sync XP + difficulty
}
```

**Guardian → ScoperAI handoff remains decoupled:** Guardian returns booleans. ScoperAI alone
owns the multiplier decision. No pricing logic lives in ComplianceGuardianService.

---

### Change 4: TaskTemplateRegistry — `one_line_desc` + Manifest Endpoint (Fix 6)

**Location:** `TaskTemplateRegistry.ts` + new endpoint `GET /templates/manifest`

Add `one_line_desc: string` to `TaskTemplate` interface and populate for all 8 templates:

| Slug | display_name | one_line_desc |
|---|---|---|
| standard_physical | Physical & Errand | Help moving, delivery, or muscle work out in the world |
| in_home | In-Home Task | Cleaning, repairs, or handyman work inside someone's home |
| care | Care & Companionship | Childcare, pet care, elder care, or personal assistance |
| content_creator | Content & Creator Collab | You appear in someone's stream, video, or podcast in person |
| event_appearance | Event & Appearance | Brand promo, party hosting, or crowd work at an event |
| creative_production | Creative Production | Photo shoot, video shoot, music session, or film work |
| specialized_licensed | Specialist / Licensed Pro | Trade work, therapy, notary, or licensed skill services |
| wildcard_bizarre | Wildcard / Custom | Anything weird, one-off, or hard to categorize |

**Manifest endpoint:** `GET /api/templates/manifest`
- Response: array of `{ slug, display_name, one_line_desc }` for all 8 templates
- Cache-Control: `max-age=3600` (1h client TTL)
- Used by iOS reclassify valve to show human-readable template choices

**Reclassify UX copy:** "This task looks like [display_name]. [one_line_desc]. Does this feel right?"

---

### Change 5: proof_steps + Partial Payout Logic (Fix 4)

**Location:** DB migration + task router `acceptWithConsent`

`completion_criteria` JSONB (already on tasks) gains an optional `proof_steps` array:

```json
{
  "proof_steps": [
    { "leg": 1, "type": "gps_checkin", "description": "Pickup at groomer" },
    { "leg": 2, "type": "photo", "description": "Dog in car" },
    { "leg": 3, "type": "gps_checkout", "description": "Dropoff at sitter" }
  ],
  "partial_completion_allowed": false,
  "prorate_on_abort": false,
  "challenge_window_hours": 6
}
```

New tasks table columns:
- `prorate_on_abort BOOLEAN DEFAULT FALSE`
- `challenge_window_hours INTEGER DEFAULT 6`

When `prorate_on_abort = true` and Hustler aborts mid-leg with proof of prior legs:
1. Calculate pro-rata %: `completed_legs / total_legs`
2. Start challenge window (`challenge_window_hours`, default 6)
3. Send FCM push notification to Poster (if token exists); fallback to email + persistent in-app badge
4. If no dispute filed before window expires → release pro-rata escrow automatically
5. Admin notified of all partial releases

**Poster UX:** Whenever `proof_steps.length > 1`, show a single toggle labeled:
"High-value task — extend dispute window to 24 hours" (sets `challenge_window_hours = 24`).
Default remains 6h. No scheduling logic or new fields required beyond the toggle.

---

### Change 6: DB Migration v2.7

**File:** `backend/database/migrations/task_template_v2_7.sql`

```sql
BEGIN;

-- Users: flagged phrase cross-task counter
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS flagged_phrase_counter JSONB DEFAULT '[]'::jsonb;

-- Tasks: partial payout support
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS prorate_on_abort BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS challenge_window_hours INTEGER DEFAULT 6;

COMMIT;
```

Note: `proof_steps` is stored inside the existing `completion_criteria` JSONB column (no new column needed). `challenge_window_hours` and `prorate_on_abort` are top-level task columns for efficient querying by the escrow release cron.

---

## Summary Table — v2.7 Status

| Component | Type | Claim |
|---|---|---|
| FLAGGED_PATTERNS matcher | Deterministic | Behaves exactly as written |
| flagged_phrase_counter cross-task bump | Deterministic | Behaves exactly as written |
| deception_detected → zero multiplier | Deterministic | Behaves exactly as written |
| challenge_window timer | Deterministic | Behaves exactly as written |
| Manifest endpoint | Deterministic | Behaves exactly as written |
| proof_steps pro-rata calculation | Deterministic | Behaves exactly as written |
| is_genuinely_bizarre heuristic (incl. aggregation threshold) | Probabilistic (LLM) | Reduces gaming EV to negative |
| Guardian compliance score + novel patterns | Probabilistic (LLM) | Reduces gaming EV to negative |

**The game surface is now narrow enough that attempting to game the system has negative expected value for rational actors. That is the strongest honest claim possible.**

---

## Sprint Scope (2 Sprints)

**Sprint 1:**
- DB migration (Change 6)
- FLAGGED_PATTERNS code matcher + flagged_phrase_counter logic (Change 1)
- Guardian returns deception_detected + is_genuinely_bizarre (Change 2)
- ScoperAI reads Guardian outputs (Change 3)

**Sprint 2:**
- TaskTemplateRegistry one_line_desc (Change 4)
- Manifest endpoint (Change 4)
- proof_steps + partial payout + challenge window (Change 5)
- Router wiring + tests for all new paths
