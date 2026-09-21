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

The inspected .github/workflows/ci.yml selects Node 22. The inspected package.json does not declare an engines or packageManager pin. September 20 baseline CI logs record Node 22.23.2/npm 10.9.8; record the actual versions on any new machine. These observed versions do not certify equivalent environments. Run the following separately in an authorized checkout with a validated disposable test environment, preserving each exit status:

```bash
node --version
npm --version
npm ci
npx tsc --noEmit
npx eslint backend/src/ --ext .ts --max-warnings 0
npx vitest run --reporter=verbose
npm audit --omit=dev --audit-level=high
npm run compile
```

These are the inspected CI command forms; package lint alone does not add the zero-warning argument. Capture failures without silently weakening rules or skipping evidence. CI's build/role/legal steps may be skipped after test failure; a separate controlled execution must be recorded as a different run, not promoted into the old run. TEST_* secret names in CI do not establish the targets' identity or containment.

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

The inspected .github/workflows/deploy.yml is workflow_dispatch-only. That does not establish Railway's separate Git integration, preview settings, current deployments or artifact identity. Default-branch auto-deployment was historically reported; current hosted linkage remains unverified. Keep this documentation on the review branch until required checks/review and deployment-safe adoption are evidenced. Production new-customer-money creation remains frozen unless separately approved/certified. Retain lawful required refund/recovery capabilities and applicable controls.
