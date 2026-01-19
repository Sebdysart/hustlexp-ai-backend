# Screen 12: Trust Change Explanation (Read-Only)
## Purpose: Make trust predictable, reinforce that outcomes are earned, show system is deterministic, prevent shadow scoring myths

### Screen Purpose (Non-Negotiable)

This screen exists to answer the **first unresolved question** after completion:

> **"What did this task *do* to my standing?"**

It must be:
- **Read-only** (no editing, no appeals)
- **Non-emotional** (factual, system-driven)
- **Non-interactive** (no buttons except "Continue")
- **Non-negotiable** (system has decided)

This screen is a **pressure release valve** that prevents:
- Hustlers assuming silent penalties
- Posters assuming ratings secretly matter
- Both sides projecting hidden math
- "Shadow scoring" myths
- Uncertainty → suspicion → escalation loops

---

### Backend States Represented

This screen appears when:
- `task.state = COMPLETED`
- `poster_feedback.status = SUBMITTED` OR `poster_feedback.status = SKIPPED`
- `xp_ledger` entry exists for this task
- `trust_tier` evaluation may have occurred

It must reflect **backend truth only**:

#### XP Changes
- `xp_gained` (total XP from this task)
- `xp_breakdown` (base, multipliers, bonuses)
- `xp_withheld` (if applicable, with reason)

#### Trust Tier Changes
- `trust_tier_before`
- `trust_tier_after` (if changed)
- `trust_tier_promotion_eligible` (if not yet promoted, show requirements)

#### Streak / Consistency
- `streak_count` (current streak)
- `streak_bonus_applied` (if applicable)

#### What Did NOT Change
- `trust_tier_unchanged` (if no promotion occurred, explain why)
- `no_penalties` (if task completed successfully)

No speculation. No promises. No "maybe later."

---

### Stitch Prompt (Poster Variant)

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Trust Change Explanation (Poster View, Read-Only)

Style: Apple Glass aesthetic, clean typography, authoritative and transparent.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Tone:
Factual. Transparent. Non-emotional.
The system has decided. This is a receipt, not a negotiation.

Visual Requirements:
- Read-only view (no edits, no appeals)
- Clear breakdown of what changed and why
- Explicit statement of what did NOT change
- No interactive elements except "Continue" button

Content Layout (Top to Bottom):

