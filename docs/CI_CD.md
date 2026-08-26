# CI/CD

Status: `CURRENT_IMPLEMENTATION_REFERENCE / RELEASE_BLOCKED`

Production launch: `NO-GO`

Read [the team goal](HUSTLEXP_TEAM_ALIGNMENT.md) and source-dated [current checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md). A workflow definition proves intended controls; a successful run proves only its named assertions on its exact SHA. Neither grants Governor admission, merge, deployment, processor, or production authority.

## Required workflows

| Workflow/job | Trigger | Exact responsibility |
|---|---|---|
| `CI — Lint, Typecheck, Test` | Pull request to `main` and configured pushes | Node 22 typecheck, zero-warning backend lint, full Vitest, readiness/legal contract tests, production dependency audit, and gated build |
| `Build Validation` | After typecheck, lint, and tests | Compile; fresh/upgrade/replay/recovery migrations on PostgreSQL 17.7; PR276 prefix/drift/preservation/role/containment harness; production image build; migrator-credential exclusion; exact migration-artifact identity |
| `Security` / `audit` | Pull requests, `main`, and weekly schedule | Pinned Actions, workflow contract, and high/critical production dependency audit |
| `Security` / `codeql` | Pull requests, `main`, and weekly schedule | JavaScript/TypeScript CodeQL analysis |
| `Security` / `dependency-review` | Pull requests only | Dependency diff review on the exact PR head |
| `Security` / `snyk` | Explicit repository-variable opt-in only | Supplemental scan; a skipped job receives no green credit |
| `Release exact admitted engine revision` | Manual dispatch on protected `main` | Re-admit the exact merge, apply checksummed migrations with one-shot credentials, upload separate web/worker sources, and attest both deployments and public identity |
| Railway Git integration | Push or merge to `main` | Current out-of-band production web deployment path; release-blocking until disabled or contained by an accepted transaction |

The authoritative workflow files are [CI](../.github/workflows/ci.yml), [Security](../.github/workflows/security.yml), and [Deploy](../.github/workflows/deploy.yml). Actions are pinned by full commit SHA. Do not relax assertions or invent success for an unavailable/skipped job.

## Protected repository boundary

GitHub API verification at the checkpoint observation window confirmed active ruleset `20840525` with no bypass actors. It requires signatures, linear history, a pull request, one independent approval, post-final-push approval, resolved threads, strict up-to-date checks, CodeQL high-or-higher enforcement, and these contexts:

1. `TypeScript — zero errors`
2. `Lint — zero warnings (backend/src/)`
3. `Security audit — no high/critical production vulnerabilities`
4. `Tests — zero failures`
5. `Build Validation`
6. `audit`
7. `dependency-review`
8. `codeql`

The `production` environment disallows administrator bypass, accepts protected branches only, requires reviewer `whitehorse1016`, and prevents self-review. The repository remains personally owned by `Sebdysart`; organization Enterprise entitlement is not repository control until ownership/policy topology is explicitly changed and re-audited.

## Exact release admission

The manual release workflow fails closed unless all of the following hold:

1. The dispatched SHA is a clean checkout equal to current protected `main`.
2. Required checks from the expected GitHub Actions app succeeded.
3. Exactly one merged first-party PR owns the merge SHA, and its final head tree equals the merge tree.
4. `whitehorse1016` approved the exact final PR head.
5. `dependency-review` succeeded on that PR head.
6. A successful `Governor admission` status is published by the expected identity and points to a content-addressed control commit/evidence digest.
7. Compiled build identity and the registered migration-artifact digest match the exact source.
8. The protected environment approval is current after revalidating `main`.
9. Migrations run once with `PRODUCTION_MIGRATION_DATABASE_URL`; long-lived web and worker services do not receive that credential or mutable build-identity variables.
10. Railway CLI `4.66.0` uploads distinct content-addressed web and worker contexts and returns exact deployment identifiers.
11. Public `/health`, web deployment, worker deployment, source tree, migration digest, and release provenance all match the admitted SHA.

Workflow code cannot repair a Railway deployment that starts before these checks. The Git auto-deploy path must be disabled or equivalently contained under fresh Governor/deployment authority before merge.

## Current failures

- Remote `main` is unsigned and CI run `32904480883` is red: lint and tests failed, Build Validation skipped, while TypeScript and production audit passed.
- PR #275 is already merged unchanged but has no `whitehorse1016` approval; it receives no independent-review precedent.
- Railway web source is `73c44eee22fa79c2957583217e69aa972291776f`, worker source is unbound, and `/health` reports stale revision `140ce19f4f77926249b1e7c0e5d2aac29bd4c9ef`.
- Seven CodeQL alerts and six secret-scanning alerts remain open; the exposed credentials lack accepted rotation/revocation receipts.
- Dependabot alerts and security updates are disabled.
- The local D1/CI tree is uncommitted, unpublished, outside the last accepted Governor manifest, not independently reviewed, and has not passed the full/PostgreSQL matrix.

Each defect independently preserves `NO-GO`.

## Required secrets and credential separation

| Secret | Scope |
|---|---|
| `TEST_DATABASE_URL` | Optional test-only integration database; absence can cause visible test skips and never earns PostgreSQL credit |
| `TEST_UPSTASH_REDIS_REST_URL`, `TEST_UPSTASH_REDIS_REST_TOKEN` | Optional test-only Redis REST integration |
| `RAILWAY_TOKEN` | Protected release job only; does not contain Railway Git auto-deploy |
| `PRODUCTION_DATABASE_URL` | Protected one-shot release job runtime connection |
| `PRODUCTION_MIGRATION_DATABASE_URL` | Protected one-shot migrator credential; forbidden from long-lived Railway web/worker variables and images |
| `SNYK_TOKEN` | Optional supplemental scanner only |

Runtime/provider secrets are configured through their authorized secret stores. Never copy secret values into logs, documentation, evidence, source, browser storage, or GitHub issue/PR text. See [ENV.md](ENV.md).
