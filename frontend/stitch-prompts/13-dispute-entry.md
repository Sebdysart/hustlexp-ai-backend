# Screen 13: Dispute Entry (Rare Path, Frictioned)
## Purpose: Capture legitimate failures, prevent emotional retaliation, deter low-signal abuse, produce audit-ready records, preserve system authority

### Screen Purpose (Non-Negotiable)

This screen exists to:

* Capture **legitimate failures**
* Prevent **emotional retaliation**
* Deter **low-signal abuse**
* Produce **audit-ready records**
* Preserve **system authority**

Disputes are **exceptions**, not features.

**Entry Conditions (Hard Gated):**
This screen is **only reachable if ALL are true**:
- Task state = `FAILED` or `ACTION_REQUIRED → FAILED`
- Completion gate did **not** approve
- Trust Change Explanation screen has been viewed
- User explicitly selected "Dispute" from a failure-only affordance

No other entry paths exist.

---

### Stitch Prompt (Poster Variant)

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Dispute Entry (Poster View, Rare Path, Frictioned)

Style: Apple Glass aesthetic, calm, neutral, legal-grade.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

Tone:
Neutral. Legal. Calm.
Disputes are exceptions, not features. No urgency color, no green or red dominance.

Visual Requirements:
- Hard-gated entry (only after failure states)
- Read-only task context
- Structured input (no free-form rants)
- Explicit consequences shown
- Single irreversible submission
- No emotional language
- No ratings, no trust manipulation

Content Layout (Top to Bottom):

