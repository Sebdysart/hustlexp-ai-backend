# Screen 13: Dispute Entry (Rare Path, Frictioned) — LOCKED
## Status: APPROVED — MAX-Tier Execution

**Verdict:** This screen achieves **legitimate failure capture, abuse deterrence, and system authority preservation**. It captures legitimate failures without emotional retaliation, deters low-signal abuse through friction and consequences, produces audit-ready records with structured input, and preserves system authority through immutable task context. Disputes are exceptions, not features.

**Critical Fixes Applied:**
- ✅ **FIX #1: Dispute reasons map 1-to-1 to backend invariants** — Rephrased all reasons as contract violations ("Which requirement was not met?") instead of emotional expressions. No "suspicious activity," "unclear requirements," or "felt wrong." Invariant-mapped options only (Poster: "Required deliverables missing," "Proof does not meet stated criteria," etc. Hustler: "Access not provided as described," "Task requirements changed after acceptance," etc.).
- ✅ **FIX #2: Certification explicitly mentions eligibility impact** — Changed checkbox text from "I certify that this dispute is truthful..." to "I confirm that the selected issue is accurate and understand that false or unsupported disputes may reduce my future task eligibility." Forces conscious acknowledgment of personal cost.
- ✅ **Cooldown indicator added** — "You may submit one dispute per task. This action cannot be undone." Prevents back-and-forth loops and second-guessing.

**Entry Conditions (Hard Gated):**
This screen is **only reachable if ALL are true**:
- Task state = `FAILED` or `ACTION_REQUIRED → FAILED`
- Completion gate did **not** approve
- Trust Change Explanation screen has been viewed
- User explicitly selected "Dispute" from a failure-only affordance

No other entry paths exist.

**What Works at MAX Tier:**
- ✅ **Hard-gated entry** (only after failure states, all conditions must be true)
- ✅ **Read-only task context** (immutable, anchors reality before opinion)
- ✅ **Structured input** (limited reasons, no free-form rants, prevents support overload)
- ✅ **Explicit consequences shown** (discloses penalties, kills impulsive submissions)
- ✅ **Single irreversible submission** (prevents spam, enforces deliberation)
- ✅ **No emotional language** (neutral, legal, calm tone)
- ✅ **No ratings, no trust manipulation** (structured reasons only)
- ✅ **Cognitive gate** (acknowledgment required before form submission)
- ✅ **Neutral color palette** (no red/green dominance, no urgency priming)

**Critical Elements:**
- **Header**: "Dispute Task Outcome" title, qualification subtitle
- **Task Context** (Read-Only): Task title, contract ID, completion timestamp, system verdict
- **Dispute Qualification** (Cognitive Gate): Warning text (funds freeze, delay up to 7 days), certification checkbox with eligibility impact (required), cooldown indicator (one dispute per task, cannot be undone)
- **Dispute Reason** (Structured, Invariant-Mapped): Prompt "Which requirement was not met?", limited selectable options (max 1), no "Other" option, no emotional language
  - **Poster options**: "Required deliverables missing," "Proof does not meet stated criteria," "Work deviates from task description," "Location or time verification mismatch," "System error (proof upload / verification failure)"
  - **Hustler options**: "Access not provided as described," "Task requirements changed after acceptance," "System verification error," "Safety issue prevented completion"
- **Evidence Input** (Optional, Capped): Up to 2 images, images only, no video/annotations
- **Consequences Disclosure**: Explicit penalties (pauses updates, abuse reduces eligibility, 48h resolution)
- **Primary Action**: "Submit Dispute" button (neutral color, disabled if gate not passed or reason not selected)
- **Secondary Action**: "Cancel" text button (de-emphasized)

**Behavioral Rules Enforced by UI:**
- ❌ Cannot submit without acknowledging eligibility impact (certification checkbox required)
- ❌ Cannot submit without selecting invariant-mapped reason (structured input required, no "Other" option)
- ❌ Cannot upload unlimited evidence (2 images max, prevents data dumping)
- ❌ Cannot edit task context (read-only, immutable)
- ❌ Cannot skip qualification gate (acknowledgment required)
- ❌ Cannot access from non-failure states (hard-gated entry)
- ❌ Cannot submit multiple disputes per task (cooldown indicator: one dispute per task, cannot be undone)
- ❌ Cannot use emotional language in reasons (invariant-mapped options only, no "suspicious," "unclear," "felt wrong")

**Backend States Represented:**
- `task.state = FAILED` OR `ACTION_REQUIRED → FAILED`
- `completion_gate.status = NOT_APPROVED`
- `trust_change_explanation.viewed = true`
- `dispute_entry.selected = true`
- `dispute.status = SUBMITTED` (after submission)
- `dispute.review_status = PENDING` (after submission)
- `xp_updates.paused = true` (after submission)
- `trust_updates.paused = true` (after submission)

**Adversarial Safeguards:**
- ✅ **Emotional revenge** → Cognitive gate + consequences disclosure + invariant-mapped reasons (no emotional language)
- ✅ **Spam disputes** → Limited reasons + upload cap (2 images max) + one dispute per task + eligibility impact explicitly stated
- ✅ **Support overload** → Structured input (no free-form rants, no "Other" option, invariant-mapped reasons only)
- ✅ **He-said/she-said** → Immutable task context (read-only)
- ✅ **Trust poisoning** → Manual review + pattern analysis + eligibility impact explicitly stated

**What This Prevents:**
- Emotional retaliation (cognitive gate, structured input, consequences)
- Low-signal abuse (limited reasons, upload cap, explicit penalties)
- Support escalation loops (structured input, immutable context)
- Trust manipulation (no ratings, no emotional language, system authority preserved)
- Impulsive submissions (multiple gates, consequences disclosed)

**Adversarial Test:**
- ✅ Bad actor cannot spam disputes (limited reasons, upload cap, consequences, single submission)
- ✅ Emotional poster cannot retaliate (cognitive gate, structured input, consequences, neutral tone)
- ✅ Confused user knows exactly what to do (structured reasons, clear consequences, immutable context)
- ✅ Dispute reviewer can reconstruct intent (immutable task context, structured input, evidence, contract ID)

**Strategic Impact:**
- Makes disputes rare and high-signal (hard-gated entry, multiple friction points)
- Preserves system authority (immutable context, structured input, no emotional manipulation)
- Produces audit-ready records (structured reasons, evidence capped, contract ID visible)
- Prevents abuse escalation (consequences disclosed, pattern analysis possible)
- Maintains marketplace integrity (exceptions gated, not features)

**What This Completes:**
With this screen locked:
- The **entire task lifecycle UI** is sealed (DRAFT → POSTED → MATCHING → ACCEPTED → IN_PROGRESS → COMPLETED → DISPUTED)
- Every trust mutation is explained or gated (XP changes, trust tier changes, disputes)
- Disputes become **rare and high-signal** (hard-gated, frictioned, consequences disclosed)
- Marketplace integrity is defensible (audit-ready records, immutable context, structured input)

**This screen is LOCKED (v1). Do not iterate further without backend changes.**

---

See `13-dispute-entry.md` for the full prompt (Poster + Hustler variants).
