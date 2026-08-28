# Environment variables

Status: `CURRENT_IMPLEMENTATION_REFERENCE / CONFIGURATION_IS_NOT_AUTHORITY`

Production launch: `NO-GO`

Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md). Configuration is never authority: a variable must not enable a capability blocked by underwriting, policy, Governor state, or an accepted containment gate. Current `main` does not prove this globally; known processor-account, onboarding-link, provider-payout, and insurance-claim payout lanes remain outside one accepted closed-capability boundary.

## Release provenance

Preview, staging, and production do not trust `HX_RELEASE_MANIFEST_JSON`, a Git
SHA variable, or a build argument by itself. The exact canonical manifest digest
must have detached Ed25519 evidence in
`HX_RELEASE_MANIFEST_SIGNATURE_JSON` (or the adjacent packaged `.sig` file), and
the signer public key must already be pinned in
`backend/src/releaseAuthorityKeys.ts`. Runtime configuration cannot add a key.
The build also measures the compiled `dist` tree at runtime and requires that
digest to equal the component artifact digest inside the signed manifest.

The pinned-key registry and production Railway target are deliberately
unenrolled during the production hold. Enrolling either requires a separately
reviewed protected source change. No private signing key belongs in a repository,
image, Railway variable, or agent prompt.

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
| `HX_RELEASE_MANIFEST_JSON` | Required in deployed lanes | Nonsecret exact manifest; never sufficient without pinned-key signature evidence |
| `HX_RELEASE_MANIFEST_SIGNATURE_JSON` | Required in deployed lanes | Detached Ed25519 signature envelope; contains no private key |
| `HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST` | Migration role only | Must equal the authenticated exact manifest digest; cannot replace its signature |
| `ALLOWED_ORIGINS` | Required in production | Comma-separated HTTPS website origins; wildcards are rejected |

## Public intake verification and privacy

| Variable | Requirement | Purpose |
|---|---|---|
| `TURNSTILE_SECRET_KEY` | Required for hosted public create traffic | Server-only Cloudflare verification secret; never expose it to the browser |
| `PUBLIC_INGRESS_IP_HASH_SALT` | Required in production | HMAC salt for privacy-preserving TaskDraft IP rate-limit keys |
| `TASK_DRAFT_RATE_LIMIT_PER_IP_HOUR` | Optional | Positive integer create limit; defaults to 20 |
| `TASK_DRAFT_LEGACY_IP_HASH_SALT` | Temporary cutover secret reference only | Recomputes legacy `SHA-256(ip + salt)` keys so the one-hour limit survives writer cutover; if recent legacy rows exist and this reference is absent, create fails closed |
| `HX_HUMAN_VERIFICATION_MODE`, `HX_HUMAN_VERIFICATION_URL`, `HX_HUMAN_VERIFICATION_SECRET` | Isolated nonproduction only | Deterministic synthetic verification for local, test, preview, and staging; production rejects this mode |

Never copy the legacy salt into source, a release manifest, a browser variable, or
an agent prompt. Remove the reference after the old writer is proven disabled and
the last legacy rate-limit window has elapsed.

## Authentication, legacy payment containment, and queues

| Variables | Requirement |
|---|---|
| `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` | Required for authenticated production traffic |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | Legacy/recovery and webhook compatibility in the current runtime; presence does not authorize new payment creation; webhook secrets must differ |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Required for distributed cache and rate limits |
| `UPSTASH_REDIS_URL` or `REDIS_URL` | Required for BullMQ workers |
| `QUEUE_HMAC_SECRET` | Required for signed queue payloads |

`HX_PAYMENT_CREATION_MODE` must remain `frozen` in every deployed environment. The public recovery base historically accepted both `enabled` and `frozen`; this working recovery candidate no longer treats configuration alone as authority. Its payment-creation guard can return `enabled` only inside an isolated Vitest worker with `NODE_ENV=test`, `ENGINE_API_MODE=test`, `STRIPE_MODE=test`, and an `sk_test_` credential. A normal deployed process remains frozen even if every variable is spoofed. That test-only seam is not an enablement mechanism, signed release evidence, processor approval, or production customer-money authority.

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
