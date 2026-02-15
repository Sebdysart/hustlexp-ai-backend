# HustleXP Backend

Production-grade tRPC API backend for HustleXP, a gamified local task marketplace. Built with Hono, tRPC v11, PostgreSQL (Neon), Redis (Upstash), and deployed on Railway.

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
     | 261 procs  |  | /realtime   |  | /terms     |
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

## Quick Start

```bash
npm install                    # Install dependencies
cp .env.template .env          # Configure environment
npm run db:migrate             # Run database migrations
npm run dev                    # Start dev server (port 3000)
npm run dev:workers            # Start background workers (separate terminal)
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| HTTP Framework | Hono v4.10 | Request routing, middleware, CORS |
| API Layer | tRPC v11.7 | Type-safe RPC with Zod validation |
| Database | PostgreSQL (Neon) | 103 tables, PostGIS, triggers |
| Cache | Upstash Redis | Rate limiting, caching, sessions |
| Job Queue | BullMQ + ioredis | 23 async background workers |
| Auth | Firebase Admin SDK | JWT verification, user lookup |
| Payments | Stripe SDK v20 | Escrow, subscriptions, tipping |
| Storage | Cloudflare R2 (S3) | Photo proofs, license uploads |
| AI | OpenAI, Groq, DeepSeek, Anthropic | 4 AI agents (Judge, Matchmaker, Dispute, Reputation) |
| Email | SendGrid | Transactional emails, verification |
| SMS | Twilio | Phone verification, alerts |
| Runtime | Node.js + tsx | ES2022 target, ESM modules |

## Project Structure

```
hustlexp-backend-clean/
├── backend/src/
│   ├── server.ts              # Hono server entry (860 lines)
│   ├── trpc.ts                # tRPC setup, auth middleware, error formatting
│   ├── db.ts                  # PostgreSQL pool, error codes (HX001-HX905)
│   ├── config.ts              # Environment validation
│   ├── types.ts               # Shared TypeScript types
│   ├── routers/               # 38 tRPC routers (+ index.ts aggregator)
│   │   ├── task.ts            # Core task CRUD + state machine
│   │   ├── user.ts            # Registration, profiles, XP, badges
│   │   ├── escrow.ts          # Payment escrow lifecycle
│   │   ├── messaging.ts       # Direct messaging
│   │   ├── taskDiscovery.ts   # AI-powered task feed + search
│   │   ├── rating.ts          # Ratings and reviews
│   │   ├── notification.ts    # Push notification management
│   │   ├── skills.ts          # Worker skill system
│   │   ├── betaDashboard.ts   # Admin dashboard + kill switches
│   │   └── ... (29 more)
│   ├── services/              # 68 business logic services
│   │   ├── TaskService.ts
│   │   ├── EscrowService.ts
│   │   ├── StripeService.ts
│   │   ├── JudgeAIService.ts
│   │   ├── MatchmakerAIService.ts
│   │   ├── DisputeAIService.ts
│   │   ├── ReputationAIService.ts
│   │   └── ... (61 more)
│   ├── jobs/                  # 23 BullMQ background workers
│   │   ├── payment-worker.ts
│   │   ├── fraud-detection-worker.ts
│   │   ├── push-worker.ts
│   │   ├── email-worker.ts
│   │   └── ... (19 more)
│   ├── auth/                  # Firebase auth + middleware
│   ├── cache/                 # Redis caching layer
│   ├── middleware/             # Security headers, rate limiting
│   ├── realtime/              # SSE (Server-Sent Events)
│   └── storage/               # S3/R2 file storage
├── migrations/                # 23 SQL migration files
├── public/                    # Static HTML (privacy, terms, legal)
├── scripts/                   # Utility and test scripts
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── Procfile                   # Railway/Heroku deployment
```

## API Surface (261 Procedures)

All tRPC routes are at `/trpc/*`. Auth via `Authorization: Bearer <firebase_jwt>`.

### Core Business

| Router | Procedures | Description |
|--------|-----------|-------------|
| **task** | `getById` `getState` `listOpen` `listByPoster` `listByWorker` `getProof` `create` `accept` `start` `submitProof` `reviewProof` `complete` `cancel` | Task lifecycle and state machine |
| **escrow** | `getById` `getState` `getByTaskId` `getHistory` `createPaymentIntent` `confirmFunding` `release` `refund` `lockForDispute` `awardXP` | Payment escrow management |
| **user** | `me` `getById` `xpHistory` `badges` `register` `updateProfile` `getOnboardingStatus` `completeOnboarding` `getVerificationUnlockStatus` `checkVerificationEligibility` `getVerificationEarningsLedger` | User accounts and gamification |
| **messaging** | `sendMessage` `sendPhotoMessage` `getTaskMessages` `getConversations` `getUnreadCount` `markAsRead` `markAllAsRead` | In-app direct messaging |
| **rating** | `submitRating` `getTaskRatings` `getUserRatingSummary` `getMyRatings` `getRatingsReceived` `processAutoRatings` | Bidirectional ratings |

### Discovery and Matching

| Router | Procedures | Description |
|--------|-----------|-------------|
| **taskDiscovery** | `getFeed` `search` `calculateMatchingScore` `calculateFeedScores` `getExplanation` `saveSearch` `getSavedSearches` `deleteSavedSearch` `executeSavedSearch` | AI-powered task recommendation |
| **matchmaker** | `rankCandidates` `explainMatch` `suggestPrice` | AI matchmaking engine |
| **heatmap** | `getHeatMap` `getDemandAlerts` | Demand heat mapping |
| **geofence** | `checkProximity` `getTaskEvents` `verifyPresence` | Location verification |
| **skills** | `getCategories` `getSkills` `getMySkills` `addSkills` `removeSkill` `submitLicense` `getLicenseSubmissions` `checkTaskEligibility` | Worker skill management |

### Payments and Finance

| Router | Procedures | Description |
|--------|-----------|-------------|
| **pricing** | `calculate` `updateMyModifier` | Dynamic pricing engine |
| **subscription** | `getMySubscription` `subscribe` `cancel` `confirmSubscription` | Stripe subscription management |
| **tipping** | `createTip` `confirmTip` `getTipsForTask` `getMyTipsReceived` | In-app tipping |
| **xpTax** | `getTaxStatus` `getTaxHistory` `createPaymentIntent` `payTax` | XP tax system |
| **insurance** | `getPoolStatus` `getMyClaims` `fileClaim` `reviewClaim` `payClaim` | Self-insurance pool |
| **featured** | `promoteTask` `confirmPromotion` `getFeaturedTasks` | Promoted listings |
| **referral** | `getOrCreateCode` `redeemCode` `getReferralStats` | Referral rewards |

### AI Agents

| Router | Procedures | Description |
|--------|-----------|-------------|
| **ai** | `submitCalibration` `getInferenceResult` `confirmRole` | AI onboarding calibration |
| **disputeAI** | `analyzeDispute` `generateEvidenceRequest` `assessEscalation` | AI dispute resolution |
| **reputation** | `calculateTrustScore` `detectAnomalies` `generateUserInsight` `checkTierEligibility` | AI reputation scoring |

### Safety and Compliance

| Router | Procedures | Description |
|--------|-----------|-------------|
| **fraud** | `calculateRiskScore` `getLatestRiskScore` `getRiskAssessment` `getHighRiskScores` `updateRiskScoreStatus` `detectPattern` `getUserPatterns` `getDetectedPatterns` `updatePatternStatus` | Fraud detection |
| **moderation** | `moderateContent` `getPendingQueue` `getQueueItemById` `reviewQueueItem` `createReport` `getUserReports` `reviewReport` `createAppeal` `getUserAppeals` `reviewAppeal` `getPendingAppeals` | Content moderation |
| **biometric** | `submitBiometricProof` `analyzeFacePhoto` | Biometric verification |
| **gdpr** | `createRequest` `getRequestStatus` `getMyRequests` `cancelRequest` `getConsentStatus` `updateConsent` | GDPR data export/delete |
| **verification** | (via user router) | License and identity verification |

### Platform Features

| Router | Procedures | Description |
|--------|-----------|-------------|
| **notification** | `getList` `getUnreadCount` `getById` `markAsRead` `markAllAsRead` `markAsClicked` `getPreferences` `updatePreferences` `registerDeviceToken` `unregisterDeviceToken` | Push notifications |
| **live** | `toggle` `getStatus` `listBroadcasts` | Live mode broadcasting |
| **instant** | `listAvailable` `accept` `dismiss` `metrics` | Instant task matching |
| **batchQuest** | `getSuggestions` `buildRoute` | Multi-task route optimization |
| **tutorial** | `getScenarios` `submitAnswers` `scanEquipment` | Interactive tutorials |
| **challenges** | `getTodaysChallenges` `updateProgress` | Daily challenges |
| **jury** | `submitVote` `getVoteTally` | Community jury disputes |
| **expertiseSupply** | `listExpertise` `getMyExpertise` `addExpertise` `removeExpertise` `promoteExpertise` `checkCapacity` `getMyWaitlist` `acceptInvite` `getSupplyDashboard` `updateCapacity` `triggerRecalc` | Supply/demand control |
| **upload** | `getPresignedUrl` | S3/R2 file upload |

### Monitoring

| Router | Procedures | Description |
|--------|-----------|-------------|
| **health** | `ping` `status` `verifySchema` | Server health checks |
| **analytics** | `trackEvent` `trackBatch` `getUserEvents` `getTaskEvents` `calculateFunnel` `calculateCohortRetention` `trackABTest` `getEventCounts` | Product analytics |
| **alphaTelemetry** | `getEdgeStateDistribution` `getEdgeStateTimeSpent` `getDisputeRate` `getProofCorrectionRate` `getTrustTierMovement` `emitEdgeStateImpression` `emitEdgeStateExit` | Alpha telemetry |
| **betaDashboard** | `getMetrics` `getStatus` `getKillSignals` `getRevenueSummary` `getMonthlyPnl` `verifyLedgerIntegrity` `getDisputeRate` `getDailyTaskCounts` `getDailyRevenue` `getActivityFeed` `listUsers` `getBetaConfig` `requestKillSwitchToggle` `getKillSwitchHistory` | Admin dashboard |
| **ui** | `getXPCelebrationStatus` `markXPCelebrationShown` `getBadgeAnimationStatus` `markBadgeAnimationShown` `reportViolation` | UI state sync |

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Basic health check |
| GET | `/health/detailed` | Full service status (DB, Firebase, Stripe, Redis) |
| GET | `/realtime/stream` | SSE endpoint for real-time updates |
| GET | `/privacy-policy` | Privacy policy HTML |
| GET | `/terms-of-service` | Terms of service HTML |
| GET | `/legal` | Legal landing page |
| GET/POST | `/api/users/:id/xp-celebration-status` | XP celebration state |
| GET/POST | `/api/users/:id/badges/:badgeId/animation-status` | Badge animation state |
| GET | `/api/tasks/:taskId/state` | Task state machine |
| GET | `/api/escrows/:escrowId/state` | Escrow state |
| POST | `/api/ui/violations` | UI violation reports |
| GET | `/api/users/:id/onboarding-status` | Onboarding completion |

## Auth Model

```
Client request
    |
    v
Authorization: Bearer <firebase_jwt>
    |
    v
Firebase Admin SDK verifies token
    |
    v
Database lookup by firebase_uid
    |
    v
Context { user, firebaseUid } injected into tRPC procedures
```

Three procedure types:
- **publicProcedure** - No auth (health checks, legal pages)
- **protectedProcedure** - Requires valid Firebase JWT
- **adminProcedure** - Requires admin role in `admin_roles` table

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `UPSTASH_REDIS_REST_URL` | Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST token |
| `UPSTASH_REDIS_URL` | Redis TCP connection (BullMQ) |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin SDK private key |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin SDK email |

### Optional Services

| Variable | Description |
|----------|-------------|
| `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET_NAME` | Cloudflare R2 storage |
| `SENDGRID_API_KEY` `SENDGRID_FROM_EMAIL` | Email via SendGrid |
| `OPENAI_API_KEY` | OpenAI (GPT-4o) |
| `GROQ_API_KEY` | Groq (Llama 3.3 70B) |
| `DEEPSEEK_API_KEY` | DeepSeek (R1 reasoning) |
| `ANTHROPIC_API_KEY` | Anthropic (Claude Sonnet) |
| `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` `TWILIO_VERIFY_SERVICE_SID` | SMS verification |
| `GOOGLE_MAPS_API_KEY` | Google Maps geocoding |

### Application

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Environment |
| `ALLOWED_ORIGINS` | `*` (dev) | CORS origins (comma-separated) |

## Database

**103 tables** on PostgreSQL (Neon) with PostGIS. Key areas:

- **Core**: users, tasks, escrows, payments, revenue_ledger
- **Gamification**: xp_events, badges, user_badges, challenges, daily_progress
- **Trust**: trust_events, trust_tier_audit, fraud_risk_scores, fraud_patterns
- **Skills**: skill_categories, skills, user_skills, license_submissions
- **Messaging**: task_messages, conversations
- **Notifications**: notifications, device_tokens, notification_preferences
- **AI**: ai_decisions, ai_audit_trail, calibration_responses
- **Moderation**: moderation_queue, user_reports, appeals
- **Financial**: subscription_plans, user_subscriptions, tips, referral_codes

Financial operations are protected by PostgreSQL triggers enforcing:
- No negative escrow balances
- Double-spending prevention
- Append-only audit logs
- Trust tier audit trail

### Migrations

```bash
npm run db:migrate    # Run all pending migrations
npm run db:check      # Verify database connection
```

53 migration files across three directories (root `migrations/`, `backend/database/migrations/`, `backend/src/migrations/`).

## Background Workers (23)

BullMQ workers processing async jobs via Redis:

| Worker | Purpose |
|--------|---------|
| payment-worker | Stripe payment processing |
| escrow-action-worker | Escrow state transitions |
| fraud-detection-worker | Real-time fraud scoring |
| push-worker | Push notification delivery |
| email-worker | SendGrid email dispatch |
| sms-worker | Twilio SMS delivery |
| instant-matching-worker | Instant task matching |
| biometric-analyzer-worker | Face photo analysis |
| trust-tier-promotion-worker | Trust tier recalculation |
| xp-tax-reminder-worker | Tax payment reminders |
| maintenance-worker | Cleanup and maintenance |
| stripe-event-worker | Webhook event processing |
| outbox-worker | Transactional outbox pattern |
| ... | 10 more specialized workers |

## Scripts

```bash
npm run dev              # Hot-reload dev server
npm run dev:workers      # Hot-reload background workers
npm start                # Production server
npm run start:workers    # Production workers
npm run build            # TypeScript type check
npm test                 # Run all tests (vitest)
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage report
npm run test:invariants  # Database integrity tests
npm run health           # curl localhost:3000/health
```

## Deployment

Deployed on **Railway** via Procfile:

```
web: npx tsx backend/src/server.ts
```

Production URL: `https://hustlexp-ai-backend-staging-production.up.railway.app`

### Deploy Steps

1. Push to `main` branch (Railway auto-deploys)
2. Railway runs `npm install` + starts Procfile
3. Verify: `curl https://your-app.up.railway.app/health`

## Architecture

```
Layer 0: PostgreSQL triggers (financial invariants, audit logs)
Layer 1: Services (68 files - business logic, state machines)
Layer 2: tRPC Routers (38 files - typed API, Zod validation)
Layer 3: AI Agents (Judge, Matchmaker, Dispute, Reputation)
```

All financial operations use escrow accounts with state machine transitions to ensure atomic, append-only money movement. Error responses use HustleXP error codes (HX001-HX905) for programmatic handling.

## License

Proprietary - All rights reserved.
