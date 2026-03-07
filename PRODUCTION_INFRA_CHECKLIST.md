# HustleXP Production Infrastructure Checklist

> **Purpose:** Actionable pre-launch checklist covering every layer of the HustleXP production stack.
> Check each item before opening private beta to real users.
>
> **Stack:** Node.js / Hono / tRPC · PostgreSQL (Neon) · BullMQ (Redis/Upstash) · Stripe Connect · Firebase Auth · Cloudflare R2 · FCM · OpenAI · Sentry
>
> **Last updated:** 2026-03-07

---

## 1. Environment & Secrets

- [ ] **DATABASE_URL** is set to the production Neon connection string (not a local or staging URL).
  Verify with: `echo $DATABASE_URL | grep -v localhost`

- [ ] **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** are production Upstash credentials.
  Used by rate limiting and feed cache via `@upstash/redis`. Missing → all origins allowed + caching disabled.

- [ ] **UPSTASH_REDIS_URL** (or **REDIS_URL**) is set to the direct TCP Redis connection string.
  Used by BullMQ workers (`ioredis`). Format: `redis://default:{password}@{endpoint}:6379`

- [ ] **STRIPE_SECRET_KEY** is a live-mode key (`sk_live_...`), not a test key (`sk_test_...`).
  The server's `validateConfig()` rejects placeholder values at startup.

- [ ] **STRIPE_WEBHOOK_SECRET** is copied from the Stripe Dashboard for the production webhook endpoint (`whsec_...`).
  Without this, all webhook events are rejected as unverified.

- [ ] **STRIPE_PREMIUM_MONTHLY_PRICE_ID**, **STRIPE_PREMIUM_YEARLY_PRICE_ID**, **STRIPE_PRO_MONTHLY_PRICE_ID**, **STRIPE_PRO_YEARLY_PRICE_ID** are live Stripe Price IDs.

- [ ] **FIREBASE_PROJECT_ID**, **FIREBASE_PRIVATE_KEY**, **FIREBASE_CLIENT_EMAIL** are from the production Firebase service account (not the dev project).
  All three are required in production (`validateConfig()` hard-errors on any missing).

- [ ] **OPENAI_API_KEY** is set. Missing → AI safety layer disabled (warning on startup, does not block).

- [ ] **GROQ_API_KEY** is set. Missing → fast inference disabled.

- [ ] **DEEPSEEK_API_KEY** is set. Missing → reasoning model disabled.

- [ ] **ANTHROPIC_API_KEY** is set. Missing → safety model fallback disabled.

- [ ] **R2_ACCOUNT_ID**, **R2_ACCESS_KEY_ID**, **R2_SECRET_ACCESS_KEY**, **R2_BUCKET_NAME** are set to production Cloudflare R2 credentials.
  Missing → photo upload and proof submission fails.

- [ ] **SENTRY_DSN** is set to the production Sentry project DSN.
  Without it, the server prints `[sentry] Sentry DSN not configured` and error tracking is disabled.

- [ ] **TAX_TIN_ENCRYPTION_KEY** is a 64-character hex string (32 bytes, AES-256-GCM).
  Generate with: `openssl rand -hex 32`. This is a hard error in production — server will not start without it.

- [ ] **ALLOWED_ORIGINS** is set to the exact iOS app deep-link origin and any web clients.
  Example: `https://app.hustlexp.com`. The server process-exits in production if this is empty or contains `*`.

- [ ] **NODE_ENV=production** is explicitly set. This activates all production validation paths in `validateConfig()` and `validateEnv()`.

- [ ] **SENDGRID_API_KEY** and **SENDGRID_FROM_EMAIL** are configured. Missing → email notifications silently fail.

- [ ] **TWILIO_ACCOUNT_SID**, **TWILIO_AUTH_TOKEN**, **TWILIO_VERIFY_SERVICE_SID** are set for phone verification.

- [ ] **GOOGLE_MAPS_API_KEY** is set for geocoding / geofence queries.

- [ ] **CHECKR_API_KEY** is set (when Checkr account is authorized — currently deferred to B3).

- [ ] No secrets are hardcoded in source files. Scan with:
  `git grep -n 'sk_live_\|sk_test_\|whsec_\|AIza\|AKIA' -- '*.ts' '*.js' '*.json'`
  (Zero matches expected.)