1. HEADER (Top)
   - Title: "Task Impact Summary" (size: 28px, weight: 700, color: white)
   - Subtitle: "How this task affected system trust and matching" (size: 14px, color: #8E8E93, margin-top: 8px)

2. TASK SUMMARY (Card, glassmorphic)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Task title: "Site Survey: Sector 4" (size: 18px, weight: 700, color: white)
   - Contract ID: "#820-A4" (size: 11px, color: #8E8E93, monospace, uppercase, tracking: 1px, margin-top: 4px)
   - Completion date: "Completed on Oct 24, 2024" (size: 12px, color: #8E8E93, margin-top: 8px)

3. WHAT CHANGED (Primary Section, glassmorphic card)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "System Updates" (size: 14px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   
   Changes (vertical list, spacing: 16px):
   
   If XP gained:
   - Icon: Trophy icon (size: 20px, color: #34C759)
   - Label: "XP Gained" (size: 16px, weight: 600, color: white)
   - Value: "+342 XP" (size: 24px, weight: 700, color: #34C759)
   - Breakdown (size: 12px, color: #8E8E93, margin-top: 4px):
     "Base: 300 XP • Instant: +1.5× • Speed: +1.2×"
   
   CRITICAL FIX #1: Reliability Status (Task-Scoped, Not Global):
   - Icon: Shield icon (size: 20px, color: #34C759)
   - Label: "Reliability Status for This Task" (size: 16px, weight: 600, color: white)
   - Value: "Passed" (size: 18px, weight: 700, color: #34C759)
   - Subordinate line (size: 11px, color: #8E8E93, margin-top: 4px, secondary color):
     "Account Reliability (unchanged)" — Numeric score moved down, visually subordinate
   - This preserves motivation without implying fragility
   
   If trust tier unchanged:
   - Icon: Shield icon (size: 20px, color: #8E8E93)
   - Label: "Trust Tier" (size: 16px, weight: 600, color: white)
   - Value: "Unchanged" (size: 18px, weight: 600, color: #8E8E93)
   - Explanation (size: 12px, color: #8E8E93, margin-top: 4px):
     "Current tier: Trusted (Tier C). You are 3 completed tasks away from Tier D promotion."
   
   If trust tier promoted:
   - Icon: Shield icon (size: 20px, color: #34C759)
   - Label: "Trust Tier" (size: 16px, weight: 600, color: white)
   - Value: "Promoted to Tier D" (size: 18px, weight: 700, color: #34C759)
   - Explanation (size: 12px, color: #8E8E93, margin-top: 4px):
     "Requirements met: 10 completed tasks, 0 disputes, verified ID"

4. SYSTEM IMPACT (Secondary Section, glassmorphic card)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "System Impact" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Icon: Shield icon (size: 20px, color: #8E8E93, margin-top: 12px)
   - CRITICAL FIX #2: Explicit delta line (size: 14px, color: #E5E5EA, line-height: 1.6, margin-top: 12px):
     "Impact from this task:"
   - Bullet points (size: 14px, color: #E5E5EA, line-height: 1.8, margin-top: 8px):
     • "Priority matching weight increased for Instant tasks"
     • "No penalties applied"
     • "No restrictions added"
   - General statement (size: 12px, color: #8E8E93, margin-top: 12px, italic):
     "High-trust status unlocks priority matching for future tasks."
   - This adds why, when, what exactly changed — prevents "did anything actually change?" questions

5. WHAT DID NOT CHANGE (Tertiary Section, glassmorphic card)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Title: "No Penalties" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Text (size: 14px, color: #E5E5EA, line-height: 1.6):
     "Task completed successfully. No trust penalties or restrictions applied."

6. WHAT HAPPENS NEXT (Quaternary Section, glassmorphic card)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Title: "Next Steps" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Text (size: 14px, color: #E5E5EA, line-height: 1.6):
     "Your updated trust tier and XP will be reflected in future task matching and eligibility."

7. PRIMARY ACTION (Full-width, single button)
   - Button: "Continue" (background: #34C759, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
   - No subtext needed
   - This is the ONLY interactive element

Spacing:
- Card spacing: 16px vertical
- Card padding: 20px (16px for secondary/tertiary cards)
- Section spacing: 24px
- Header margin-bottom: 24px

Typography:
- Font family: SF Pro Display
- Headers: weight 700
- Labels: weight 600
- Body: weight 400

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur
- Success: #34C759 (green)
- Neutral: #8E8E93 (gray)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone:
Factual. Transparent. Non-emotional.
The system has decided. This is a receipt, not a negotiation.

Constraints:
- Static UI only. No animations.
- Read-only view (no edits, no appeals).
- No interactive elements except "Continue" button.
- No emotional language.
- No speculation ("maybe", "could", "might").
- Explicit statements only (what changed, what didn't, why).
```

---

### Stitch Prompt (Hustler Variant)

The Hustler variant is **symmetric** with the following differences:

1. **Header subtitle**: "How this task affected your trust tier and XP"

2. **XP Changes Section**:
   - Shows XP gained (same format)
   - Shows streak updates (if applicable)
   - Shows XP bonuses (Instant, Speed, Surge multipliers)

3. **Reliability Status Section** (CRITICAL FIX #1):
   - Label: "Reliability Status for This Task"
   - Value: "Passed"
   - Subordinate line: "Account Reliability (unchanged)" (task-scoped, not global)

4. **Trust Tier Changes Section**:
   - If promoted: "Promoted to Tier [X]"
   - If unchanged: Shows progress toward next tier ("You are X completed tasks away from Tier [Y] promotion")
   - Explicit requirements listed

5. **System Impact Section** (CRITICAL FIX #2):
   - Explicit delta line: "Impact from this task:"
   - Bullet points:
     • "Priority matching weight increased for Instant tasks"
     • "No penalties applied"
     • "No restrictions added"
   - General statement: "High-trust status unlocks priority matching for future tasks."

6. **What Did NOT Change Section**:
   - "Task completed successfully. No trust penalties or restrictions applied."
   - May include: "No disputes filed. No time violations."

7. **What Happens Next Section**:
   - "Your updated trust tier and XP will be reflected in task eligibility and Instant Mode access."

Everything else is identical. The screen is **read-only, non-emotional, non-negotiable**.

---

### Lock Criteria (Must All Be True)

This screen is **LOCKED** only when:

* [ ] Read-only (no edits, no appeals, no negotiation)
* [ ] Non-emotional (factual language only, no speculation)
* [ ] Non-interactive (only "Continue" button)
* [ ] Explains what changed (XP, trust tier, streaks)
* [ ] Explains what did NOT change (no penalties, no restrictions)
* [ ] Explains why (requirements met/not met, explicit criteria)
* [ ] Explains what happens next (system updates, matching changes)
* [ ] Poster and Hustler variants are symmetric
* [ ] Backend states are accurately represented
* [ ] No "shadow scoring" ambiguity remains

---

### Why This Matters (Strategic)

This screen:
- Makes trust **predictable** (users see changes immediately)
- Reinforces that outcomes are **earned** (requirements are explicit)
- Shows the system is **deterministic** (no hidden math)
- Prevents "shadow scoring" myths (transparency kills uncertainty)
- Acts as a **pressure release valve** (answers questions before they become disputes)

Without this screen:
- Users invent explanations
- Uncertainty becomes suspicion
- Suspicion becomes escalation
- System feels opaque despite being fair

---
