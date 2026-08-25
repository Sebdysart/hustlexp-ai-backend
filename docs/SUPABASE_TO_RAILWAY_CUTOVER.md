# Supabase to Railway PostgreSQL cutover

Status: `PROPOSED_NOT_BUILT / NOT_ACTIVE_GOVERNOR_NODE`

Production effects authorized: `NONE`

Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md). Railway PostgreSQL owns the target canonical marketplace lifecycle. Supabase remains an overlay and compatibility surface during convergence; this document is a staged migration proposal, not permission to move data, redirect traffic, delete functions, rotate keys, or deploy.

## Decision

Migration is feasible and desirable, but the inspected source does not support treating Supabase as a removable website SDK. It implements a second backend for website data and automation; whether every observed surface is currently deployed or called remains `UNKNOWN` without exact runtime evidence.

Source-locked scope observed on `2026-08-25` in the clean site worktree at commit `843e37c0fafa65ba63612cffd0e17476d4c76593` (tree `229958fac537f61d2f342a625dfb6c7a810458cd`):

- 49 executable Supabase Edge Function directories, plus one shared function package
- 145 SQL migration files
- lead classification, inbound messaging, quotes, supply, dispatch, payments, action links, webhooks, and lifecycle automation

Those counts are source-dated inventory, not proof of live deployment or current callers. Recompute them at the exact cutover candidate.

The canonical engine has already started the replacement:

- `backend/database/migrations/010_web_platform_tables.sql`
- `backend/src/routers/web/leads.ts`
- `backend/src/routers/web/ops.ts`
- `backend/src/routers/web/actionLinks.ts`

Those routes replace only a subset of the Supabase surface. In particular, `hustlexp-site/src/lib/leadApi.ts` deliberately keeps lead ingress in Supabase because Supabase triggers and the automation belt consume `public.leads` there. Repointing the form alone would silently bypass that automation.

## What moves where

| Current Supabase responsibility | Railway target |
|---|---|
| PostgreSQL tables, functions, triggers, RLS | Railway PostgreSQL schema, constraints, and reviewed migrations |
| Edge HTTP functions | Hono REST/tRPC routes with shared Zod contracts |
| Cron and lifecycle functions | BullMQ repeatable jobs and engine workers |
| Trigger-produced work | Transactional outbox rows consumed by workers |
| Operations/admin authorization | Named short-lived session into role-scoped `opsProcedure`; server-derived actor, resource RBAC, typed engine command, expected version, immutable accepted/rejected result, recent step-up, and dual approval where policy requires it; never a browser-supplied shared secret |
| Supabase Auth poster sessions | Firebase Auth or an explicitly designed engine session flow |
| Supabase Storage uploads | Existing engine object-storage abstraction (R2/S3-compatible) |
| Realtime subscriptions | Existing SSE/Redis realtime path where needed |
| Function secrets | Railway service variables |

## Required sequence

### 1. Freeze and inventory

- Freeze new Supabase schema work except production fixes.
- Export the live schema, row counts, constraints, triggers, functions, cron jobs, storage objects, auth identities, and secret names.
- Classify each Edge Function as public API, admin API, webhook, scheduled job, worker, or dead code.
- Record callers for every function. The 145 historical migrations are evidence, not a safe production install script.

### 2. Define the Railway contracts

- Reconcile the current Supabase schema with the engine baseline and migration ledger.
- Preserve stable external identifiers and create explicit identity mapping tables where Supabase and Firebase IDs differ.
- Move shared request/response schemas to a package both the website and engine can test.
- Replace `publicProcedure + adminKey` scaffolding with authenticated, role-scoped `opsProcedure` commands. Identity is server-derived from a named short-lived session; each command requires closed RBAC/capability checks, expected version, strict reason/action codes, immutable accepted or rejected results, recent step-up, and dual approval where policy requires it.

### 3. Port the public and admin APIs

Start with bounded, already-partial replacements:

1. action-link public/admin;
2. survey ingress and statistics;
3. lead admin reads/updates;
4. task drafts, quotes, roster, and public flags;
5. poster auth/task APIs, uploads, and remaining ops screens.

Route website calls through one engine API client instead of constructing Supabase function URLs in components.

### 4. Port automation before lead ingress

Move the complete chain as one unit:

```text
lead-submit
  → classification/inbound events
  → lifecycle autopilot
  → quote generation and delivery
  → supply and dispatch
  → engine reservation/payment lifecycle
```

Implement database changes and outbox writes in one Railway PostgreSQL transaction. BullMQ workers perform external calls with idempotency keys and retries. Lead ingress must remain on Supabase until this chain passes parity tests.

### 5. Migrate data

- Provision Railway PostgreSQL with required extensions and backups/PITR.
- Apply the engine baseline plus reviewed convergence migrations.
- Run a full export/import into staging, then validate row counts, foreign keys, enum/state mappings, money totals, and token hashes.
- Rehearse a final delta migration or use a short write freeze. Do not replay all 145 Supabase migrations against Railway; migrate the resulting live state through reviewed DDL and data transforms.
- Copy storage objects separately and verify checksums and access controls.

### 6. Shadow and cut over

- Shadow Supabase events into Railway without triggering customer side effects.
- Compare lead routes, quotes, consent state, message suppression, assignment decisions, and payment state.
- Switch reads by feature flag, then switch writes endpoint by endpoint.
- Switch `lead-submit` only after automation parity and recovery drills pass.
- Remove `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` only when production caller search is empty.

### 7. Retire safely

- Keep Supabase read-only through the rollback window.
- Archive schema, data, function source, audit logs, and storage inventory.
- Remove Supabase code/tests/migrations from the website in one dedicated cleanup change.
- Revoke Supabase keys and delete the project only after backup restore and Railway rollback tests succeed.

## Cutover gates

Do not retire Supabase until all are true:

- no production frontend file constructs a Supabase URL;
- every Edge Function has a Railway replacement or an approved deletion record;
- Supabase cron, webhook, and database-trigger inventories are empty or redirected;
- named short-lived Operations sessions, role-scoped `opsProcedure`, server-derived identity, resource RBAC, expected-version commands, immutable results, step-up/dual approval policy, and object storage work without Supabase;
- financial totals and lifecycle state counts reconcile;
- shadow automation produces equivalent decisions without duplicate messages or charges;
- Railway backup restore, worker replay, and rollback drills pass;
- legal/privacy copy is updated to name the actual datastore only at cutover.

## Immediate recommendation

Keep the Supabase website backend contained while the active task-first fake-FSE PostgreSQL authority node is completed. Freeze new Supabase canonical task/payment/assignment behavior; inventory and quarantine existing bypasses. After the active node and migration lineage are independently accepted, replacement slices must route typed commands through the engine with runtime wiring, authorization, observability, migration proof, and rollback/forward-repair. Lead ingress and lifecycle automation remain late cutover work because moving intake before its dependent automation would silently drop or duplicate effects.