- [ ] `AppConfig.swift` in the iOS app does NOT contain `REPLACE_WITH_LIVE_PUBLISHABLE_KEY`.
  The production Stripe publishable key (`pk_live_...`) must be set before App Store submission.

---

## 2. Database

- [ ] **All migrations applied** to the production database.
  Run: `node migrate-pg.mjs` against the production `DATABASE_URL`.
  The health router's `verifySchema` procedure checks for 33 tables, 19 triggers, and 3 views — run it post-deploy.

- [ ] **Connection pool tuned** via environment variables:
  - `DB_POOL_MAX` — max simultaneous connections (default: 20; increase if traffic justifies).
  - `DB_IDLE_TIMEOUT_MS` — idle connection eviction (default: 30000 ms).
  - `DB_CONNECT_TIMEOUT_MS` — timeout acquiring a connection (default: 10000 ms).
  - `DB_STATEMENT_TIMEOUT_MS` — per-query hard limit (default: 30000 ms).

- [ ] **Database backups** are configured for at minimum daily snapshots.
  Neon has point-in-time restore (PITR) — verify it is enabled on the production project.

- [ ] **Indexes on the tasks table** are present for discovery queries.
  Confirm with: `SELECT indexname FROM pg_indexes WHERE tablename = 'tasks';`
  At minimum: `(status, created_at)`, `(poster_id)`, `(assigned_to)`, geospatial index if used.

- [ ] **SSL/TLS** is enforced for the database connection string.
  Neon connection strings include `sslmode=require` by default — do not strip it.

- [ ] **`DB_PGBOUNCER=true`** is set if connecting through PgBouncer (Neon serverless driver requires this for transaction pooling).

- [ ] **Escrow financial triggers** are in place and verified:
  Run `GET /trpc/health.verifySchema` and confirm `triggers.missing` is an empty array.
  Critical triggers: `escrow_terminal_guard`, `xp_requires_released_escrow`, `xp_ledger_no_delete`, `prevent_double_release`.

---

## 3. Redis / BullMQ

- [ ] **Redis persistence** is enabled.
  For Upstash: persistence is on by default.
  For self-hosted Redis: verify AOF (`appendonly yes`) or RDB snapshots (`save 900 1`) in `redis.conf`.

- [ ] **`maxmemory-policy`** is configured appropriately:
  - Cache instance: `allkeys-lru` (evict oldest keys when full).
  - Queue/BullMQ instance: `noeviction` (never evict — a lost job is a lost payment).
  If using a single Redis instance for both, use `noeviction` and size the instance to handle combined load.

- [ ] **BullMQ failed job retention** is configured so failed jobs are inspectable.
  Default retention in this codebase: verify `removeOnFail` settings in `backend/src/jobs/workers.ts`.

- [ ] **Redis memory** is sized for the expected queue depth plus cache.
  Alert threshold: 80% used memory (see Monitoring section).

- [ ] **BullMQ queue workers** are running and healthy.
  Workers started in `backend/src/jobs/workers.ts` include: payment-worker, stripe-event-worker, ai-worker, push-worker.
  Confirm all four queues are active after deploy.

---

## 4. Application Server

- [ ] **Process manager** is configured with auto-restart on crash.
  Options: PM2 (`pm2 start ecosystem.config.js`), systemd service unit, or Dockerfile CMD with restart policy.
  The `Procfile` in the repo root defines the web process command.

- [ ] **Cluster mode** is enabled to utilize all CPU cores.
  PM2 example: `instances: 'max'` in `ecosystem.config.js`.
  With Hono on Node, each worker handles concurrent requests independently.

- [ ] **Graceful shutdown** is wired and verified.
  `server.ts` registers `process.on('SIGTERM', gracefulShutdown)` and `process.on('SIGINT', gracefulShutdown)`.
  Test: send SIGTERM to the process and confirm in-flight requests complete before the process exits.

- [ ] **Health endpoints** respond correctly in production:
  - `GET /health` — should return `{ status: 'ok' }` (via `healthRouter.ping`).
  - `GET /trpc/health.status` — should return `{ status: 'healthy' }` with all services connected.

- [ ] **Server listens on `PORT`** from the environment (default 3000).
  The reverse proxy or load balancer must forward to this port.

