# Redis Usage — Analysis & Current State

**Last updated:** 2026-03-13

---

## 1. Overview

The project uses **two Redis connection modes** (both can point at the same Upstash instance):

| Mode | Env vars | Client | Used for |
|------|----------|--------|----------|
| **REST API** | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | `@upstash/redis` | Caching, rate limiting, auth cache, feature flags, AI budget, connection registry, pub/sub (connection registry only) |
| **Direct TCP** | `UPSTASH_REDIS_URL` or `REDIS_URL` | `ioredis` | BullMQ job queues, Redis Pub/Sub (SSE fanout) |

**Config:** `backend/src/config.ts` — `config.redis.restUrl`, `config.redis.restToken`, `config.redis.url`.

**Production:** `validateConfig()` requires both REST and TCP Redis in production.

---

## 2. REST API usage (Upstash REST)

### 2.1 Shared client — `backend/src/cache/redis.ts`

- **Singleton:** One `@upstash/redis` client from `restUrl` + `restToken`.
- **If missing:** Client is `null`; all helpers return null/empty/fail-closed in prod (rate limit denies).
- **Exports:** `redis` (get/set/del/exists/incr/expire/zadd/zrange/zrevrange), `checkRateLimit`, `CACHE_KEYS`, `CACHE_TTL`, `Ratelimit` (sliding window).

**Used by:**

- **Auth** (`auth/middleware.ts`) — Session cache by token (`session:${token}`), revocation key `auth:revoked:${uid}`. TTL 5 min; reduces Firebase verification calls.
- **Security** (`middleware/security.ts`) — Per-category rate limits (AI, auth, escrow, financial, mutation, task, general) via `checkRateLimit`.
- **AIClient** (`services/AIClient.ts`) — AI response cache by hash; TTL from `CACHE_TTL.aiCache`.
- **GeocodingService** — Geocode result cache (address → lat/lng, reverse); long TTL (e.g. 30 days).
- **CapabilityProfileService** — Uses cache layer (query-cache or redis) for profile data.

### 2.2 NotificationService — `backend/src/services/NotificationService.ts`

- **Own client:** Lazy `getNotifRedis()` from `restUrl`/`restToken`.
- **Use:** Notification frequency caps (hourly/daily per user per category) via `incr` + `expire`.
- **If missing:** Returns `{ hourlyCount: 0, dailyCount: 0 }` (no cap).

### 2.3 AI budget / rate limit

- **UserAIBudget** (`ai/UserAIBudget.ts`) — Per-user and global daily spend; `get`/`incrby`/`expire`. Requires REST; throws if not configured.
- **AIRouter** (`ai/AIRouter.ts`) — Same pattern for cost tracking; requires REST for “Redis not configured” path.
- **ai-guard** (`middleware/ai-guard.ts`) — Daily AI cost tracking with `incrbyfloat`; fallback to in-memory if Redis unavailable.

### 2.4 Connection registry — `backend/src/cache/connection-registry-redis.ts`

- **Own client:** New `Redis({ url: config.redis.restUrl, token: config.redis.restToken })` at load.
- **Use:** SSE connection registry (multi-instance): connection metadata, user→connections, instance→connections, presence, broadcast channel, outbox list.
- **If missing:** Module load will likely fail (empty url/token to Upstash client).

### 2.5 FlagsService — `backend/src/services/FlagsService.ts`

- **Own client:** Lazy `getRedis()` from REST; caches evaluated flags with 60s TTL (`ff:${flagId}:${userId}`).
- **If missing:** Cache skipped; flags evaluated from DB every time.

---

## 3. Direct TCP usage (ioredis)

### 3.1 BullMQ — `backend/src/jobs/queues.ts`

- **Connection:** `createRedisConnection()` using `config.redis.url` (ioredis). TLS for `upstash.io`.
- **If missing:** Throws at first queue/worker creation: “Redis configuration missing (UPSTASH_REDIS_URL or REDIS_URL required for BullMQ)”.
- **Queues:** `critical_payments`, `critical_trust`, `user_notifications`, `exports`, `maintenance`, `tax_reporting`.
- **Workers:** Started in `workers.ts`; each worker gets its own connection from `createRedisConnection()`.

### 3.2 Redis Pub/Sub — `backend/src/realtime/redis-pubsub.ts`

- **Connections:** Lazy `getPublisher()` and `getSubscriber()` from `config.redis.url` (ioredis).
- **Use:** Cross-instance SSE: publish to task/user rooms; subscriber receives and dispatches to local connections.
- **If missing:** Throws “HX004: Redis URL not configured for pub/sub” when first used. SSE handler calls `initializePubSub()` on load and logs on failure.

---

## 4. Current state summary

| Area | REST required? | TCP required? | If REST missing | If TCP missing |
|------|----------------|---------------|-----------------|----------------|
| Auth session cache | Yes (recommended) | No | Every request hits Firebase | N/A |
| Rate limiting | Yes (prod) | No | Fail-closed in prod | N/A |
| Feature flags cache | No | No | DB every time | N/A |
| Notification frequency | No | No | No caps | N/A |
| AI budget / cost | Yes (for tracking) | No | In-memory fallback in ai-guard; others can throw | N/A |
| Geocoding cache | No | No | No cache | N/A |
| Connection registry | Yes (if used) | No | Registry init can fail | N/A |
| BullMQ workers | No | **Yes** | N/A | Workers/queues throw |
| SSE pub/sub | No | **Yes** | N/A | SSE cross-instance broken; init can throw |

---

## 5. Environment variables (reference)

| Variable | Purpose |
|----------|---------|
| `UPSTASH_REDIS_REST_URL` | Upstash REST endpoint (caching, rate limit, auth, flags, AI budget, connection registry). |
| `UPSTASH_REDIS_REST_TOKEN` | Token for REST API (not used for TCP). |
| `UPSTASH_REDIS_URL` or `REDIS_URL` | Redis TCP URL for BullMQ and redis-pubsub (ioredis). Must use the **direct connection URL** from the Upstash dashboard (not the REST URL or REST token). Format: `rediss://default:<password>@<endpoint>.upstash.io:6379`. |

**WRONGPASS:** If you see `WRONGPASS invalid username-password pair`, the TCP URL password is wrong. In Upstash: use the **Redis URL** (or **.NET, Go, etc.** connection string) from the database’s “Direct” / “TCP” section — do not paste the REST API token into the TCP URL.
See `docs/ENV.md` for full list.

---

## 6. Health and startup

- **Server startup** (`server.ts`): Logs `configStatus.redis: !!config.redis.url` (only TCP URL; REST not reflected).
- **Health router** (`routers/health.ts`): `services.redis.configured` is `!!config.redis.url` (TCP only).
- **Shutdown** (`lib/shutdown.ts`): Can register `redis: { quit: () => Promise<void> }[]` for graceful close (BullMQ workers close their own connections).

---

## 7. Recommendations

1. **Production:** Set both REST and TCP Redis (same Upstash DB is fine). Required by `validateConfig()` for production.
2. **Health:** Optionally extend health/status to report REST Redis (e.g. ping or “configured”) so both modes are visible.
3. **Connection registry:** If you run a single instance and don’t need SSE across instances, you could make the connection registry optional and fall back to in-memory; currently it creates an Upstash client at load.
4. **Doc:** Point README or ENV.md to this file for “how Redis is used” and which vars are required when.
