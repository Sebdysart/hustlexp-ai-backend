# HustleXP — Credential Registry

> **⚠ NO SECRET VALUES ARE STORED HERE.**
> This file is a setup guide and inventory only — actual credentials live in Railway env vars, service dashboards, or 1Password. Never commit secrets to git.

---

## How to Use (Dev Onboarding)

1. Review each service below
2. Check **"Where to Get It"** — the exact dashboard to visit
3. Check **"Where It Lives Now"** — if it says Railway env vars, ask Seb for project access
4. Tick off **Dev Status** as you configure each service
5. Never paste actual values into this file

---

## Quick Summary

| # | Service | Category | Required? | Env Var(s) | Dev Status |
|---|---------|----------|-----------|-----------|------------|
| 1 | Railway | Infrastructure | ✅ Required | — | ☐ |
| 2 | GitHub | Infrastructure | ✅ Required | — | ☐ |
| 3 | Neon (PostgreSQL) | Infrastructure | ✅ Required | `DATABASE_URL` | ☐ |
| 4 | Upstash Redis | Infrastructure | ✅ Required | `UPSTASH_REDIS_REST_URL` `UPSTASH_REDIS_REST_TOKEN` `UPSTASH_REDIS_URL` | ☐ |
| 5 | Cloudflare R2 | Infrastructure | Optional | `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET_NAME` `R2_PUBLIC_URL` | ☐ |
| 6 | Firebase | Auth & Mobile | ✅ Required | `FIREBASE_PROJECT_ID` `FIREBASE_PRIVATE_KEY` `FIREBASE_CLIENT_EMAIL` | ☐ |
| 7 | Apple Developer | Auth & Mobile | ✅ Required | — (Xcode config) | ☐ |
| 8 | Stripe | Payments | ✅ Required | `STRIPE_SECRET_KEY` `STRIPE_WEBHOOK_SECRET` | ☐ |
| 9 | Checkr | Payments | Optional (B3) | `CHECKR_API_KEY` | ⏸ Blocked |
| 10 | OpenAI | AI Services | Optional | `OPENAI_API_KEY` | ☐ |
| 11 | Groq | AI Services | Optional | `GROQ_API_KEY` | ☐ |
| 12 | Anthropic | AI Services | Optional | `ANTHROPIC_API_KEY` | ☐ |
| 13 | DeepSeek | AI Services | Optional | `DEEPSEEK_API_KEY` | ☐ |
| 14 | Google AI (Gemini) | AI Services | Optional | `GOOGLE_AI_API_KEY` | ☐ |
| 15 | Greptile | AI Services | Optional | `GREPTILE_API_KEY` | ☐ |
| 16 | SendGrid | Communications | Optional | `SENDGRID_API_KEY` `SENDGRID_FROM_EMAIL` | ☐ |
| 17 | Twilio | Communications | Optional | `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` `TWILIO_VERIFY_SERVICE_SID` | ☐ |
| 18 | Google Maps | Communications | Optional | `GOOGLE_MAPS_API_KEY` | ☐ |
| 19 | Sentry | Monitoring | Optional | `SENTRY_DSN` | ☐ |
| 20 | PostHog | Monitoring | Optional | `POSTHOG_API_KEY` | ☐ |
| 21 | Figma | Dev Tools | No | — (MCP config) | ☐ |
| 22 | Amazon Rekognition | AWS / Biometric | Optional (New) | `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` `AWS_REGION` | ☐ |
| 23 | AWS S3 (Biometric) | AWS / Biometric | Optional (New) | `AWS_REKOGNITION_COLLECTION_ID` `AWS_S3_BIOMETRIC_BUCKET` | ☐ |
| 24 | AWS Amplify SDK (iOS) | AWS / Biometric | Optional (New) | — (iOS SDK config) | ☐ |

---

## Infrastructure

### 1. Railway
**Use in HustleXP:** Production hosting, auto-deploy from GitHub `main`, env var storage for entire backend, Procfile manages web server + 23 BullMQ workers as separate processes.

| Field | Value |
|-------|-------|
| Credential Type | Email + password (account login) |
| Env Var(s) | N/A — Railway stores all other env vars |
| Where to Get It | railway.app → Project Settings → Members |
| Where It Lives | Railway dashboard |
| Required? | ✅ Required |
| Setup Complexity | Low |

**Notes:** Invite dev via Settings → Members. They see env vars directly without you copy-pasting secrets.

---

### 2. GitHub
**Use in HustleXP:** Source control for 3 repos (`hustlexp-ai-backend`, `HUSTLEXPFINAL1`, `HUSTLEXP-DOCS`). Zenith Codex CI/CD pipeline via GitHub Actions. Greptile PR review gate. Stores `GREPTILE_API_KEY` as repo secret.

