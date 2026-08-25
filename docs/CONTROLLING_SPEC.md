# Controlling specification pointer

Status: `CURRENT_TEAM_TARGET_POINTER / NOT_PRODUCTION_AUTHORITY`

Production launch: `NO-GO`

[HUSTLEXP_TEAM_ALIGNMENT.md](HUSTLEXP_TEAM_ALIGNMENT.md) is the stable target contract. [HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md) carries mutable current-state claims, and [the payment and `/OPS` convergence record](architecture/HUSTLEXP_PAYMENT_OPS_CONVERGENCE_RECORD.md) carries detailed target design plus a source-dated historical inventory. The default-branch target becomes team-operative only at an exact commit accepted by an independent Reviewer. None of these documents overrides the Governor, accepted evidence, approved policy, written processor decisions, or production authority.

## Truth-plane rules

- Executed agreements, approved policy, canonical Governor authority, and repository controls govern permission claims.
- The source-locked underwriting package, [frozen mission and `/OPS` source contracts](source-contracts/README.md), and team goal govern target claims.
- Exact-revision code, migrations, manifests, tests, CI, and static call graphs govern implementation claims.
- Trusted deployment identity, migration ledgers, provider receipts, reconciliations, and canonical outcomes govern runtime/provider claims.

Never use one plane to overwrite another. Resolve conflict inside a plane using the freshest exact primary source; retain cross-plane contradictions as blockers.

## Non-negotiable engine contract

1. Railway PostgreSQL is the target canonical transaction authority; Supabase is overlay-only.
2. One task occurrence has one root across `MARKETPLACE`, `PROVIDER_OS`, and `BRING_YOUR_OWN_PROVIDER` origins.
3. Task Draft precedes opportunity, provider hold, Financial Security Event, Work Order, hard assignment, and exact-address release.
4. Processor eligibility and HustleXP task eligibility are separate gates.
5. Financial Security Event, capture, settlement, platform funding, provider payout, and reconciliation are orthogonal facts.
6. Browsers submit typed commands through named sessions; they never hold a shared admin key or write canonical state directly.
7. Every external money or obligation operation is durably claimed with deterministic idempotency before provider I/O and reconciled after it.
8. Target policy requires every unresolved processor capability to fail closed. Current implementation must prove this per capability; a historical Stripe receipt or kill-switch probe cannot authorize enablement.
9. AI may recommend or summarize; deterministic policy plus authorized humans control money, assignment, identity, address, safety, and closure.
10. Production customer-money creation remains unauthorized until every external and independent release gate passes; structural impossibility is required candidate evidence, not a prose assumption about current `main`.

## Current execution lock

The active node is `TASK_FIRST_FAKE_FSE_POSTGRES_AUTHORITY_REBUILD`. Both exact-name migration paths are locked until all relevant persistent PostgreSQL targets and ledgers are closed with admissible evidence. `20260824_task_first_fake_fse_vertical` has only a prospective unauthorized append ordinal of 112; `20260825_task_first_fake_fse_postgres_authority_repair` has no assigned ordinal pending reconstruction. Numeric aliases are prohibited. Documentation does not select a migration, permit backend implementation, approve a merge, or authorize a deployment.
