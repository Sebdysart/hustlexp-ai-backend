# HustleXP canonical backend

This repository is the authoritative HustleXP marketplace engine. It owns business rules, task and escrow state transitions, XP/trust calculation, web operations, background automation, and PostgreSQL invariants.

The website and mobile clients are API consumers. They must not recreate these rules in client code or in a second database backend.

## Runtime architecture

```text
Website / iOS
     │ Firebase JWT + HTTPS
     ▼
Railway web service
Hono + tRPC + REST/webhooks
     │
     ├── services and deterministic state machines
     ├── PostgreSQL transactions, triggers, and outbox
     └── Redis/BullMQ queues
                    │
                    ▼
           Railway worker service
           notifications, payments,
           automation, reconciliation

Shared state: Railway PostgreSQL
Supporting services: Redis, Firebase Auth, Stripe, object storage, AI providers
```

PostgreSQL is accessed through the standard `pg` driver, so the runtime is not tied to Supabase or Neon. Railway supplies `DATABASE_URL` in production.

## Source layout

| Path | Responsibility |
|---|---|
| `backend/src/server.ts` | Hono composition root |
| `backend/src/routers/` | Typed API boundary and input validation |
| `backend/src/services/` | Business use cases and domain rules |
| `backend/src/jobs/` | BullMQ producers, workers, and runtime migration manifest |
| `backend/src/db.ts` and `backend/src/db/` | PostgreSQL pools, tagged SQL, and transactions |
| `backend/database/constitutional-schema.sql` | Fresh-database baseline and core invariants |
| `backend/database/migrations/` | Ordered, ledger-backed production migrations |
| `backend/tests/` | Unit, integration, system, and invariant tests |
| `scripts/` | Maintained operator and verification commands |
| `ops/` | Runbooks, security, and compliance material |

## Local development

Requirements: Node 22, PostgreSQL, and Redis.

```bash
npm ci
cp .env.template .env
npm run db:validate
npm run dev
```

Run workers in a second terminal:

```bash
npm run dev:workers
```

Important commands:

```bash
npm run typecheck
npm run lint
npm test
npm run verify:architecture
npm run compile
```

`npm run db:reset:destructive` drops and rebuilds the public schema. It is permitted only for an explicitly disposable development database. Normal runtime migrations are incremental and recorded in `applied_migrations`.

## Deployment

Railway is the only maintained backend deployment target:

- `railway.json` defines the build and health policy.
- `Dockerfile` builds the web and worker image.
- `SERVICE_ROLE=worker` selects the worker process; otherwise the API starts.
- The manual production workflow verifies and deploys an exact Git revision.
- Both roles apply the idempotent runtime migration manifest before starting.

See [CI/CD](docs/CI_CD.md), [environment variables](docs/ENV.md), and [migrations](docs/MIGRATIONS.md).

## Website/Supabase boundary

The engine already exposes replacement web routes under `backend/src/routers/web/`, backed by PostgreSQL tables introduced in `backend/database/migrations/010_web_platform_tables.sql`. Supabase can be retired only after website reads/writes, automation triggers, authentication assumptions, file storage, and production data are moved and verified. Do not delete the Supabase implementation before that cutover.

## Safety rules

- PostgreSQL triggers are the final authority for financial and XP invariants.
- Money and critical side effects use transactions, idempotency keys, and the outbox/worker path.
- AI proposes; deterministic code authorizes state and money changes.
- Secrets belong in local ignored files or Railway variables, never in Git.
- Schema history and compliance evidence are retained even when they look redundant.

The controlling engineering rules are in [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), and [docs/CONTROLLING_SPEC.md](docs/CONTROLLING_SPEC.md).
