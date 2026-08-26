# HustleXP canonical backend

Status: `CURRENT_IMPLEMENTATION_REFERENCE / CONVERGENCE_IN_PROGRESS`

Production launch: `NO-GO`

Production effects authorized by this repository documentation: `NONE`

[HustleXP Business and Universal V1 Charter](https://github.com/Sebdysart/HUSTLEXP-DOCS/blob/main/governance/HUSTLEXP_BUSINESS_AND_UNIVERSAL_V1_CHARTER.md) is the controlling cross-repository authority for business identity, Universal V1 scope, marketplace lanes, provider routing, lifecycle, economics, launch gates, and versioned policy ownership. Its operating doctrine is **Wide intake. Credentialed routing. Narrow financial commitment.** This backend README is a narrower implementation reference: where documents conflict, the Charter controls business intent, while the most restrictive current production-safety hold continues to control execution. Nothing in the Charter enables payment creation or changes the `NO-GO` state recorded here.

[The Team Goal and Execution Contract](docs/HUSTLEXP_TEAM_ALIGNMENT.md) is the stable engineering target. [The Current Backend Checkpoint](docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md) contains source-dated implementation and external-state facts. The default-branch copy of the target becomes team-operative only at an exact commit accepted by an independent Reviewer; working-copy edits never change adopted policy. [AGENTS.md](AGENTS.md) controls repository workflow; canonical Governor state and accepted evidence control program authority.

Documentation publication and backend implementation use separate candidates. Do not place runtime changes in a documentation branch. The reserved implementation branch is `codex/task-first-fake-fse-postgres-authority-rebuild`; do not create or populate it until persistent targets are closed and a fresh revision lock authorizes its exact base, tree, paths, and migration identity.

This repository is the target owner of HustleXP's canonical marketplace lifecycle. Existing code includes legacy task, escrow, Stripe, admin, and Supabase-bridge behavior that is being contained and converged; repository presence is not proof that a path is authorized, deployed, or safe.

## Current decision

- one transaction root per task occurrence;
- Railway PostgreSQL owns canonical transaction, fulfillment, financial, audit, and reconciliation facts;
- Supabase is an acquisition/read-model overlay, not a second lifecycle;
- a durable Task Draft precedes opportunity and financial security; Work Order materialization, assignment, and exact-address release follow a successful reconciled FSE;
- processor eligibility and HustleXP task eligibility are separate;
- Financial Security Event, capture, settlement, platform funding, provider payout, and reconciliation are separate rails;
- browsers cannot hold shared administrative authority or mutate canonical records directly;
- target policy requires all 20 unresolved processor-dependent capabilities to fail closed; current global enforcement is not proven and legacy positive processor/payout lanes remain blockers;
- production authority for new customer-money creation is `NO-GO`; remote `main` still accepts `HX_PAYMENT_CREATION_MODE=enabled`, so structural containment is not proven until an exact repaired candidate passes negative-effect tests.

The active Governor node is `TASK_FIRST_FAKE_FSE_POSTGRES_AUTHORITY_REBUILD`. Migration choice remains locked while persistent PostgreSQL targets are not fully closed. Ledger identity is the exact migration name, never a numeric alias: `20260824_task_first_fake_fse_vertical` has only a prospective, unauthorized clean-baseline append ordinal of 112; `20260825_task_first_fake_fse_postgres_authority_repair` has no assigned source ordinal pending legacy-chain reconstruction. Do not select either path or make backend runtime changes from documentation alone.

## Target runtime boundary

```text
Website / iOS / approved service clients
              │ authenticated typed commands and reads
              ▼
Railway web service
Hono + tRPC + REST/webhooks
              │
              ├── deterministic domain services and policy gates
              ├── PostgreSQL transactions, invariants, inbox/outbox
              └── Redis/BullMQ queues
                              │
                              ▼
                     Railway worker service
                     retries, recovery,
                     reconciliation, notifications

Canonical state: Railway PostgreSQL
Overlay: Supabase acquisition, consent, communications, recovery,
         analytics, and approved read projections only
External providers: adapters behind closed capabilities and evidence gates
```

The runtime uses the standard `pg` driver and must not depend on Supabase- or Neon-specific database semantics.

## Source layout

| Path | Responsibility |
|---|---|
| `backend/src/server.ts` | Hono composition root |
| `backend/src/routers/` | Typed API boundary and input validation |
| `backend/src/services/` | Business use cases and deterministic domain rules |
| `backend/src/jobs/` | Queue producers, workers, and runtime migration manifest |
| `backend/src/db.ts`, `backend/src/db/` | PostgreSQL pools, tagged SQL, and transactions |
| `backend/database/constitutional-schema.sql` | Fresh-database baseline and core invariants |
| `backend/database/migrations/` | Ordered, ledger-backed incremental migrations |
| `backend/tests/` | Unit, integration, system, and invariant tests |
| `scripts/` | Maintained operator and verification commands |
| `ops/` | Classified runbooks, templates, historical evidence, security, and compliance material |

## Local development

Requirements: Node 22, PostgreSQL, and Redis.

```bash
npm ci
test -e .env || cp .env.template .env
npm run db:validate
npm run dev
```

Run workers in a second terminal:

```bash
npm run dev:workers
```

Verification commands:

```bash
npm run typecheck
npm run lint
npm test
npm run verify:architecture
npm run compile
git diff --check
```

Test counts and coverage are revision-specific. Report the command, exact SHA, environment, skips, and result; never copy a historical count forward.

`npm run db:reset:destructive` drops and rebuilds `public`. It is permitted only against an explicitly verified disposable local database. Runtime migrations are incremental and recorded in `applied_migrations`; see [Migrations](docs/MIGRATIONS.md).

## Deployment and external effects

Railway is the only maintained target backend platform, but this document does not authorize a deploy. A production action requires fresh root-specific authority, exact source/build identity, protected approval, and the current Governor/evidence gates.

Railway currently auto-deploys `main`. Merging even documentation is therefore a Level 3 production-consequential action until that integration is detached or placed behind the accepted release transaction. Active Railway metadata identifies source `ab4a76…`, while public `/health` reports stale revision `140ce19…`; neither the health response nor `HX_PAYMENT_CREATION_MODE=frozen` proves truthful artifact identity or structural containment.

Never infer authority from an environment variable, a green check, a historical receipt, a provider test-mode success, or code presence. Preserve refund, void, recovery, webhook, and reconciliation lanes while positive production creation remains frozen.

## Documentation

- [Team Goal and Execution Contract](docs/HUSTLEXP_TEAM_ALIGNMENT.md) — stable mission, target invariants, gates, and definition of done
- [Current Backend Checkpoint](docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md) — refreshable exact-identity implementation, repository, migration, and evidence status
- [Frozen source contracts](docs/source-contracts/README.md) — byte-preserved backend mission and `/OPS` target inputs with SHA-256 provenance
- [Documentation index and status register](docs/README.md) — current, proposed, historical, frozen, and legacy classifications
- [Controlling specification pointer](docs/CONTROLLING_SPEC.md) — authority precedence and non-negotiable invariants
- [Architecture convergence record](docs/architecture/HUSTLEXP_PAYMENT_OPS_CONVERGENCE_RECORD.md) — detailed target design plus a source-dated historical writer snapshot, not current implementation or production authority
- [CI/CD](docs/CI_CD.md), [environment variables](docs/ENV.md), [migrations](docs/MIGRATIONS.md), and [Supabase cutover](docs/SUPABASE_TO_RAILWAY_CUTOVER.md) — bounded implementation references

Historical or legacy documents may explain prior behavior. Their content cannot authorize execution.
