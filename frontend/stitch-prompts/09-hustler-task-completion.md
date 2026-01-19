# Screen 9: Task Completion Confirmation (Hustler View)
## Purpose: Formally decide whether hustler earns completion, XP, and payment — or not

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Task Completion Confirmation (Hustler View)

Style: Apple Glass aesthetic, clean typography, authoritative and conclusive.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

This screen should feel like a formal system verdict, not a reward animation.

Visual Requirements:
- Full-screen confirmation view
- Clear verdict state (APPROVED / ACTION REQUIRED / BLOCKED)
- Proof review visibility
- XP and payment outcomes explicit
- No ambiguity about outcome

Content Layout (Top to Bottom):

1. VERDICT HEADER (Top, dominant)
   - Status label (one of three states, uppercase, size: 14px, tracking: 2px, weight: 700):
     - "COMPLETION APPROVED" (green #34C759, border: rgba(52, 199, 89, 0.3), background: rgba(52, 199, 89, 0.1))
     - "ACTION REQUIRED" (amber #FF9500, border: rgba(255, 149, 0, 0.3), background: rgba(255, 149, 0, 0.1))
     - "COMPLETION BLOCKED" (red #FF3B30, border: rgba(255, 59, 48, 0.3), background: rgba(255, 59, 48, 0.1))
   - Status badge: Rounded pill, padding: 8px 16px, uppercase, tracking: 2px
   - Subtitle (size: 14px, color: #8E8E93, margin-top: 8px):
     - Approved: "Task requirements met"
     - Action Required: "Proof needs correction"
     - Blocked: "Completion criteria not satisfied"
   - Task title: "Site Survey: Sector 4" (size: 24px, weight: 700, color: white, margin-top: 12px)

2. PROOF REVIEW SUMMARY (Card, glassmorphic)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "Proof Review" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Contract ID: "#820-A4" (size: 10px, color: #8E8E93, monospace, uppercase, tracking: 1px, margin-top: 4px)
   - Proof status section (margin-top: 16px):
     - If APPROVED:
       - Green checkmark icon (size: 32px, color: #34C759)
       - "All required criteria verified" (size: 16px, color: white, weight: 600, margin-top: 8px)
     - If NEEDS_CORRECTION:
       - Amber warning icon (size: 32px, color: #FF9500)
       - "Proof needs correction" (size: 16px, color: white, weight: 600, margin-top: 8px)
       - Bullet list of rejection reasons (size: 14px, color: #E5E5EA, margin-top: 12px, line-height: 1.6):
         • "Entry point not visible"
         • "Image too dark"
         • "Work area unclear"
     - If BLOCKED:
       - Red cross icon (size: 32px, color: #FF3B30)
       - "Completion criteria not satisfied" (size: 16px, color: white, weight: 600, margin-top: 8px)
       - Bullet list of blocking reasons (size: 14px, color: #E5E5EA, margin-top: 12px, line-height: 1.6):
         • "Required proof missing"
         • "Task not completed as described"

3. XP OUTCOME (Card, authoritative)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "XP Outcome" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - If awarded:
     - "+342 XP" (size: 36px, weight: 800, color: #34C759, margin-top: 12px)
     - Breakdown summary (size: 14px, color: #8E8E93, margin-top: 8px):
       "Instant • Speed • Streak bonuses applied"
     - Subtext (size: 12px, color: #8E8E93, margin-top: 12px, italic):
       "XP is awarded only when quality gates are met"
   - If withheld:
     - "XP Withheld" (size: 24px, weight: 700, color: #8E8E93, margin-top: 12px)
     - Reason text (size: 14px, color: #8E8E93, margin-top: 8px, line-height: 1.5):
       "Proof requirements not met. Resubmit corrected proof to earn XP."
     - Subtext (size: 12px, color: #8E8E93, margin-top: 12px, italic):
       "XP is awarded only when quality gates are met"

4. PAYMENT STATUS (Card)
   - Glass card (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.08))
   - Padding: 20px
   - Title: "Payment" (size: 12px, uppercase, tracking: 1.5px, color: #8E8E93, weight: 700)
   - Status (size: 16px, color: white, weight: 600, margin-top: 12px):
     - If APPROVED: "Escrow release pending"
     - If NEEDS_CORRECTION: "Payment blocked pending resolution"
     - If BLOCKED: "Payment blocked pending resolution"
   - Amount: "$45.00" (size: 28px, weight: 700, color: white, margin-top: 8px)
   - Badge: "Escrow protected" (size: 11px, color: #8E8E93, background: rgba(255, 255, 255, 0.05), padding: 4px 8px, rounded: 4px, margin-top: 8px, inline-block)

5. NEXT ACTION (Primary CTA, full-width)
   - If APPROVED:
     - Button: "Finish Task" (background: #34C759, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
     - Subtext line 1: "This will finalize the task and release escrow." (size: 12px, color: #8E8E93, margin-top: 8px, text-center) — CRITICAL: Removes fear, prevents double-taps/hesitation
     - Subtext line 2: "Escrow will be released after poster confirmation" (size: 11px, color: #8E8E93, opacity: 0.7, margin-top: 4px, text-center)
   - If NEEDS_CORRECTION:
     - Button: "Fix Proof Issues" (background: #FF9500, color: white, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
     - Subtext line 1: "Resubmit proof to complete task" (size: 12px, color: #8E8E93, margin-top: 8px, text-center)
     - Subtext line 2: "You may resubmit proof **once** for this requirement." (size: 11px, color: #8E8E93, opacity: 0.8, margin-top: 4px, text-center, italic) — CRITICAL: Prevents spam uploads, brute-force guessing, support escalation loops
   - If BLOCKED:
     - Button: "View Issue Details" (background: transparent, border: 2px solid #FF3B30, color: #FF3B30, height: 52px, rounded: 12px, weight: 700, size: 16px, full-width)
     - Subtext: "Contact support if you believe this is incorrect" (size: 12px, color: #8E8E93, margin-top: 8px, text-center)

6. SUPPORT FOOTER (Bottom, subdued, visually de-emphasized)
   - CRITICAL: Support must feel like a last resort, not an option
   - Visual hierarchy: Correction > Appeal
   - Text button: "Contact Support" (size: 12px, color: #8E8E93, opacity: 0.6, weight: 400, margin-top: 16px, text-center, underline decoration, underline-offset: 4px)
   - Subtext: "Use only if you believe this decision is incorrect" (size: 10px, color: #8E8E93, opacity: 0.5, margin-top: 4px, text-center)
   - Placement: Below primary CTA, visually separated, tertiary styling

Spacing:
- Card spacing: 16px vertical
- Card padding: 20px
- Section spacing: 24px
- Header margin-bottom: 24px

Typography:
- Font family: SF Pro Display
- Headers: weight 700-800
- Labels: weight 600-700
- Body: weight 400-500

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur
- Approved: #34C759 (green)
- Action Required: #FF9500 (amber)
- Blocked: #FF3B30 (red)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone:
Final. Fair. Unemotional.
The system has decided.

Constraints:
- Static UI only. No animations.
- No celebration animations.
- No XP confetti.
- No poster visibility.
- No ambiguity about outcome.
- No "retry spam" path.
- No negotiation language.
- No ambiguous success signals.
- No celebratory dopamine masking rejection.
```

### Design Notes

**Why this matters:**
- Formally decides whether hustler earns completion, XP, and payment
- Final authority checkpoint before escrow release, XP ledger writes, trust tier progression
- Nothing past this screen can be reversed casually
- Trains behavior: every denial makes the system stronger

**Visual Authority:**
- Verdict state is unambiguous (three clear states: APPROVED / ACTION REQUIRED / BLOCKED)
- Proof acceptance criteria are visible
- Rejection reasons are explicit (bullet list, no ambiguity)
- XP outcome is final and clear (awarded or withheld with reason)
- Payment status is explicit (escrow release pending or blocked)

**Trust Signals:**
- Contract ID visible (auditability)
- Outcome reconstructible from UI alone
- Dispute reviewer could screenshot this and decide
- "XP is awarded only when quality gates are met" reinforces discipline
- Escrow protection badge visible

**Behavioral Rules (Enforced by UI):**
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
- `xp_amount_awarded` (if eligible)
- `xp_withheld_reason` (if not eligible)
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
- ✅ Confused user knows exactly what to do (clear CTA per state)
- ✅ Dispute reviewer can reconstruct intent (contract ID, proof status, rejection reasons, XP outcome, payment status all visible)

---
