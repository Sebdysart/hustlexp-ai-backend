# HustleXP Backend Wiki

Welcome to the HustleXP Backend documentation. This wiki contains everything needed to deploy, operate, and maintain the Seattle Beta.

## Quick Links

| Document | Description |
|---|---|
| [Home](Home) | This page |
| [Deployment Guide](Deployment-Guide) | Railway production setup |
| [Go-No-Go Matrix](Go-No-Go-Matrix) | Launch decision criteria |
| [SEV Protocol](SEV-Protocol) | Failure escalation procedures |
| [War Room](War-Room) | Launch day operations |
| [Emergency Procedures](Emergency-Procedures) | Rollback and freeze |

---

## Architecture Overview

```
Frontend (Expo) → Railway (Fastify) → Neon (Postgres) + Upstash (Redis) + Stripe
                           ↓
                    AI Providers (DeepSeek, Groq, OpenAI)
```

## Phase Status

| Phase | Status |
|---|---|
| Phase 5: Financial Subsystem | ✅ Complete |
| Phase 6: Backend Hardening | ✅ Complete |
| Phase 6.5: Middleware Wiring | ✅ Complete |
| Phase 7: Production Validation | ⏳ In Progress |

## Key Files

| File | Purpose |
|---|---|
| `src/services/StripeMoneyEngine.ts` | Financial state machine |
| `src/middleware/idempotency.ts` | Duplicate POST prevention |
| `src/middleware/requestId.ts` | Log correlation |
| `src/middleware/rateLimiter.ts` | Rate limiting |
| `tests/phase6_verification.test.ts` | Destruction tests |

---

## Getting Started

1. Clone the repository
2. Copy `.env.example` to `.env`
3. Set required environment variables
4. Run `npm install`
5. Run `npm run dev`

See [Deployment Guide](Deployment-Guide) for production setup.