1. HEADER (Authority First)
   - Title: "Dispute Task Outcome" (size: 28px, weight: 700, color: white)
   - Subtitle: "Use this only if the task outcome is incorrect based on the agreed criteria." (size: 14px, color: #8E8E93, margin-top: 8px, line-height: 1.5)
   - Visual tone: Neutral, legal, calm, no urgency color, no green or red dominance

2. TASK CONTEXT (Immutable, Read-Only, glassmorphic card)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "Task Details" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Task title: "Site Survey: Sector 4" (size: 18px, weight: 700, color: white, margin-top: 8px)
   - Contract ID: "#820-A4" (size: 11px, color: #8E8E93, monospace, uppercase, tracking: 1px, margin-top: 4px)
   - Completion attempt timestamp: "Completion attempted on Oct 24, 2024 at 2:34 PM" (size: 12px, color: #8E8E93, margin-top: 8px)
   - System verdict: "Completion not approved" (size: 14px, color: #8E8E93, margin-top: 8px, with icon)
   - This anchors reality before opinion

3. DISPUTE QUALIFICATION (Cognitive Gate, Required)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "Dispute Qualification" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Warning text (size: 14px, color: #E5E5EA, line-height: 1.6, margin-top: 12px):
     "Disputing triggers a manual review by HustleXP staff. This freezes funds and may delay payment release by up to 7 days."
   - CRITICAL FIX #2: Certification checkbox text (required, size: 14px, color: white, weight: 500, margin-top: 16px):
     ☐ "I confirm that the selected issue is accurate and understand that false or unsupported disputes may reduce my future task eligibility."
   - Cooldown indicator (size: 11px, color: #8E8E93, margin-top: 12px, italic):
     "You may submit one dispute per task. This action cannot be undone."
   - No checkbox → form disabled (cannot submit)

4. DISPUTE REASON (Structured, Limited, glassmorphic card)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "Dispute Reason" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Prompt: "Which requirement was not met?" (size: 16px, weight: 600, color: white, margin-top: 12px)
     - CRITICAL FIX #1: Reasons must map 1-to-1 to backend invariants, phrased as contract violations (not feelings)
   
   Selectable options (radio buttons, max 1, vertical spacing: 12px, margin-top: 16px):
   
   **Poster-side options (invariant-mapped):**
   - ☐ "Required deliverables missing" (size: 14px, color: white, weight: 500)
   - ☐ "Proof does not meet stated criteria" (size: 14px, color: white, weight: 500)
   - ☐ "Work deviates from task description" (size: 14px, color: white, weight: 500)
   - ☐ "Location or time verification mismatch" (size: 14px, color: white, weight: 500)
   - ☐ "System error (proof upload / verification failure)" (size: 14px, color: white, weight: 500)
   
   **Hustler-side options (invariant-mapped):**
   - ☐ "Access not provided as described" (size: 14px, color: white, weight: 500)
   - ☐ "Task requirements changed after acceptance" (size: 14px, color: white, weight: 500)
   - ☐ "System verification error" (size: 14px, color: white, weight: 500)
   - ☐ "Safety issue prevented completion" (size: 14px, color: white, weight: 500)
   
   No "suspicious activity." No "unclear requirements." No "felt wrong." No "Other" option. No free-form rants. No multi-select. No star ratings.

5. EVIDENCE INPUT (Optional, Capped, glassmorphic card)
   - Glass card (background: rgba(28, 28, 30, 0.4), blur, border: rgba(255, 255, 255, 0.05))
   - Padding: 16px
   - Title: "Supporting Evidence" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Helper text (size: 12px, color: #8E8E93, margin-top: 8px, italic):
     "Only upload evidence directly related to the task criteria."
   - Upload control: "Upload up to 2 images" (size: 14px, color: white, weight: 500, with upload icon)
   - Limitations (size: 11px, color: #8E8E93, margin-top: 8px):
     "Images only. No video. No annotations."
   - This prevents data dumping

6. CONSEQUENCES DISCLOSURE (Critical, glassmorphic card)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 16px
   - Icon: Shield icon (size: 20px, color: #8E8E93)
   - Title: "Important" (size: 14px, weight: 700, color: white, margin-top: 8px)
   - Bullet points (size: 12px, color: #E5E5EA, line-height: 1.6, margin-top: 12px):
     • "Disputes pause XP and trust updates"
     • "Abuse may reduce future dispute eligibility"
     • "Most disputes resolve within 48 hours"
   - This alone kills impulsive submissions

7. PRIMARY ACTION (Singular, Full-width)
   - Button: "Submit Dispute" (background: #8E8E93, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
     - Note: Neutral color (not red/green) to avoid emotional priming
     - Disabled state if checkbox not checked or reason not selected
   - Secondary action: "Cancel" (text button, size: 14px, color: #8E8E93, opacity: 0.7, weight: 400, margin-top: 12px, text-center)
   - No "Contact Support" here. Support is downstream, not parallel.

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
Neutral. Legal. Calm.
Disputes are exceptions, not features. No urgency color, no green or red dominance.

Constraints:
- Static UI only. No animations.
- Hard-gated entry (only after failure states).
- Read-only task context (no editing).
- Structured input (no free-form rants).
- Explicit consequences shown.
- Single irreversible submission.
- No emotional language.
- No ratings, no trust manipulation.
```

---

### Stitch Prompt (Hustler Variant)

The Hustler variant is **symmetric** with the following differences:

1. **Header subtitle**: "Use this only if the task outcome is incorrect based on the agreed criteria."

2. **Dispute Reasons** (invariant-mapped, hustler perspective):
   - ☐ "Access not provided as described"
   - ☐ "Task requirements changed after acceptance"
   - ☐ "System verification error"
   - ☐ "Safety issue prevented completion"
   - CRITICAL FIX #1: No "unclear," no "unfeasible," no "Other" option. Invariant-mapped contract violations only.

3. **Consequences Disclosure** (hustler-specific):
   - Bullet points:
     • "Disputes pause XP and trust updates"
     • "Abuse may reduce future dispute eligibility"
     • "Most disputes resolve within 48 hours"
     • "Successful disputes restore XP and trust"

Everything else is identical. The screen is **read-only task context, structured input, explicit consequences, single irreversible submission**.

---

### Backend States Represented

This screen only appears when:
- `task.state = FAILED` OR `task.state = ACTION_REQUIRED → FAILED`
- `completion_gate.status = NOT_APPROVED`
- `trust_change_explanation.viewed = true`
- `dispute_entry.selected = true` (from failure-only affordance)

After submission:
- `dispute.status = SUBMITTED`
- `dispute.review_status = PENDING`
- `xp_updates.paused = true`
- `trust_updates.paused = true`

UI does **not** speculate on outcome.

---

### Adversarial Safeguards (Why This Works)

| Threat | Countermeasure |
|--------|----------------|
| Emotional revenge | Cognitive gate + consequences disclosure + invariant-mapped reasons (no emotional language) |
| Spam disputes | Limited reasons + upload cap (2 images max) + one dispute per task + eligibility impact explicitly stated |
| Support overload | Structured input (no free-form rants, no "Other" option, invariant-mapped reasons only) |
| He-said/she-said | Immutable task context (read-only) |
| Trust poisoning | Manual review + pattern analysis + eligibility impact explicitly stated |

---

### Lock Criteria (Must All Pass)

* ✅ Only accessible after failure states
* ✅ Read-only task context
* ✅ Structured input (no open rants)
* ✅ Explicit consequences shown
* ✅ Single irreversible submission
* ✅ No emotional language
* ✅ No ratings, no trust manipulation
* ✅ Hard-gated entry (all conditions must be true)
* ✅ Cognitive gate (acknowledgment required)
* ✅ Neutral color palette (no red/green dominance)

When locked, this screen **must not change** without backend changes.

---

### Design Notes

**Why this matters:**
- Captures legitimate failures without emotional retaliation
- Deters low-signal abuse through friction and consequences
- Produces audit-ready records with structured input
- Preserves system authority through immutable task context
- Makes disputes rare and high-signal

**Visual Authority:**
- Hard-gated entry (only after failure states)
- Read-only task context (anchors reality before opinion)
- Structured input (no free-form rants, prevents support overload)
- Explicit consequences (discloses penalties, kills impulsive submissions)
- Single irreversible submission (prevents spam)

**Behavioral Rules (Enforced by UI):**
- ❌ Cannot submit without acknowledging eligibility impact (certification checkbox required)
- ❌ Cannot submit without selecting invariant-mapped reason (structured input required, no "Other" option)
- ❌ Cannot upload unlimited evidence (2 images max, prevents data dumping)
- ❌ Cannot edit task context (read-only, immutable)
- ❌ Cannot skip qualification gate (acknowledgment required)
- ❌ Cannot submit multiple disputes per task (cooldown indicator: one dispute per task, cannot be undone)
- ❌ Cannot use emotional language in reasons (invariant-mapped options only, no "suspicious," "unclear," "felt wrong")

**What This Prevents:**
- Emotional revenge (cognitive gate + consequences + invariant-mapped reasons)
- Spam disputes (limited reasons + upload cap + one dispute per task + eligibility impact)
- Support overload (structured input, no "Other" option, invariant-mapped reasons only)
- He-said/she-said (immutable task context)
- Trust poisoning (manual review + pattern analysis + eligibility impact)

**Adversarial Test:**
- ✅ Bad actor cannot spam disputes (limited reasons, upload cap, consequences, one dispute per task, eligibility impact)
- ✅ Emotional poster cannot retaliate (cognitive gate, structured input, consequences, invariant-mapped reasons only, no emotional language)
- ✅ Confused user knows exactly what to do (structured reasons mapped to invariants, clear consequences, immutable context)
- ✅ Dispute reviewer can reconstruct intent (immutable task context, invariant-mapped reasons, structured input, evidence, contract ID)

---
