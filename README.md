# HustleXP canonical backend

**Repository role:** canonical backend API, worker, PostgreSQL lifecycle, policy enforcement, and provider-adapter boundary for HustleXP Universal V1.

**Lifecycle status:** `ACTIVE_DEVELOPMENT / PUBLIC_MAIN_INCIDENT / NO_IMMUTABLE_CANDIDATE / NOT_PRODUCTION_APPROVED`.

**Canonical authority:** [HustleXP Business and Universal V1 Charter v1.1.0](https://github.com/Sebdysart/HUSTLEXP-DOCS/blob/0b80c71e118d7cab70474bbbf6df778811fe4fe8/governance/HUSTLEXP_BUSINESS_AND_UNIVERSAL_V1_CHARTER.md)

**Supported runtime:** Node.js 22, Hono/tRPC, PostgreSQL, Redis/BullMQ, API and worker roles.

**Local start:** use the company `hustlexp-platform` repository for the canonical one-command synthetic stack. The host commands below are backend-only diagnostics against explicitly disposable PostgreSQL and Redis services; they are not a complete product stack.

**Staging path:** signed PR branch -> required CI -> immutable artifacts -> synthetic PR preview -> exact compatible manifest promotion to the isolated `hustlexp-nonprod` Railway project.

**Payment posture:** production customer-money creation and hard assignment are frozen. Local, preview, and staging use deterministic fake financial value only.

**Deployment authority:** no Git push, branch name, environment variable, historical receipt, or repository document authorizes production. A release requires the exact signed manifest, protected approvals, required green checks, environment approval, and matching API/worker runtime provenance.

**Known limitations:** public `main` is in an active release-authority incident and contains bundled `.local-tools`; this aligned local tree is not the default branch or an exact signed candidate. Legacy Stripe-specific projections and Supabase writers remain under controlled migration; database-dependent cohorts require disposable PostgreSQL; the [Work Order database command boundary](docs/architecture/HUSTLEXP_WORK_ORDER_DATABASE_AUTHORITY_BOUNDARY.md) remains `EXTERNAL_DECISION_REQUIRED / RELEASE_BLOCKING`, so a successful disposable-database journey does not establish least-privilege release authority; no real processor adapter is certified; production intake/estimate promotion remains separately held.

The Charter is the sole authority for business promises, categories, lifecycle meaning, and production posture. [The Team Goal and Execution Contract](docs/HUSTLEXP_TEAM_ALIGNMENT.md), [the Current Backend Checkpoint](docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md), [AGENTS.md](AGENTS.md), and Governor evidence govern engineering execution only and cannot create competing business strategy or authorize external effects.

This repository owns HustleXP's canonical marketplace lifecycle. Existing code includes legacy task, escrow, Stripe, admin, and Supabase-bridge behavior that is being contained and converged; repository presence is not proof that a path is authorized, deployed, or safe.

New Universal V1 financial commands enter through the provider-neutral `finance` tRPC boundary. That boundary supports deterministic fake preparation, authorization/security, adjustment, void, capture, refund/reversal, settlement/funding/payout observation, provider-account state, webhook ingestion, and reconciliation only inside exact synthetic local/preview/staging manifests. The `syntheticFinance` name remains a compatibility alias for existing nonproduction clients. Legacy quote creation, pay-first finalization, and test confirmation are permanent compatibility tombstones in every environment; only exact read-only materialization replay and persisted-provider orphan refund/void recovery remain. Legacy escrow, subscription, tip, cash-out, and Stripe Connect code remains frozen compatibility/recovery surface and cannot authorize production money or hard assignment.

## Current decision

- one transaction root per task occurrence;
- Railway PostgreSQL owns canonical transaction, fulfillment, financial, audit, and reconciliation facts;
- Supabase is an acquisition/read-model overlay, not a second lifecycle;
- a durable Task Draft precedes opportunity and financial security; Work Order materialization, assignment, and exact-address release follow a successful reconciled FSE;
- processor eligibility and HustleXP task eligibility are separate;
- Financial Security Event, capture, settlement, platform funding, provider payout, and reconciliation are separate rails;
- browsers cannot hold shared administrative authority or mutate canonical records directly;
- production money creation, hard assignment, and real settlement fail closed in the aligned local candidate; exact signed-candidate and deployed-runtime enforcement remain unproven;
- production authority for new customer-money creation is `NO-GO`; structural containment is not proven until one exact repaired candidate passes every negative-effect and runtime-provenance gate.

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

| Path                                         | Responsibility                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `backend/src/server.ts`                      | Hono composition root                                                                  |
| `backend/src/routers/`                       | Typed API boundary and input validation                                                |
| `backend/src/services/`                      | Business use cases and deterministic domain rules                                      |
| `backend/src/jobs/`                          | Queue producers, workers, and runtime migration manifest                               |
| `backend/src/db.ts`, `backend/src/db/`       | PostgreSQL pools, tagged SQL, and transactions                                         |
| `backend/database/constitutional-schema.sql` | Fresh-database baseline and core invariants                                            |
| `backend/database/migrations/`               | Ordered, ledger-backed incremental migrations                                          |
| `backend/tests/`                             | Unit, integration, system, and invariant tests                                         |
| `scripts/`                                   | Maintained operator and verification commands                                          |
| `ops/`                                       | Classified runbooks, templates, historical evidence, security, and compliance material |

## Local development

Requirements: Node 22, PostgreSQL, and Redis.

The checked-in `docker-compose.yml` is deliberately a non-runnable pointer. It
does not define an API, worker, PostgreSQL, or Redis runtime and cannot be used
as production, staging, or local-stack evidence. Start the complete local system
from the sibling `hustlexp-platform` repository. The commands in this section
are useful only when developing this repository directly and you have supplied
explicitly disposable local dependencies.

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
npm test                 # diagnostic; may skip DB cohorts when services are absent
npm run test:required    # release gate; zero failures and zero skip/todo
npm run verify:architecture
npm run compile
git diff --check
```

`npm run test:required` accepts only the allowlisted loopback test-database identity and isolated Redis, recreates only its disposable invariant/system databases, scrubs ambient live-provider configuration, and verifies the complete result artifact. See [System-test setup](backend/tests/system/README.md). A plain `npm test` result is not release evidence if any cohort skipped.

Test counts and coverage are revision-specific. Report the command, exact SHA, environment, skips, and result; never copy a historical count forward.

`npm run db:reset:destructive` drops and rebuilds `public`. It is permitted only against an explicitly verified disposable local database. Runtime migrations are incremental and recorded in `applied_migrations`; see [Migrations](docs/MIGRATIONS.md).

## Deployment and external effects

Railway is the only maintained target backend platform, but this document does not authorize a deploy. A production action requires fresh root-specific authority, exact source/build identity, protected approval, and the current Governor/evidence gates.

The checked-in `deploy.yml` is verification-only hold evidence: it compiles the dispatched SHA and proves customer-money creation remains frozen, but contains no Railway credential or deployment command. Production promotion automation is intentionally absent until staging acceptance and the separate release decision are complete.

The [2026-08-28 public incident readback](docs/incidents/2026-08-28-release-authority-readback.md) proves Railway Git auto-deployment acted on the current default-branch SHA. Merging even documentation is production-consequential until an authenticated administrator detaches the integration and proves the readback. API and worker health expose both build identity and release-manifest evidence; preview, staging, and production fail readiness unless the manifest has a valid detached signature from a public key pinned in protected source and the signed component digest matches the runtime-measured compiled artifact. API and worker startup are read-only migration attestors; only the explicit one-shot migration role may write schema after exact environment approval.

Never infer authority from an environment variable, a green check, a historical receipt, a provider test-mode success, or code presence. Preserve refund, void, recovery, webhook, and reconciliation lanes while positive production creation remains frozen.

## Documentation

- [Team Goal and Execution Contract](docs/HUSTLEXP_TEAM_ALIGNMENT.md) — stable mission, target invariants, gates, and definition of done
- [Current Backend Checkpoint](docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md) — refreshable exact-identity implementation, repository, migration, and evidence status
- [Frozen source contracts](docs/source-contracts/README.md) — byte-preserved backend mission and `/OPS` target inputs with SHA-256 provenance
- [Documentation index and status register](docs/README.md) — current, proposed, historical, frozen, and legacy classifications
- [Controlling specification pointer](docs/CONTROLLING_SPEC.md) — authority precedence and non-negotiable invariants
- [Architecture convergence record](docs/architecture/HUSTLEXP_PAYMENT_OPS_CONVERGENCE_RECORD.md) — detailed target design plus a source-dated historical writer snapshot, not current implementation or production authority
- [Work Order database command boundary](docs/architecture/HUSTLEXP_WORK_ORDER_DATABASE_AUTHORITY_BOUNDARY.md) — current external-decision hold for actor binding, sealed commands, roles, and live privilege readback
- [CI/CD](docs/CI_CD.md), [environment variables](docs/ENV.md), [migrations](docs/MIGRATIONS.md), and [Supabase cutover](docs/SUPABASE_TO_RAILWAY_CUTOVER.md) — bounded implementation references

Historical or legacy documents may explain prior behavior. Their content cannot authorize execution.
