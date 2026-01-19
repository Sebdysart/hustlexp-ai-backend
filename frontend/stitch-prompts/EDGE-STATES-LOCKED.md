# Edge & Empty States — LOCKED (v1)
## Status: SPEC COMPLETE — MAX-Tier Execution

**Verdict:** These screens achieve **factual system explanations, explicit reasons, and concrete paths forward**. They prevent "silent confusion," eliminate refresh loops, maintain system authority, and make trust boring, deterministic, and earned. No emotional language, no growth copy, no false hope.

**Cross-Screen Enforcement Rules (All States):**
- ✅ **No spinners as explanations**
- ✅ **No retry buttons for deterministic states**
- ✅ **No emotional language**
- ✅ **No growth copy**
- ✅ **No chat entry points**

---

## Screen E1: No Tasks Available (Hustler View)

**Purpose:** Prevent "is the app broken?" confusion when supply > demand.

**Core Message:**
> "No tasks available right now"

Not "Nothing yet," not "Check back later," not "We're working on it."

**Critical Elements:**
- **Header**: "No tasks available" title, eligibility/location subtitle
- **System Context Card**: Account active, matching automatic, tasks appear when demand exists
- **Status Chips** (Read-Only): Location, Trust Tier, Instant Mode status
- **Primary Action**: "Return to Dashboard" (only interactive element)

**Lock Criteria Met:**
- ✅ No implication of user fault
- ✅ No suggestion to "try harder"
- ✅ No fake activity or placeholders
- ✅ Clear that system is idle, not broken
- ✅ Single primary action (no refresh, no retry)

---

## Screen E2: Instant Mode Unavailable (Hustler View)

**Purpose:** Explain why Instant Mode is off without sounding punitive or upselling.

**Title Variants (System-Chosen, Single Reason Shown):**
- **Variant A — Trust Tier**: "Instant Mode unavailable — Requires In-Home clearance"
- **Variant B — Location**: "Instant Mode unavailable — No active Instant demand in your area"
- **Variant C — Timing / Rate Limit**: "Instant Mode temporarily paused — Instant accept limit reached"

**Critical Elements:**
- **Reason Card** (Single, explicit): Exactly one reason shown (no stacking excuses)
- **What This Means**: You can still accept standard tasks, Instant Mode enables high-priority matching only
- **What Unlocks It** (If Applicable): Progress indicators (read-only, no animations)
- **Primary Action**: "View Requirements" (Variant A) or "Return to Dashboard" (Variants B/C)

**Lock Criteria Met:**
- ✅ Exactly one reason shown (no stacking excuses)
- ✅ No emotional framing ("almost there!")
- ✅ No toggle override
- ✅ System decides availability, not user

---

## Screen E3: Trust Tier Locked (Poster + Hustler)

**Purpose:** Make trust boring, deterministic, and earned. This is a requirements document, not a marketing screen.

**Core Message:**
> "Access is earned through verified actions."

**Critical Elements:**
- **Header**: "Trust Tier Locked" title, earned-through-actions subtitle
- **Tier Card**: Locked tier badge, factual description (no emotional framing)
- **Requirements Section**: Read-only checklist, current state shown (no progress animations)
- **What This Affects**: Factual list (in-home tasks, Instant matching, care-related work)
- **Primary Action**: "Continue" (no "Apply," no "Request," no "Contact support")

**Lock Criteria Met:**
- ✅ No way to bypass
- ✅ No appeal language
- ✅ No promises
- ✅ No variable interpretation
- ✅ Read-only requirements (requirements document, not application)

---

## Strategic Impact

**What These Screens Prevent:**
- "Is the app broken?" confusion (E1: system idle, not broken)
- "Why can't I enable this?" confusion (E2: single explicit reason)
- "How do I unlock this?" confusion (E3: requirements document)
- Refresh loops and retry abuse (no retry buttons, no refresh CTAs)
- False hope and emotional manipulation (factual language only)
- Support escalation (explicit reasons, no chat entry points)

**What These Screens Achieve:**
- Factual system explanations (system speaks truth, not hope)
- Explicit reasons (no ambiguity, no false hope)
- Concrete paths forward (single primary action)
- Maintained system authority (system decides, not user)
- Preserved trust signal integrity (requirements earned, not requested)

**Adversarial Test:**
- ✅ User cannot refresh to force tasks (E1: no retry button)
- ✅ User cannot toggle override (E2: system decides availability)
- ✅ User cannot bypass requirements (E3: no "Apply" or "Request")
- ✅ User cannot appeal or contact support (no chat entry points)
- ✅ User understands exactly why and what to do (explicit reasons, concrete paths)

---

## Completion Status

**Edge & Empty States — LOCKED (v1)**

All three screens are:
- ✅ MAX-tier execution (factual, authoritative, transparent)
- ✅ Consistent with locked UI surfaces (glassmorphic, neutral palette)
- ✅ Ready for Stitch prompt generation or direct HTML implementation

**Files:**
- `E1-no-tasks-available.md` — Stitch prompt for No Tasks Available screen
- `E2-instant-mode-unavailable.md` — Stitch prompts for all three variants (Trust Tier, Location, Timing/Rate Limit)
- `E3-trust-tier-locked.md` — Stitch prompts for Poster and Hustler variants

**This completes Edge & Empty States implementation.**

Once these are locked, the UI surface is functionally complete for alpha.

---

See individual screen markdown files for detailed Stitch prompts.
