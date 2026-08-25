# CI/CD

Status: `CURRENT_IMPLEMENTATION_REFERENCE / NOT_DEPLOYMENT_AUTHORITY`

Production launch: `NO-GO`

Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md). A workflow definition or green run proves only the named check on the exact SHA; it does not authorize merge, deployment, provider configuration, or production effects.

Railway is the only maintained deployment target for this repository. The intended service configuration is [`railway.json`](../railway.json), and the production image is defined by [`Dockerfile`](../Dockerfile). The manual GitHub workflow is not the only effective deployment path: Railway Git integration currently auto-deploys `main` to production.

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| CI | Push and pull request | Typecheck, lint, tests, production dependency audit, compile |
| Deploy | Manual production dispatch | Re-verify the selected revision, deploy the web and worker Railway services, then verify exact build identity and health |
| Railway Git integration | Push or merge to `main` | Current out-of-band path that automatically deploys Railway production; blocking defect until detached or placed behind equivalent protected approval |
| Security | Pull requests and weekly schedule | CodeQL, dependency review, and supplemental dependency scans |

The deploy workflow checks out the exact dispatched commit before deployment. It targets the GitHub `production` environment, but the live environment does not currently provide an independent deployment-approval gate. Separately, Railway deployment `8e8e3864-5348-4f91-ae33-c614425f2362` in project `authentic-compassion`, environment `production`, service `hustlexp-ai-backend-staging`, was created nine seconds after `main` commit `ab4a76cbc8ea32c663c36982eafe94b20d2dc879` and is metadata-bound to that source. This proves automatic production deployment outside the manual workflow.

The public runtime cannot currently prove its artifact identity. At `2026-08-25T20:08:08Z`, `/health` returned HTTP 200 but reported revision `140ce19f4f77926249b1e7c0e5d2aac29bd4c9ef` and a `2026-07-23` build, while Railway metadata identifies deployed source `ab4a76…`. Stale `HX_BUILD_REVISION`, `HX_BUILD_TIMESTAMP`, and `HX_BUILD_SOURCE_CLEAN` variables must be removed from release identity authority.

## Verified repository-control boundary

At the 2026-08-25 read-only audit, the API confirmed active configuration in repository ruleset `20840525` for signed commits, linear history, one independent approval, last-push approval, resolved review threads, eight strict required checks, CodeQL, and no bypass actors on the backend default branch. This is `API-CONFIRMED ACTIVE CONFIGURATION / BEHAVIORAL REHEARSAL NOT_PROVEN`: the rule-suite query returned no evaluated suites, and no controlled direct-push or unapproved-merge rejection was attempted. The legacy branch-protection endpoint returning `404` does not negate the ruleset configuration, but the configuration must not be represented as observed rejection behavior.

Independent review root `01c0433009c62160f86fb295927490a1f1c10a5d1c11dec1c86c8ac5cebbe5a5` (`SHA-256(SHA256SUMS)`) concluded `ACTIVE_REPOSITORY_CONTAINMENT_NOT_HEALTHY_ENTERPRISE_ENFORCEMENT`. The repository remained owned by personal user `Sebdysart`; `HustleXP-LLC` had Enterprise entitlement but no organization ruleset, MFA requirement, SAML identity provider, web commit signoff, or control over the backend. Full Enterprise-account topology remained `BLOCKED_SCOPE` because the authenticated session lacked `read:enterprise` or `admin:enterprise`. Re-audit through the API before crediting any mutable control.

Required checks do not replace Governor admission, exact evidence, independent review, or production authority. Snyk is optional supplemental evidence and must never be reported green when skipped.

## Active deployment-control defects

The 2026-08-25 read-only API audit found:

- `production.can_admins_bypass = true`;
- the only required reviewer is `Sebdysart`;
- `prevent_self_review = false`;
- the environment accepts all deployment branches;
- repository and organization Actions policy allow all actions, SHA pinning is not required, and the default workflow permission is read-only;
- `.github/workflows/deploy.yml` verifies typecheck, build identity, and compilation, but does not run lint, tests, dependency/security gates, Governor preflight, or an exact protected-`main` membership check before deployment;
- Railway Git integration auto-deploys `main`, so any merge—including documentation-only content—is a Level 3 production action until the integration is detached or protected by the accepted release transaction;
- active Railway source identity `ab4a76…` contradicts public `/health` revision `140ce19…`;
- remote `main` `ab4a76cbc8ea32c663c36982eafe94b20d2dc879` is unsigned; its CI run `32569865606` failed lint and 63 tests while build validation was skipped;
- that run contained 63 failed tests across 24 files with 7,690 passing tests, four lint errors and nine warnings; dependency review was skipped while typecheck and production dependency audit passed;
- Dependabot alerts and security updates are disabled;
- PR 274 head `714e111efa7ae8615313b79338f4a65f71f1df41` has all eight required contexts green, but its ten commits are unsigned and merge remains blocked for review;
- seven CodeQL alerts and six secret-scanning alerts remain open; Dependabot alerts are disabled.

These are independent `NO-GO` defects. A successful workflow dispatch, environment approval, health response, or CodeQL check cannot be represented as a complete release or security review.

## Required GitHub secrets

| Secret | Purpose |
|---|---|
| `RAILWAY_TOKEN` | Token used by the manual GitHub deployment workflow; it does not control or contain Railway Git auto-deployment |
| `TEST_DATABASE_URL` | Optional PostgreSQL database for CI integration tests |
| `TEST_UPSTASH_REDIS_REST_URL` | Optional Redis REST endpoint for CI |
| `TEST_UPSTASH_REDIS_REST_TOKEN` | Optional Redis REST token for CI |
| `SNYK_TOKEN` | Optional supplemental Snyk scan |

Runtime secrets, including `DATABASE_URL`, are configured in Railway rather than GitHub Actions. See [ENV.md](ENV.md).
