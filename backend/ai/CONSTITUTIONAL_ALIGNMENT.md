# AI Orchestrator - Constitutional Alignment

## Overview

The AI orchestrator (`backend/ai/orchestrator.ts`) is now aligned with the constitutional specifications from HUSTLEXP-DOCS.

## Authority Model Implementation

The orchestrator enforces the AI authority levels defined in `AI_INFRASTRUCTURE.md`:

- **A0 (Forbidden)**: AI may not participate. Any AI output is ignored.
  - XP awarding (INV-1, INV-5)
  - Trust tier mutations
  - Escrow release/capture (INV-2, INV-4)
  - Bans/suspensions
  - Dispute resolution

- **A1 (Read-Only)**: AI can summarize, extract, classify for display only.
  - User profile summaries
  - Wallet summaries
  - Leaderboard views
  - Support drafting

- **A2 (Proposal-Only)**: AI outputs proposals validated by deterministic rules.
  - Onboarding role inference
  - Task classification
  - Task pricing suggestions
  - Matching/ranking
  - Fraud risk scoring
  - Proof analysis

- **A3 (Restricted Execution)**: Limited reversible actions with strict gating.
  - Proof requests (INV-3)

## Files

### `backend/ai/authority.ts`
- Defines authority levels (A0-A3)
- Maps subsystems to authority levels
- Provides validation functions
- References HUSTLEXP-DOCS path

### `backend/ai/orchestrator.ts`
- Enforces authority checks before executing actions
- Maps actions to subsystems
- Blocks A0 violations
- Logs authority level for each action

## Constitutional References

All specifications are sourced from:
- `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/AI_INFRASTRUCTURE.md`
- `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/ARCHITECTURE.md`
- `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/PRODUCT_SPEC.md`
- `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/schema.sql`

## Enforcement

The orchestrator now:
1. ✅ Validates authority before executing any action
2. ✅ Blocks A0 violations (XP, trust, payments, bans)
3. ✅ Logs authority level for audit trail
4. ✅ References HUSTLEXP-DOCS path for constitutional alignment
5. ✅ Maps actions to subsystems from AI_INFRASTRUCTURE.md §3.2

## Next Steps

To fully align with the constitutional plan:
1. Implement canonical AI execution flow (event capture → job → proposal → validation → decision → write)
2. Add AI event logging to `ai_events` table
3. Add AI job tracking to `ai_jobs` table
4. Add AI proposal storage to `ai_proposals` table
5. Add AI decision tracking to `ai_decisions` table

See: `constitutional_alignment_full_rebuild_914bd8d5.plan.md` Phase 3 (AI Infrastructure)
