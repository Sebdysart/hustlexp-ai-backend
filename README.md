# HustleXP Backend

HustleXP is a **gamified local task marketplace** — think "Uber for local help" but with one critical difference: completing work here builds a permanent, verifiable identity. Every task earns XP. XP builds trust tiers. Trust tiers unlock better tasks, higher XP multipliers, Live Mode access, squad formation, and preferential AI matching. Your reputation compounds over time instead of resetting with every job.

**Two user roles:**
- **Hustlers** — workers who browse tasks, navigate to locations, submit GPS + photo + biometric proof of completion, and earn XP toward the next trust tier.
- **Posters** — employers who post tasks (standard, AI-assisted, or ASAP/Live), review applicants by trust tier and rating, approve proof, and release payment from Stripe escrow.

**What makes it different from TaskRabbit:**

| | TaskRabbit | HustleXP |
|--|--|--|
| Worker identity | Resets per job | Compounds (XP → tiers → reputation) |
| Task urgency | Booking flow | Live Mode radar — 60s claim windows, surge pricing |
| Payment safety | Platform-managed | Escrow + GPS + biometric proof + AI verification |
| Team work | No | Squads (Elite+ workers, shared XP + earnings) |
| Fraud prevention | None | 4 AI agents, DB-trigger invariants, liveness detection |

---

## Current Status (April 2, 2026)

| Metric | Value |
|--------|-------|
| Test Files | 239 passing, 0 failing |
| Tests | 5,448 passing |
| Statement Coverage | 89.6% |
| Branch Coverage | 77.6% |
| API Procedures | 290+ across 38 routers |
| Database | 103 tables, PostGIS |
| Deployed | Railway — auto-deploy from `main` |
| Production URL | `https://hustlexp-ai-backend-staging-production.up.railway.app` |
| **Audit Status** | **7 stress test loops completed — 3 CRITICAL, 4 HIGH open** |
| **Stripe** | **Unconfigured (STOP-001) — payment flow non-functional** |

### Open Critical/High Issues (from [HUSTLEXP-ERRORS-AND-TODOS](https://github.com/Sebdysart/HUSTLEXP-ERRORS-AND-TODOS))

| ID | Issue | Severity |
|----|-------|----------|
| STOP-001 | Stripe dashboard empty — no products, no webhooks | HIGH |
| STOP-005 | `transfers.create()` missing idempotency key — double-payout risk | CRITICAL |
| STOP-006 | Post-commit side effects outside transaction in EscrowService | CRITICAL |
| STOP-007 | SelfInsurancePool direct `fetch()` bypasses StripeService | CRITICAL |
| STOP-008 | Webhook idempotency TOCTOU race | HIGH |
| STOP-009 | `HX_STRIPE_STUB=1` no production guard | HIGH |
| STOP-010 | Referral rewards marked paid but never transferred | HIGH |
| STOP-011 | XP velocity check fails open on error | HIGH |

