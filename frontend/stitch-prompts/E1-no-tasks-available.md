# Screen E1: No Tasks Available (Hustler View)
## Purpose: Prevent "is the app broken?" confusion when supply > demand

### Screen Purpose (Non-Negotiable)

This screen exists to explain **system idleness**, not user failure.

It must be:
- **Factual** (system speaks truth, not hope)
- **Explicit** (reason is clear)
- **Non-interactive** (no refresh loops, no retry buttons)
- **Non-emotional** (no "almost there!", no growth copy)

When triggered:
- Task feed query returns zero eligible tasks
- Includes Instant + non-Instant

Core message:
> "No tasks available right now"

Not "Nothing yet," not "Check back later," not "We're working on it."

---

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: No Tasks Available (Hustler View, Edge State)

Style: Apple Glass aesthetic, clean typography, authoritative and transparent.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Tone:
Factual. Transparent. Non-emotional.
The system is idle, not broken. No refresh loops, no false hope.

Visual Requirements:
- Empty state with clear explanation
- Read-only status indicators
- Single primary action (no retry, no refresh)
- No spinners, no fake activity, no placeholders

Content Layout (Top to Bottom):

1. HEADER (Top)
   - Title: "No tasks available" (size: 28px, weight: 700, color: white)
   - Subtitle: "There are currently no tasks matching your eligibility and location." (size: 14px, color: #8E8E93, margin-top: 8px, line-height: 1.5)

2. SYSTEM CONTEXT CARD (Glassmorphic, primary)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Icon: Shield icon (size: 24px, color: #8E8E93, margin-bottom: 12px)
   - Title: "System Status" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Bullet points (size: 14px, color: #E5E5EA, line-height: 1.8, margin-top: 12px):
     • "Your account is active and eligible"
     • "Matching is automatic — no action required"
     • "Tasks appear when demand exists nearby"
   - This anchors reality: system works, just no demand right now

3. TIME-BASED EXPECTATION (Secondary, if applicable)
   - Helper text (size: 12px, color: #8E8E93, italic, margin-top: 12px, same card as System Context):
     "New tasks typically appear within 24 hours. No action required from you."
   - Note: Time-based expectation, not promises
   - No "check back later" — implies user responsibility
   - No "we're working on it" — implies system failure
   - This sets realistic expectations without false hope

4. STATUS CHIPS (Read-Only, optional)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Title: "Current Settings" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Chips (horizontal flex, gap: 8px, margin-top: 12px):
     - Location: "UW Campus + 2mi" (background: rgba(255, 255, 255, 0.1), padding: 6px 12px, rounded: 8px, size: 12px, color: white)
     - Trust Tier: "Tier B — Trusted" (background: rgba(255, 255, 255, 0.1), padding: 6px 12px, rounded: 8px, size: 12px, color: white)
     - Instant Mode: "ON" (background: rgba(66, 188, 240, 0.2), padding: 6px 12px, rounded: 8px, size: 12px, color: #42bcf0)
   - All chips are read-only (no interaction)

4. PRIMARY ACTION (Full-width, single button)
   - Button: "Return to Dashboard" (background: #8E8E93, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
   - No subtext needed
   - This is the ONLY interactive element
   - No refresh button. No pull-to-refresh CTA. No dopamine loop.

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
Factual. Transparent. Non-emotional.
The system is idle, not broken. No refresh loops, no false hope.

Constraints:
- Static UI only. No animations.
- No spinners as explanations.
- No retry buttons for deterministic states.
- No emotional language.
- No growth copy.
- No chat entry points.
- No implication of user fault.
- No suggestion to "try harder."
- No fake activity or placeholders.
- Clear that system is idle, not broken.
```

---

### Lock Criteria (Must All Pass)

* ✅ No implication of user fault
* ✅ No suggestion to "try harder"
* ✅ No fake activity or placeholders
* ✅ Clear that system is idle, not broken
* ✅ Factual system language only
* ✅ Explicit reason shown
* ✅ Single primary action (no refresh, no retry)
* ✅ No emotional language
* ✅ No growth copy
* ✅ No chat entry points

When locked, this screen **must not change** without backend changes.

---

### Design Notes

**Why this matters:**
- Prevents "is the app broken?" confusion when supply > demand
- Anchors reality: system works, just no demand right now
- Eliminates refresh loops and false hope
- Maintains trust through transparency
- **This is the most frequently encountered alpha condition** and the highest trust risk if mishandled
- Users will see this constantly in alpha — it must not look like a loading failure, suggest low trust, or suggest user error

**Visual Authority:**
- Factual title ("No tasks available")
- System context card (account active, matching automatic)
- Read-only status chips (shows current eligibility)
- Single primary action (return to dashboard)

**Behavioral Rules (Enforced by UI):**
- ❌ Cannot refresh to force tasks (no retry button)
- ❌ Cannot change eligibility from here (status chips read-only)
- ❌ Cannot contact support for empty feed (no chat entry point)
- ❌ Cannot trigger false activity (no spinners, no placeholders)
- ❌ Cannot see "check back later" (implies user responsibility)
- ❌ Cannot see "we're working on it" (implies system failure)

**What This Prevents:**
- "Is the app broken?" confusion (system idle, not broken)
- Refresh loops and retry abuse (no retry button)
- False hope and emotional manipulation (time-based expectation, not promises)
- Support escalation (explicit reason, no chat entry point)
- User blame (system speaks factually, not user-blaming)

---
