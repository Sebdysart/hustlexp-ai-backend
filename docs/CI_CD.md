# CI/CD and release authority

Status: `CURRENT_IMPLEMENTATION_REFERENCE / NOT_DEPLOYMENT_AUTHORITY`

Production launch: `NO-GO`

Evidence refreshed through a public read-only observation on `2026-08-28`. Mutable GitHub and Railway administrator state must be authenticated and read again before any release decision.

Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md). A workflow definition or green run proves only the named check on one exact SHA. It does not authorize merge, deployment, provider configuration, database mutation, or production effects.

## Current checked-in workflows

| Workflow | Trigger | Current purpose |
|---|---|---|
| CI | Push and pull request | TypeScript, zero-warning lint, complete PostgreSQL/Redis-backed Vitest gate, production dependency audit, and Build Validation |
| Security | Pull requests and weekly schedule | `audit`, CodeQL, dependency review, and optional supplemental Snyk |
| Production release hold evidence | Manual dispatch | Check out the dispatched SHA, typecheck, lint, compile an attributable artifact, and prove new customer-money creation remains frozen |

The checked-in production workflow contains no Railway token, CLI command, deployment job, database migration, or capability enablement. It is evidence of a deliberate hold, not a deployment path.

The complete test context provisions disposable PostgreSQL and Redis service containers in GitHub Actions. It runs `scripts/prepare-test-databases.mjs` against the allowlisted loopback administrator database and then rejects any failed, skipped, pending, or todo Vitest result. No Neon, Supabase, or production database secret is part of that gate.

## Critical public readback — 2026-08-28

The source-dated [release-authority incident readback](incidents/2026-08-28-release-authority-readback.md) supersedes the older default-branch and production-trigger facts below:

- public `main` is unsigned `d42975be9691c6dbe99f7580fac1b0d8258a3f7a`, seven commits ahead of `73c44eee…`, and includes a merge commit;
- PR #281 reached `main` with no approving review while lint and tests failed and Build Validation was skipped;
- the current default-branch tree contains 3,248 `.local-tools` entries;
- Railway created GitHub deployment `6142799813` for `d42975be…` in `authentic-compassion / production`, and its latest public status is `success`;
- the public ruleset payload still describes the intended protections but omits administrator-only bypass fields, so zero bypass actors cannot be re-proven without approved authentication; and
- the direct mainline-parent-1 revert now conflicts in 36 paths and was aborted without a commit, activating the reconstruction branch of the recovery plan.

Release authority must therefore be treated as compromised until an authenticated readback explains and removes the bypass path, production Git auto-deployment is detached, and one new signed forward-repair candidate passes every exact gate. No merge—including documentation—is safe while the production trigger remains attached.

## Prior authenticated GitHub readback — 2026-08-26

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

Railway is the intended hosting platform, but Railway administrative state remains inaccessible: no approved Railway session or project credential is available, and no authenticated readback proves an isolated `hustlexp-nonprod` project provisioned.

The public `2026-08-28` GitHub deployment record binds current `main` SHA `d42975be…` to a successful `authentic-compassion / production` deployment. This is current evidence that the production Git trigger remained operative for that commit, although only an authenticated Railway readback can prove the present switch state. Before any protected merge, an authorized administrator must disable production Git auto-deployment and re-read the setting. Production promotion must then be an explicit exact-manifest action behind environment approval and runtime provenance checks.

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