- [ ] **HTTPS/TLS termination** is configured at the reverse proxy (nginx, Caddy) or load balancer layer.
  The server itself listens on plain HTTP internally; TLS is terminated upstream.
  HSTS header (`Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`) is set automatically in non-development mode by `securityHeaders` middleware.

- [ ] **Body size limits** are in place.
  Verify `bodyLimit` middleware in `server.ts` is set to a sensible maximum (e.g., 10 MB for photo uploads, 1 MB for JSON payloads).

- [ ] **Response compression** is enabled.
  `compress()` middleware from `hono/compress` is imported in `server.ts` — confirm it is active.

---

## 5. Security

- [ ] **Security headers** are applied to every response.
  The `securityHeaders` middleware in `backend/src/middleware/security.ts` sets:
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `Content-Security-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`.
  Verify with: `curl -I https://api.hustlexp.com/health` and inspect response headers.

- [ ] **CORS** is configured for production iOS app domains only.
  `ALLOWED_ORIGINS` must not include `*` or any `http://` origin (server hard-fails on these in production).

- [ ] **Rate limiting** is Redis-backed, not in-memory.
  `rateLimitMiddleware` in `backend/src/middleware/security.ts` uses `checkRateLimit` from `cache/redis`.
  Confirm `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set (otherwise rate limit checks are no-ops).

- [ ] **Stripe webhook signature verification** is active.
  The `/webhooks/stripe` handler in `server.ts` must call `stripe.webhooks.constructEvent()` before processing.
  This requires `STRIPE_WEBHOOK_SECRET` to be set.

- [ ] **Firebase token verification** is enforced on all authenticated tRPC procedures.
  Procedures using `protectedProcedure` or `adminProcedure` in `backend/src/trpc.ts` verify the Firebase ID token from the `Authorization` header.

- [ ] **No debug or admin endpoints exposed without auth**.
  Routes under `/trpc/admin.*` must use `adminProcedure`. Verify no `publicProcedure` is used on sensitive operations.

- [ ] **Request ID logging** is active.
  `requestIdMiddleware` in `backend/src/middleware/request-id.ts` attaches a UUID to every request and logs it. Confirm in production logs.

- [ ] **Input validation** (Zod) is present on all mutation procedures.
  Run `grep -rn 'publicProcedure.mutation\|protectedProcedure.mutation' backend/src/routers/` and verify each has `.input(z.object(...))`.

- [ ] **Circuit breakers** wrap all external API calls (Stripe, Firebase, OpenAI, R2, FCM).
  Check `backend/src/middleware/circuit-breaker.ts` is imported and used by services that call external APIs.

- [ ] **Prompt injection guard** is active for AI endpoints.
  `PromptInjectionGuard` in `src/ai/PromptInjectionGuard.ts` and `ai-guard.ts` middleware must be wired on all `/trpc/ai.*` routes.

---

## 6. Monitoring & Alerting

- [ ] **Sentry DSN** is configured for the production project (not the dev DSN).
  Set `SENTRY_DSN` and confirm `SENTRY_TRACES_SAMPLE_RATE` is appropriate (0.1 = 10% for production).

- [ ] **Sentry environment** is set to `'production'`.
  `config.sentry.environment` defaults to `process.env.NODE_ENV` — set `NODE_ENV=production`.

- [ ] **Uptime monitoring** is configured.
  Set up UptimeRobot, Better Uptime, or equivalent to ping `GET /health` every 60 seconds.
  Alert via PagerDuty/SMS/email on 2+ consecutive failures.

- [ ] **Alerts configured** for the following conditions:
  - Error rate spike: > 1% 5xx responses over a 5-minute window.
  - p99 latency > 2000 ms.
  - Health check failure: `/health` returns non-200 or times out.
  - Database connection pool exhaustion: all `DB_POOL_MAX` connections in use.
  - Redis memory > 80% of `maxmemory`.
  - BullMQ failed job queue depth > 10 (indicates payment or notification failures).

- [ ] **Log aggregation** is configured.
  The backend uses `pino` for structured JSON logging. Ship logs to Logtail, Papertrail, Datadog, or similar.
  Set `DD_AGENT_HOST`, `DD_SERVICE`, `DD_ENV` if using Datadog (`DATADOG_ENABLED=true`).

- [ ] **OpenTelemetry traces** are exported to a backend (optional but recommended).
  Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export traces; omit to fall back to console logging only.

- [ ] **HTTP metrics endpoint** is accessible for internal scraping.
  `createMetricsEndpoint` in `backend/src/monitoring/metrics.ts` exposes a Prometheus-compatible metrics endpoint.
  Ensure it is not publicly accessible (restrict at the reverse proxy level).

- [ ] **Dashboard** created with key metrics:
  - Request rate and error rate (5xx / 4xx).
  - p50 / p95 / p99 response times.
  - Active BullMQ job counts per queue.
  - Database pool utilization.
  - Redis memory usage.
  - Stripe webhook event lag.

---

## 7. Stripe Production Setup

- [ ] **Stripe account is in live mode** (not test mode).
  Dashboard: check the toggle in the top-left of the Stripe Dashboard.

- [ ] **Stripe Connect platform configuration** is verified.
  Platform profile, branding, and supported capabilities (transfers, card_payments) are enabled for connected accounts.

- [ ] **Webhook endpoint registered** in Stripe Dashboard for the production URL:
  `https://api.hustlexp.com/webhooks/stripe`
  Subscribe to the following events (all handled by `stripe-event-worker` and `payment-worker`):
  - `payment_intent.succeeded`
  - `transfer.created`
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`
  - `account.updated`
  - `capability.updated` (for KYC / payouts_enabled state changes)
  - `payout.failed` (for alerting on failed hustler payouts)
  - `charge.dispute.created` (for fraud alerting)

- [ ] **Stripe Tax** is configured for 1099-NEC reporting.
  `TaxReportingService.generate1099Form()` uses the Stripe Tax Forms API.
  Verify `stripe.tax.calculations.create` is accessible with the live key.

- [ ] **Payout schedule** is configured for the platform account.
  Recommended: daily automatic payouts to the platform bank account.
  Hustler payouts are triggered on-demand via Stripe Connect transfers.

- [ ] **Stripe Radar rules** reviewed.
  Review default fraud rules in the Stripe Dashboard → Radar section.
  Consider adding rules to block cards from high-risk countries if not in the service area.

- [ ] **Platform fee percentage** is correct.
  `PLATFORM_FEE_PERCENT` defaults to 15 (per PRODUCT_SPEC §9). Confirm this is intentional.

- [ ] **Minimum task value** is correct.
  `MIN_TASK_VALUE_CENTS` defaults to 500 ($5.00). Confirm.

- [ ] **KYC gate is verified end-to-end**.
  `EscrowService.release()` validates `payouts_enabled` and `stripe_connect_id` before releasing funds.
  Test with a connected account that has not completed KYC — release should be blocked.

---

## 8. Firebase Production

- [ ] **Firebase project** used is the production project (not the `*-dev` or `*-staging` project).
  Confirm `FIREBASE_PROJECT_ID` matches the production Firebase console URL.

- [ ] **FCM server key** is configured.
  `PushNotificationService` in `backend/src/services/PushNotificationService.ts` uses the Firebase Admin SDK.
  The service account credentials (`FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`) authorize FCM sends.

- [ ] **APNs certificate** uploaded to Firebase for iOS push notifications.
  Firebase Console → Project Settings → Cloud Messaging → Apple app configuration.
  Upload the APNs Authentication Key (`.p8`) or APNs Certificate.

- [ ] **Firebase App Check** enabled to prevent API abuse from unofficial clients.
  Firebase Console → App Check → Enable for Auth and Firestore (if used).
  Requires client-side SDK integration in the iOS app.

- [ ] **Firebase Auth** production app configured.
  Verify authorized domains include the production backend URL.
  Verify sign-in methods (phone, email, etc.) are enabled in the production project.

- [ ] **Firebase service account key** is stored as an environment variable, not committed to git.
  Confirm with: `git log --all --full-history -- '*service-account*.json'` (zero results expected).

---

## 9. Cloudflare R2

- [ ] **Production R2 bucket** created with name matching `R2_BUCKET_NAME`.
  Do not reuse the development bucket for production data.

- [ ] **R2 access credentials** are separate from development credentials.
  Create a dedicated API token in the Cloudflare dashboard with read/write access to the production bucket only.

- [ ] **CORS policy** on the R2 bucket allows uploads from the iOS app origin.
  Set via Cloudflare API or dashboard. Example allowed origin: `https://app.hustlexp.com`.
  Required for presigned URL-based direct uploads from the iOS client.

