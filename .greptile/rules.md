# HustleXP blocking review rules

Production launch: `NO-GO`

Review the exact candidate against [AGENTS.md](../AGENTS.md), [the team goal](../docs/HUSTLEXP_TEAM_ALIGNMENT.md), and the source-dated [current checkpoint](../docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md). Flag every P0/P1 issue; never infer authority from code presence, configuration, or green checks.

## Authority and repository controls

- Block changes outside the active Governor path manifest or a tree with stale, contradictory, or missing control evidence.
- Block weakened assertions, skipped required checks, unpinned Actions, bypass actors, direct `main` publication, unsigned release commits, self-approval, or approval that does not cover the final push.
- Block any merge while Railway auto-deploy can bypass the accepted release transaction.

## Payments and financial truth

- Block every positive production processor-creation path. The guard must execute before provider calls and before task, escrow, payment, account, onboarding, payout, or related writes.
- Block processor-first task creation, processor-shaped canonical state, environment-only kill switches, or configuration that can re-enable production money.
- Preserve and test refund, void, dispute, restriction, cancellation, recovery, webhook replay, and reconciliation behavior.
- Require integer-cent economics, exact gross decomposition, immutable ledger/audit evidence, deterministic idempotency, transaction boundaries, optimistic versions, and PostgreSQL backstops.
- A refund create requires one escrow-scoped immutable claim, a database-clock safe replay deadline, exact provider discovery outside that window, a succeeded witness, and claim-bound canonical resolution. Block blind replay or a second claim after version drift.

## Queue and webhook truth

- Database outbox authority is the durable `_outbox_key`; BullMQ `job.id` must equal the SHA-derived `outboxTransportJobId(_outbox_key)` and must never replace the durable key.
- Require exact HMAC/signature validation for financial outbox payloads before using their durable identity.
- Block ACK before terminal business/inbox evidence, ACK of an active or rotated lease, best-effort ACK that converts failure to success, or retry paths that can duplicate an external money effect.
- Require correct platform-versus-Connect webhook secrets, normalization, idempotency, stale-claim recovery, and out-of-order/duplicate coverage.

## Lifecycle and Operations

- Railway PostgreSQL is canonical; Supabase is overlay-only. Flag duplicate canonical writers or processor-direct bypasses.
- Consequential Operations writes require named authenticated `opsProcedure`/`opsSensitiveProcedure`, typed commands, expected versions, reason codes, immutable actor audit, and step-up/two-person gates where specified.
- Block `publicProcedure`, browser/shared admin keys, caller-supplied actor identity, direct status SQL, arbitrary status strings, and browsers mutating canonical financial/transaction rows.
- Require explicit orthogonal task, provider-eligibility, security, completion, settlement, dispute, replacement, and recurring states. Do not approve collapsed legacy state diagrams as the target architecture.

## Required proof

The exact final candidate must pass typecheck, zero-warning lint, full tests, compile/container build, production dependency audit, fresh/upgrade/replay/recovery PostgreSQL migrations, containment contracts, `git diff --check`, independent review, and fresh Governor admission. Skipped database tests are not database evidence, and builder output is not independent proof.
