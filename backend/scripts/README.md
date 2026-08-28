# Backend scripts

**Repository role:** inventory backend-specific scripts and state each script's effect and safety boundary.

**Lifecycle status:** `ACTIVE_IMPLEMENTATION_REFERENCE / LOCAL_ONLY_UNLESS_AUTHORIZED`.

**Canonical authority:** [HustleXP Business and Universal V1 Charter v1.1.0](https://github.com/Sebdysart/HUSTLEXP-DOCS/blob/0b80c71e118d7cab70474bbbf6df778811fe4fe8/governance/HUSTLEXP_BUSINESS_AND_UNIVERSAL_V1_CHARTER.md); this inventory is subordinate implementation guidance.

**Supported runtime:** the exact backend Node.js 22 toolchain plus only the disposable services explicitly required by each script.

**Local start:** no blanket start command; review the exact inventory row and repository safety contract before running an individual script.

**Staging path:** none directly; a maintained script can participate only through an exact signed backend candidate and its required CI or reviewed nonproduction manifest.

**Payment posture:** financial and lifecycle mutators are disposable-local-only; production payment creation, hard assignment, payout, and settlement remain frozen.

**Deployment authority:** none; script presence or output cannot authorize a deployment or external effect.

**Known limitations:** classifications are source-dated, some scripts preserve legacy processor assumptions, and any unclassified addition is `DO_NOT_EXECUTE`.

Status: `CURRENT_IMPLEMENTATION_REFERENCE / LOCAL_ONLY_UNLESS_AUTHORIZED`

Script presence is not authority for an external or production effect. Follow [the Team Goal and Execution Contract](../../docs/HUSTLEXP_TEAM_ALIGNMENT.md) and [AGENTS.md](../../AGENTS.md).

Scripts here are backend-specific only. Use repo-root `scripts/` for shared tooling, subject to the classifications in [docs/SCRIPTS.md](../../docs/SCRIPTS.md).

## Exact inventory at this revision

| File | Classification | Boundary |
|---|---|---|
| `README.md` | `CURRENT_DOCUMENTATION` | This inventory only. |
| `alpha-telemetry-smoke.ts` | `DATABASE_MUTATOR / DISPOSABLE_LOCAL_ONLY` | Uses configured `DATABASE_URL`; may insert a fixed test user, deletes prior `alpha_telemetry` for that user, and emits new telemetry rows. Never point it at a persistent or production target. |
| `classify-pr-changes.ts` | `LOCAL_ANALYSIS` | Reads repository diff inputs; output is not Governor or review evidence. |
| `concurrency-load-test.ts` | `HIGH_VOLUME_LIFECYCLE_AND_FINANCIAL_DATABASE_MUTATOR / DISPOSABLE_LOCAL_ONLY` | Directly creates users, tasks, escrows, revenue-ledger and other fixture rows, then drives legacy task/escrow transitions including `RELEASED`. It refuses to connect unless `HX_ALLOW_DESTRUCTIVE_LOAD_TEST=true`, the URL is loopback, the role is exactly `hx_ci_runner`, the database is `hx_ci_system_test` or `hx_concurrency_test`, and database readback matches. |
| `disposable-load-test-policy.ts` | `SAFETY_POLICY` | Exact pre-connect and post-connect authority for `concurrency-load-test.ts`; it creates no connection or external effect. |
| `posttask-paymenttest.sh` | `LEGACY_NON_EXECUTABLE` | Calls the rejected quote `PaymentIntent -> confirm -> finalize -> task/escrow` path. It is historical evidence, not a valid certification flow. |
| `revenue-replay.ts` | `TARGET_BOUND_FINANCIAL_READ / EXACT_READ_AUTHORITY_REQUIRED` | Source issues `SELECT` queries against `revenue_ledger` and prints aggregate financial data. It does not write at this revision, but target identity, data-access authority, and output handling must be proven. |
| `syntheticHustler.ts` | `SCREENING_DATABASE_MUTATOR / DISPOSABLE_LOCAL_ONLY` | Grants consent and creates/completes a synthetic screening record. It is not provider or production proof. |

Anything added without an updated row is `UNCLASSIFIED / DO_NOT_EXECUTE`. See [docs/SCRIPTS.md](../../docs/SCRIPTS.md) for the repository-wide convention.
