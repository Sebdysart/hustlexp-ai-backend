# Environment variables

Status: `CURRENT_IMPLEMENTATION_REFERENCE / CONFIGURATION_IS_NOT_AUTHORITY`

Production launch: `NO-GO`

Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md) and [current checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md). Configuration is never authority: a variable must not enable a capability blocked by underwriting, policy, Governor state, or an accepted containment gate. The local D1 candidate closes the identified production creation lanes, but only the frozen exact candidate and its full negative-effect evidence can establish that implementation boundary.

`backend/src/config.ts` is the runtime authority. [`.env.template`](../.env.template) is the copyable local-development template; Railway variables are the production source of truth. Never commit a populated `.env` file.

Classification-only production inspection on `2026-08-25` found `NODE_ENV=production`, `HX_PAYMENT_CREATION_MODE=frozen`, `STRIPE_MODE=live`, live-classified Stripe credentials, legacy `OPS_ADMIN_KEY`, and `KILL_SWITCH=false`; secret values were not read or recorded. The later Railway observation binds web source to `73c44eee22fa79c2957583217e69aa972291776f`, while `/health` reports stale revision `140ce19f4f77926249b1e7c0e5d2aac29bd4c9ef`. `HX_BUILD_REVISION`, `HX_BUILD_TIMESTAMP`, and `HX_BUILD_SOURCE_CLEAN` must not be long-lived runtime variables or release evidence; build identity is compiled from the admitted source.

## Core runtime

| Variable | Requirement | Purpose |
|---|---|---|
| `DATABASE_URL` | Required in web and worker | Non-owner Railway PostgreSQL runtime connection; cannot perform schema/role/extension DDL |
| `MIGRATION_DATABASE_URL` | One-shot migrator only | Protected release-job credential; forbidden in Railway web/worker variables, images, and child processes |
| `DATABASE_REPLICA_URL` | Optional | Read-only replica connection string |
| `PORT` | Optional | API port; Railway supplies this in production |
| `WORKER_PORT` | Optional | Separate worker health port |
| `SERVICE_ROLE` | Required for worker | `worker` selects the BullMQ worker process; web must not declare `worker` |
| `NODE_ENV` | Required in production | Use `production` on Railway |
| `ALLOWED_ORIGINS` | Required in production | Comma-separated HTTPS website origins; wildcards are rejected |

## Authentication, legacy payment containment, and queues

| Variables | Requirement |
|---|---|
| `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` | Required for authenticated production traffic |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | Legacy/recovery and webhook compatibility in the current runtime; presence does not authorize new payment creation; webhook secrets must differ |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Required for distributed cache and rate limits |
| `UPSTASH_REDIS_URL` or `REDIS_URL` | Required for BullMQ workers |
| `QUEUE_HMAC_SECRET` | Required for signed queue payloads |

`HX_PAYMENT_CREATION_MODE` must remain `frozen` in every persistent environment. Remote base `73c44eee22fa79c2957583217e69aa972291776f` is not accepted containment. In the local D1 candidate, `enabled` is honored only inside a real Vitest worker when all of these exact conditions hold: `NODE_ENV=test`, `ENGINE_API_MODE=test`, `STRIPE_MODE=test`, an `sk_test_` key, the closed `HXOS_LOCAL_TEST_DATABASE_ATTESTATION` token, a loopback disposable `hx_*_test` database, a matching restricted `hx_test_*` role, and matching `HXOS_LOCAL_TEST_DATABASE_NAME`/`HXOS_LOCAL_TEST_DATABASE_ROLE`. Missing or production-like evidence returns `frozen`.

`HX_STRIPE_STUB`, sandbox keys, a test receipt, or manually setting `VITEST` never authorizes production effects. The guard additionally requires real runner evidence and executes before provider and canonical write effects.

Do not place `OPS_ADMIN_KEY`, another human shared credential, or a caller-supplied actor identity in browser-exposed variables. The target Operations boundary uses named short-lived sessions and server-side capability checks.

`OPS_ADMIN_KEY` has been removed from the candidate template, but the source-dated production presence is a blocking legacy condition until an authorized rotation/removal receipt and built-asset/source search both pass. `KILL_SWITCH=false` is not containment when no accepted runtime consumer enforces it.

The one-shot migrator may additionally require `HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER`, `HX_MIGRATION_EXPECTED_DATABASE_NAME`, and `HX_MIGRATION_EXPECTED_DATABASE_OID` to bind an approved target. Those values describe a target; they do not authorize it.

## Encryption

Use independent secrets; never reuse one key for multiple fields.

| Variable | Purpose |
|---|---|
| `TASK_LOCATION_ENCRYPTION_KEY` | Base64-encoded 32-byte key for precise task locations |
| `TASK_LOCATION_ENCRYPTION_KEY_ID` | Stable identifier for the active location key |
| `TASK_LOCATION_DECRYPTION_KEYS` | JSON map of retired key IDs to base64 keys during rotation |
| `TAX_TIN_ENCRYPTION_KEY` | Encrypt tax identifiers |
| `SESSION_ENCRYPTION_KEY` | Encrypt server-side session material |

Generate TIN/session keys with `openssl rand -hex 32` and location keys with `openssl rand -base64 32`. Follow validation errors for exact formats.

## Optional integrations

The template groups optional variables for object storage, maps, AI providers, Twilio, SendGrid, Sentry, feature flags, and operator-only certification tooling. Configure only integrations that are enabled. AWS credentials used by Rekognition or S3-compatible storage are service credentials; they do not imply AWS hosts the backend.

Database pool tuning is available through `DB_POOL_MAX`, `DB_REPLICA_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS`, and `DB_STATEMENT_TIMEOUT_MS`.
