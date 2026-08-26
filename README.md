# HustleXP canonical backend

Status: `CURRENT_IMPLEMENTATION_REFERENCE / CONVERGENCE_IN_PROGRESS`

Production launch: `NO-GO`

Production effects authorized by this repository documentation: `NONE`

[The Team Goal and Execution Contract](docs/HUSTLEXP_TEAM_ALIGNMENT.md) is the stable engineering target. [The Current Backend Checkpoint](docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md) contains source-dated implementation and external-state facts. The default-branch copy of the target becomes team-operative only at an exact commit accepted by an independent Reviewer; working-copy edits never change adopted policy. [AGENTS.md](AGENTS.md) controls repository workflow; canonical Governor state and accepted evidence control program authority.

PR #275 published its documentation tree unchanged at merge commit `5a8675b37473d626efbf4bff8635797ba29db7af`, but it did not receive the requested `whitehorse1016` approval and it did not make the backend healthy. The separate D1/CI recovery work is rooted at `main` commit `73c44eee22fa79c2957583217e69aa972291776f` on `codex/d1-ci-incident-recovery`. Its working tree is not publication evidence: it must be frozen, independently reviewed, freshly admitted by the Governor, signed, pushed, and accepted through protection.

This repository is the target owner of HustleXP's canonical marketplace lifecycle. Existing code includes legacy task, escrow, Stripe, admin, and Supabase-bridge behavior that is being contained and converged; repository presence is not proof that a path is authorized, deployed, or safe.

## Current decision

- one transaction root per task occurrence;
- Railway PostgreSQL owns canonical transaction, fulfillment, financial, audit, and reconciliation facts;
- Supabase is an acquisition/read-model overlay, not a second lifecycle;
- a durable Task Draft precedes opportunity and financial security; Work Order materialization, assignment, and exact-address release follow a successful reconciled FSE;
- processor eligibility and HustleXP task eligibility are separate;
- Financial Security Event, capture, settlement, platform funding, provider payout, and reconciliation are separate rails;
- browsers cannot hold shared administrative authority or mutate canonical records directly;
- target policy requires all 20 unresolved processor-dependent capabilities to fail closed; no unresolved decision can be enabled by configuration;
- the local D1/CI candidate structurally freezes new production processor creation while preserving negative/recovery lanes, but it receives no implementation credit until the exact final tree passes the full protected matrix and PostgreSQL harness;
- queue transport identity is distinct from durable outbox authority, refund creation is bound to one immutable escrow-scoped provider claim, and Operations writes remain fail-closed pending the later authenticated command-plane convergence;
- production authority for new customer-money creation and production launch remain `NO-GO`.

The active Governor node is `D1_CI_INCIDENT_RECOVERY_20260825`. The last accepted local control HEAD is `1e0887d4e6ab8dfa4006734faf7090b46985e25b`; the current implementation tree has moved beyond its accepted path manifest. Publication is therefore blocked until a fresh, independently accepted Governor-maintainer revision binds the exact final tree. Normal backend sessions must not modify or self-accept the Governor.

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
npm run lint -- --max-warnings 0
npm test -- --maxWorkers=1
npm run verify:architecture
npm run compile
npm audit --omit=dev --audit-level=high
git diff --check
```

Test counts and coverage are revision-specific. Report the command, exact SHA, environment, skips, and result; never copy a historical count forward.

`npm run db:reset:destructive` drops and rebuilds `public`. It is permitted only against an explicitly verified disposable local database. Runtime migrations are incremental and recorded in `applied_migrations`; see [Migrations](docs/MIGRATIONS.md).

## Deployment and external effects

Railway is the only maintained target backend platform, but this document does not authorize a deploy. A production action requires fresh root-specific authority, exact source/build identity, protected approval, and the current Governor/evidence gates.

Railway currently auto-deploys `main`. Merging is therefore production-consequential until that integration is disabled or placed behind the accepted release transaction. The latest read-only observation binds the web source to `main` `73c44eee22fa79c2957583217e69aa972291776f`, while public `/health` still reports revision `140ce19f4f77926249b1e7c0e5d2aac29bd4c9ef`; the worker has no source binding. None of those observations proves truthful web/worker/image/database convergence or structural containment.

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
