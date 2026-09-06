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

`backend/src/config.ts` is the runtime authority. [`.env.template`](../.env.template) is the copyable backend-only host-diagnostics template; Railway variables are the production source of truth. Never commit a populated `.env` file. The repository's `docker-compose.yml` is an intentionally non-runnable pointer, not an environment definition. The sibling `hustlexp-platform` repository owns the complete synthetic local stack.

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

## Work Order actor-attestation role plan

Status: `AUTHORIZED_LOCAL_NONPROD_IMPLEMENTATION_PENDING /
RELEASE_BLOCKED_PENDING_IMPLEMENTATION_AND_INDEPENDENT_REVIEW`

Option A authorizes an isolated one-time attester design for synthetic local,
preview, and staging implementation only. It does not authorize setting any
variable on a persistent target, and the current runtime does not yet implement
or certify these bindings.

| Planned variable | Logical role | Required shape |
|---|---|---|
| `HX_WORK_ORDER_MIGRATION_DATABASE_ROLE` | Migrator | Pairwise-distinct one-shot login; never supplied to API, worker, or attester |
| `HX_WORK_ORDER_API_DATABASE_ROLE` | API | Login; command `EXECUTE` plus required reads only; no protected direct DML |
| `HX_WORK_ORDER_WORKER_DATABASE_ROLE` | Worker | Login; bounded worker/recovery `EXECUTE` plus required reads only; no protected direct DML |
| `HX_WORK_ORDER_ATTESTER_DATABASE_ROLE` | Attester | Login; sealed assertion issuance only; cannot consume assertions or execute Work Order commands |
| `HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE` | Command owner | Unprivileged `NOLOGIN` owner of sealed Work Order commands |
| `HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE` | Assertion owner | Unprivileged `NOLOGIN` owner of assertion relations and functions |
| `HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE` | Finance owner | Unprivileged `NOLOGIN` owner for the separately certified provider-neutral financial boundary |
| `HX_TELEMETRY_OWNER_DATABASE_ROLE` | Telemetry owner | Unprivileged `NOLOGIN` owner of the exact sealed major-action telemetry surface |

All eight configured identifiers must be pairwise distinct and have no
cross-membership or elevated PostgreSQL attributes. Each service continues to
receive its own secret-referenced connection string through its service-local
`DATABASE_URL`; role names are nonsecret identifiers and never substitute for
credentials or live role readback.

The assertion lifetime is database-owned and fixed at a maximum of 60 seconds;
there is deliberately no environment-variable override. Only the SHA-256 digest
of a random 256-bit opaque token may be persisted. Plaintext assertion tokens,
bearer tokens, and database passwords must never appear in source, manifests,
logs, health output, or agent prompts. See the
[actor-attestation decision packet](architecture/HUSTLEXP_V1A_ACTOR_ATTESTATION_DECISION_PACKET.md)
and machine-readable HOLD for the exact non-authorizing plan.

Production effects remain `NONE`; production payment creation and real hard
assignment remain `FROZEN`. Owner authorization of this design is not
independent security or release approval.

## Migration and synthetic-bootstrap inventory

The current dirty-local review registry contains exactly 144 migrations through
`20261010_universal_v1_financial_security_event_expiry_v1`; the migration directory
contains exactly 199 SQL files. Application startup remains
read-only: no environment variable may append, skip, reorder, or apply that
chain. The explicit migration role must still satisfy the signed-manifest and
environment-approval boundary above.

Local, preview, and staging fake-finance readiness requires exactly nine
ordered nonproduction fixtures, ending with
`20261010_universal_v1_fake_financial_expiry_v9`. That v9 fixture remains outside
the engine registry and may install only after the registered Financial Security
Event expiry contract and fake-finance v8 evidence exist. It binds raw fake-provider
observation and expiry to the canonical lifecycle fact and denies stale positive
security use; it does not block bounded void, refund, reversal, reconciliation,
or recovery. Its presence grants no refund, reversal, release, payout, provider
call, or real-money authority. Production
does not enable this synthetic bootstrap; `HX_PAYMENT_CREATION_MODE` remains
`frozen`, and configuration cannot turn either migration inventory into a
capability.

