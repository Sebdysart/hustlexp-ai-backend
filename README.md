# HustleXP backend

Status: DOCUMENTATION HANDOFF CANDIDATE, 2026-09-21. No runtime change, deployment, payment enablement or independent release acceptance is created by this documentation change.

## Start here

1. [Current source/evidence checkpoint](docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md): exact source pair, latest inspected CI, reproducibility and unknowns.
2. [M01 provider-account handoff](docs/M01_PROVIDER_ACCOUNT_HANDOFF.md): existing bounded milestone, inspected code anchors, missing links, tests, recovery and accountable resolver.
3. [AGENTS.md](AGENTS.md): agent/session procedure and safety boundaries.
4. [Canonical Document Index](https://docs.google.com/document/d/1QTrT40LK5zo-DN6ER7naM3p43WlyxkBxKsjL23p20mY/edit): current business/product authorities. Read relevant current sections, not superseded Charter copies.

HustleXP is a managed local-work transaction network. This backend owns the intended canonical transaction lifecycle; the presence of legacy task, escrow, Stripe or other provider-specific code does not establish current authority or working behavior. The website, mobile clients, Provider OS and /OPS render server-authorized state. Provider eligibility, financial security, assignment, completion, capture, payout and reconciliation remain distinct.

Assessment-only visits have separate purpose-bound consent/access controls. A no-charge visit is not a paid Work Order; separate paid assessment/execution obligations retain separate roots in one customer workspace. Consult current policy rather than historical blanket address-release statements.

## Local reproduction

Package evidence at the checkpoint source specifies Node 22 and npm 10. These commands exist; their presence does not prove startup or success:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run compile
```

Application/worker startup requires a separately identified disposable environment with correctly scoped database/queue credentials and external effects denied. Only after validating those prerequisites:

```bash
npm run db:validate
npm run dev
# Separate terminal, same approved disposable topology:
npm run dev:workers
```

Do not run destructive reset against persistent/shared databases. Do not use real processor, email, SMS, push or other externally effective credentials to reproduce a documentation fixture. An environment variable alone is not proof of containment. Record commands, exact revisions, failures, skips and simulation boundaries. Current cold-start/CI results are in the checkpoint, not static passing totals here.

## Source navigation

`backend/src/server.ts`: API composition; `backend/src/routers/`: typed routes; `backend/src/services/`: use cases; `backend/src/db.ts` and `backend/src/db/`: persistence; `backend/src/jobs/`: queues, workers and migration manifest; `backend/database/migrations/`: migrations; `backend/tests/`: test sources; `scripts/`: project commands.

Existing Team Alignment, controlling-spec, architecture, migration and security records remain applicable within their scope, date and actual adoption state. A stale checkpoint or source-contract snapshot cannot establish current facts. No documentation cleanup waives genuine safety, migration, signing, review or release requirements.

Default-branch auto-deployment was historically reported; current deployment linkage and artifact identity were not independently inspected in this execution. Therefore this change is staged on a review branch and is not permission to merge or deploy. Production new-customer-money creation remains frozen unless separately approved/certified. Retain lawful required refund/recovery capabilities and applicable controls.
