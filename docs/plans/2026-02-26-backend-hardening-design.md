# Backend Hardening Design
**Date:** 2026-02-26
**Status:** APPROVED
**Approach:** Risk-First (A) + Layer-by-Layer (B) combined

---

## Objective
Make `hustlexp-ai-backend` bulletproof, scale-proof, and max-tier — eliminating every category of error that an audit (human or AI) would flag, while preserving all existing functionality.

## Scope
- Repo: `hustlexp-ai-backend` (Hono + multi-AI, the active backend)
- Out of scope: frontend, docs repo structural changes
- Delete: Citadel Governor, autonomous SDLC workflows (claude-implement, orchestrator auto-merge)

---

## Phase 0 — Purge the Noise
Remove the meta-infrastructure that was added but never proved value:
- Delete `.github/workflows/citadel.yml`
- Delete `.github/workflows/claude-implement.yml`
- Delete `.github/workflows/orchestrator.yml` (auto-merge section, keep CI)
- Delete `scripts/citadel-*.ts` (4 files)
- Delete `scripts/compute-readiness-score.ts`, `classify-pr-changes.ts`
- Delete `citadel-provenance.sqlite`, `citadel-constitution-report.md`, `citadel-provenance-report.md`
- Remove citadel deps from package.json: `@noble/ed25519`, `@noble/hashes`, `better-sqlite3`, `stryker-*`
- Close GitHub issue #12, delete `auto` label

---

## Phase 1 — Fix 5 Production Risks (Risk-First)

### Risk 1: DB Connection Pool Exhaustion
- Add `DB_POOL_MAX` env var (default 20, prod 50)
- Alert at 80% via Pino log + Prometheus metric
- Document PgBouncer setup in ops runbook

### Risk 2: Stripe Webhook Duplicate Processing
- Change INSERT into `processed_stripe_events` to `INSERT ... ON CONFLICT DO NOTHING`
- Log duplicate event IDs to Sentry
- Add test: concurrent webhook delivery of same event ID

### Risk 3: Auth Token Revocation Race
- Reduce Redis cache TTL from 15min → 5min
- Add revocation check on every admin/financial operation (not just cache miss)
- Test: verify revoked token rejected within 5s

### Risk 4: Financial Transaction Consistency (Escrow + XP)
- Wrap escrow release + XP award in single `db.serializableTransaction()`
- Add compensating transaction logging if XP fails post-escrow
- Test: escrow release fails → XP not awarded; escrow releases → XP awarded atomically

### Risk 5: AI Cascade Failure
- Add `AI_DEGRADED_MODE` env flag
- When all circuit breakers open: queue requests to BullMQ with 5min retry, return `202 Accepted` + job ID
- Add `/health/ai` endpoint showing per-model circuit breaker status

---

## Phase 2 — TypeScript Hardening
- Fix all 10 production `any` types:
  - `DisputeAIService.ts` (5x)
  - `JudgeAIService.ts` (3x)
  - `AnalyticsService.ts` (2x) — or `src/utils/aiEventLogger.ts`
  - `ExpertiseSupplyService.ts` (2x)
  - `InstantModeKillSwitch.ts` (1x)
- Add `"noUncheckedIndexedAccess": true` to tsconfig (catches array OOB)
- Verify `npx tsc --noEmit` exits 0 with zero warnings

---

## Phase 3 — Error Handling Audit
- Every service method must either: return typed result OR throw typed error (no silent failures)
- Add `Result<T, E>` pattern to all AI service calls (success/error explicit)
- Ensure every Hono route has explicit error response shape in JSDoc
- Confirm global error handler in `src/index.ts` catches and formats all unhandled rejections

---

## Phase 4 — API Contract Alignment
- Audit every route in `src/routes/` + `src/index.ts` against `HUSTLEXP-DOCS/specs/04-backend/API_CONTRACT.md`
- Every endpoint must have: Zod input schema, typed response, auth level documented
- Generate OpenAPI spec from routes (or tRPC types) for frontend contract

---

## Phase 5 — Test Coverage Gaps
- Integration test for every route that touches Stripe or Firebase
- E2E test: full task lifecycle (create → fund → accept → complete → payout)
- Load test baseline: 50 concurrent users, p99 < 500ms
- All tests pass: `npx vitest run` exits 0

---

## Phase 6 — CI Cleanup
- Keep `ci.yml`: lint + typecheck + test on every PR
- Keep `security.yml`: dependency audit
- Remove all Citadel/autonomous workflows
- Add branch protection: require CI green before merge

---

## Success Criteria
- `npx tsc --noEmit` → 0 errors
- `npx eslint src/` → 0 errors, 0 warnings
- `npx vitest run` → all pass
- Zero `any` in production `src/` (excluding test files)
- All 5 production risks have fixes + tests
- No AI audit tool can find a structural issue
