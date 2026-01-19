# Screen 9: Task Completion Confirmation (Hustler View) — LOCKED
## Status: APPROVED — MAX-Tier Execution (After Critical Fixes)

**Verdict:** This screen achieves **formal system verdict, not reward animation**. It formally decides whether the hustler earns completion, XP, and payment — or not. This is the final authority checkpoint before escrow release, XP ledger writes, trust tier progression, and dispute eligibility. **Nothing past this screen can be reversed casually.**

**Critical Fixes Applied:**
- ✅ **One-time correction limit** explicitly stated: "You may resubmit proof **once** for this requirement." (prevents spam uploads, brute-force guessing, support escalation loops)
- ✅ **Post-Finish Task clarification**: "This will finalize the task and release escrow." (removes fear, prevents double-taps/hesitation)
- ✅ **Visual hierarchy: Correction > Appeal** (support is tertiary, de-emphasized, feels like last resort)

**What Works at MAX Tier:**
- ✅ **Verdict state is unambiguous** (three clear states: APPROVED / ACTION REQUIRED / BLOCKED with distinct colors and messaging)
- ✅ **Proof acceptance criteria are visible** (contract ID, proof status, rejection reasons explicit)
- ✅ **XP outcome is final and clear** (awarded with breakdown or withheld with reason)
- ✅ **Payment status is explicit** (escrow release pending or blocked)
- ✅ **No ambiguity about outcome** (static UI, no animations, no confetti)
- ✅ **Abuse resistance** (no retry spam, one-time correction limit, no negotiation language, no ambiguous signals, visual hierarchy enforces correction over appeal)

**Critical Elements:**
- **Verdict Header**: Status badge (APPROVED / ACTION REQUIRED / BLOCKED), subtitle, task title
- **Proof Review Summary**: Contract ID, proof status icon, rejection reasons (if any)
- **XP Outcome**: Awarded amount with breakdown or withheld with reason
- **Payment Status**: Escrow release status, amount, protection badge
- **Next Action**: State-specific CTA (Finish Task / Fix Proof Issues / View Issue Details)
- **Support Footer**: Subdued "Contact Support" with clear usage guidance (tertiary, de-emphasized)

**Behavioral Rules Enforced by UI:**
- ❌ Cannot "force complete" (verdict is final, no retry button on blocked)
- ❌ Cannot edit proof here (must use "Fix Proof Issues" button)
- ❌ Cannot message instead of resolving (no chat affordances)
- ❌ Cannot see poster controls (hustler view only)
- ❌ Cannot spam resubmissions (one-time correction limit explicitly stated)
- ❌ Cannot bypass correction to appeal (support is visually de-emphasized, feels like last resort)

**Backend States Represented:**
- `task.state === 'COMPLETION_REVIEW'`
- `proof_status: APPROVED | REJECTED | NEEDS_CORRECTION`
- `proof_rejection_reasons[]` (explicit bullet list)
- `xp_eligible: true | false`
- `xp_amount_awarded` / `xp_withheld_reason`
- `escrow_release_status: PENDING | BLOCKED | APPROVED`
- `risk_level`, `trust_tier`, `instant_mode`, `surge_level`

**Abuse Resistance:**
- ✅ No "retry spam" path (blocked state has "View Issue Details", not "Try Again")
- ✅ **One-time correction limit** explicitly stated (prevents spam uploads, brute-force guessing, support escalation loops)
- ✅ No negotiation language (verdict is final)
- ✅ No ambiguous success signals (clear APPROVED state)
- ✅ No celebratory dopamine masking rejection (no confetti, no animations)
- ✅ **Visual hierarchy: Correction > Appeal** (support is tertiary, de-emphasized, feels like last resort)

**Adversarial Test:**
- ✅ Bad actor cannot "force complete" (verdict is final, UI blocks)
- ✅ Bad actor cannot spam resubmissions (one-time limit stated, backend enforced)
- ✅ Confused user knows exactly what to do (clear CTA per state, post-Finish Task clarification)
- ✅ Dispute reviewer can reconstruct intent (contract ID, proof status, rejection reasons, XP outcome, payment status all visible)

**Strategic Impact:**
- XP stops feeling random (clear criteria, explicit outcomes)
- Hustlers learn standards (rejection reasons are explicit, one-time limit prevents gaming)
- Bad actors churn out (no retry spam, no negotiation, visual hierarchy prevents appeal-first behavior)
- Good actors level up faster (fair denials make system stronger)

**This screen is LOCKED (v1). Do not iterate further.**

---

See `09-hustler-task-completion.md` for the full prompt with critical fixes applied.
