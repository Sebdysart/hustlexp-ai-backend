# Screen E2: Tasks Available, But Not Eligible — LOCKED (v1)
## Status: SPEC COMPLETE — MAX-Tier Execution

**Verdict:** This screen achieves **shadow-ban paranoia prevention, bias assumption elimination, and trust preservation**. It prevents shadow-ban paranoia through explicit "What This Is NOT" section, prevents bias assumptions by mapping all reasons 1:1 to backend eligibility gates, prevents retry/refresh behavior through single primary action, and preserves trust in system integrity by confirming system health and tasks existence.

**Screen Purpose:**
This screen exists to answer **one question only**:
> "Why do tasks exist, but I am not seeing them?"

**Backend States Represented:**
This screen may render **only if all are true**:
- `matching_pool.count > 0` (tasks exist)
- `eligible_tasks.count == 0` (user sees none)
- `account_status == ACTIVE` (account is active)
- `no_active_penalties == true` (no penalties)

If penalties exist → different screen.
If zero tasks exist → E1 (No Tasks Available).

**What Works at MAX Tier:**
- ✅ **Authority framing** (shield + filter icon, system health confirmed, tasks existence confirmed)
- ✅ **Explicit "What This Is NOT" section** (prevents escalation, kills support tickets)
- ✅ **Eligibility breakdown** (collapsed by default, factual, read-only, maps 1:1 to backend gates)
- ✅ **Current settings snapshot** (read-only, no toggles, no edits, no CTAs)
- ✅ **Single primary action** (return to dashboard, no refresh, no retry, no secondary actions)
- ✅ **No emotional language** (factual, transparent, non-emotional)
- ✅ **No implication of user fault** (system health confirmed, user not penalized)
- ✅ **No upgrade or grind framing** (no "View requirements" or "Improve eligibility" CTAs)

**Critical Elements:**
- **Header**: "Tasks available — eligibility required" title, eligibility parameters subtitle, shield + filter icon (static)
- **Core System Card**: "Eligibility Status" title, three bullet points (account active, matching normal, some tasks require additional eligibility)
- **Eligibility Mismatch Breakdown**: "Why you may not see some tasks" title, collapsed by default, expandable rows (Trust Tier, Task Type Clearance, Location Radius, Timing Window, Instant Mode Constraints)
- **Explicit "What This Is NOT" Section**: Divider label, three bullet points (not restricted/penalized, trust score unchanged, no action required)
- **Current Settings Snapshot**: "Current Settings" title, read-only chips (Location, Trust Tier, Instant Mode)
- **Primary Action**: "Return to Dashboard" button (neutral gray, no secondary actions)

**Behavioral Rules Enforced by UI:**
- ❌ Cannot refresh to see tasks (no retry button, no refresh CTA)
- ❌ Cannot edit eligibility from here (current settings read-only, no toggles, no edits)
- ❌ Cannot upgrade or appeal (no "View requirements" or "Improve eligibility" CTAs)
- ❌ Cannot contact support (no chat entry point)
- ❌ Cannot assume penalty or restriction (explicit "What This Is NOT" section)

**Lock Criteria Met:**
- ✅ No emotional language
- ✅ No implication of user fault
- ✅ No upgrade or grind framing
- ✅ No refresh / retry affordance
- ✅ All reasons map 1:1 to backend eligibility gates
- ✅ Read-only, explanatory, final
- ✅ Explicit "What This Is NOT" section (prevents escalation)
- ✅ System health confirmed (account active, matching normal)
- ✅ Tasks existence confirmed (tasks available, just not eligible)
- ✅ Single primary action (return to dashboard, no secondary actions)

**What This Prevents:**
- Shadow-ban paranoia (explicit "What This Is NOT" section, system health confirmed, tasks existence confirmed)
- Bias assumptions (all reasons map 1:1 to backend eligibility gates, factual explanations)
- Retry/refresh loops (single primary action, no retry button, no refresh CTA)
- Support escalation (explicit "What This Is NOT" section, no chat entry point)
- Upgrade/grind framing (no "View requirements" or "Improve eligibility" CTAs)

**Adversarial Test:**
- ✅ User cannot assume penalty (explicit "What This Is NOT" section: not restricted/penalized, trust score unchanged)
- ✅ User cannot retry/refresh (no retry button, single primary action: return to dashboard)
- ✅ User cannot appeal or upgrade (no "View requirements" or "Improve eligibility" CTAs)
- ✅ User understands exactly why (eligibility breakdown collapsed by default, expandable, maps to backend gates)
- ✅ Support tickets prevented (explicit "What This Is NOT" section, no chat entry point)

**Strategic Impact:**
- Prevents shadow-ban paranoia (explicit denial section, system health confirmed)
- Prevents bias assumptions (all reasons map 1:1 to backend eligibility gates)
- Prevents retry/refresh behavior (single primary action, no retry button)
- Preserves trust in system integrity (system health confirmed, tasks existence confirmed)
- Kills support escalation (explicit "What This Is NOT" section, no chat entry point)

**This screen is LOCKED (v1). Do not iterate further without backend changes.**

---

See `E2-eligibility-mismatch.md` for the full Stitch prompt.
