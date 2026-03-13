# Environment Variables — Single Reference

**Source of truth:** `backend/src/config.ts` reads these. Copy `.env.template` to `.env` and fill in values.

**Last updated:** 2026-03-13

---

## Required (all environments)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (e.g. Neon). |

---

## Required in production

| Variable | Description |
|----------|-------------|
| `FIREBASE_PROJECT_ID` | Firebase project ID. |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin SDK private key (multiline; use `\n` in .env). |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin SDK client email. |
| `STRIPE_SECRET_KEY` | Stripe secret key (not a placeholder). |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (caching, rate limiting). |
| `UPSTASH_REDIS_URL` or `REDIS_URL` | Redis TCP URL for BullMQ job queues. |
| `TAX_TIN_ENCRYPTION_KEY` | 64 hex chars (32 bytes) for TIN encryption. Generate: `openssl rand -hex 32`. |
| `ALLOWED_ORIGINS` | Comma-separated HTTPS origins (no `*` in production). |

---

## Optional (services)

| Variable | Description |
|----------|-------------|
| **Stripe** | |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret. |
| `PLATFORM_FEE_PERCENT` | Default 15. |
| `MIN_TASK_VALUE_CENTS` | Default 500 ($5). |
| `STRIPE_PREMIUM_MONTHLY_PRICE_ID`, `STRIPE_PREMIUM_YEARLY_PRICE_ID` | Plan price IDs. |
| `STRIPE_PRO_*` | Same for Pro plan. |
| **Redis** | |
| `DB_PGBOUNCER` | Set to `true` if using PgBouncer. |
| **Firebase** | |
| `FIREBASE_WEB_API_KEY` | Firebase web API key. |
| **Storage (R2)** | |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | Cloudflare R2. |
| **Maps** | |
| `GOOGLE_MAPS_API_KEY` | Google Maps Platform. |
| **AI** | |
| `OPENAI_API_KEY`, `OPENAI_MODEL` (default gpt-4o) | OpenAI. |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | DeepSeek. |
| `GROQ_API_KEY`, `GROQ_MODEL` | Groq. |
| `ALIBABA_API_KEY`, `ALIBABA_MODEL` | Alibaba. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic. |
| `AI_ROUTE_PRIMARY`, `AI_ROUTE_FAST`, etc. | Model routing. |
| `AI_CACHE_TTL` | Cache TTL seconds. |
| **Identity** | |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` | Twilio SMS. |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` | SendGrid email. |
| **Beta** | |
| `BETA_ENABLED`, `BETA_START_DATE`, `BETA_END_DATE`, `STRIPE_FREE_PRICE_ID`, etc. | Seattle beta. |
| **Monitoring** | |
| `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE` | Sentry. |
| `DATADOG_ENABLED`, `DD_AGENT_HOST`, `DD_AGENT_PORT`, `DD_SERVICE`, `DD_ENV`, `DD_VERSION` | Datadog. |

---

## Application

| Variable | Default | Description |
|----------|--------|-------------|
| `PORT` | 3000 | Server port. |
| `NODE_ENV` | development | `development` or `production`. |
| `ALLOWED_ORIGINS` | (empty in dev) | Comma-separated CORS origins. |

---

## DB pool (optional)

| Variable | Default | Description |
|----------|--------|-------------|
| `DB_POOL_MAX` | 20 | Max pool size. |
| `DB_REPLICA_POOL_MAX` | 15 | Replica pool. |
| `DB_IDLE_TIMEOUT_MS` | 30000 | Idle timeout. |
| `DB_CONNECT_TIMEOUT_MS` | 10000 | Connect timeout. |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 | Statement timeout. |

---

**Template file:** Copy `.env.template` to `.env` and fill in. See `backend/src/config.ts` and `validateConfig()` for validation rules.
