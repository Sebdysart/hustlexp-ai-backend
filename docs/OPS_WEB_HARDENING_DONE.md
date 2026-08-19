# Ops `/ops` hardening — work completed

**Date:** 2026-08-19  
**Scope:** Railway `webOps` hardening, Command-center read cutover, liquidity restore, tests/hygiene.  
**Out of scope (intentionally deferred):** Remounting mutation Ops panels until Railway mutation ports exist.

---

## Goal

Make live `/ops` safer and Railway-first for **read** paths used by Command center, liquidity, and engine-bridge, without breaking Supabase fallback during cutover.

---

## What was done

### 1. Auth hardening (Railway `webOps`)

| Path | Gate |
|------|------|
| Browser ops (`getTaskDraft`, quotes, hustlers, leads, liquidity, flags update, …) | Firebase + `operationsAdminProcedure` (`can_manage_operations`) |
| `listEngineTasks` (engine-bridge-admin) | Service key only — timing-safe compare |

- New helper: `backend/src/routers/web/opsServiceKey.ts`
- Prefers `ENGINE_OPS_ADMIN_KEY` (≥16 chars); falls back to `OPS_ADMIN_KEY`
- Documented in `.env.template`

### 2. Display-safe drafts & transactional quotes

- `getTaskDraft` returns a **whitelist** of columns (no `card_token_hash` / `ip_hash`)
- `createQuote` / `markQuoteSendReady` run in a **transaction**
- Explicit eligibility codes: `already_linked`, `not_eligible`

### 3. PII redaction

- `listHustlers`: phone/email redacted for ops roster reads
- `listOpsLeads`: lead names reduced to **initials**; omits phone/email/answers/utm-style fields

### 4. Liquidity API restored

- `webOps.getLiquidity` (Firebase ops admin)
- `operations.getLiquidity` (existing operations router alignment)
- REST `GET /admin/liquidity` (Bearer via ops service key) — registered from `serverOpsAdminRoutes.ts`
- Service: `backend/src/services/OpsLiquidityService.ts`

### 5. Command-center read paths on Railway

New/expanded `webOps` procedures:

- `listQuotes`
- `listOpsLeads`
- `getLeadReport`
- `getCommandEngineJoin`
- `getLiquidity`

Site client: `hustlexp-site/src/lib/opsApi.ts`

- Railway-first tRPC calls with Supabase fallback
- Wired into Command center, AI Activity, and related API helpers
- Command center attempts Firebase unlock **without** requiring a pasted key first

### 6. Database migration

`backend/database/migrations/20260819_ops_web_hardening.sql`

- `feature_flags.key` column + sync with `name` (Supabase parity)
- `ops_action_audit` append-only audit table
- Registered as `OPS_WEB_HARDENING_MIGRATION` in engine-automation migration registry

### 7. Tests & static checks

| Check | Status |
|-------|--------|
| `backend/tests/unit/web-ops-contracts.test.ts` | Pass |
| `backend/tests/unit/ops-service-key.test.ts` | Pass |
| `backend/tests/unit/web-ops-hardening-static.test.ts` | Pass |
| `scripts/verify-automation-contracts.mjs` | Pass |
| `scripts/check-ops-pii-static.mjs` | Pass |
| Site `src/shared/opsBackendCutoverReconcile.test.ts` | Pass (4) |

Updated related engine/edges tests for the new service-key env.

### 8. Cutover docs

`docs/SUPABASE_TO_RAILWAY_CUTOVER.md` updated to reflect the hardened Railway-first read cutover and that mutation panels stay unmounted.

---

## Key files touched

**Backend**

- `backend/src/routers/web/ops.ts`
- `backend/src/routers/web/opsServiceKey.ts`
- `backend/src/services/OpsLiquidityService.ts`
- `backend/src/serverOpsAdminRoutes.ts`
- `backend/src/routers/operations.ts` (liquidity)
- `backend/database/migrations/20260819_ops_web_hardening.sql`
- `.env.template`
- Unit/static test files under `backend/tests/unit/` and `scripts/`

**Site**

- `src/lib/opsApi.ts`
- `src/lib/api.ts`, `src/lib/trpcClient.ts`
- `src/components/OpsCommandCenter.tsx`
- `src/components/OpsAiActivity.tsx`
- `src/shared/opsBackendCutoverReconcile.test.ts`

---

## Staging / production checklist (ops still need to do)

1. Set matching secrets on Railway **and** Supabase: `ENGINE_OPS_ADMIN_KEY` (≥16), plus `OPS_ADMIN_KEY` on Railway as needed.
2. Confirm Supabase engine bridge env: `ENGINE_API_URL`, `ENGINE_API_HOST_ALLOWLIST`, `ENGINE_CONTRACT_VERSION`.
3. Apply migration `20260819_ops_web_hardening` on the Railway DB.
4. Ensure at least one Firebase ops user has `admin_roles.can_manage_operations`.
5. Smoke:
   - `listEngineTasks` with service key / `engine-bridge-admin`
   - Firebase `webOps.getLiquidity` / `listOpsLeads` / Command center load
   - Bearer `GET /admin/liquidity`

---

## Known limitations (not bugs of this pass)

- `getCommandEngineJoin` does not fully join pointer↔engine (no `engine_task_id` on Railway quotes yet).
- Liquidity may still fall back to mock/empty paths if upstream data is missing — treat live smoke as required.
- `getPublicFlags` remains a public procedure (by design for current contract).
- Mutation Ops UI panels remain **unmounted** until Railway mutation ports are complete.

---

## Related plan priority (completed)

1. Harden Railway `webOps` auth + drafts/quotes/PII  
2. Fix liquidity  
3. Port Command-center reads  
4. Tests / cutover hygiene  
5. Later: full mutation remount on Railway only  
