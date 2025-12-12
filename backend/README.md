# HustleXP Backend (Hono + tRPC)

## Setup
- Install deps: `npm install`
- Copy env: `cp env.backend.template env.backend` and fill server-only secrets (Postgres, Redis, Stripe, Firebase Admin, R2, AI keys). Keep this file out of git.
- Run server: `PORT=5000 bunx tsx backend/hono.ts` (uses stubs for DB/Redis/Stripe when env vars are missing).

## Database
- Apply schema: `psql "$DATABASE_URL" -f backend/database/schema.sql`
- The app will stub queries when `NODE_ENV=development` or `DATABASE_URL` is empty.

## Endpoints
- Health: `GET /api/health`
- tRPC: `POST /api/trpc`
- Auth: Firebase Admin ID token required for protected routes.
- AI: `/api/ai/orchestrate`, `/api/ai/compose`
- Gamification samples: `/api/coach/*`, `/api/badges/*`

## Notes
- CORS honors `ALLOWED_ORIGINS` (comma-separated); defaults to `*` if unset.
- Stripe + R2 + Redis are stubbed; wire real clients before production.
- Avoid logging secrets; Firebase verification uses Admin credentials only.
