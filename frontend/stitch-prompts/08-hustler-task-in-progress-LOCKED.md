# Screen 8: Hustler Task In-Progress (Hustler View) — LOCKED
## Status: APPROVED — MAX-Tier Execution

**Verdict:** This screen achieves **containment, not productivity**. It prevents disputes before they happen, keeps the hustler focused and compliant, makes system authority visible, and creates an auditable execution trail. **Mission dashboard aesthetic, not social app.**

**What Works at MAX Tier:**
- ✅ **Proof requirements are unavoidable** (highlighted card, border accent, gradient glow)
- ✅ **Time authority is visible** (progress bar, countdown timer, late warning)
- ✅ **Sequential checklist enforces compliance** (completed steps line-through, active step emphasized, pending steps muted)
- ✅ **No chat affordances** (no negotiation, system is in control)
- ✅ **Auditable trail** (GPS verification, contract ID, time-stamped proof, "What must be visible" checklist)
- ✅ **Mission dashboard aesthetic** (procedural, calm, authoritative)

**Critical Elements:**
- **Status Header**: WORKING state badge, task title, Instant/Escrow badges
- **Time Authority Bar**: Countdown timer, progress bar, late warning
- **Task Checklist**: Sequential steps with visual line, GPS verification on arrival, active step with pulsing indicator
- **Proof Upload Module**: Highlighted card with contract ID, proof requirement badges, "What must be visible" checklist, rules, warning box, primary action button
- **Task Details**: Grid of 3 cards (Location, Risk, Tier) — clean, scannable
- **Support & Safety**: Subdued "Report an issue" at bottom

**Behavioral Rules Enforced by UI:**
- ❌ Cannot mark complete without required proof (UI blocks, warning shown)
- ❌ Cannot skip steps (checklist is sequential, active step is only actionable)
- ❌ Cannot "message instead of complying" (no chat UI, proof is focal point)
- ❌ Cannot ignore time pressure (progress bar + countdown + warning)

**Backend States Represented:**
- `EN_ROUTE` / `WORKING` states (status badge)
- `proof_missing` / `proof_rejected` signals (highlighted proof card, warning box)
- `late_warning` / `time_remaining` authority (countdown, progress bar, warning text)
- `risk_level` / `trust_tier_required` visibility (task details cards)
- `instant_mode` / `sensitive` flags (header badges)
- GPS verification (arrival step)

**Adversarial Test:**
- ✅ Bad actor cannot "fake" completion (proof required, GPS verified, time-stamped, "What must be visible" checklist)
- ✅ Confused user knows exactly what to do (clear checklist, one primary action, rules explained)
- ✅ Dispute reviewer can reconstruct intent (auditable trail: contract ID, GPS timestamps, proof requirements, completion checklist)

**This screen is LOCKED (v1). Do not iterate further.**

---

See `08-hustler-task-in-progress.md` for the full prompt and `08-hustler-task-in-progress.html` for the MAX-tier implementation.