The migration-138 completion-notice lane is synthetic and nonproduction only.
`SMTP_URL` must select the isolated SMTP sink, and
`HX_COMPLETION_DELIVERY_SINK_ACTOR_ID` must be a UUID for the configured active,
adult, non-banned synthetic service actor; deployed-synthetic startup refuses a
missing or malformed actor. `HX_COMPLETION_DELIVERY_WEBHOOK_SECRET` authenticates
only the legacy migration-121 callback path. The migration-138 worker instead
binds its persisted `smtp_sink` receipt to the exact notice request and
materializes the canonical `SYNTHETIC_SINK` delivery fact. None of these
variables enables a live provider, assignment, payment, capture, settlement, or
payout.

Migration 139 adds no runtime enablement variable. Operations occurrence reads
must provide a bounded purpose and are returned only after the database rechecks
the named operator and appends the exact projection digest to immutable audit
evidence. This read-accountability seam grants no lifecycle or financial write.

Migration 140 adds no runtime enablement variable. It preserves rows and
receipts left by twelve retired Stage-1 migrations while removing their writer
and bypass authority, blocking row writes and truncation of contaminated
relations, restoring worker-only acceptance and payout gates, and failing
closed on a partial legacy task or quote shape. It enables no assignment,
provider call, payment, payout, deployment, or production effect. Production
money remains frozen, and no configuration value can reverse this containment.

Migration 141 adds no runtime enablement variable. It installs append-only
evidence for subscription-cancellation operations so a pending attempt,
provider failure, sticky `CANCELLATION_UNCERTAIN` state, and provider-confirmed
cancellation can be distinguished and recovered without fabricating success.
`CANCELLATION_UNCERTAIN` permits retry-only recovery; it is never confirmation
and never authority to clear the provider reference. Migration 141 grants
cancellation and recovery semantics only: no payment creation, capture,
settlement, payout, assignment, deployment, production, or other positive-money
capability.

Migration 142 adds no runtime enablement variable. It installs fail-closed
PostgreSQL containment so only an `OPEN`, unassigned, unbound Universal V1
controlled-test task may receive a Work Order, and then prevents the legacy
task state, worker, Work Order pointer, or row deletion from competing with
append-only Work Order execution facts. It grants no assignment, provider call,
payment, payout, deployment, production effect, role, or actor authority. On
`2026-08-31`, the complete verifier ran against disposable, loopback-only
PostgreSQL and emitted `HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 142` for the current
dirty local source. The earlier `HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 141` receipt
remains historical evidence for its predecessor bytes. Neither receipt grants
signed-candidate, hosted, staging, deployment, persistent-target, or production
authority.

Migration 143 adds no runtime enablement variable. It supplies standardized-quote
readiness truth without granting assignment, provider, financial, or production
authority.

Migration 144 adds no runtime enablement variable. It records provider-authored
expiry for successful Financial Security Events and denies stale positive
consumers using database-owned observation time while preserving bounded void,
refund, reversal, reconciliation, and recovery. Current 144-entry verifier proof
remains pending; the named 142-entry receipt above is historical predecessor
evidence and does not certify these bytes.

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
| `HX_PAYMENT_CREATION_MODE` | Must be `frozen` in every deployed environment | Explicit customer-money creation posture; never sufficient authority to enable an effect |
| `HX_HARD_ASSIGNMENT_MODE` | Must be `frozen` in every deployed environment | Independent provider-assignment posture; never sufficient authority to enable an effect |
| `REDIS_URL` | Canonical provider-neutral `redis://` or `rediss://` TCP connection for cache, rate limits, BullMQ, and realtime |
| `UPSTASH_REDIS_URL` | Legacy TCP alias accepted only when `REDIS_URL` is absent |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional legacy HTTP alternate; configure both or neither; never inferred from TCP variables and never overrides `REDIS_URL` |
| `QUEUE_HMAC_SECRET` | Required for signed queue payloads |

`REDIS_URL` is the portable path used by the local stack and isolated Railway
Redis. It takes precedence over `UPSTASH_REDIS_URL`. A `redis://` or `rediss://`
value is never passed to `@upstash/redis`, and the ambiguous `REDIS_TOKEN` name
is not accepted as a REST credential. Cache, rate-limit, AI-budget, flags,
messaging, and realtime-registry commands share one normalized port. Notification
acceptance and fixed-window frequency limits remain PostgreSQL-authoritative so
the accepted row and every delivery intent commit atomically. The only direct
`@upstash/redis` import is the reviewed legacy adapter.
It is selected only when no TCP URL exists; it is intentionally not runtime
failover, because switching Redis services after a command error would split
locks, counters, revocation markers, and rate windows. Local and staging do not
require this alternate.

