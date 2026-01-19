# Screen 1: Instant Interrupt Card (Hustler View)
## Priority: CRITICAL — This is the most important UI in the product

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Instant Task Interrupt (Hustler View)

Style: Apple Glass aesthetic, clean typography, subtle glassmorphism, controlled urgency. 
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Visual Requirements:
- Full-width modal interrupt (covers entire screen with subtle backdrop blur)
- Glassmorphic card with frosted glass effect (backdrop-filter: blur)
- Red/amber urgency accent border (top edge, 4px solid, gradient from #FF3B30 to #FF9500)
- Subtle shadow for depth (not heavy, just enough to lift from background)

Content Hierarchy (Top to Bottom):

1. HEADER (Top 20% of screen)
   - "⚡ INSTANT TASK" label (uppercase, tracking: 2px, color: #FF3B30, size: 12px, weight: 600)
   - Countdown timer: "First to accept — 00:45" (large, bold, color: #F2F2F7, size: 32px, opacity: 90%)
   - XP bonus badge: "+1.8× XP" (pill-shaped, amber background #FF9500, white text, size: 14px)
   - **SPACING: 12px gap between XP pill and task title below**

2. TASK PREVIEW (Middle 50% of screen)
   - Task title: "Move furniture — 2nd floor" (size: 24px, weight: 700, color: white, max 2 lines)
   - Location hint: "📍 0.8 mi away" (size: 16px, color: #8E8E93, icon + text)
   - Pay amount: "$45.00" (size: 36px, weight: 800, color: #34C759, green accent)
   - Trust requirement badge: "Tier 2+ required" (subtle, size: 12px, color: #8E8E93)

3. ACTIONS (Bottom 30% of screen)
   - Primary button: "ACCEPT & GO" (full-width, height: 56px, background: #34C759, white text, size: 18px, weight: 700, rounded corners: 12px)
   - Secondary button: "Skip this task" (text button, color: #8E8E93, size: 15px, weight: 500, padding: 16px, opacity: 85%)

Spacing:
- Card padding: 24px all sides
- Element spacing: 16px vertical between major sections
- **CRITICAL: 12px extra spacing between XP pill and task title** (total: 28px from XP pill to task title)
- Button spacing: 12px between Accept and Dismiss

Typography:
- Font family: SF Pro Display (system font stack)
- Headings: weight 700-800
- Body: weight 400-500
- Labels: weight 600

Color Palette:
- Background: #000000 (true black, not dark grey)
- Card background: rgba(28, 28, 30, 0.8) with blur
- Primary accent: #34C759 (green for money/accept)
- Urgency accent: #FF3B30 (red) to #FF9500 (amber)
- Timer text: #F2F2F7 (light off-white, 90% opacity) - de-emphasized to not compete with task title
- Text primary: #FFFFFF
- Text secondary: #8E8E93
- Skip button: #8E8E93 at 85% opacity (more subordinate)

Tone: Authoritative, focused, game-like but not childish. Controlled urgency, not panic.

Constraints:
- Static UI only. No animations.
- No placeholder charts or fake data beyond what's specified.
- No decorative elements that distract from the action.
- Countdown timer should be prominent but not flashing or pulsing (static design only).
```

### Design Notes

**Why this matters:**
- This is where virality comes from
- First impression of Instant Mode
- Must feel inevitable, not optional
- One-tap accept is the entire value prop

**Visual Authority:**
- Glassmorphism signals premium
- Red/amber border signals urgency without being aggressive
- Large countdown creates time pressure (de-emphasized color prevents overpowering task value)
- **12px spacing between urgency (XP pill) and reward (task title) creates clean cognitive transition**
- XP bonus makes the reward clear
- Skip button is subordinate (85% opacity, 1pt smaller) to prevent accidental dismissals

**Trust Signals:**
- "Tier 2+ required" shows system is in control
- Clean, Apple-like design signals legitimacy
- No spammy or aggressive copy

---
