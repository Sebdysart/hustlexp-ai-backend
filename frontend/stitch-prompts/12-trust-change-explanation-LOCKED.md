# Screen 12: Trust Change Explanation (Read-Only) — LOCKED
## Status: APPROVED — MAX-Tier Execution

**Verdict:** This screen achieves **transparency, predictability, and trust stabilization**. It answers the first unresolved question after completion: "What did this task *do* to my standing?" It makes trust predictable, reinforces that outcomes are earned, shows the system is deterministic, and prevents "shadow scoring" myths. This is a pressure release valve that prevents uncertainty → suspicion → escalation loops.

**Critical Fixes Applied:**
- ✅ **FIX #1: Reliability Status is task-scoped, not global** — Changed "Reliability Score: Maintained (98/100)" to "Reliability Status for This Task: Passed" with subordinate "Account Reliability (unchanged)" line. Prevents "shadow scoring" anxiety, preserves motivation without implying fragility.
- ✅ **FIX #2: System Impact has explicit causal anchor** — Added "Impact from this task:" with bullet points (priority matching weight increased, no penalties, no restrictions). Prevents "did anything actually change?" questions, saves support tickets.

**What Works at MAX Tier:**
- ✅ **Read-only** (no edits, no appeals, no negotiation)
- ✅ **Non-emotional** (factual language only, no speculation)
- ✅ **Non-interactive** (only "Continue" button)
- ✅ **Explains what changed** (XP, trust tier, streaks, explicit breakdowns, task-scoped reliability)
- ✅ **Explains what did NOT change** (no penalties, no restrictions, explicit statements)
- ✅ **Explains why** (requirements met/not met, explicit criteria, explicit impact deltas)
- ✅ **Explains what happens next** (system updates, matching changes, eligibility)
- ✅ **Poster and Hustler variants are symmetric** (same structure, task-specific details)
- ✅ **Backend states accurately represented** (XP ledger, trust tier, streaks, no speculation)

**Critical Elements:**
- **Header**: "Task Impact Summary" title, system trust/matching subtitle
- **Task Summary**: Task title, contract ID, completion date
- **What Changed**: XP gained (with breakdown), reliability status (task-scoped: "Passed"), trust tier changes (promoted/unchanged with progress), streaks
- **System Impact**: Explicit delta line "Impact from this task:" with bullet points (priority matching weight, no penalties, no restrictions)
- **What Did NOT Change**: Explicit "No Penalties" section (task completed successfully, no restrictions)
- **What Happens Next**: System updates reflected in matching/eligibility
- **Primary Action**: Single "Continue" button (only interactive element)

**Behavioral Rules Enforced by UI:**
- ❌ Cannot edit outcomes (read-only, no appeals)
- ❌ Cannot negotiate changes (system has decided, non-negotiable)
- ❌ Cannot speculate about hidden math (explicit breakdowns, no ambiguity)
- ❌ Cannot escalate without cause (uncertainty answered, suspicion prevented)

**Backend States Represented:**
- `task.state = COMPLETED`
- `poster_feedback.status = SUBMITTED` OR `SKIPPED`
- `xp_ledger` entry (XP gained, breakdown, multipliers)
- `trust_tier_before` / `trust_tier_after`
- `trust_tier_promotion_eligible` (requirements if not promoted)
- `streak_count` (current streak)
- `streak_bonus_applied` (if applicable)
- `no_penalties` (explicit statement if task completed successfully)

**Strategic Impact:**
- Makes trust predictable (users see changes immediately)
- Reinforces that outcomes are earned (requirements are explicit)
- Shows system is deterministic (no hidden math, no speculation)
- Prevents "shadow scoring" myths (transparency kills uncertainty)
- Acts as pressure release valve (answers questions before they become disputes)

**What This Prevents:**
- Hustlers assuming silent penalties
- Posters assuming ratings secretly matter
- Both sides projecting hidden math
- Uncertainty → suspicion → escalation loops
- "Shadow scoring" myths
- System feeling opaque despite being fair

**This screen is LOCKED (v1). Do not iterate further.**

---

See `12-trust-change-explanation.md` for the full prompt (Poster + Hustler variants).