`HX_PAYMENT_CREATION_MODE` must remain `frozen` in every deployed environment. The public recovery base historically accepted both `enabled` and `frozen`; this working recovery candidate no longer treats configuration alone as authority. Its payment-creation guard can return `enabled` only inside an isolated Vitest worker with `NODE_ENV=test`, `ENGINE_API_MODE=test`, `STRIPE_MODE=test`, and an `sk_test_` credential. A normal deployed process remains frozen even if every variable is spoofed. That test-only seam is not an enablement mechanism, signed release evidence, processor approval, or production customer-money authority.

`HX_HARD_ASSIGNMENT_MODE` is a separate deny-by-default control and must also remain `frozen` in every deployed environment. The local candidate permits its enabled result only in an isolated Vitest worker with `NODE_ENV=test`; production and ordinary development remain frozen even if the variable is set to `enabled`. Health exposes payment creation and hard assignment separately so one green posture cannot conceal the other. This local implementation does not prove the stale-provenance production runtime is enforcing the guard.

Direct legacy Task and `PENDING`-escrow materialization has no runtime enablement mechanism. Shipped code returns `LEGACY_TASK_MATERIALIZATION_FROZEN` in every environment, including processes that spoof test or Vitest metadata. Historical compatibility mechanics are characterized only through an explicit Vitest module mock under `backend/tests`; that test adapter is not imported by production code. Exact idempotent read-only replay and negative refund, void, reversal, dispute, and reconciliation paths remain available. New business flow must enter the Universal V1 TaskDraft-to-Work-Order lifecycle.

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

### Isolated fake-provider webhook verification

The v13 HTTP route `/webhooks/fake-financial` and `finance.ingestWebhook` use a
database-held verifier key. API, worker and actor-attester credentials cannot
read or provision this key. `HX_FAKE_FINANCIAL_WEBHOOK_SECRET` does not authenticate
these routes. Keep the isolated fake provider's signing key outside those runtimes.

Provision a randomly generated 32–128-byte key using the migration role and a
parameterized `INSERT` into `hx_authority.fake_financial_webhook_keys_v13`
(`key_id`, `target_authority_id`, `key_material`, `expires_at`). Commit provisioning
before accepting deliveries. Key IDs are UUIDs; the target must be the current
enrolled local, preview or staging database/release. Never place key bytes in SQL
migration source, shell arguments, logs or review manifests. The synthetic tests
provision disposable random keys in memory; a deployment provisioner and actual
staging custody remain release work.

The HTTP sender supplies `x-hustlexp-fake-finance-key-id` and a lowercase hex
`x-hustlexp-fake-finance-signature`; tRPC supplies `keyId`, `rawBody`, `signature`.
The signature is HMAC-SHA256 over the exact UTF-8 signing format exported by
`FakeFinancialWebhookAuthentication.ts`: the `HUSTLEXP_FAKE_FINANCIAL_WEBHOOK_V13`
domain, key UUID, target UUID, target version, database name, environment and
release-manifest digest, each terminated by one zero byte, followed by the exact
raw JSON bytes. The closed observation envelope and 16-KiB limit still apply.

Use READ COMMITTED transactions for ingestion. The database commits the immutable
observation, delivery receipt, verification provenance and pending processing row
together. An acknowledgement means durable receipt only; it does not mean a
financial operation completed. Exact active-key redelivery preserves original
receipt identities and times. Expired, revoked or superseded-target keys cannot
authenticate fresh deliveries or reauthenticate old ones. Stored historical
evidence remains immutable for separately authorized reconciliation.

Revoke a key by committing a parameterized `INSERT` of its `key_id` into
`hx_authority.fake_financial_webhook_key_revocations_v13` using the migration role.
Provision a new key ID for rotation. No production keys, live providers or
production value are enabled by this setup.

The template groups optional variables for object storage, maps, AI providers, Twilio, SendGrid, Sentry, feature flags, and operator-only certification tooling. Configure only integrations that are enabled. AWS credentials used by Rekognition or S3-compatible storage are service credentials; they do not imply AWS hosts the backend.

Database pool tuning is available through `DB_POOL_MAX`, `DB_REPLICA_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS`, and `DB_STATEMENT_TIMEOUT_MS`.
