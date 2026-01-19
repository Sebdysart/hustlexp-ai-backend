# Screen E2: Instant Mode Unavailable (Hustler View)
## Purpose: Explain why Instant Mode is off without sounding punitive or upselling

### Screen Purpose (Non-Negotiable)

This screen exists to explain **system-gated unavailability**, not user failure.

It must be:
- **Single explicit reason** (no stacking excuses)
- **Factual** (system decides, not user)
- **Non-emotional** (no "almost there!", no upselling)
- **Non-interactive** (no toggle override)

When triggered:
- User toggles Instant Mode ON but fails eligibility
- Or Instant Mode auto-disabled by system

Title variants (system-chosen, single reason shown):

**Variant A — Trust Tier:**
> Instant Mode unavailable
> Requires In-Home clearance

**Variant B — Location:**
> Instant Mode unavailable
> No active Instant demand in your area

**Variant C — Timing / Rate Limit:**
> Instant Mode temporarily paused
> Instant accept limit reached

---

### Stitch Prompt (Variant A — Trust Tier)

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Instant Mode Unavailable (Hustler View, Edge State, Trust Tier Variant)

Style: Apple Glass aesthetic, clean typography, authoritative and transparent.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Tone:
Factual. Transparent. Non-emotional.
System decides availability, not user. No toggle override, no emotional framing.

Visual Requirements:
- Single explicit reason shown (no stacking excuses)
- Read-only progress indicators (if applicable)
- Single primary action (navigate to requirements)
- No emotional language, no upselling, no toggle override

Content Layout (Top to Bottom):

1. HEADER (Top)
   - Title: "Instant Mode unavailable" (size: 28px, weight: 700, color: white)
   - Subtitle: "Requires In-Home clearance" (size: 14px, color: #8E8E93, margin-top: 8px, line-height: 1.5)

2. REASON CARD (Glassmorphic, primary, single reason only)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Label: "Why this is unavailable" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Body (size: 14px, color: #E5E5EA, line-height: 1.6, margin-top: 12px):
     "Instant tasks require In-Home clearance due to higher trust and response requirements."
   - Exactly one reason shown (no stacking excuses)

3. WHAT THIS MEANS (Glassmorphic, secondary)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Title: "What This Means" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Bullet points (size: 14px, color: #E5E5EA, line-height: 1.8, margin-top: 12px):
     • "You can still accept standard tasks"
     • "Instant Mode enables high-priority matching only"
   - No emotional framing ("almost there!")

4. WHAT UNLOCKS IT (Glassmorphic, tertiary, if applicable)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Title: "Requirements for In-Home Clearance" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Progress indicators (read-only, vertical list, spacing: 12px, margin-top: 12px):
     - "Tasks completed: 18 / 25" (size: 14px, color: #E5E5EA)
     - "Days active: 22 / 30" (size: 14px, color: #E5E5EA)
     - "Deposit status: Not locked" (size: 14px, color: #E5E5EA)
   - No progress animations. No percentages unless already defined in backend.

5. PRIMARY ACTION (Full-width, single button)
   - Button: "View Requirements" (background: #8E8E93, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
   - Note: Navigates to Trust Tier screen
   - No toggle override. System decides availability, not user.

Spacing:
- Card spacing: 16px vertical
- Card padding: 20px (16px for secondary/tertiary cards)
- Section spacing: 24px
- Header margin-bottom: 24px

Typography:
- Font family: SF Pro Display
- Headers: weight 700
- Labels: weight 600
- Body: weight 400-500

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur
- Neutral action: #8E8E93 (gray, not red/green)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone:
Factual. Transparent. Non-emotional.
System decides availability, not user. No toggle override, no emotional framing.

Constraints:
- Static UI only. No animations.
- Exactly one reason shown (no stacking excuses).
- No emotional framing ("almost there!").
- No toggle override.
- System decides availability, not user.
- No spinners, no retry buttons.
- No growth copy.
- No chat entry points.
```

---

### Stitch Prompt (Variant B — Location)

Same structure as Variant A, with these differences:

**Header:**
- Title: "Instant Mode unavailable"
- Subtitle: "No active Instant demand in your area"

**Reason Card:**
- Body: "Instant tasks require nearby demand within your eligibility radius. No matching requests are active right now."

**What Unlocks It (if applicable):**
- Title: "Location Settings"
- Progress indicators:
  - "Current radius: 2 miles"
  - "Location: UW Campus"
  - "Last updated: Oct 24, 2024"

**Primary Action:**
- Button: "Return to Dashboard" (no requirements screen for location variant)

---

### Stitch Prompt (Variant C — Timing / Rate Limit)

Same structure as Variant A, with these differences:

**Header:**
- Title: "Instant Mode temporarily paused"
- Subtitle: "Instant accept limit reached"

**Reason Card:**
- Body: "You've reached the maximum Instant accepts for this time period. The limit resets automatically."

**What Unlocks It (if applicable):**
- Title: "Rate Limit Status"
- Progress indicators:
  - "Instant accepts today: 5 / 5"
  - "Reset time: Oct 25, 2024 at 12:00 AM"
  - "Remaining standard tasks: Unlimited"

**Primary Action:**
- Button: "Return to Dashboard"

---

### Lock Criteria (Must All Pass)

* ✅ Exactly one reason shown (no stacking excuses)
* ✅ No emotional framing ("almost there!")
* ✅ No toggle override
* ✅ System decides availability, not user
* ✅ Factual system language only
* ✅ Explicit reason shown
* ✅ Single primary action
* ✅ No retry buttons
* ✅ No growth copy
* ✅ No chat entry points

When locked, this screen **must not change** without backend changes.

---

### Design Notes

**Why this matters:**
- Explains why Instant Mode is off without sounding punitive or upselling
- Prevents user confusion ("why can't I enable this?")
- Maintains system authority (system decides, not user)
- Eliminates toggle override attempts

**Visual Authority:**
- Single explicit reason (no stacking excuses)
- Factual explanation (system requirements, not user failure)
- Read-only progress indicators (if applicable)
- Single primary action (view requirements or return)

**Behavioral Rules (Enforced by UI):**
- ❌ Cannot toggle override (system decides availability)
- ❌ Cannot appeal or request bypass (no chat entry point)
- ❌ Cannot see multiple reasons at once (single reason variant shown)
- ❌ Cannot skip to requirements without acknowledging unavailability

---
