# AGENTS.md

Cursor/IDE instructions for this project. For Claude-specific protocol and invariants, see [CLAUDE.md](CLAUDE.md).

## Cursor Cloud specific instructions

### Project overview
Node.js backend (Hono + tRPC + BullMQ + PostgreSQL) for HustleXP, a managed local-work transaction network. See `README.md` for full architecture and API surface.

### Key commands
All documented in `CLAUDE.md` and `package.json` scripts. Quick reference:
- **Lint:** `npm run lint` (the required context allows zero warnings)
- **Type check:** `npx tsc --noEmit`
- **Release test gate:** `npm run test:required` with the exact disposable local PostgreSQL identity on port 5432 and isolated Redis on port 16379. This compiles, recreates only the allowlisted test databases, runs the complete Vitest suite, and rejects any failed, skipped, pending, or todo test.
- **Diagnostic test run:** `npm test` is useful during development, but database-dependent cohorts can skip when the required disposable services are absent. It is never sufficient release evidence.
- **Dev server:** `npm run dev` (port 3000, hot-reload via tsx)
- **Workers:** `npm run dev:workers` (BullMQ background workers, separate process)

### Non-obvious caveats
- The dev server starts and serves HTTP/tRPC even without a database or external services configured. It logs errors for missing `DATABASE_URL`, Firebase, Stripe, and Redis but does **not** crash — requests that need those services will fail at call time.
- `/health` returns 503 without `DATABASE_URL`; use `/trpc/health.ping` to verify the tRPC layer is alive.
- Many unit tests mock external services and require no infrastructure. Database-dependent cohorts remain conditionally declared for diagnostic runs, but the required gate supplies disposable local PostgreSQL/Redis and treats every skip or todo as a failure.
- CI and the supported local runtime use Node 22.
- The `.env` file is gitignored; create one from `.env.template` if you need external service credentials.
- ESLint is pinned to v8 (deprecated upstream but functional).
