# Screen 7: XP Breakdown / Rewards Screen
## Purpose: Explain *why* Instant Mode is addictive

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: XP Breakdown & Rewards (Hustler View)

Style: Apple Glass aesthetic, clean typography, subtle glassmorphism, clear cause → effect mapping.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Visual Requirements:
- Scrollable breakdown
- Multipliers clearly explained
- Today's earnings breakdown
- Clear cause → effect

Content Layout (Top to Bottom):

1. HEADER
   - "XP Breakdown" (title, size: 28px, weight: 700, color: white)
   - "Today" (subtitle, size: 14px, color: #8E8E93)

2. TODAY'S SUMMARY (Card, top)
   - Glassmorphic card (background: rgba(28, 28, 30, 0.6), blur)
   - "Total XP Earned" (label, size: 12px, color: #8E8E93, uppercase)
   - "342 XP" (amount, size: 48px, weight: 800, color: white)
   - "From 3 tasks" (subtext, size: 14px, color: #8E8E93)

3. MULTIPLIERS BREAKDOWN (Cards, below summary)

   SECTION LABEL: "REAL-TIME BONUSES" (size: 11px, uppercase, tracking: 1px, color: #8E8E93, weight: 600, margin-bottom: 12px)

   INSTANT MODE MULTIPLIER
   - Card: Glassmorphic
   - Icon: ⚡ (size: 24px, amber #FF9500)
   - "Instant Mode Bonus" (label, size: 14px, weight: 600, color: white)
   - "1.5× base XP" (multiplier, size: 18px, weight: 700, color: #FF9500)
   - "Applied to: 2 tasks" (detail, size: 12px, color: #8E8E93)
   - "+68 XP" (bonus amount, size: 16px, color: #34C759)

   SPEED MULTIPLIER
   - Card: Glassmorphic
   - Icon: ⏱ (size: 24px, green #34C759)
   - "Speed Bonus" (label, size: 14px, weight: 600, color: white)
   - "1.2× (accepted in 28s)" (multiplier, size: 18px, weight: 700, color: #34C759)
   - "Applied to: 1 task" (detail, size: 12px, color: #8E8E93)
   - "+24 XP" (bonus amount, size: 16px, color: #34C759)

   SURGE MULTIPLIER
   - Card: Glassmorphic
   - Icon: 📈 (size: 24px, amber #FF9500)
   - "Surge Bonus" (label, size: 14px, weight: 600, color: white)
   - "2.0× (Level 2 surge)" (multiplier, size: 18px, weight: 700, color: #FF9500)
   - "Applied to: 1 task" (detail, size: 12px, color: #8E8E93)
   - "(limited window)" (muted text, size: 11px, color: #8E8E93, opacity: 0.7) — REFINEMENT: Prevents surge from feeling like a reliable farm
   - "+50 XP" (bonus amount, size: 16px, color: #34C759, opacity: 0.9) — REFINEMENT: Slightly de-emphasized if surge is rare

   SECTION LABEL: "CONSISTENCY BONUS" (size: 11px, uppercase, tracking: 1px, color: #8E8E93, weight: 600, margin-top: 16px, margin-bottom: 12px)

   STREAK MULTIPLIER
   - Card: Glassmorphic
   - Icon: 🔥 (size: 24px, red #FF3B30)
   - "7-Day Streak" (label, size: 14px, weight: 600, color: white)
   - "1.1× bonus" (multiplier, size: 18px, weight: 700, color: #FF3B30)
   - "Keep it going!" (detail, size: 12px, color: #8E8E93)
   - "+12 XP" (bonus amount, size: 16px, color: #34C759)

4. BASE XP BREAKDOWN (Card, below multipliers)
   - "Base XP (before multipliers)" (label, size: 12px, color: #8E8E93, uppercase)
   - Task 1: "Move furniture" — "100 XP" (size: 14px, color: white)
   - Task 2: "Deliver package" — "80 XP" (size: 14px, color: white)
   - Task 3: "Assemble desk" — "120 XP" (size: 14px, color: white)
   - "Total base: 300 XP" (sum, size: 16px, weight: 600, color: white)

5. CALCULATION SUMMARY (Card, bottom)
   - "XP Resolution" (label, size: 12px, color: #8E8E93, uppercase) — REFINEMENT: "Resolution" sounds authoritative and final, not academic
   - Formula line 1: "300 base × 1.5 (Instant) × 1.2 (Speed) × 1.1 (Streak) = 594 XP" (size: 14px, color: white)
   - Formula line 2: "Capped at 2.0× → 300 × 2.0 = 600 XP" (size: 14px, color: white)
   - Formula line 3: "After quality & completion filters → Final: 342 XP" (size: 14px, color: #34C759, weight: 600)
   - Helper line: "Bonuses stack up to a 2.0× maximum. Quality gates apply." (size: 11px, color: #8E8E93, opacity: 0.8, italic)

Spacing:
- Card spacing: 16px vertical
- Card padding: 20px
- Section spacing: 24px

Typography:
- Font family: SF Pro Display
- Numbers: weight 700-800
- Labels: weight 600
- Details: weight 400

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur
- Instant: #FF9500 (amber)
- Speed: #34C759 (green)
- Surge: #FF9500 (amber)
- Streak: #FF3B30 (red)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone: Clear cause → effect. XP doesn't feel random. This prevents XP from feeling random.

Constraints:
- Static UI only. No animations.
- No fake charts or graphs.
- Formula is visible and clear.
- Multipliers are explained, not hidden.
```

### Design Notes

**Why this matters:**
- Makes XP feel earned, not random
- Shows why Instant Mode is rewarding
- Explains multipliers clearly
- Prevents confusion about rewards

**Visual Authority:**
- Clear breakdown = transparency
- Multipliers grouped by behavioral meaning (Real-time vs Consistency) = behavior-shaping UI
- Formula visible = no hidden math
- Cap behavior explicitly shown = mathematical truthfulness
- Quality gates mentioned = reinforces discipline
- Cause → effect mapping = predictable rewards

**Trust Signals:**
- Calculation is transparent and mathematically honest
- Cap behavior explicitly shown (not implied)
- Multipliers grouped by behavioral meaning (Real-time vs Consistency)
- Quality gates mentioned = no multiplier bypasses discipline
- Formula reconciles = cannot screenshot and claim "XP is lying"
- System is fair, predictable, and auditable

---
