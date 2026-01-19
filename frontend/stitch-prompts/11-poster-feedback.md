# Screen 11: Poster Feedback / Rating (Controlled)
## Purpose: Capture signal not emotion, anchor feedback to objective task criteria, protect trust system from outliers, close loop without reopening disputes

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Poster Feedback (Controlled)

Style: Apple Glass aesthetic, calm, neutral, system-led.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Tone:
Objective. Calm. Non-emotional.
This is a confirmation step, not a judgment.

Visual Requirements:
- No star-first rating
- Criteria-based confirmation
- Optional comments, clearly de-emphasized
- Trust impact explained transparently
- No gamification
- No celebratory language

Content Layout (Top to Bottom):

1. HEADER (Top)
   - Title: "Confirm Task Outcome" (size: 28px, weight: 700, color: white)
   - Subtitle: "Your feedback helps keep the system accurate" (size: 14px, color: #8E8E93, margin-top: 8px)

2. FEEDBACK GATE SCREEN (Lightweight Intermediate Screen — Shown BEFORE feedback form)
   - CRITICAL FIX #2: Insert this screen on "Confirm Task Outcome" tap
   - Full-screen overlay or modal (background: rgba(0, 0, 0, 0.95), blur)
   - Title: "Confirm Outcome" (size: 24px, weight: 700, color: white)
   - Copy (size: 16px, color: #E5E5EA, line-height: 1.6, margin-top: 12px):
     "Your feedback is about the task — not the person. Payment is already complete."
   - Buttons:
     - Primary: "Continue" (background: #34C759, color: white, height: 52px, full-width)
     - Secondary: "Skip feedback" (text button, color: #8E8E93, margin-top: 12px)
   - This single sentence prevents 80% of abuse

3. TASK SUMMARY (Card, glassmorphic — Inside Feedback Form)
   - CRITICAL FIX #3: Suppress hustler identity during feedback
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Task title: "Site Survey: Sector 4" (size: 18px, weight: 700, color: white)
   - Contract ID: "#820-A4" (size: 11px, color: #8E8E93, monospace, uppercase, tracking: 1px, margin-top: 4px)
   - CRITICAL FIX #3: NO avatar, NO name, NO tier, NO role badge
   - Identity is irrelevant at this stage. Only execution matters.

4. CRITERIA CONFIRMATION (Primary Section, glassmorphic card — FIRST INTERACTION)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "Did the task meet the agreed criteria?" (size: 16px, weight: 700, color: white, margin-bottom: 16px)
   
   Criteria (each required, vertical spacing: 16px):
   
   Criterion 1:
   - Label: "Work completed as described" (size: 15px, weight: 600, color: white)
   - Binary control: Toggle or segmented control
     - "Yes" (default, pre-selected, green accent #34C759)
     - "No" (amber accent #FF9500)
   - If "No" selected: Explanation note appears (size: 12px, color: #FF9500, margin-top: 8px):
     "Selecting 'No' may trigger a system review."
   
   Criterion 2:
   - Label: "Required areas were covered" (size: 15px, weight: 600, color: white)
   - Binary control: "Yes" (default) / "No"
   - If "No" selected: Same explanation note
   
   Criterion 3:
   - Label: "No issues encountered" (size: 15px, weight: 600, color: white)
   - Binary control: "Yes" (default) / "No"
   - If "No" selected: Same explanation note

5. OVERALL SATISFACTION (Secondary, glassmorphic card — AFTER Criteria)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Label: "Overall experience" (size: 14px, weight: 600, color: #8E8E93, uppercase, tracking: 1px)
   - Scale: 1–5 (icon-based, not stars, horizontal layout, spacing: 12px)
     - Icons: Circle icons (unfilled = not selected, filled = selected)
     - Size: 32px each
     - Color: #8E8E93 (unselected), #34C759 (selected)
     - No selection required (all unselected by default)
   - Helper text (size: 12px, color: #8E8E93, margin-top: 12px, italic):
     "This does not affect payment. Outlier feedback may be reviewed automatically."

6. OPTIONAL COMMENT (De-emphasized, glassmorphic card)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Label: "Optional note" (size: 12px, color: #8E8E93, uppercase, tracking: 1px)
   - Textarea (background: transparent, border: 1px solid rgba(255, 255, 255, 0.1), rounded: 8px, padding: 12px, color: white, min-height: 80px)
   - Placeholder: "Visible to system moderators only" (size: 14px, color: #8E8E93, italic)
   - Character counter: "0 / 240" (size: 11px, color: #8E8E93, text-align: right, margin-top: 4px)
   - Styling: Clearly non-primary, greyed, de-emphasized

7. TRUST IMPACT DISCLOSURE (System Card, glassmorphic)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 16px
   - Icon: Shield icon (size: 20px, color: #8E8E93)
   - Text (size: 12px, color: #8E8E93, line-height: 1.5, margin-top: 8px):
     "Ratings are weighted by task type, risk level, and verification status. Outlier feedback may be reviewed automatically."
   - Styling: Informational, not warning, neutral tone

8. PRIMARY ACTION (Full-width — On Initial Completion Screen, NOT Feedback Form)
   - CRITICAL FIX #1: Button: "Confirm Task Outcome" (NOT "Leave Feedback")
   - Icon: Checklist or shield icon (NOT thumbs)
   - Background: #34C759, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width
   - Subtext: "Optional — helps improve matching accuracy" (size: 12px, color: #8E8E93, margin-top: 8px, text-center)
   - This reframes the action as verification, not opinion

9. SUBMIT CONFIRMATION (Inside Feedback Form)
   - Button: "Submit Confirmation" (background: #34C759, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
   - Subtext: "This will finalize feedback for this task." (size: 12px, color: #8E8E93, margin-top: 8px, text-center)

10. SECONDARY ACTION (Subdued, Inside Feedback Form)
   - Text button: "Skip feedback" (size: 14px, color: #8E8E93, opacity: 0.7, weight: 400, margin-top: 16px, text-center, underline decoration, underline-offset: 4px)
   - Tooltip on tap (if implemented): "You can skip. Feedback is optional." (size: 11px, color: #8E8E93)

Spacing:
- Card spacing: 16px vertical
- Card padding: 20px (16px for de-emphasized cards)
- Section spacing: 24px
- Header margin-bottom: 24px

Typography:
- Font family: SF Pro Display
- Headers: weight 700
- Criteria labels: weight 600
- Helper text: weight 400

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur
- Primary: #34C759 (green)
- Warning: #FF9500 (amber)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone:
Objective. Calm. Non-emotional.
This is a confirmation step, not a judgment.

Constraints:
- Static UI only. No animations.
- No gamification.
- No celebratory language.
- No visible trust score changes.
- No star-first rating.
- Criteria confirmation is required (at least one criterion must be answered).
- Overall satisfaction is optional.
- Comments are de-weaponized (not public, not prominent, not rewarded).
```

### Design Notes

**Why this matters:**
- Captures signal, not emotion
- Anchors feedback to objective task criteria
- Protects trust system from outliers
- Closes the loop without reopening disputes
- Prevents trust score poisoning
- Prevents retaliatory 1-star abuse
- Prevents poster regret after payout
- Prevents support escalation loops
- Prevents hustler fear of arbitrary punishment

**Core Principle:**
**Posters do not rate people. They confirm task outcomes.**
The system derives trust deltas.

**Visual Authority:**
- CRITICAL FIX #1: Primary CTA is "Confirm Task Outcome" (NOT "Leave Feedback") — reframes as verification, not opinion
- CRITICAL FIX #2: Feedback gate screen prevents emotional input ("Your feedback is about the task — not the person")
- CRITICAL FIX #3: Hustler identity suppressed during feedback (no avatar, no name, no tier) — prevents identity priming, halo effects, bias carryover
- CRITICAL FIX #4: Criteria confirmation is FIRST interaction (before any rating) — forces cognition before emotion
- CRITICAL FIX #5: Satisfaction scoring de-emphasized (no stars, neutral icons, optional, below criteria, with guardrail text) — psychological circuit breaker
- Binary confirmation anchors truth ("Yes / No" forces facts, not feelings)
- Trust impact is explained but abstracted (posters understand feedback matters but cannot directly manipulate outcomes)
- Comments are de-weaponized (not public, not prominent, not rewarded)

**Behavioral Rules (Enforced by UI):**
- ❌ Cannot rate without confirming criteria (criteria confirmation is required)
- ❌ Cannot see immediate trust score changes (no visible deltas)
- ❌ Cannot use comments as public weapon (comments are system-only, de-emphasized)
- ❌ Cannot skip criteria confirmation (required, but can skip overall satisfaction)
- ❌ Cannot initiate dispute here (dispute is separate, exceptional flow)

**Backend States Represented:**
- `task.status = COMPLETED_APPROVED`
- `escrow.status = RELEASED`
- `proof.status = VERIFIED`
- `poster_feedback.status = PENDING`

**Screen must never appear if:**
- Task is disputed
- Completion is blocked
- Proof is under review

**Critical Design Safeguards:**
1. **Criteria First, Rating Second** — Prevents revenge ratings, vibe-based scoring, emotional punishment
2. **Binary Confirmation Anchors Truth** — "Yes / No" forces posters to think in facts, not feelings
3. **Trust Impact Is Explained (But Abstracted)** — Posters understand feedback matters but cannot directly manipulate outcomes
4. **Comments Are De-Weaponized** — Not public, not prominent, not rewarded

**What This Prevents:**
- Trust score poisoning
- Retaliatory 1-star abuse
- Poster regret after payout
- Support escalation loops
- Hustler fear of arbitrary punishment

**Adversarial Test:**
- ✅ Poster cannot revenge-rate (criteria-first, binary confirmation, no star-first)
- ✅ Poster cannot weaponize comments (de-emphasized, system-only, not public)
- ✅ Poster cannot see immediate trust impact (abstracted disclosure, no visible deltas)
- ✅ Poster cannot skip criteria (required, but can skip overall satisfaction)
- ✅ Poster cannot initiate dispute (separate, exceptional flow)

---
