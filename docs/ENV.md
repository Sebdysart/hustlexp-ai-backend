# Environment variables

Status: `CURRENT_IMPLEMENTATION_REFERENCE / CONFIGURATION_IS_NOT_AUTHORITY`

Production launch: `NO-GO`

Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md). Configuration is never authority: a variable must not enable a capability blocked by underwriting, policy, Governor state, or an accepted containment gate. Current `main` does not prove this globally; known processor-account, onboarding-link, provider-payout, and insurance-claim payout lanes remain outside one accepted closed-capability boundary.

`backend/src/config.ts` is the runtime authority. [`.env.template`](../.env.template) is the copyable local-development template; Railway variables are the production source of truth. Never commit a populated `.env` file.

Classification-only production inspection on `2026-08-25` found `NODE_ENV=production`, `HX_PAYMENT_CREATION_MODE=frozen`, `STRIPE_MODE=live`, live-classified Stripe secret and publishable keys present, `OPS_ADMIN_KEY` present, and `KILL_SWITCH=false`; no runtime use of `KILL_SWITCH` was found. Secret values were not read or recorded. Stale `HX_BUILD_REVISION`, `HX_BUILD_TIMESTAMP`, and `HX_BUILD_SOURCE_CLEAN` values cause `/health` to report revision `140ce19…` while Railway metadata identifies deployed source `ab4a76…`; those variables are not trustworthy release evidence.

## Core runtime

| Variable | Requirement | Purpose |
|---|---|---|
| `DATABASE_URL` | Required | Railway PostgreSQL connection string |
| `DATABASE_REPLICA_URL` | Optional | Read-only replica connection string |
| `PORT` | Optional | API port; Railway supplies this in production |
| `WORKER_PORT` | Optional | Separate worker health port |
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

`HX_PAYMENT_CREATION_MODE` must remain `frozen`. Current `main` accepts both `enabled` and `frozen`, and the payment-creation guard returns enabled when explicitly configured; that is a blocking containment defect, not an enablement mechanism. A repaired exact candidate must make production creation structurally impossible regardless of environment configuration. `STRIPE_MODE=test`, `HX_STRIPE_STUB`, sandbox keys, or test receipts do not authorize a live processor adapter or production customer-money effects.

Do not place `OPS_ADMIN_KEY`, another human shared credential, or a caller-supplied actor identity in browser-exposed variables. The target Operations boundary uses named short-lived sessions and server-side capability checks.

The observed production presence of `OPS_ADMIN_KEY` is a blocking legacy condition, not an approved server-side authority. `KILL_SWITCH=false` is also not containment when no runtime consumer enforces it.

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
