# Screen E3: Trust Tier Locked (Poster + Hustler)
## Purpose: Make trust boring, deterministic, and earned. This is a requirements document, not a marketing screen.

### Screen Purpose (Non-Negotiable)

This screen exists to show **locked trust tier requirements**, not user encouragement.

It must be:
- **Read-only** (requirements document, not application)
- **Deterministic** (no variable interpretation)
- **Non-emotional** (no "almost there!", no promises)
- **Non-interactive** (no bypass, no appeal, no contact)

Make trust **boring, deterministic, and earned**.

This is not a marketing screen. It is a requirements document.

---

### Stitch Prompt (Poster Variant)

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Trust Tier Locked (Poster View, Edge State)

Style: Apple Glass aesthetic, clean typography, authoritative and transparent.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Tone:
Factual. Boring. Deterministic.
This is a requirements document, not a marketing screen. Trust is earned, not requested.

Visual Requirements:
- Read-only requirements checklist
- No progress animations, no percentages (unless backend-defined)
- Single primary action (continue, no "Apply" or "Request")
- No way to bypass, no appeal language, no promises

Content Layout (Top to Bottom):

1. HEADER (Top)
   - Title: "Trust Tier Locked" (size: 28px, weight: 700, color: white)
   - Subtitle: "Access is earned through verified actions." (size: 14px, color: #8E8E93, margin-top: 8px, line-height: 1.5)

2. TIER CARD (Locked Tier, glassmorphic)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Badge: 🔒 "In-Home Tasks" (size: 18px, weight: 700, color: white, with lock icon)
   - Description (size: 14px, color: #E5E5EA, line-height: 1.6, margin-top: 8px):
     "Required for tasks involving private spaces or sensitive access."
   - No emotional framing, no upselling

3. REQUIREMENTS SECTION (Checklist, read-only, glassmorphic)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "Requirements" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Checklist (vertical list, spacing: 16px, margin-top: 16px):
     Each item shows state, not encouragement:
     
     - ⬜ "25 completed tasks" (size: 14px, color: #E5E5EA)
       - Current: "18 completed" (size: 12px, color: #8E8E93, margin-left: 24px)
     
     - ⬜ "5 five-star reviews from different posters" (size: 14px, color: #E5E5EA)
       - Current: "3 reviews" (size: 12px, color: #8E8E93, margin-left: 24px)
     
     - ⬜ "30 days account age" (size: 14px, color: #E5E5EA)
       - Current: "22 days active" (size: 12px, color: #8E8E93, margin-left: 24px)
     
     - ⬜ "Security deposit locked" (size: 14px, color: #E5E5EA)
       - Current: "Not locked" (size: 12px, color: #8E8E93, margin-left: 24px)
   
   - No progress animations. No percentages unless already defined in backend.
   - Each item shows state, not encouragement.

4. WHAT THIS AFFECTS (Glassmorphic, secondary)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Title: "What This Affects" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Bullet points (size: 14px, color: #E5E5EA, line-height: 1.8, margin-top: 12px):
     • "In-home tasks"
     • "Instant high-priority matching"
     • "Care-related work"
   - Factual, not promotional

5. PRIMARY ACTION (Full-width, single button)
   - Button: "Continue" (background: #8E8E93, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
   - No subtext needed
   - No "Apply," no "Request," no "Contact support."
   - This is the ONLY interactive element

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
- Card background: rgba(28, 28, 30, 0.6) with blur
- Neutral action: #8E8E93 (gray, not red/green)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone:
Factual. Boring. Deterministic.
This is a requirements document, not a marketing screen. Trust is earned, not requested.

Constraints:
- Static UI only. No animations.
- Read-only requirements (no editing, no appeals).
- No progress animations, no percentages (unless backend-defined).
- No way to bypass.
- No appeal language.
- No promises.
- No variable interpretation.
- No emotional language.
- No growth copy.
- No chat entry points.
```

---

### Stitch Prompt (Hustler Variant)

The Hustler variant is **symmetric** with the following differences:

**Requirements Section (Hustler-specific):**
- ⬜ "10 completed tasks" (instead of 25)
  - Current: "7 completed"
- ⬜ "0 disputes" (instead of 5 reviews)
  - Current: "0 disputes"
- ⬜ "30 days account age" (same)
  - Current: "22 days active"
- ⬜ "Verified ID" (instead of security deposit)
  - Current: "Not verified"

**What This Affects (Hustler-specific):**
- Bullet points:
  • "In-home tasks"
  • "Instant high-priority matching"
  • "Care-related work"
  • "Higher-value task eligibility"

Everything else is identical. The screen is **read-only, non-emotional, non-negotiable**.

---

### Lock Criteria (Must All Pass)

* ✅ No way to bypass
* ✅ No appeal language
* ✅ No promises
* ✅ No variable interpretation
* ✅ Read-only requirements (requirements document, not application)
* ✅ Factual system language only
* ✅ Explicit requirements shown
* ✅ Single primary action (continue, no "Apply" or "Request")
* ✅ No progress animations (unless backend-defined)
* ✅ No emotional language
* ✅ No growth copy
* ✅ No chat entry points

When locked, this screen **must not change** without backend changes.

---

### Design Notes

**Why this matters:**
- Makes trust boring, deterministic, and earned
- Prevents "how do I unlock this?" confusion
- Maintains system authority (requirements document, not application)
- Eliminates bypass attempts and appeals

**Visual Authority:**
- Read-only requirements checklist (requirements document, not application)
- Factual tier description (no emotional framing)
- Current state shown (no progress animations)
- Single primary action (continue, no "Apply" or "Request")

**Behavioral Rules (Enforced by UI):**
- ❌ Cannot bypass requirements (no "Apply" or "Request" buttons)
- ❌ Cannot appeal or contact support (no chat entry point)
- ❌ Cannot edit requirements (read-only checklist)
- ❌ Cannot see progress animations (unless backend-defined)
- ❌ Cannot request manual override (no appeal language)

---