**64 total TODOs tracked** — see [TODOS-BY-PRIORITY.md](https://github.com/Sebdysart/HUSTLEXP-ERRORS-AND-TODOS/blob/main/TODOS-BY-PRIORITY.md) for the full prioritized list.

### Confirmed Architectural Strengths

These patterns were validated as production-ready by adversarial stress testing:

- **PaymentWorker**: Atomic claims via CAS (`claimed_at IS NULL`), HMAC-signed payloads, Zod schema validation
- **EscrowActionWorker**: Optimistic locking (`WHERE version = $N`), Stripe account restriction handling, partial refund checkpointing
- **Outbox pattern**: Triple-layer deduplication (DB unique constraint → CAS UPDATE → BullMQ jobId)
- **Queue system**: HMAC-SHA256 signing on all financial events, DLQ monitoring, `critical_payments` job preservation
- **NotificationService**: All external channels via outbox (no inline sends), frequency limiting, quiet hours

---

## Architecture Overview

```
                    +-----------------+
                    |   iOS Client    |
                    |  (SwiftUI App)  |
                    +--------+--------+
                             |
                     Firebase Auth JWT
                             |
                    +--------v--------+
                    |   Hono Server   |
                    |  (port 3000)    |
                    +--------+--------+
                             |
              +--------------+--------------+
              |              |              |
     +--------v---+  +------v------+  +----v-------+
     | tRPC Router|  | REST Routes |  | Static     |
     | 38 routers |  | /health     |  | /privacy   |
     | 290 procs  |  | /realtime   |  | /terms     |
     +--------+---+  +------+------+  | /legal     |
              |              |         +------------+
     +--------v--------------v--------+
     |        Service Layer           |
     |   68 services + 4 AI agents   |
     +--------+-----------+----------+
              |           |
     +--------v---+  +----v-------+
     | PostgreSQL |  | Upstash    |
     | Neon (103  |  | Redis      |
     | tables)    |  | (cache +   |
     +-----------+   | rate limit)|
                     +----+-------+
                          |
                     +----v-------+
                     | BullMQ     |
                     | 23 workers |
                     +------------+
```

**Four architectural layers:**
```
Layer 0 — PostgreSQL triggers: enforce ALL financial invariants (no negative escrow,
           double-spend prevention, XP requires RELEASED escrow, badge immutability)
Layer 1 — 68 Services: business logic, state machines, AI orchestration
Layer 2 — 38 tRPC Routers: typed procedures + Zod validation + Firebase JWT auth
Layer 3 — 4 AI Agents: proposal-only authority, deterministic fallbacks, cost governance
```

---

## Quick Start

```bash
npm install                    # Install dependencies
cp .env.template .env          # Configure environment
npm run db:migrate             # Run database migrations
npm run dev                    # Start dev server (port 3000)
npm run dev:workers            # Start background workers (separate terminal)
```

---

## Core Business Logic

### 1. Task Lifecycle

Nine states forming a strict state machine enforced by PostgreSQL triggers:

```
OPEN → ACCEPTED → PROOF_SUBMITTED → COMPLETED  (terminal)
     ↘ CANCELLED              ↘ DISPUTED → COMPLETED / CANCELLED
     ↘ EXPIRED
```

Workers can only claim tasks within their trust tier. Proof submission requires GPS accuracy within task geofence. Completion requires Poster approval or admin override. All transitions are atomic — no invalid paths exist in the database.

### 2. Escrow Chain

Money never moves without a corresponding state transition:

```
PENDING → FUNDED (Poster card charged at worker claim)
        → RELEASED (worker paid after proof approved — triggers XP award)
        → REFUNDED (Poster gets money back after rejection/dispute win)
        → LOCKED_DISPUTE (frozen during dispute — neither party can access)
        → REFUND_PARTIAL (dispute split resolution)
```

Before any release: KYC check (`payouts_enabled + stripe_connect_id`), platform fee deducted, revenue logged. XP is only awarded after escrow reaches RELEASED — enforced at the DB trigger level. No escrow release = no XP. This is invariant, not convention.

### 3. XP + Trust Tier System

```
effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier

base_xp           ≈ 10% of task price in cents  ($50 task = 500 base XP)
streak_multiplier = 1.0 + (streak_days × 0.05), max 2.0
trust_multiplier  = 1.0 (Rookie) → 1.5 (Verified) → 2.0 (Trusted/Elite)
live_multiplier   = 1.25× during active Live Mode session
daily_cap         = 10,000 XP
```

Trust tiers gate features: Verified unlocks medium tasks, Trusted unlocks recurring tasks, Elite unlocks Live Mode + Squads, Master unlocks all. Promotion is deterministic (task count + approval rate + dispute history). Demotion only via ban.

### 4. AI Agent Pipeline

Four agents, all Authority Level A2 (proposal-only — humans make final calls):

| Agent | Purpose | Budget/user/day |
|-------|---------|----------------|
| **Judge** | GPS + photo + biometric → APPROVE / REVIEW / REJECT | $0.50 |
| **Matchmaker** | Worker ranking + price suggestions | $0.10 |
| **Dispute** | Fault scoring, split ratios, escalation | $1.00 |
| **Reputation** | Dynamic trust scoring, anomaly detection | $0.05 |

Provider chains: Groq (fast, cheap) → DeepSeek (reasoning) → OpenAI (fallback). Deterministic fallback if all AI unavailable. Global circuit breaker at $500/day.

### 5. Live Mode / ASAP Broadcasting

Poster creates ASAP task (min $15) → broadcasts to all Elite+ Hustlers within 5 miles via SSE → workers see pulsing quest alerts on Live Radar screen → first to accept within 60-second window wins → 1.25× XP multiplier active during full Live session. Surge pricing: `urgencyPremium` (30% of base) + `surgeMultiplier` (1.0–3.0×) compound on top of base payment.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| HTTP Framework | Hono v4.10 | Request routing, middleware, CORS |
| API Layer | tRPC v11.7 | Type-safe RPC with Zod validation |
| Database | PostgreSQL (Neon) | 103 tables, PostGIS, triggers |
| Cache | Upstash Redis | Rate limiting, caching, pub/sub |
| Job Queue | BullMQ + ioredis | 23 async background workers |
| Auth | Firebase Admin SDK | JWT verification, FCM push |
| Payments | Stripe SDK v20 | Escrow, Connect, subscriptions, 1099-NEC |
| Storage | Cloudflare R2 (S3) | Photo proofs, license uploads |
| AI | OpenAI, Groq, Anthropic, DeepSeek | 4 agents with cost governance |
| Email | SendGrid | Transactional emails |
| SMS | Twilio | Phone OTP verification |
| Runtime | Node.js + tsx | ES2022, ESM modules |

---

## Project Structure

```
hustlexp-ai-backend/
├── backend/src/
│   ├── server.ts              # Hono server entry
│   ├── trpc.ts                # tRPC setup, auth middleware
│   ├── db.ts                  # PostgreSQL pool, HX error codes
│   ├── config.ts              # Environment + fee configuration
│   ├── types.ts               # Shared TypeScript types
│   ├── ai/                    # 4 AI agents + AIRouter cost governance
│   ├── routers/               # 38 tRPC routers
│   ├── services/              # 68 business logic services
│   ├── jobs/                  # 23 BullMQ background workers
│   ├── auth/                  # Firebase auth middleware
│   ├── middleware/            # Security headers, rate limiting (6 tiers)
│   ├── realtime/              # SSE broadcasting
│   └── storage/               # R2 file storage
├── backend/tests/unit/        # 239 test files, 5,448 tests
├── migrations/                # SQL migration files
└── scripts/                   # CI pipeline (Zenith Codex, 16 layers)
```

---

## API Surface (290+ Procedures)

### Core Business

| Router | Procedures | Description |
|--------|-----------|-------------|
| **task** | create, accept, start, submitProof, reviewProof, complete, cancel, getById, getState, listOpen, listByPoster, listByWorker, getProof, listApplicants | Task lifecycle + state machine |
| **escrow** | getById, getState, getByTaskId, getHistory, createPaymentIntent, confirmFunding, release, refund, lockForDispute, awardXP | Payment escrow management |
| **user** | me, getById, register, updateProfile, xpHistory, badges, getOnboardingStatus, completeOnboarding, getVerificationUnlockStatus, checkVerificationEligibility | User accounts + gamification |
| **messaging** | sendMessage, sendPhotoMessage, getTaskMessages, getConversations, getUnreadCount, markAsRead, markAllAsRead | Task-scoped messaging |
| **rating** | submitRating, getTaskRatings, getUserRatingSummary, getMyRatings, getRatingsReceived, processAutoRatings | Bidirectional ratings |

### Discovery & Matching

| Router | Procedures | Description |
|--------|-----------|-------------|
| **taskDiscovery** | getFeed, search, calculateMatchingScore, saveSearch, getSavedSearches, executeSavedSearch | AI-powered task feed |
| **matchmaker** | rankCandidates, explainMatch, suggestPrice | AI matchmaking engine |
| **heatmap** | getHeatMap, getDemandAlerts | Demand heat mapping |
| **geofence** | checkProximity, getTaskEvents, verifyPresence | Location verification |
| **skills** | getCategories, getMySkills, addSkills, submitLicense, checkTaskEligibility | Skill + license management |

### Payments & Finance

| Router | Procedures | Description |
|--------|-----------|-------------|
| **subscription** | getMySubscription, subscribe, cancel, confirmSubscription | Stripe subscriptions (Free / Premium $14.99 / Pro $29.99) |
| **tipping** | createTip, confirmTip, getTipsForTask, getMyTipsReceived | In-app tipping |
| **xpTax** | getTaxStatus, getTaxHistory, createPaymentIntent, payTax | 10% tax on offline payments |
| **insurance** | getPoolStatus, getMyClaims, fileClaim, reviewClaim | Self-insurance pool |
| **featured** | promoteTask, confirmPromotion, getFeaturedTasks | Task promotion ($2.99–$7.99) |

### Safety & Compliance

| Router | Procedures | Description |
|--------|-----------|-------------|
| **fraud** | calculateRiskScore, getHighRiskScores, detectPattern, getUserPatterns | Real-time fraud scoring |
| **moderation** | moderateContent, getPendingQueue, reviewQueueItem, createReport, createAppeal | Content moderation + appeals |
| **biometric** | submitBiometricProof, analyzeFacePhoto | Liveness + deepfake detection |
| **gdpr** | createRequest, getConsentStatus, updateConsent | GDPR data rights |

### Platform Features

| Router | Procedures | Description |
|--------|-----------|-------------|
| **notification** | getList, getPreferences, updatePreferences, registerDeviceToken | Push notification management |
| **live** | toggle, getStatus, listBroadcasts | Live Mode session management |
| **instant** | listAvailable, accept, dismiss, metrics | Instant task matching |
| **squad** | create, joinSquad, leaveSquad, getMembers, listMine | Team-based collaboration |
| **recurringTask** | create, cancel, listMine, listOccurrences | Recurring task series |
| **expertiseSupply** | listExpertise, getMyExpertise, addExpertise, getSupplyDashboard | Supply/demand control |
| **betaDashboard** | getMetrics, getRevenueSummary, getMonthlyPnl, listUsers, requestKillSwitchToggle | Admin dashboard + kill switches |

---

## Auth Model

```
Client → Authorization: Bearer <firebase_jwt>
       → Firebase Admin SDK verifies
       → DB lookup by firebase_uid
       → Context { user, firebaseUid } injected into procedure

Three types:
  publicProcedure   — no auth (health checks, legal pages)
  protectedProcedure — valid Firebase JWT required
  adminProcedure    — admin role in admin_roles table required
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `UPSTASH_REDIS_REST_URL` | Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST token |
| `UPSTASH_REDIS_URL` | Redis TCP (BullMQ) |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin SDK private key |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin SDK email |

### Optional Services

| Variable | Description |
|----------|-------------|
| `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET_NAME` | Cloudflare R2 |
| `SENDGRID_API_KEY` `SENDGRID_FROM_EMAIL` | Email |
| `OPENAI_API_KEY` `GROQ_API_KEY` `DEEPSEEK_API_KEY` `ANTHROPIC_API_KEY` | AI providers |
| `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` `TWILIO_VERIFY_SERVICE_SID` | SMS |
| `GOOGLE_MAPS_API_KEY` | Geocoding |
| `PLATFORM_FEE_PERCENT` | Platform fee % (default: 15) |

---

## Database

**103 tables** on PostgreSQL (Neon) with PostGIS. Key areas:

- **Core**: users, tasks, escrows, payments, revenue_ledger
- **Gamification**: xp_events, badges, user_badges, streaks, daily_progress
- **Trust**: trust_events, trust_tier_audit, fraud_risk_scores
- **Skills**: skill_categories, skills, user_skills, license_submissions
- **Messaging**: task_messages, conversations
- **Notifications**: notifications, device_tokens, notification_preferences
- **AI**: ai_decisions, ai_audit_trail, ai_cost_logs
- **Moderation**: moderation_queue, user_reports, appeals
- **Financial**: subscription_plans, user_subscriptions, tips, referral_codes, self_insurance_pool

Financial operations enforced by PostgreSQL triggers:
- No negative escrow balances (INV-1)
- Double-spending prevention (INV-2)
- Append-only audit logs (INV-3)
- XP requires RELEASED escrow (INV-4)
- Badge immutability (INV-5)

---

## Background Workers (23)

| Worker | Trigger | Purpose |
|--------|---------|---------|
| payment-worker | Payment initiated | Stripe PaymentIntent → fund escrow |
| escrow-action-worker | Outbox event | Execute escrow state transitions |
| fraud-detection-worker | Real-time signal | Velocity checks, pattern detection |
| push-worker | Notification queued | Firebase FCM delivery |
| email-worker | Email event | SendGrid dispatch |
| sms-worker | SMS event | Twilio OTP |
| biometric-analyzer-worker | Proof submitted | Async liveness + deepfake |
| instant-matching-worker | Task enters MATCHING | Match workers to ASAP tasks |
| trust-tier-promotion-worker | Cron: daily 2AM | Evaluate tier promotions |
| xp-tax-reminder-worker | Cron: daily 9AM | Unpaid tax reminders |
| maintenance-worker | Cron: daily 3AM | Expire stale tasks, cleanup |
| stripe-event-worker | Stripe webhook | Route payment events |
| outbox-worker | Scheduled poll | Transactional outbox pattern |
| recurring-task-worker | Per-series schedule | Generate recurring instances |
| tax-reporting-worker | Cron: Feb 1 annually | Generate + file 1099-NEC forms |
| ... 8 more | Various | Surge evaluation, GDPR export, expertise recalc, incident diagnosis |

---

## Test Coverage

```bash
npm test               # Run all tests (vitest)
npm run test:coverage  # Coverage report
npm run test:invariants # Database integrity tests (requires live DATABASE_URL)
```

| Metric | Value |
|--------|-------|
| Test files | 239 (+ 16 skipped invariant files) |
| Tests passing | 5,448 |
| Statement coverage | 89.6% |
| Branch coverage | 77.6% |
| Function coverage | 90.9% |

---

## Scripts

```bash
npm run dev              # Hot-reload dev server
npm run dev:workers      # Hot-reload workers
npm start                # Production server
npm run start:workers    # Production workers
npm run build            # TypeScript type check
npm run health           # curl localhost:3000/health
```

---

## Deployment

Deployed on **Railway** via Procfile. Auto-deploys on push to `main`.

```
web: npx tsx backend/src/server.ts
```

Production URL: `https://hustlexp-ai-backend-staging-production.up.railway.app`

---

## Roadmap

**Week 1 — Critical Financial Patches (~15 hours):**
1. STOP-005: Add idempotency keys to Stripe `transfers.create()` and `refunds.create()` (2h)
2. STOP-006: Move post-commit side effects into transaction or transactional outbox (4-6h)
3. STOP-007: Refactor SelfInsurancePool to use StripeService (2h)
4. STOP-009: Add startup assertion blocking `HX_STRIPE_STUB=1` in production (15min)
5. STOP-011: Change XP velocity check to fail closed on error (30min)
6. STOP-008: Fix webhook dedup with atomic `INSERT ON CONFLICT` (2h)

**Week 2 — High Priority (~10 hours):**
7. STOP-001: Configure Stripe dashboard (products, prices, webhooks)
8. STOP-010: Wire actual Stripe transfer in referral rewards (2h)
9. STOP-012: Fix ASAP price bump / escrow amount mismatch (3-4h)
10. Rate-limit account creation per IP/device (Sybil defense phase 1) (3h)

**Weeks 3-4 — Anti-Abuse & Growth:**
- Require phone verification for account activation
- Implement graph-based collusion detection
- Integrate Checkr API for background checks
- Build 5-tier verification ladder (email → phone → ID → background → expertise)
- Dual-sided referral rewards ($5 referrer + $3 new user)
- Neighborhood-level geo-fenced task feed

**6-12 months:**
- Android client
- AI agents shift from assistive to predictive (demand forecasting, hot zone routing)
- Earned wage advance at Trusted+ tier
- Squad commercial contract access (Poster posts $500+ job → requires squad bid)
- Insurance pool sustainability controls (min balance, claim frequency limits, reinsurance)

**2-year north star:**
HustleXP becomes a skilled-labor credentialing network. A Master Hustler with 4.95+ stars and $10k+ earned is more verifiable than a resume. The XP economy extends into insurance discounts, earned wage advance, and portable verified identity exportable to other gig platforms.

**Full roadmap**: See [HUSTLEXP-ERRORS-AND-TODOS](https://github.com/Sebdysart/HUSTLEXP-ERRORS-AND-TODOS) for the complete 64-item prioritized TODO list.

---

## What's Deferred

| Feature | Status | Reason |
|---------|--------|--------|
| Checkr background checks | Stub (INFO-001) | `initiateBackgroundCheck()` generates fake ID, never calls API |
| Fraud detection graph analysis | Stub | Pattern types defined but detection logic is TBD |
| AWS Rekognition liveness | Planned | Amplify SDK not yet installed on iOS |
| Android client | Roadmap | iOS private beta first |
| Video proof / LiDAR | Roadmap | Judge Agent Phase 2 |
| AI-dynamic insurance premiums | Roadmap | Risk Engine Phase 2 |
| Surge pricing manipulation guards | TODO-056 | Cap demand signal changes per 15-min window |

## Audit Trail

Full source-level audit and adversarial stress testing performed April 1-2, 2026. Documentation in [HustleXP-Vault](https://github.com/Sebdysart/HustleXP-Vault) (16 pages, 5,200+ lines). Actionable tracking in [HUSTLEXP-ERRORS-AND-TODOS](https://github.com/Sebdysart/HUSTLEXP-ERRORS-AND-TODOS) (64 TODOs, 12 STOP errors).

---

## Error Codes (HX001–HX905)

All errors follow `{ code: string, message: string }` where code is a HustleXP error code:

| Range | Category |
|-------|---------|
| HX001–006 | Auth & Authorization |
| HX100–106 | User & Profile |
| HX200–209 | Tasks & Discovery |
| HX300–310 | Payments & Escrow |
| HX400–407 | Trust & Safety |
| HX500–505 | AI & Intelligence |
| HX600–607 | System & Infrastructure |
| HX700–704 | Compliance & Reporting |
| HX800–802 | Data & Privacy |
| HX900–905 | Live Mode & Features |

---

## License

Proprietary — All rights reserved.
