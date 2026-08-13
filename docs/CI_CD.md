# CI/CD

Railway is the only maintained deployment target for this repository. The authoritative service configuration is [`railway.json`](../railway.json), and the production image is defined by [`Dockerfile`](../Dockerfile).

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| CI | Push and pull request | Typecheck, lint, tests, production dependency audit, compile |
| Deploy | Manual production dispatch | Re-verify the selected revision, deploy the web and worker Railway services, then verify exact build identity and health |
| Security | Pull requests and weekly schedule | CodeQL, dependency review, and supplemental dependency scans |

The deploy workflow checks out and verifies the exact dispatched commit before deployment. The GitHub `production` environment owns deployment approval.

## Required GitHub secrets

| Secret | Purpose |
|---|---|
| `RAILWAY_TOKEN` | Railway token allowed to deploy the production web and worker services |
| `TEST_DATABASE_URL` | Optional PostgreSQL database for CI integration tests |
| `TEST_UPSTASH_REDIS_REST_URL` | Optional Redis REST endpoint for CI |
| `TEST_UPSTASH_REDIS_REST_TOKEN` | Optional Redis REST token for CI |
| `SNYK_TOKEN` | Optional supplemental Snyk scan |

Runtime secrets, including `DATABASE_URL`, are configured in Railway rather than GitHub Actions. See [ENV.md](ENV.md).