| Field | Value |
|-------|-------|
| Credential Type | Username + 2FA + Personal Access Token |
| Env Var(s) | `GITHUB_TOKEN` (auto-injected in Actions) |
| Where to Get It | github.com/Sebdysart → Settings → Developer Settings → PAT |
| Where It Lives | GitHub account + repo secrets |
| Required? | ✅ Required |
| Setup Complexity | Low |

**Notes:** PAT needs `workflow` scope for pushing CI files. Run: `gh auth refresh -h github.com -s workflow`

---

### 3. Neon (PostgreSQL)
**Use in HustleXP:** Primary database — 103 tables. PostGIS for geolocation and heat maps. PostgreSQL triggers enforce financial invariants (no negative escrow, double-spend prevention, append-only audit logs). Task state machine, XP ledger, trust scores, moderation queue, all user data.

| Field | Value |
|-------|-------|
| Credential Type | Connection string `postgres://user:pass@host/db` |
| Env Var(s) | `DATABASE_URL` |
| Where to Get It | console.neon.tech → Project → Connection Details |
| Where It Lives | Railway env vars |
| Required? | ✅ Required |
| Setup Complexity | Medium |

**Notes:** Serverless Postgres. PostGIS extension must be enabled. 53 migration files across 3 directories. Run `npm run db:migrate` after configuring.

---

### 4. Upstash Redis
**Use in HustleXP:** 6-tier rate limiting (auth / AI / financial / mutation / upload / general). BullMQ job queues for 23 async background workers. Caching AI responses and user sessions. Pub/sub for SSE real-time task updates.

| Field | Value |
|-------|-------|
| Credential Type | REST URL + REST token + TCP connection URL |
| Env Var(s) | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_URL` |
| Where to Get It | console.upstash.com → Database → REST API tab + Details tab |
| Where It Lives | Railway env vars |
| Required? | ✅ Required |
| Setup Complexity | Low |

**Notes:** Two connection types needed from the same database: REST (`@upstash/redis` for caching/rate-limiting) + TCP (`ioredis` for BullMQ workers).

---

### 5. Cloudflare R2
**Use in HustleXP:** Photo proof uploads (task completion evidence), worker license/certification uploads, user profile photos, messaging photo attachments. Presigned URLs allow iOS to upload directly to R2 without routing through the backend.

| Field | Value |
|-------|-------|
| Credential Type | Account ID + R2 Access Key ID + R2 Secret Access Key |
| Env Var(s) | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` |
| Where to Get It | dash.cloudflare.com → R2 → Manage R2 API Tokens |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Medium |

**Notes:** S3-compatible API. Bucket name: `hustlexp-media`. Falls back to mock URLs in dev if not configured. `R2_PUBLIC_URL` = custom domain or `https://<bucket>.r2.dev`.

---

## Auth & Mobile

### 6. Firebase
**Use in HustleXP:** Core authentication — every single API call requires a valid Firebase JWT. Admin SDK on backend verifies tokens and injects user context into all tRPC procedures. FCM push notifications for task updates, new messages, XP events, dispute alerts. iOS client uses Firebase SDK directly for sign-in.

| Field | Value |
|-------|-------|
| Credential Type | Service account JSON: Project ID + Private Key (RSA) + Client Email |
| Env Var(s) | `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL` |
| Where to Get It | console.firebase.google.com → Project Settings → Service Accounts → Generate new key |
| Where It Lives | Railway env vars |
| Required? | ✅ Required (CRITICAL) |
| Setup Complexity | High |

**Notes:** Nothing works without Firebase. `FIREBASE_PRIVATE_KEY` is multi-line — in Railway paste with literal `\n`. FCM iOS push requires APNs `.p8` key uploaded to Firebase Console → Project Settings → Cloud Messaging.

---

### 7. Apple Developer Account
**Use in HustleXP:** iOS App Store submission and review. TestFlight beta distribution (internal + external testers). APNs (Apple Push Notification service) — `.p8` key required for Firebase FCM to deliver push notifications on iOS. Provisioning profiles and code signing certificates for Xcode builds.

| Field | Value |
|-------|-------|
| Credential Type | Apple ID + password + Team ID + APNs `.p8` key file |
| Env Var(s) | N/A (Xcode project config — `AppConfig.swift`) |
| Where to Get It | developer.apple.com → Certificates, Identifiers & Profiles |
| Where It Lives | Apple Keychain / 1Password + Firebase console (APNs key) |
| Required? | ✅ Required |
| Setup Complexity | High |

