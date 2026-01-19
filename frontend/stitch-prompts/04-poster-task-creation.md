# Screen 4: Poster Task Creation (AI-Assisted)
## Purpose: Reduce bad tasks *before* they exist

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Task Creation with AI Guidance (Poster View)

Style: Apple Glass aesthetic, clean typography, subtle glassmorphism, helpful but authoritative.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Visual Requirements:
- Scrollable form
- AI guidance appears inline (not popups)
- Risk classification visible
- Instant Mode toggle with explanation

Content Layout (Top to Bottom):

1. HEADER
   - "Create Task" (title, size: 28px, weight: 700, color: white)
   - Back button (standard iOS)

2. TASK DETAILS FORM
   - Title field: "What needs to be done?" (placeholder, size: 16px)
     - AI hint below if incomplete: "💡 Add specific dimensions or quantities" (amber, size: 12px)
   - Description field: "Provide details..." (placeholder, multi-line)
     - AI hint if vague: "💡 Clarify location access instructions" (amber, size: 12px)
   - Location field: "Where?" (with map pin icon)
     - AI hint if missing: "💡 Location required for Instant Mode" (amber, size: 12px)

3. AI COMPLETENESS INDICATOR (Card, below form)
   - Status: "✓ Task is Instant-ready" (green) OR "⚠ Needs clarification" (amber)
   - Missing fields list (if any):
     * "• Add access instructions"
     * "• Specify quantity"
   - "AI checked" badge (small, subtle)

4. RISK CLASSIFICATION PREVIEW (Card, below AI indicator)
   - "Risk Level: IN-HOME" (label, size: 12px, color: #8E8E93)
   - "Requires trusted hustler (Tier 3+)" (description, size: 14px, color: white)
   - Visual indicator: Shield icon + tier badge
   - Auto-classified (not user choice)

5. INSTANT MODE TOGGLE (Card, below risk)
   - Toggle switch: "⚡ Instant Execution" (large, prominent)
   - Explanation: "Get a hustler on the way in under 60 seconds" (size: 14px, color: #8E8E93)
   - Status: Enabled (green) OR Disabled (grey) based on AI completeness
   - If disabled: "Complete task details above to enable" (amber, size: 12px)

6. PRICING
   - Amount field: "$45.00" (large, prominent)
   - "Suggested: $40-50" (AI suggestion, subtle)

7. SUBMIT BUTTON
   - "Post Task" (full-width, height: 56px, background: #34C759, white text, size: 18px, weight: 700)
   - Disabled state if Instant Mode enabled but task incomplete

Spacing:
- Section spacing: 24px vertical
- Card padding: 20px
- Form field spacing: 16px

Typography:
- Font family: SF Pro Display
- Form labels: weight 600, size: 14px
- AI hints: weight 500, size: 12px, italic

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur
- AI hints: #FF9500 (amber)
- Success: #34C759 (green)
- Primary action: #34C759
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone: The system is helping, not asking. AI is authoritative, not suggestive.

Constraints:
- Static UI only. No animations.
- AI guidance is inline, not popups.
- Risk classification is automatic (not user choice).
- Instant Mode toggle is gated by AI completeness.
```

### Design Notes

**Why this matters:**
- Prevents bad tasks from being created
- Makes AI gate visible and helpful
- Shows system is in control (risk classification automatic)
- Reduces support burden

**Visual Authority:**
- AI hints are amber (attention) not red (error)
- Risk classification is automatic (not optional)
- Instant Mode is gated (not always available)
- System helps, doesn't ask permission

**Trust Signals:**
- Clear risk classification
- AI completeness is transparent
- No hidden requirements
- System prevents problems before they exist

---
