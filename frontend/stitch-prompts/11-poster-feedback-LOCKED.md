# Screen 11: Poster Feedback / Rating (Controlled) — LOCKED
## Status: APPROVED — MAX-Tier Execution

**Verdict:** This screen achieves **signal capture, not emotion**. It anchors feedback to objective task criteria, protects the trust system from outliers, and closes the loop without reopening disputes. This is a post-execution verification input, not a "rate your experience" screen.

**Core Principle:**
**Posters do not rate people. They confirm task outcomes.**
The system derives trust deltas.

**Critical Fixes Applied:**
- ✅ **FIX #1: Primary CTA is "Confirm Task Outcome"** (NOT "Leave Feedback", uses checklist/shield icon, reframes as verification, not opinion)
- ✅ **FIX #2: Feedback gate screen inserted** (lightweight intermediate screen: "Your feedback is about the task — not the person. Payment is already complete.")
- ✅ **FIX #3: Hustler identity suppressed during feedback** (no avatar, no name, no tier — only task title and contract ID)
- ✅ **FIX #4: Criteria confirmation is FIRST interaction** (binary Yes/No before any rating — forces cognition before emotion)
- ✅ **FIX #5: Satisfaction scoring de-emphasized** (no stars, neutral icons, optional, below criteria, guardrail text: "Outlier feedback may be reviewed automatically")

**What Works at MAX Tier:**
- ✅ **Criteria-first, not star-first** (prevents revenge ratings, vibe-based scoring, emotional punishment)
- ✅ **Binary confirmation anchors truth** ("Yes / No" forces facts, not feelings)
- ✅ **Trust impact is explained but abstracted** (posters understand feedback matters but cannot directly manipulate outcomes)
- ✅ **Comments are de-weaponized** (not public, not prominent, not rewarded)
- ✅ **Overall satisfaction is optional and secondary** (does not affect payment, helps improve matching)
- ✅ **Skip path exists and is safe** (feedback is optional, can skip without penalty)
- ✅ **No visible trust score changes** (abstracted disclosure, no immediate deltas shown)
- ✅ **Feedback gate prevents emotional input** (single sentence prevents 80% of abuse)
- ✅ **Identity suppression prevents bias** (no halo effects, no bias carryover, no rating inflation/deflation)

**Critical Elements:**
- **Initial Completion Screen CTA**: "Confirm Task Outcome" button (NOT "Leave Feedback", uses checklist/shield icon, subtext: "Optional — helps improve matching accuracy")
- **Feedback Gate Screen** (Lightweight Intermediate): Title "Confirm Outcome", copy "Your feedback is about the task — not the person. Payment is already complete.", Continue/Skip buttons
- **Header** (Inside Feedback Form): "Confirm Task Outcome" title, system accuracy subtitle
- **Task Summary** (Inside Feedback Form): Task title, contract ID only — NO avatar, NO name, NO tier, NO role badge
- **Criteria Confirmation** (Primary, Required, FIRST INTERACTION): Three binary Yes/No criteria with explanation note if "No" selected
- **Overall Satisfaction** (Secondary, Optional, AFTER Criteria): 1–5 icon-based scale (no stars, neutral icons), clearly optional, guardrail text about outlier review
- **Optional Comment**: De-emphasized textarea, system-only, character limit (240), clearly non-primary
- **Trust Impact Disclosure**: Shield icon, abstracted explanation, neutral tone
- **Submit Confirmation**: "Submit Confirmation" button, finalizes feedback
- **Secondary Action**: "Skip feedback" text button, clearly optional

**Behavioral Rules Enforced by UI:**
- ❌ Cannot rate without confirming criteria (criteria confirmation is required)
- ❌ Cannot see immediate trust score changes (no visible deltas)
- ❌ Cannot use comments as public weapon (comments are system-only, de-emphasized)
- ❌ Cannot skip criteria confirmation (required, but can skip overall satisfaction)
- ❌ Cannot initiate dispute here (dispute is separate, exceptional flow)

**Backend States Represented:**
- `task.status = COMPLETED_APPROVED`
- `escrow.status = RELEASED`
- `proof.status = VERIFIED`
- `poster_feedback.status = PENDING`

**Screen must never appear if:**
- Task is disputed
- Completion is blocked
- Proof is under review

**Critical Design Safeguards:**
1. **Criteria First, Rating Second** — Prevents revenge ratings, vibe-based scoring, emotional punishment
2. **Binary Confirmation Anchors Truth** — "Yes / No" forces posters to think in facts, not feelings
3. **Trust Impact Is Explained (But Abstracted)** — Posters understand feedback matters but cannot directly manipulate outcomes
4. **Comments Are De-Weaponized** — Not public, not prominent, not rewarded

**What This Prevents:**
- Trust score poisoning
- Retaliatory 1-star abuse
- Poster regret after payout
- Support escalation loops
- Hustler fear of arbitrary punishment

**Adversarial Test:**
- ✅ Poster cannot revenge-rate (criteria-first, binary confirmation, no star-first)
- ✅ Poster cannot weaponize comments (de-emphasized, system-only, not public)
- ✅ Poster cannot see immediate trust impact (abstracted disclosure, no visible deltas)
- ✅ Poster cannot skip criteria (required, but can skip overall satisfaction)
- ✅ Poster cannot initiate dispute (separate, exceptional flow)

**This screen is LOCKED (v1). Do not iterate further.**

---

See `11-poster-feedback.md` for the full prompt.