**Notes:** $99/year subscription required. Bundle ID: `com.hustlexp.app` (verify in Xcode). APNs key (`.p8`) must be uploaded to Firebase Console → Project Settings → Cloud Messaging → Apple app config.

---

## Payments

### 8. Stripe
**Use in HustleXP:** Escrow payment intents (task payments held until completion). Stripe Connect for worker payouts — requires `payouts_enabled` + `stripe_connect_id` KYC gate before any release. Subscription management (Hustler Pro plans). In-app tipping. Featured task promotion payments. 1099-NEC tax form generation. Fraud detection via Stripe Radar. Webhook events for all payment state changes.

| Field | Value |
|-------|-------|
| Credential Type | Secret key + Webhook signing secret + Publishable key (iOS) |
| Env Var(s) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Where to Get It | dashboard.stripe.com → Developers → API Keys / Webhooks |
| Where It Lives | Railway env vars |
| Required? | ✅ Required |
| Setup Complexity | High |

**Notes:** Use `sk_test_` for dev, `sk_live_` for production. Stripe Connect required for worker payouts. Add webhook in Stripe dashboard pointing to: `https://your-railway-url.up.railway.app/api/stripe/webhook`

---

### 9. Checkr
**Use in HustleXP:** Worker criminal background checks before high-trust task assignments. Identity verification layer for safety-critical gig categories.

| Field | Value |
|-------|-------|
| Credential Type | API key |
| Env Var(s) | `CHECKR_API_KEY` (TBD — not yet implemented) |
| Where to Get It | dashboard.checkr.com → Settings → API Keys |
| Where It Lives | PENDING — not yet configured |
| Required? | Optional (B3 — deferred post-beta) |
| Setup Complexity | High |

**Notes:** ⏸ **BLOCKED** — Account (`dycejr@outlook.com`) must be authorized before API keys can be generated. Email sent to Checkr. Deferred to post-beta launch.

---

## AI Services

### 10. OpenAI
**Use in HustleXP:** Judge AI agent — evaluates task completion proof photos for quality and authenticity. Task description auto-generation. Content moderation assistance. Most reliable provider in the AIRouter fallback chain.

| Field | Value |
|-------|-------|
| Credential Type | API key |
| Env Var(s) | `OPENAI_API_KEY` |
| Where to Get It | platform.openai.com → API Keys |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** Model: GPT-4o. Most expensive but most reliable. AIRouter enforces per-user daily budget ($25 default). Degrades gracefully to other providers if rate-limited.

---

### 11. Groq
**Use in HustleXP:** Matchmaker AI agent — fast candidate ranking for task-worker matching. Primary provider for real-time AI where speed matters most. Low-latency inference.

| Field | Value |
|-------|-------|
| Credential Type | API key |
| Env Var(s) | `GROQ_API_KEY` |
| Where to Get It | console.groq.com → API Keys |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** Model: Llama 3.3 70B. Free tier available. Fastest inference of all providers. Primary choice for matchmaking. Falls back gracefully.

---

### 12. Anthropic
**Use in HustleXP:** Dispute AI agent — complex multi-party dispute analysis, evidence evaluation, resolution recommendations. Reputation AI — nuanced trust score reasoning, anomaly detection narrative.

| Field | Value |
|-------|-------|
| Credential Type | API key |
| Env Var(s) | `ANTHROPIC_API_KEY` |
| Where to Get It | console.anthropic.com → API Keys |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** Model: Claude Sonnet. Best for nuanced multi-step reasoning. Also used separately for Claude Code development sessions.

---

### 13. DeepSeek
**Use in HustleXP:** Cost-efficient AI reasoning for bulk operations. Dispute analysis backup. Structured chain-of-thought tasks where budget is a constraint.

| Field | Value |
|-------|-------|
| Credential Type | API key |
| Env Var(s) | `DEEPSEEK_API_KEY` |
| Where to Get It | platform.deepseek.com → API Keys |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** Model: DeepSeek R1. Very cheap per token. Good for high-volume operations under budget pressure.

---

### 14. Google AI (Gemini)
**Use in HustleXP:** AI onboarding calibration responses (worker skill assessment). Free-tier fallback when paid providers are rate-limited or budget-exhausted.

| Field | Value |
|-------|-------|
| Credential Type | API key |
| Env Var(s) | `GOOGLE_AI_API_KEY` |
| Where to Get It | aistudio.google.com → Get API Key |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** Free tier available. Used as final fallback in AIRouter chain. Supports Gemini 1.5 Pro for multimodal (image + text) tasks.

---