- [ ] **Lifecycle policy** configured to expire orphaned photo objects (optional).
  Recommended: expire objects with prefix `temp/` after 24 hours if not referenced by a proof record.

- [ ] **Public access** is restricted.
  Bucket should NOT be publicly readable. Access is via presigned URLs generated by the backend.

---

## 10. iOS App Production Config

- [ ] **Production backend URL** is set in `AppConfig.swift`.
  `#if DEBUG` block should point to localhost; Release should point to `https://api.hustlexp.com`.

- [ ] **Production Stripe publishable key** is set in `AppConfig.swift`.
  The placeholder `REPLACE_WITH_LIVE_PUBLISHABLE_KEY` must be replaced with `pk_live_...` before App Store submission.

- [ ] **SSL pinning** is enabled for Release builds.
  `AppConfig.swift` has an `sslPinningEnabled` flag. Confirm it is `true` for non-debug builds.

- [ ] **Debug logging** is disabled in Release builds.
  Confirm that verbose logging (network request/response bodies, user data) is gated behind `#if DEBUG`.

- [ ] **Analytics / crash reporting** is configured for the production app.
  Confirm Firebase Crashlytics (or equivalent) is initialized with the production `GoogleService-Info.plist`.

- [ ] **App icons and launch screen** pass App Store review guidelines.
  No placeholder assets, no references to third-party IP without permission.

