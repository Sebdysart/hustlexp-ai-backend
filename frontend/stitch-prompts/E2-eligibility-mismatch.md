# Screen E2: Tasks Available, But Not Eligible (Hustler View)
## Purpose: Prevent shadow-ban paranoia, bias assumptions, retry/refresh behavior, preserve trust in system integrity

### Screen Purpose (Non-Negotiable)

This screen exists to answer **one question only**:

> "Why do tasks exist, but I am not seeing them?"

It must:
- Prevent **shadow-ban paranoia**
- Prevent **bias assumptions**
- Prevent **retry / refresh behavior**
- Preserve trust in **system integrity**

This is **not** a motivation screen.
This is **not** an upgrade funnel.
This is a **status explanation**.

---

### Backend States Represented

This screen may render **only if all are true**:
- `matching_pool.count > 0` (tasks exist)
- `eligible_tasks.count == 0` (user sees none)
- `account_status == ACTIVE` (account is active)
- `no_active_penalties == true` (no penalties)

If penalties exist → different screen.
If zero tasks exist → E1 (No Tasks Available).

---

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Tasks Available, But Not Eligible (Hustler View, Edge State)

Style: Apple Glass aesthetic, clean typography, authoritative and transparent.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Tone:
Factual. Transparent. Non-emotional.
This is a status explanation, not a motivation screen or upgrade funnel.

Visual Requirements:
- Authority framing (system health confirmed, user not penalized)
- Read-only eligibility breakdown (collapsed by default)
- Explicit "What This Is NOT" section (prevents escalation)
- Current settings snapshot (read-only)
- Single primary action (no refresh, no retry)

Content Layout (Top to Bottom):