### 15. Greptile
**Use in HustleXP:** Automated PR code review as part of the Zenith Codex CI pipeline. Enforces constitutional invariants (financial safety rules, escrow FSM, error code standards). Generates PR summaries with confidence-scored comments. Gates merges via pipeline quality score.

| Field | Value |
|-------|-------|
| Credential Type | API key (GitHub OAuth-linked) |
| Env Var(s) | `GREPTILE_API_KEY` |
| Where to Get It | app.greptile.com → Settings → API Keys |
| Where It Lives | GitHub Actions secret + `~/.zshrc` (local dev) |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** GitHub-integrated. Repo indexed (38 files, status: COMPLETED). PR review runs on push to `main`. Degrades gracefully — pipeline continues but +0 bonus instead of +10 if unavailable.

---

## Communications

### 16. SendGrid
**Use in HustleXP:** Email address verification during signup. Task lifecycle notifications (accepted, completed, cancelled, disputed). Payment receipts and escrow release confirmations. Dispute resolution notifications. 1099-NEC tax form delivery at year-end. Subscription confirmation and billing alerts.

| Field | Value |
|-------|-------|
| Credential Type | API key + verified sender email |
| Env Var(s) | `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` |
| Where to Get It | app.sendgrid.com → Settings → API Keys + Sender Authentication |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** From: `verify@hustlexp.app`. Sender domain must be verified in SendGrid. All email features disabled gracefully if absent — no crashes.

---

### 17. Twilio
**Use in HustleXP:** Phone number OTP verification during worker onboarding. Identity confirmation via SMS for high-trust task categories. Uses Twilio Verify product (managed OTP service — not raw SMS).

