# Screen 10: Poster Task Completion Confirmation (Poster View) — LOCKED
## Status: APPROVED — MAX-Tier Execution

**Verdict:** This screen achieves **relief, trust visibility, and dispute prevention**. It delivers relief ("It worked"), makes trust visible and earned, and prevents disputes before they form. This is the trust payoff moment where anxiety converts to confidence, trust converts to retention, and a one-off task becomes habit.

**Critical Fixes Applied:**
- ✅ **FIX #1: Authority is about task execution, not the person** — Changed "Protocol Checks Passed" to "Task Completion Verified" with task-specific bullets (work completed, proof verified, location & time confirmed)
- ✅ **FIX #2: Avatar is abstract, not photographic** — Replaced photo with abstract geometric avatar (initials on gradient background)
- ✅ **FIX #3: Proof existence is visible** — Added collapsible "Proof Verified" card showing timestamped photos, contract ID, verification method

**What Works at MAX Tier:**
- ✅ **Completion is unambiguous** (clear status badge, verified subtitle, no ambiguity)
- ✅ **Verification is visible** (checkmark, explicit bullet points, protocol mention)
- ✅ **Trust tier is visible** (hustler summary with tier badge, stats, "Verified and in good standing")
- ✅ **Payment is confirmed** (amount, "Paid" badge, escrow release confirmation)
- ✅ **No manual proof judgment** (verification is automatic, system-decided)
- ✅ **No ambiguous language** (clear, factual statements)
- ✅ **Dispute path is de-emphasized** (support footer is tertiary, visually separated, feels exceptional)
- ✅ **System authority is clear** ("Verified automatically by HustleXP protocol")
- ✅ **Proof visibility kills doubt** (collapsible proof viewer prevents "did they really do it?" questions)

**Critical Elements:**
- **Completion Header**: Status badge (TASK COMPLETED), title, verified subtitle
- **Hustler Summary**: Abstract avatar (geometric, NOT photo), name, trust tier badge, stats, verification status
- **Verification Summary**: "Task Completion Verified" (NOT "Protocol Checks Passed"), checkmark, task-specific bullet points, protocol verification
- **Payment Confirmation**: Amount, "Paid" badge, escrow release confirmation
- **Proof Summary**: Collapsible card showing "Proof Verified (3 items)" with expandable viewer (timestamped photos, contract ID, verification method)
- **Task Details**: Task title, completion timestamp, contract ID
- **Next Action**: "Leave Feedback" button (optional, helps maintain trust)
- **Support Footer**: Subdued "Report an issue" (tertiary, de-emphasized, visually separated)

**Behavioral Rules Enforced by UI:**
- ❌ Cannot edit outcome (verdict is final, no edit affordances)
- ❌ Cannot re-judge proof (verification is automatic, no manual review UI)
- ❌ Cannot reopen task casually (no reopen button, dispute is exceptional)
- ❌ Cannot escalate without cause (support is de-emphasized, feels like last resort)

**Backend States Represented:**
- `task.state === 'COMPLETED'`
- `completion_status: APPROVED`
- `completed_at` (timestamp visible)
- `proof_verified: true`
- `verification_method: AUTO | MANUAL` (stated as "automatically")
- `escrow_release_status: RELEASED`
- `amount_paid` (visible)
- `trust_tier` (visible badge)
- `tasks_completed` (visible in stats)
- `rating` (visible in stats)
- `contract_id` (visible)
- `proof_available: true` (implied by verification)
- `location_verified: true` (stated in bullet points)

**Dispute Prevention:**
- ✅ No manual proof judgment (verification is automatic, system-decided)
- ✅ No ambiguous language (clear, factual statements)
- ✅ Dispute path is de-emphasized (support footer is tertiary, visually separated)
- ✅ System authority is clear (protocol verification, not human mood)
- ✅ Relief-focused, not celebration-focused (calm, professional tone)

**Adversarial Test:**
- ✅ Poster cannot doubt outcome (verification is explicit, system-decided)
- ✅ Poster cannot escalate casually (support is de-emphasized, feels exceptional)
- ✅ Poster knows exactly what happened (all details visible, contract ID for audit)
- ✅ Support can reconstruct from screenshot (contract ID, verification method, completion timestamp, payment status all visible)

**Strategic Impact:**
- Trust converts to retention (relief → confidence → repeat usage)
- Anxiety converts to confidence (system handled it correctly)
- One-off task becomes habit (positive experience → return)
- Disputes feel exceptional (not routine, system is authoritative)

**This screen is LOCKED (v1). Do not iterate further.**

---

See `10-poster-task-completion.md` for the full prompt.
