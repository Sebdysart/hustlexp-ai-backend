# AGENTS.md

## Cursor Cloud specific instructions

### Project overview
Node.js backend (Hono + tRPC + BullMQ + PostgreSQL) for HustleXP, a gamified local task marketplace. See `README.md` for full architecture and API surface.

### Key commands
All documented in `CLAUDE.md` and `package.json` scripts. Quick reference:
- **Lint:** `npx eslint backend/src --ext .ts` (CI also lints `src/`)
- **Type check:** `npx tsc --noEmit`
- **Tests:** `npx vitest run` (unit tests mock all external services; DB-dependent tests skip gracefully when `DATABASE_URL` is unset)
- **Dev server:** `npm run dev` (port 3000, hot-reload via tsx)
- **Workers:** `npm run dev:workers` (BullMQ background workers, separate process)

### Non-obvious caveats
- The dev server starts and serves HTTP/tRPC even without a database or external services configured. It logs errors for missing `DATABASE_URL`, Firebase, Stripe, and Redis but does **not** crash — requests that need those services will fail at call time.
- `/health` returns 503 without `DATABASE_URL`; use `/trpc/health.ping` to verify the tRPC layer is alive.
- Unit tests (the vast majority, 218+ files) use `vi.mock()` and require **zero infrastructure** — only `npm install`. DB-dependent invariant/integration tests use `describe.skipIf(!hasDb)` and skip gracefully.
- CI uses Node 20 (`ci.yml`), but Node 22 works fine locally.
- The `.env` file is gitignored; create one from `.env.template` if you need external service credentials.
- ESLint is pinned to v8 (deprecated upstream but functional).