| Field | Value |
|-------|-------|
| Credential Type | Account SID + Auth Token + Verify Service SID |
| Env Var(s) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` |
| Where to Get It | console.twilio.com → Account Info + Verify → Services |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Medium |

**Notes:** Must create a Verify Service in Twilio console to get the `TWILIO_VERIFY_SERVICE_SID`. Not plain SMS — uses Twilio Verify for OTP delivery and code validation.

---

### 18. Google Maps
**Use in HustleXP:** Task location geocoding (address → lat/lng for PostGIS storage). Geofence proximity verification (confirm worker is physically at task site). Distance calculation for task matching score algorithm. Heat map demand visualization. Reverse geocoding for display.

| Field | Value |
|-------|-------|
| Credential Type | API key |
| Env Var(s) | `GOOGLE_MAPS_API_KEY` |
| Where to Get It | console.cloud.google.com → APIs & Services → Credentials |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** Must enable in GCP: Maps JavaScript API, Places API, Geocoding API, Distance Matrix API. Set API key restrictions by IP or service in GCP console for security.

---

## Monitoring

### 19. Sentry
**Use in HustleXP:** Production error tracking and alerting. Performance monitoring (slow query detection). Crash reporting with full stack traces and context. Release health tracking across Railway deploys. Unhandled promise rejection capture.

| Field | Value |
|-------|-------|
| Credential Type | DSN (Data Source Name) |
| Env Var(s) | `SENTRY_DSN` |
| Where to Get It | sentry.io → Project → Settings → Client Keys (DSN) |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** Node.js SDK initialized in `server.ts`. Set `environment` tag to `production` or `staging`. Configure alert rules in Sentry dashboard for critical error thresholds.

---

### 20. PostHog
**Use in HustleXP:** Product analytics event tracking (task created, escrow released, user registered). Feature flag management for gradual rollouts. A/B testing via `analyticsRouter.trackABTest`. User funnel analysis. Cohort retention tracking. Both backend and iOS PostHog SDK feed into the same project.

| Field | Value |
|-------|-------|
| Credential Type | API key + Project ID |
| Env Var(s) | `POSTHOG_API_KEY` |
| Where to Get It | app.posthog.com → Project Settings → API Keys |
| Where It Lives | Railway env vars |
| Required? | Optional |
| Setup Complexity | Low |

**Notes:** Self-hostable if data residency is required. Free tier is generous. iOS PostHog SDK also in the HustleXP iOS app feeding the same project.

---

## Dev Tools

### 21. Figma
**Use in HustleXP:** Source of truth for all iOS screen designs and UI components. Design token definitions (colors, spacing, typography). Component library for the HustleXP design system. Design handoff reference for iOS SwiftUI implementation. MCP integration for pulling design context directly into Claude Code sessions.

| Field | Value |
|-------|-------|
| Credential Type | Personal access token (for MCP) + Figma account |
| Env Var(s) | N/A (MCP config at `~/.claude/`) |
| Where to Get It | figma.com → Account Settings → Personal Access Tokens |
| Where It Lives | MCP config file |
| Required? | No |
| Setup Complexity | Low |

**Notes:** MCP integration for design context in Claude Code. Use `/get_design_context` for screen specs. No Railway env var needed.

---

## AWS / Biometric ⭐ New

### 22. Amazon Rekognition
**Use in HustleXP:** Step-up authentication at task location to deter unauthorized account sharing.

**Workflow:**
1. GPS confirms worker is physically at the task site
2. `CreateFaceLivenessSession` — starts a video selfie liveness session
3. iOS `FaceLivenessDetector` component guides the worker through the challenge
4. `GetFaceLivenessSessionResults` — returns liveness score + high-quality reference image
5. `CompareFaces` — matches reference image against stored profile photo
6. If liveness score >0.99 AND face similarity >95% → task is unlocked

| Field | Value |
|-------|-------|
| Credential Type | AWS Access Key ID + AWS Secret Access Key + Region |
| Env Var(s) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| Where to Get It | aws.amazon.com/console → IAM → Users → Create access key |
| Where It Lives | Railway env vars (TBD — new service) |
| Required? | Optional (New — not yet implemented) |
| Setup Complexity | High |

**Notes:** Extends the existing `biometric.ts` router (`backend/src/routers/biometric.ts`). Must obtain explicit biometric consent from workers before capturing face data (legal requirement). Fallback: route failed checks to human review queue or support contact.

---

### 23. AWS S3 (Biometric)
**Use in HustleXP:** Stores worker reference profile photos used for `CompareFaces` identity verification. Separate bucket from Cloudflare R2 (which handles task media). Photos are encrypted at rest. Indexed by a Rekognition Face Collection for fast lookup.

| Field | Value |
|-------|-------|
| Credential Type | Same AWS credentials as Rekognition |
| Env Var(s) | `AWS_REKOGNITION_COLLECTION_ID`, `AWS_S3_BIOMETRIC_BUCKET` |
| Where to Get It | aws.amazon.com/console → S3 → Create Bucket + Rekognition → Collections |
| Where It Lives | Railway env vars (TBD — new service) |
| Required? | Optional (New — not yet implemented) |
| Setup Complexity | Medium |

**Notes:** HIPAA-adjacent data — encrypt at rest (SSE-S3 or SSE-KMS). Restrict bucket policy to backend IAM role only. Create a Rekognition Face Collection to index enrolled worker faces for fast comparison at runtime.

---

### 24. AWS Amplify SDK (iOS)
**Use in HustleXP:** Provides the pre-built `FaceLivenessDetector` camera UI component for iOS — avoids building custom face capture from scratch. Handles camera permissions, lighting guidance, and liveness challenge prompts. Returns a high-quality reference image to the backend for `CompareFaces`.

| Field | Value |
|-------|-------|
| Credential Type | Amplify config (Cognito Identity Pool or API Gateway endpoint) |
| Env Var(s) | N/A (iOS SDK config — `amplifyconfiguration.json` or `Amplify.xcconfig`) |
| Where to Get It | aws.amazon.com/amplify → Amplify CLI → `amplify init` |
| Where It Lives | iOS project config files |
| Required? | Optional (New — not yet implemented) |
| Setup Complexity | High |

**Notes:** Add via Swift Package Manager: `Amplify` + `AWSRekognitionPlugin`. Configure in `AppDelegate`. Handle outdoor scenarios (masks, sunglasses, low light) with clear in-app guidance. Fallback: if liveness check fails due to connectivity or lighting, route to manual human review or support contact.

---

## Security Rules

| ✅ Do | ❌ Never Do |
|-------|------------|
| Share Railway project access — dev reads env vars from dashboard directly | Send `.env` files over Slack, iMessage, or email |
| Share individual keys via 1Password secure share (time-limited link) | Commit secrets to git — they live in history permanently even if deleted |
| Create scoped/restricted API keys (Stripe restricted keys, R2 API tokens) | Screenshot credentials and send the image |
| Rotate any key you suspect was exposed immediately | Paste actual values into this file |

---

## Credential Color Legend (in XLSX)

| Color | Meaning |
|-------|---------|
| 🟢 Green row | Required service |
| 🟡 Yellow row | Optional service |
| 🔵 Blue row | New / not yet implemented (AWS) |
| 🔴 Red complexity | High setup complexity |
| 🟡 Yellow complexity | Medium setup complexity |
| 🟢 Green complexity | Low setup complexity |

---

*Last updated: 2026-03-14 — 24 services across 9 categories*
*Companion file: `credential-registry.xlsx` on Desktop*
