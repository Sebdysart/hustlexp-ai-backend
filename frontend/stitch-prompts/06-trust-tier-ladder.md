# Screen 6: Trust Tier Ladder Screen
## Purpose: Make safety *visible* and aspirational

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Trust Tier Ladder (Hustler View)

Style: Apple Glass aesthetic, clean typography, subtle glassmorphism, aspirational but serious.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Visual Requirements:
- Vertical ladder layout
- Current tier highlighted
- Locked tiers greyed out
- Clear requirements per tier

Content Layout (Top to Bottom):

1. HEADER
   - "Trust Tiers" (title, size: 28px, weight: 700, color: white)
   - "Earned, not requested" (subtitle, size: 14px, color: #8E8E93)

2. TIER LADDER (Vertical list, scrollable)

   TIER A — UNVERIFIED (Bottom tier)
   - Card: Glassmorphic, greyed out if locked
   - Badge: "TIER A" (size: 16px, weight: 700)
   - Status: "Starting point" (size: 14px, color: #8E8E93)
   - Requirements: "Complete profile verification" (size: 12px, color: #8E8E93)
   - Visual: Lock icon if not current tier

   TIER B — VERIFIED (Current tier, highlighted)
   - Card: Glassmorphic, blue accent border (#007AFF, 2px)
   - Badge: "✓ You are here" (size: 14px, color: #34C759)
   - "Verified" (size: 24px, weight: 700, color: white) — REFINEMENT: Name carries meaning (primary)
   - "Tier B" (size: 14px, weight: 500, color: #007AFF, opacity: 0.8) — REFINEMENT: Letter de-emphasized (secondary, system transparency)
   - Requirements: "✓ 10+ completed tasks" (size: 12px, color: white)
   - Benefits: "• Accept standard tasks" (size: 12px, color: #8E8E93)
   - Visual: Checkmark, highlighted background

   TIER C — TRUSTED (Next tier, unlocked but not achieved)
   - Card: Glassmorphic, amber accent border (#FF9500, 2px)
   - Badge: "NEXT GOAL" (amber pill, top-left)
   - "Trusted" (size: 28px, weight: 700, color: white) — REFINEMENT: Name carries meaning (primary)
   - "Tier C" (size: 14px, weight: 500, color: #FF9500, opacity: 0.8) — REFINEMENT: Letter de-emphasized (secondary, system transparency)
   - Status: "2,847 / 3,200 XP needed" (size: 14px, color: #FF9500)
   - "Requirements are evaluated automatically." (size: 12px, color: #8E8E93, opacity: 0.7, below progress) — REFINEMENT: Preempts support questions without opening debate
   - Requirements: 
     * "50+ completed tasks" (size: 12px, color: white)
     * "3.5+ average rating" (size: 12px, color: white)
     * "No disputes in 30 days" (size: 12px, color: white)
   - Benefits: 
     * "• Accept Instant tasks" (size: 12px, color: #34C759)
     * "• Higher visibility" (size: 12px, color: #8E8E93)
   - Visual: Progress indicator, unlockable

   TIER D — IN-HOME (Locked tier)
   - Card: Glassmorphic, greyed out (opacity: 0.5)
   - Badge: "TIER D — IN-HOME" (size: 16px, weight: 700, grey)
   - Status: "🔒 Locked" (size: 14px, color: #8E8E93)
   - Requirements: "Complete Tier C first" (size: 12px, color: #8E8E93)
   - Benefits: "• Accept in-home tasks" (size: 12px, color: #8E8E93, greyed)
   - Visual: Lock icon, greyed out

3. PROGRESS SUMMARY (Card, bottom)
   - "Your Progress" (label, size: 12px, color: #8E8E93)
   - XP: "2,847 / 3,200" (size: 20px, weight: 700, color: white)
   - Tasks: "47 / 50 completed" (size: 16px, color: white)
   - Rating: "4.9★ average" (size: 16px, color: white)

Spacing:
- Tier card spacing: 16px vertical
- Card padding: 20px
- Section spacing: 24px

Typography:
- Font family: SF Pro Display
- Tier names: weight 700
- Requirements: weight 500
- Benefits: weight 400

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur
- Current tier: #007AFF (blue accent)
- Next tier: #FF9500 (amber accent)
- Locked tier: #8E8E93 (grey, 50% opacity)
- Success: #34C759 (green)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone: Aspirational but serious. Earned, not requested. This quietly kills bad actors.

Constraints:
- Static UI only. No animations.
- Current tier is clearly highlighted.
- Locked tiers are clearly greyed out.
- Requirements are factual, not inflated.
```

### Design Notes

**Why this matters:**
- Makes safety visible
- Shows progression path
- Makes trust tier aspirational
- Quietly kills bad actors (they can't fake it)

**Visual Authority:**
- Ladder layout = clear progression
- Current tier highlighted = you are here
- Locked tiers greyed = can't skip ahead
- Requirements clear = earned, not requested
- Tier names carry meaning (primary), letters are secondary (system transparency)
- "Requirements are evaluated automatically" = preempts support questions, reinforces system authority
- Tier names carry meaning (primary), letters are secondary (system transparency)
- "Requirements are evaluated automatically" = preempts support questions, reinforces system authority

**Trust Signals:**
- "Earned, not requested" messaging
- Requirements are factual
- No shortcuts or pay-to-win
- System is in control

---
