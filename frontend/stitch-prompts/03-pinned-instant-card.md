# Screen 3: Pinned Instant Card (Post-Dismiss)
## Purpose: No regret, no punishment — but opportunity still visible

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Pinned Instant Task Card (Hustler Feed View)

Style: Apple Glass aesthetic, clean typography, subtle glassmorphism, muted urgency.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Visual Requirements:
- Card appears at top of task feed (below search/header)
- Glassmorphic card with subtle border (not full-width modal)
- Muted urgency styling (amber border, not red)
- Accept button still prominent but not interruptive

Content Layout (Card Structure):

1. CARD HEADER (Top section)
   - "⚡ INSTANT" label (uppercase, size: 11px, color: #FF9500, weight: 600)
   - Subtle amber left border (2px solid, color: #FF9500, full height)
   - "Limited availability" (subtext, size: 12px, color: #8E8E93, right-aligned)

2. TASK INFO (Middle section)
   - Task title: "Move furniture — 2nd floor" (size: 18px, weight: 700, color: white, max 2 lines)
   - Location: "📍 0.8 mi away" (size: 14px, color: #8E8E93)
   - Pay: "$45.00" (size: 24px, weight: 800, color: #34C759)
   - XP bonus: "+1.8× XP" (small badge, amber background, size: 12px)

3. ACTION (Bottom section)
   - "Accept" button (full-width within card, height: 44px, background: #34C759, white text, size: 16px, weight: 600, rounded: 8px)
   - No dismiss button (already dismissed, this is re-engagement)

Card Specifications:
- Width: Full width minus 16px margin (each side)
- Padding: 16px all sides
- Border radius: 12px
- Background: rgba(28, 28, 30, 0.6) with blur
- Border: 1px solid rgba(255, 149, 0, 0.3) (subtle amber)
- Left accent: 2px solid #FF9500 (amber, not red)

Spacing:
- Internal spacing: 12px vertical between sections
- Card margin: 16px top, 0px bottom (first item in feed)

Typography:
- Font family: SF Pro Display
- Headings: weight 700
- Body: weight 400-500

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur
- Urgency accent: #FF9500 (amber, muted from interrupt)
- Primary action: #34C759 (green)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone: Opportunity still available, but not pushy. No punishment for dismissing.

Constraints:
- Static UI only. No animations.
- Not a modal (part of feed).
- Muted compared to interrupt card.
- Accept button still clear and accessible.
```

### Design Notes

**Why this matters:**
- Preserves opportunity without annoyance
- Shows system respects user choice
- Maintains urgency without being pushy
- Allows re-engagement without friction

**Visual Hierarchy:**
- Muted amber (not red) = less urgent but still visible
- Part of feed (not modal) = less interruptive
- Accept button still prominent = easy to change mind
- No dismiss button = already dismissed, this is second chance

---
