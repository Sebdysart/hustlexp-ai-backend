# CI/CD and release authority

Status: `CURRENT_IMPLEMENTATION_REFERENCE / NOT_DEPLOYMENT_AUTHORITY`

Production launch: `NO-GO`

Evidence refreshed: `2026-08-26`. Mutable GitHub and Railway state must be read again before any release decision.

Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md). A workflow definition or green run proves only the named check on one exact SHA. It does not authorize merge, deployment, provider configuration, database mutation, or production effects.

## Current checked-in workflows

| Workflow | Trigger | Current purpose |
|---|---|---|
| CI | Push and pull request | TypeScript, zero-warning lint, complete PostgreSQL/Redis-backed Vitest gate, production dependency audit, and Build Validation |
| Security | Pull requests and weekly schedule | `audit`, CodeQL, dependency review, and optional supplemental Snyk |
| Production release hold evidence | Manual dispatch | Check out the dispatched SHA, typecheck, lint, compile an attributable artifact, and prove new customer-money creation remains frozen |

The checked-in production workflow contains no Railway token, CLI command, deployment job, database migration, or capability enablement. It is evidence of a deliberate hold, not a deployment path.

The complete test context provisions disposable PostgreSQL and Redis service containers in GitHub Actions. It runs `scripts/prepare-test-databases.mjs` against the allowlisted loopback administrator database and then rejects any failed, skipped, pending, or todo Vitest result. No Neon, Supabase, or production database secret is part of that gate.

## Current GitHub readback

Repository and pull-request state was read without mutation on `2026-08-26`. A least-privilege authenticated ruleset readback observed ruleset `20840525` at `2026-08-26T23:58:53-07:00`:

- default branch `main` remained exactly `73c44eee22fa79c2957583217e69aa972291776f`;
- ruleset `20840525` was active for the default branch and required signed commits, linear history, one approval, stale-review dismissal, last-push approval, conversation resolution, strict up-to-date checks, CodeQL, and the eight named contexts below;
- its authenticated response returned `bypass_actors: []`, actor `252866125` was absent, and `current_user_can_bypass` was `never`;
- recovery branch `codex/release-authority-recovery` remained at GitHub-verified SHA `90b92c917b7f88e41780b07af506cba96c0ec60f` with all eight required contexts successful;
- PR #278 remained a draft with no approval, so independent and last-push approval were absent; and
- PRs #274, #276, and #277 remained preserved incident evidence.

This source-dated readback proves only the mutable ruleset configuration observed at that time. It does not check, sign, approve, or grant hosted status to the current dirty local bytes or any future candidate; those require a fresh exact-SHA release transaction.

The exact required contexts observed on ruleset `20840525` were:

1. `TypeScript — zero errors`
2. `Lint — zero warnings (backend/src/)`
3. `Security audit — no high/critical production vulnerabilities`
4. `Tests — zero failures`
5. `Build Validation`
6. `audit`
7. `dependency-review`
8. `codeql`

Green results on recovery SHA `90b92c…` do not cover later uncommitted alignment work and cannot be carried forward to a future candidate.

## Railway authority boundary

Railway is the intended hosting platform, but current Railway administrative state was inaccessible on `2026-08-26`: no approved Railway session or project credential was available, and no current readback proved production Git auto-deploy disabled or an isolated `hustlexp-nonprod` project provisioned.

A source-dated `2026-08-25` incident observation associated Railway project `authentic-compassion` with an automatic deployment after a push to `main`. That evidence remains a blocker and must be preserved, but it is not proof of the current switch state. Before any protected merge, an authorized administrator must disable production Git auto-deployment and re-read the setting. Production promotion must then be an explicit exact-manifest action behind environment approval and runtime provenance checks.

The local `hustlexp-platform` candidate defines the desired nonproduction project, immutable-image promotion, manifest verification, and staging/preview isolation. Configuration-as-code is not proof that Railway resources exist.

## Required release transaction

No change is releasable until all of the following bind to the same exact candidate:

1. approved signing identity and verified candidate signature;
2. authenticated ruleset readback proving zero bypass actors;
3. all eight required contexts successful with none skipped;
4. one independent approval and last-push approval;
5. every conversation resolved and strict/linear history satisfied;
6. exact immutable backend, worker, web, migration, policy, and fixture artifacts in the signed release manifest;
7. accepted synthetic preview and shared-staging evidence;
8. production Git auto-deployment disabled and re-read; and
9. explicit environment approval for any later production promotion.

Production customer-money creation, hard assignment, real settlement/payout, production database migration, and TestFlight remain separately held even after an intake-and-estimate release becomes eligible.

## Secrets and credentials

The required CI test gate does not need production or hosted database credentials. Runtime secrets belong only in the approved environment secret store and are never copied into repository variables, manifests, logs, or agent prompts.

`SNYK_TOKEN` is optional supplemental scan input only when the repository variable explicitly enables that job. A skipped Snyk job is not a required green context and must never be reported as a successful scan.

The credential previously exposed in chat was not used by this work. Its revocation and replacement with short-lived, least-privilege organization authentication remain external requirements.