- [ ] **TestFlight build** is installed and manually tested against the production backend before launch.

---

## 11. Legal & Compliance

- [ ] **Privacy Policy** is published at the URL referenced in the iOS app and on the App Store listing.
  Must cover: data collected, how it is used, third-party services (Stripe, Firebase, OpenAI, Checkr when active).

- [ ] **Terms of Service** are published and linked from the app.
  Must cover: user eligibility, platform fees, payment terms, prohibited conduct, dispute resolution.

- [ ] **App Store review guidelines compliance** verified.
  In-app payments handled via Stripe Connect (B2B / gig economy) are permitted without using IAP.
  Confirm with Apple's guidelines for marketplace apps if necessary.

- [ ] **CCPA / data deletion flow** is tested end-to-end.
  `gdpr.ts` router exposes `requestDeletion`. Verify it correctly queues a deletion job and the job processes.

- [ ] **1099-NEC reporting workflow** is verified.
  `TaxReportingService.generate1099Form()` is callable and integrates with Stripe Tax Forms API.
  Threshold notification at $600 annualized earnings is tested.
  Verify `TAX_TIN_ENCRYPTION_KEY` produces correctly encrypted/decryptable TIN values.

- [ ] **Data retention policy** is defined.
  Confirm the lifecycle of: user accounts, task records, escrow records, AI event logs, proof photos.

---

## 12. Load Testing & Performance

- [ ] **Load test** executed with the expected private beta user count (100 concurrent users, per `maxUsers` beta config).
  Recommended tool: `k6`, `artillery`, or `wrk`.
  Baseline targets: p95 < 500 ms, p99 < 2000 ms, zero 5xx under normal load.

- [ ] **Database query performance** verified under load.
  Run `EXPLAIN ANALYZE` on the task discovery query (`FeedQueryService`) with realistic data volumes.
  Confirm the geospatial and status index is used (no sequential scans on large tables).

- [ ] **BullMQ queue capacity** verified.
  Simulate burst: queue 100 payment events simultaneously and verify all jobs complete without failures.
  Confirm workers drain the queue within an acceptable time window (< 30 seconds for payment jobs).

- [ ] **CDN configured** for any static assets served by the backend.
  If serving admin dashboard assets from `public/`, put Cloudflare or a CDN in front.

- [ ] **AI degraded mode** tested.
  Set `AI_DEGRADED_MODE=true` and confirm AI requests are queued (not dropped) and the app degrades gracefully.

---

## 13. Incident Response

