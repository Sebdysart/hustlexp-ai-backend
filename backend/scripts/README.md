# Backend scripts

Status: `CURRENT_IMPLEMENTATION_REFERENCE / LOCAL_ONLY_UNLESS_AUTHORIZED`

Script presence is not authority for an external or production effect. Follow [the Team Goal and Execution Contract](../../docs/HUSTLEXP_TEAM_ALIGNMENT.md) and [AGENTS.md](../../AGENTS.md).

Scripts here are backend-specific only. Use repo-root `scripts/` for shared tooling, subject to the classifications in [docs/SCRIPTS.md](../../docs/SCRIPTS.md).

## Exact inventory at this revision

| File | Classification | Boundary |
|---|---|---|
| `README.md` | `CURRENT_DOCUMENTATION` | This inventory only. |
| `alpha-telemetry-smoke.ts` | `DATABASE_MUTATOR / DISPOSABLE_LOCAL_ONLY` | Uses configured `DATABASE_URL`; may insert a fixed test user, deletes prior `alpha_telemetry` for that user, and emits new telemetry rows. Never point it at a persistent or production target. |
| `classify-pr-changes.ts` | `LOCAL_ANALYSIS` | Reads repository diff inputs; output is not Governor or review evidence. |
| `concurrency-load-test.ts` | `HIGH_VOLUME_LIFECYCLE_AND_FINANCIAL_DATABASE_MUTATOR / DISPOSABLE_LOCAL_ONLY` | Directly creates users, tasks, escrows, revenue-ledger and other fixture rows, then drives legacy task/escrow transitions including `RELEASED`. Never point it at a persistent or production target. |
| `posttask-paymenttest.sh` | `LEGACY_NON_EXECUTABLE` | Calls the rejected quote `PaymentIntent -> confirm -> finalize -> task/escrow` path. It is historical evidence, not a valid certification flow. |
| `revenue-replay.ts` | `TARGET_BOUND_FINANCIAL_READ / EXACT_READ_AUTHORITY_REQUIRED` | Source issues `SELECT` queries against `revenue_ledger` and prints aggregate financial data. It does not write at this revision, but target identity, data-access authority, and output handling must be proven. |
| `syntheticHustler.ts` | `SCREENING_DATABASE_MUTATOR / DISPOSABLE_LOCAL_ONLY` | Grants consent and creates/completes a synthetic screening record. It is not provider or production proof. |

Anything added without an updated row is `UNCLASSIFIED / DO_NOT_EXECUTE`. See [docs/SCRIPTS.md](../../docs/SCRIPTS.md) for the repository-wide convention.
