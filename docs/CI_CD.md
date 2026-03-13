# CI/CD

**Last updated:** 2026-03-13

---

## Overview

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **CI — Lint, Typecheck, Test** | Push to `main` / `feat/*`, PRs | Typecheck, ESLint, tests, audit, build (compile). Must pass before deploy. |
| **Deploy** | After CI **succeeds** on `main` | Deploy to Railway (staging → production), health check. |
| **Deploy to AWS ECS** | Push to `main`, or manual | Validate (typecheck + compile), build Docker image, ECR push, Terraform plan/apply, ECS rollout. |
| **Security** | Weekly (Mon 06:00), PRs to `main` | npm audit, CodeQL, dependency-review, Snyk (optional). |

---

## Flow

1. **Push / PR** → **CI** runs (typecheck, lint, test, audit, compile). Concurrency: only the latest run per branch is kept; in-progress runs are cancelled.
2. **Push to `main`** → When **CI completes successfully**, **Deploy** runs: deploy to Railway staging → health check → deploy to production → health check. If CI fails, Deploy is triggered but all jobs are skipped.
3. **Push to `main`** (or manual) → **Deploy to AWS ECS** runs only after the **validate** job passes (typecheck + compile), then builds the image and deploys via Terraform/ECS.

---

## Required secrets

### Railway (Deploy workflow)

| Secret | Used in | Description |
|--------|--------|-------------|
| `RAILWAY_TOKEN` | staging | Railway API token (staging env). |
| `PRODUCTION_RAILWAY_TOKEN` | production | Railway API token (production env). |
| `RAILWAY_SERVICE` | both | Railway service ID (UUID from dashboard). |
| `STAGING_URL` | staging | Base URL of staging app (e.g. `https://xxx.up.railway.app`) for `/health`. |
| `PRODUCTION_URL` | production | Base URL of production app for `/health`. |

### CI (optional for full test run)

| Secret | Description |
|--------|-------------|
| `TEST_DATABASE_URL` | Postgres URL for CI tests (if unset, DB tests are skipped). |
| `TEST_UPSTASH_REDIS_REST_URL` | Redis REST URL for CI (optional). |
| `TEST_UPSTASH_REDIS_REST_TOKEN` | Redis REST token for CI (optional). |

### AWS (Deploy to AWS ECS)

See `deploy-aws.yml` and Terraform for `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `FIREBASE_PROJECT_ID`, `DATABASE_URL_ARN`, `REDIS_URL_ARN`, `STRIPE_SECRET_KEY_ARN`, `FIREBASE_PRIVATE_KEY_ARN`, `ROUTE53_ZONE_ID`.

### Security

| Secret | Description |
|--------|-------------|
| `SNYK_TOKEN` | Optional. If set, Snyk runs; if unset or Snyk fails, the Security workflow still passes (`continue-on-error`). |

---

## Fixes applied (2026-03-13)

- **Deploy only after CI passes:** Deploy is triggered by `workflow_run` when CI completes on `main`; deploy jobs run only when `conclusion == 'success'`. No duplicate test runs; broken code is never deployed.
- **Railway deploy uses correct commit:** Checkout uses `github.event.workflow_run.head_sha` so the commit that passed CI is deployed.
- **AWS deploy gated:** A **validate** job (typecheck + compile) runs first; ECS build/deploy runs only after it succeeds.
- **CI concurrency:** `ci-${{ github.ref }}` with `cancel-in-progress: true` so the latest push/PR cancels in-progress runs.
- **CI branch filters:** PRs and pushes use `main` and `feat/*`.
- **Security workflow:** Snyk job has `continue-on-error: true` so missing `SNYK_TOKEN` or Snyk findings don’t fail the workflow; review the Security tab.