- [ ] **Runbook created** for common failure scenarios:
  - **Database unavailable**: `GET /trpc/health.status` returns degraded. Action: check Neon status page, verify `DATABASE_URL`, check connection pool metrics.
  - **Redis unavailable**: Rate limiting and caching disabled (app continues in degraded mode). BullMQ workers may fail to enqueue. Action: check Upstash status, restart workers.
  - **Stripe webhook failure**: Events pile up unprocessed. Action: check `STRIPE_WEBHOOK_SECRET`, verify endpoint URL in Stripe Dashboard, replay events from Stripe Dashboard.
  - **BullMQ worker crash**: Payment jobs stop processing. Action: restart workers via PM2 (`pm2 restart all`), check failed job queue in BullMQ dashboard.
  - **Firebase Auth outage**: All authenticated requests fail with 401. Action: enable public read-only degraded mode if applicable, check Firebase status page.

- [ ] **Rollback procedure** documented:
  1. Identify the bad commit SHA.
  2. Deploy the previous Docker image tag (or re-deploy the previous git SHA via CI).
  3. If migration was applied: restore from the last Neon PITR snapshot.
  4. Replay any Stripe webhook events that arrived during the outage via Stripe Dashboard.

- [ ] **Kill switch** is functional.
  `KillSwitch.ts` in `src/infra/KillSwitch.ts` provides an emergency circuit breaker.
  Test that activating the kill switch correctly blocks the target functionality.

- [ ] **On-call contact** is defined.
  Designate who is the first responder for production incidents and how they are paged (PagerDuty, SMS, Slack alert).

- [ ] **Incident severity levels** are defined:
  - **SEV-1**: Financial data loss, all users unable to complete payments, database down.
  - **SEV-2**: Partial feature outage (e.g., push notifications down, AI features down).
  - **SEV-3**: Degraded performance, elevated error rate but core flow working.

---

## 14. Pre-Launch Final Checks

- [ ] **All 8 P0 blockers** from the Private Beta Spec are resolved:
  - G1.4: TaskDetailScreen present in iOS app.
  - G1.5: R2 photo upload wired in ProofSubmission.
  - G2.4: Applicant accept/reject UI wired to backend endpoints.
  - G2.5: Task monitoring connected to SSE stream.
  - G2.6: Proof review UI wired to review endpoints.
  - G3.3: Photo messaging end-to-end functional.
  - I3.2: iOS photo upload to R2 implemented.
  - I4.2: FCM token registration wired in iOS app on launch.

- [ ] **Private beta scorecard** is at 95+ (B1=100%, INV=100%, B2≥80%).
  Read `hustlexp-docs/private-beta/scorecard.json` and confirm all B1 gates are green.

- [ ] **Smoke test** executed against the production environment (not staging):
  1. Create a user account via Firebase Auth.
  2. Complete Stripe Connect onboarding as a Hustler.
  3. Post a task as a Poster, fund escrow.
  4. Apply as Hustler, get accepted.
  5. Submit proof with photo.
  6. Poster approves proof.
  7. Verify escrow releases, Hustler receives transfer, XP is awarded.

- [ ] **App Store submission requirements** met:
  - All required metadata (description, screenshots, keywords) submitted.
  - Age rating set appropriately.
  - Privacy nutrition labels completed.
  - App Review notes provided explaining the gig marketplace payment flow.

- [ ] **Stripe account review** completed.
  For platforms processing real money, Stripe may request business verification documents.
  Confirm the Stripe account is fully verified and not restricted.

- [ ] **Beta user onboarding flow** tested end-to-end with a real device on production.
  Includes: account creation, profile setup, geofence verification (Seattle Metro bounds), and first task.

- [ ] **Team briefed on launch day procedures**:
  - Who monitors Sentry and uptime alerts.
  - Who handles Stripe disputes.
  - Communication channel for users reporting issues.
  - Escalation path for SEV-1 incidents.

---

## Sign-Off

| Category | Owner | Status | Date |
|---|---|---|---|
| Environment & Secrets | | | |
| Database | | | |
| Redis / BullMQ | | | |
| Application Server | | | |
| Security | | | |
| Monitoring & Alerting | | | |
| Stripe Production Setup | | | |
| Firebase Production | | | |
| Cloudflare R2 | | | |
| iOS App Production Config | | | |
| Legal & Compliance | | | |
| Load Testing & Performance | | | |
| Incident Response | | | |
| Pre-Launch Final Checks | | | |