1. HEADER (Top)
   - Title: "Tasks available — eligibility required" (size: 28px, weight: 700, color: white)
   - Subtitle: "Some active tasks are currently outside your eligibility parameters." (size: 14px, color: #8E8E93, margin-top: 8px, line-height: 1.5)
   - Icon: Shield + filter motif (size: 48px, color: #8E8E93, static, no animation, margin-top: 24px, margin-bottom: 24px)
   - No apology. No encouragement. No emotional framing.

2. CORE SYSTEM CARD (Glassmorphic, primary)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "Eligibility Status" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Bullet points (size: 14px, color: #E5E5EA, line-height: 1.8, margin-top: 12px):
     • "Your account is active and in good standing"
     • "Matching is functioning normally"
     • "Some tasks require additional eligibility"
   - This wording is deliberate: confirms system health, confirms user is not penalized, confirms tasks exist

3. ELIGIBILITY MISMATCH BREAKDOWN (Collapsed by default, expandable)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Title: "Why you may not see some tasks" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Collapsed indicator: "▾ Tap to expand" (size: 12px, color: #8E8E93, italic, margin-top: 8px)
   
   Expanded content (when open, vertical list, spacing: 16px):
   Each item is read-only, factual, and maps directly to backend gates. Only show applicable ones:
   
   - **Trust Tier Requirement**
     Text (size: 14px, color: #E5E5EA, line-height: 1.6):
     "Some tasks require a higher trust tier than your current level."
   
   - **Task Type Clearance**
     Text (size: 14px, color: #E5E5EA, line-height: 1.6):
     "Certain tasks require In-Home or Restricted clearance."
   
   - **Location Radius**
     Text (size: 14px, color: #E5E5EA, line-height: 1.6):
     "Tasks may be outside your current matching radius."
   
   - **Timing Window**
     Text (size: 14px, color: #E5E5EA, line-height: 1.6):
     "Some tasks are available only during specific time windows."
   
   - **Instant Mode Constraints**
     Text (size: 14px, color: #E5E5EA, line-height: 1.6):
     "Instant tasks require availability, demand, and clearance simultaneously."
   
   No progress bars here unless the unlock condition is binary and deterministic (e.g., "In-Home Clearance: Not Granted").

4. EXPLICIT "WHAT THIS IS NOT" SECTION (Critical, glassmorphic)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Divider label: "What this does NOT mean" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Bullet points (size: 14px, color: #E5E5EA, line-height: 1.8, margin-top: 12px):
     • "You are not restricted or penalized"
     • "Your trust score has not changed"
     • "No action is required from you"
   - This section kills escalation and support tickets.

5. CURRENT SETTINGS SNAPSHOT (Secondary card, read-only, reuse E1 pattern)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Title: "Current Settings" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Chips (horizontal flex, gap: 8px, margin-top: 12px):
     - Location: "📍 UW Campus + 2mi" (background: rgba(255, 255, 255, 0.1), padding: 6px 12px, rounded: 8px, size: 12px, color: white)
     - Trust Tier: "🛡️ Tier B — Trusted" (background: rgba(255, 255, 255, 0.1), padding: 6px 12px, rounded: 8px, size: 12px, color: white)
     - Instant Mode: "⚡ Instant Mode: ON" or "⚡ Instant Mode: OFF" (background: rgba(66, 188, 240, 0.2) if ON, rgba(255, 255, 255, 0.1) if OFF, padding: 6px 12px, rounded: 8px, size: 12px, color: #42bcf0 if ON, color: white if OFF)
   - All chips are read-only (no interaction, no toggles, no edits, no CTAs)

6. PRIMARY ACTION (Full-width, single button)
   - Button: "Return to Dashboard" (background: #8E8E93, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
   - Neutral gray (not red/green)
   - No "View requirements"
   - No "Improve eligibility"
   - No secondary actions
   - This screen should end the loop, not extend it.

Spacing:
- Card spacing: 16px vertical
- Card padding: 20px (16px for secondary cards)
- Section spacing: 24px
- Header margin-bottom: 24px

Typography:
- Font family: SF Pro Display
- Headers: weight 700
- Labels: weight 600
- Body: weight 400-500

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur (primary), rgba(28, 28, 30, 0.4) with blur (secondary)
- Neutral action: #8E8E93 (gray, not red/green)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone:
Factual. Transparent. Non-emotional.
This is a status explanation, not a motivation screen or upgrade funnel.

Constraints:
- Static UI only. No animations (icon is static).
- No emotional language.
- No implication of user fault.
- No upgrade or grind framing.
- No refresh / retry affordance.
- All reasons map 1:1 to backend eligibility gates.
- Read-only, explanatory, final.
- If any CTA suggests action, do not lock.
```

---

### Lock Criteria (Must All Pass)

* ✅ No emotional language
* ✅ No implication of user fault
* ✅ No upgrade or grind framing
* ✅ No refresh / retry affordance
* ✅ All reasons map 1:1 to backend eligibility gates
* ✅ Read-only, explanatory, final
* ✅ Explicit "What This Is NOT" section (prevents escalation)
* ✅ System health confirmed (account active, matching normal)
* ✅ Tasks existence confirmed (tasks available, just not eligible)
* ✅ Single primary action (return to dashboard, no secondary actions)

If any CTA suggests action (e.g., "View requirements," "Improve eligibility"), **do not lock**.

---

### Design Notes

**Why this matters:**
- Prevents shadow-ban paranoia (explicit "What This Is NOT" section)
- Prevents bias assumptions (all reasons map 1:1 to backend gates)
- Prevents retry/refresh behavior (single primary action, no retry button)
- Preserves trust in system integrity (system health confirmed, tasks existence confirmed)

**Visual Authority:**
- Authority framing (shield + filter icon, system health confirmed)
- Eligibility breakdown (collapsed by default, factual, read-only)
- Explicit denial section ("What This Is NOT" prevents escalation)
- Current settings snapshot (read-only, no toggles, no edits)

**Behavioral Rules (Enforced by UI):**
- ❌ Cannot refresh to see tasks (no retry button)
- ❌ Cannot edit eligibility from here (current settings read-only)
- ❌ Cannot upgrade or appeal (no "View requirements" or "Improve eligibility" CTAs)
- ❌ Cannot contact support (no chat entry point)
- ❌ Cannot assume penalty or restriction (explicit "What This Is NOT" section)

**What This Prevents:**
- Shadow-ban paranoia (explicit denial section, system health confirmed)
- Bias assumptions (all reasons map 1:1 to backend eligibility gates)
- Retry/refresh loops (single primary action, no retry button)
- Support escalation (explicit "What This Is NOT" section, no chat entry point)
- Upgrade/grind framing (no "View requirements" or "Improve eligibility" CTAs)

**Adversarial Test:**
- ✅ User cannot assume penalty (explicit "What This Is NOT" section)
- ✅ User cannot retry/refresh (no retry button, single primary action)
- ✅ User cannot appeal or upgrade (no secondary CTAs)
- ✅ User understands exactly why (eligibility breakdown maps to backend gates)
- ✅ Support tickets prevented (explicit denial section, no chat entry point)

---

### Backend State Validation

Before rendering this screen, backend must validate:
- `matching_pool.count > 0` (tasks exist)
- `eligible_tasks.count == 0` (user sees none)
- `account_status == ACTIVE` (account is active)
- `no_active_penalties == true` (no penalties)

If any condition is false, show different screen:
- If `matching_pool.count == 0` → Show E1 (No Tasks Available)
- If `account_status != ACTIVE` → Show account status screen
- If `no_active_penalties == false` → Show penalty/restriction screen

---

### Next Screen After This

Once E2 is locked, the **only remaining high-risk edge state** is:

**E3 — Task Accepted by Another Hustler**

Short-lived, emotionally charged, must feel **final but fair**.

---
