# HustleXP — Handoff: Roadmap C (C7 ACCEPTED, C8 next)

> Updated 2026-05-31 (C7). **C7 (Stripe Elements funding) manual acceptance PASSED end-to-end** against live Neon + Firebase `hustlexp-fly-new` + Stripe **test** mode. Full poster loop C4 → C5 → C6 → C7 ran live: estimate ($30 / 1 hr 15 min / standard_physical), availability empty-state, auth gate + Firebase sign-in, `user.register` 200, `task.create` 200, `escrow.createPaymentIntent` 200 returning `{paymentIntentId, clientSecret, amount, escrowId}`, a PENDING `escrows` row persisted with the PI id, a **real Stripe test charge** on the PaymentIntent (4242 card via `pm_card_visa`, 3000¢, single charge `ch_3Td2eQ…`, status `succeeded`), then PENDING→FUNDED via the hardened `escrow.confirmFunding` (server-side PI verification), and the UI showed the exact copy **"Task funded. Next: Hustler matching."** only after the backend reported FUNDED. **DB probe (product state = backend state):** escrow `4b69768c-4af8-4cad-958b-63df11c60fba` task `349222ff-80f5-466f-990e-b92fd9cd61fd` → `state=FUNDED`, `stripe_payment_intent_id=pi_3Td2eQ…` (not null), `version=2`, `funded_at` set, single escrow row (no duplicate). **No banned dispatch/match/on-the-way/insurance copy** in any state. Two backend issues C7 exposed were fixed: (a) `invalidateCacheByTag` fail-open (Upstash crash from C6 — `task.create` now returns 200 under the real rate-limited Upstash, confirming the fix); (b) `escrows.version` column missing on live Neon (migration `009`, applied to dev Neon with explicit approval). **Next step: C8 (poster dashboard shell) — out of scope for this session.**
>
> **Acceptance method note (honest):** the literal "type 4242 into the Stripe Payment Element and click Pay" keystrokes could not be automated — the card inputs live in a cross-origin `js.stripe.com` iframe the headless preview can't type into. Instead the PaymentIntent was confirmed with the equivalent test card (`pm_card_visa` = 4242) via Stripe's API, and the funded path was driven through the real `return_url` redirect-resume → polling → `confirmFunding` flow (which also proves the webhook-off resilience path, since no `stripe listen` was running). This exercises the identical backend money path and the identical UI funded-gating; only the in-iframe keystrokes were substituted. The empty-field submit was exercised through the real UI and produced the correct error-recovery state ("Your card number is incomplete." + Try again).
>
> _(Prior: C6 manual acceptance passed end-to-end 2026-05-31 — `task.create` 200, task `a90f33a1-…` persisted, post-create copy "Task draft created. Secure payment is next.", zero Stripe calls, zero banned copy. Web `d96f8ca` unchanged during C6 acceptance.)_

---

## 1. Current Objective

**Roadmap C: Poster-side web liquidity engine.** C1–C7 are **done and accepted**. The full poster outcome loop is live: a stranger describes a task → AI estimate → signs up at Dispatch → `task.create` → **funds with Stripe test mode → escrow state FUNDED**. **Next step: C8 (poster dashboard shell). Do not start C8 in this session — C7 stops here.**

Product goal (DONE-C): a Redmond stranger opens the web app, describes a real task, gets an estimate, signs up only at Dispatch, funds with Stripe test mode, and sees the task in a poster dashboard (C8).

---

## 2. Repo / Branch State

| Repo | GitHub path | Branch | HEAD | Clean? |
|------|------------|--------|------|--------|
| Backend | `Sebdysart/hustlexp-ai-backend` | `claude/audit-backend-workflow-mFb7a` | `2c474abe` (+ handoff commit) | Yes |
| Frontend/mobile | `Sebdysart/HUSTLEXPFINAL1` | `claude/audit-backend-workflow-mFb7a` | `e038545` | Yes |

> Local web checkout for this session lives at `~/Desktop/hustlexp-web` (a symlink → `~/Documents/HUSTLEXPFINAL1/web`). Backend at `~/Desktop/hustlexp-ai-backend`.

**PR #211** (`claude/audit-backend-workflow-mFb7a` → `main` on backend): open, not merged. Latest backend push was the C2 prerequisite (`chore(backend): emit AppRouter.d.ts for web type sharing`). CI gates that PR #211 already had green stayed green after the C2 push (typecheck, lint, tests, build, audit). The 4 pre-existing failures (codeql, snyk, security audit, dependency-review) are unchanged — same upstream dep vulns / infra issues that exist on `main`.

**Git proxy note:** The frontend repo requires uppercase path `Sebdysart/HUSTLEXPFINAL1` and `local_proxy@` user prefix in the git remote URL on some setups. Commits need `git -c commit.gpgsign=false commit` (signing server rejects). The C2 push worked from a clean macOS checkout without needing the proxy URL — fall back to the proxy form only if `git push` rejects.

---

## 3. Completed Work

### Roadmap B — CLOSED ✅ (pre-revenue money/trust hardening)

| Commit | What |
|--------|------|
| `b783490` | Gate-1: GAP-3 dispute-release gate + insurance pool kill-switch (legal hold) |
| `911c769` | Gate-1 test fixes (GAP-3 behavioral change) |
| `5e431bc` | **Money-path fix: real Stripe refund in EscrowService.refund()** (was state-only, never returned poster's money) |
| `ee7baf9` | Fixed 9 pre-existing failing test suites (was 10 failing → 0) |
| `70b0c4c` | Fixed 12 pre-existing lint errors (backend/src clean) |
| `c13df53` | B#1: stale-escrow auto-refund job (72h unaccepted → refund, hourly cron) |
| `484191d` | B#3: trust-tier auto-restoration on chargeback dispute won |
| `95c6040` | B#4: daily ledger↔Stripe reconciliation job (drift detection + CRITICAL alert) |
| `a53a11c` | B#6: chargeback auto-evidence to Stripe (quality-gated: ≥3 signals auto-submit, <3 flags admin) |
| `223da1b` | B#5: fraud guard at all 7 decision points (payout: fail-closed; others: fail-open) |
| `037230c` | PR #211 review fixes: hook scripts (permissions, exit-code, untracked+branch detection) |
| `a6073d8` | CI fix: remove tsconfig references (PR regression) |
| `8cd1d1e` | CI fix: resolve 13 pre-existing strict-mode TypeScript errors |

Backend test suite: **258 files / ~5,900 tests / 0 failures.** TypeScript: 0 errors. Lint: clean.

### Roadmap C1 — Scaffold ✅
Commit `8a3076d` on `HUSTLEXPFINAL1`. Next.js 16.2.6 + React 19 + Tailwind v4, color tokens from `COLOR_SEMANTICS_LAW.md` v3.0.0, env stubs in place. Build + lint clean.

### Roadmap C2 — tRPC + Firebase Foundation ✅
| Repo | Commit | What |
|------|--------|------|
| Backend (`hustlexp-ai-backend`) | `37d283a8` | `chore(backend): emit AppRouter.d.ts for web type sharing` — adds `dts-bundle-generator` + `scripts/emit-approuter-types.ts` + `npm run emit:trpc-types`. Generated `dist-types/AppRouter.d.ts` (5,777 lines, ~140KB, single self-contained bundle). Added `export` to 46 internal type declarations across 24 services so the declaration emit doesn't trip TS4023. Backend `tsc --noEmit` + `eslint` stay clean. |
| Frontend (`HUSTLEXPFINAL1`) | `27f7809` | `feat(web): add trpc firebase foundation` — installs `@trpc/client`, `@trpc/react-query`, `@tanstack/react-query`, `firebase`. Vendors `web/types/trpc/AppRouter.d.ts` from the backend bundle. Adds `lib/firebase.ts` (lazy browser-only init, never touched during SSR/build), `lib/trpc.ts`, `providers/trpc-provider.tsx` (with custom `authTokenRefreshLink` that retries once on 401 after `getIdToken(true)`), `providers/auth-provider.tsx`. Wires both providers into `app/layout.tsx`. Adds `app/dev/me/page.tsx` (dev-only smoke page — returns `notFound()` in prod — shows `health.ping`, `user.me`, plus Firebase email/password sign-in form). Adds `scripts/sync-trpc-types.sh` for regen. Web `tsc --noEmit` + `lint` + `build` all EXIT 0. |

**AppRouter type-sharing decision (made at C2):** **generated standalone bundled `.d.ts`** (handoff fallback #2). Workspace reference was the user's first pick but the layout (two separate GitHub repos) made it equivalent in cost to the "last resort" submodule path (Vercel auth + slower builds + tighter cross-repo coupling). The bundled `.d.ts` keeps web builds self-contained on Vercel. Regen via `npm run emit:trpc-types` in the backend + `./scripts/sync-trpc-types.sh` in the web after every backend AppRouter change.

### Roadmap C3 — Public Poster Funnel Homepage ✅
| Repo | Commit | What |
|------|--------|------|
| Frontend (`HUSTLEXPFINAL1`) | `bff1607` | `feat(web): build poster funnel homepage` — replaces the C1 placeholder at `web/app/page.tsx` with the real funnel (server-rendered shell + `<FunnelForm>` client island at `web/components/funnel-form.tsx`). Above the fold: H1 "What can you get done today?", info-blue escrow promise, task textarea, 5-digit ZIP with Eastside allow-list (Redmond/Sammamish/Bellevue/Kirkland/Issaquah), 6 single-select category chips (moving help, furniture assembly, dump runs, yard cleanup, errands, event setup), purple "Get estimate" CTA. Non-Eastside ZIP shows honest waitlist signal. Submit shows a stub "Generating estimate…" panel (no backend call yet — C4 swaps in the real mutation + `/draft` route). Below the fold: 4 honest trust bullets with inline SVG icons (escrow / proof-before-release / "Poster feedback appears on Hustler profiles as tasks are completed." / identity & trust checks for higher-risk tasks — deliberately NOT "background-checked" until Checkr is live). Layout `<title>` retitled to mirror the H1. Verified: lint/typecheck/build EXIT 0; rendered HTML has 0 banned-term matches. |

**Constraints honored in C3:** no fake liquidity, no fake completed-task counts, no fake response times, no "background-checked" copy, no insurance/self-protection claims, no green on the entry surface, no Hustler web flows, no new deps (shadcn deferred to C8 per "no detour" directive).

### Roadmap C4 — Draft Estimate Flow ✅ (manually accepted 2026-05-30)

| Repo | Commit | What |
|------|--------|------|
| Backend (`hustlexp-ai-backend`) | `293a508d` | `feat(task): add public draftEstimate procedure (C4)` — adds `task.draftEstimate` `publicProcedure.mutation` mirroring the auth-gated `evaluateDraft` shape (compliance gate → ScoperAI scoping) but anonymous + write-free. Three-layer rate limit: per-IP burst (5/60s) + per-IP daily (30/day) fail OPEN, GLOBAL daily (2000/day) fails CLOSED on Redis outage. IP derived from `x-forwarded-for` → `x-real-ip`. Compliance `hard_block` → BAD_REQUEST with canonical "blocked by compliance check" message. Single LLM call, no retries. Description never logged in full (length + 40-char preview only). Extends `Context` with optional `req?: Request` so the public path can read headers; auth-narrowing middlewares strip it. Output: `{title, cleanedDescription, category, recommendedPriceCents, estimatedDurationMinutes, requiredTools, urgency, safetyNotes, followUpQuestions}`. Regenerates `dist-types/AppRouter.d.ts`. |
| Backend (`hustlexp-ai-backend`) | `e3f09b9c` | `fix(task): allow draftEstimate from dev localhost without a reverse proxy (C4)` — surfaced by manual browser acceptance. Without a reverse proxy in front of the dev backend, browsers don't set `x-forwarded-for`/`x-real-ip` and every call was being rejected with BAD_REQUEST. `deriveIpKey` now falls back to a shared `'dev-local'` rate-limit key only when both headers are absent **and** `NODE_ENV !== 'production'`. Production still refuses unkeyed requests — no wallet-drain vector introduced. AppRouter bundle byte-identical (procedure shape unchanged). |
| Frontend (`HUSTLEXPFINAL1`) | `3559da1` | `feat(web): wire homepage to draftEstimate (C4)` — replaces the C3 `setSubmitted(true)` stub in `web/components/funnel-form.tsx` with `trpc.task.draftEstimate.useMutation()`. Adds explicit C3-chip → backend-template-slug map (`moving`/`dump`/`yard`/`errands` → `standard_physical`, `assembly` → `in_home`, `event` → `event_appearance`) so unmapped slugs can't reach the procedure. Error mapping: `TOO_MANY_REQUESTS` → "You've made a lot of requests — try again in a minute"; `SERVICE_UNAVAILABLE` → "Our estimator is taking a breath — please try in a bit"; else server message. Result panel shows the eight output fields with hidden-when-empty sections for tools/safety/follow-ups. `localStorage["hustlexp.draft.v1"]` persists `{input, result, createdAt}` with 24h expiry and schema-mismatch guard; refresh restores; Start Over clears both UI and storage. Syncs `web/types/trpc/AppRouter.d.ts` from the backend bundle. |

**Verification log:**
- Backend: 14/14 `draftEstimate` tests, 128/128 task-router tests, `npx tsc -b` clean, `npx eslint backend/src` clean, `npm run emit:trpc-types` clean.
- Web: `npm run lint` clean, `npx tsc --noEmit` clean, `npm run build` clean (all 5 routes prerendered).
- Manual browser acceptance via Claude in Chrome agent against `localhost:8081` → backend on `localhost:3000`:
  - Valid Eastside task ("Mount a 55-inch TV in my Bellevue apartment Saturday afternoon", ZIP 98004, Furniture assembly chip) → POST 200 in ~3s.
  - Loading state observed (button "Estimating…", `aria-busy=true`).
  - Result panel rendered: title, cleaned description, category `in_home`, $30.00, 1 hr 15 min, urgency Normal.
  - Hard refresh restored the draft from `localStorage["hustlexp.draft.v1"]`.
  - Start Over cleared both UI state and the localStorage key.
  - Off-area ZIP `90210` blocked client-side with the Eastside-only message; no `draftEstimate` network call fired.
  - Copy/legal audit: no `background checked` / `insurance` / `protection` / fake liquidity / fake response times / fake nearby counts. Existing copy ("identity and trust checks", "escrow until you approve", "photo or video proof") all describe real mechanics.

**Open C4 caveat (carry forward):**
- Local dev uses the shared `dev-local` rate-limit key only when `NODE_ENV !== 'production'` AND neither IP header is present. Every dev request lands in the same bucket. Production still rejects unkeyed requests, so this only relaxes the local-developer ergonomics.

**Out-of-scope-for-C4 honored:** no signup gate, no task creation, no Stripe, no dashboard, no new routes, no new UI library, no analytics expansion, no Hustler-side flows, no SEO pages. The `/draft/[id]` route originally sketched in the C4 plan was intentionally dropped in favor of an inline result panel + localStorage persistence — simpler, refresh-safe, and removes the need for a new task_drafts table this round.

### Roadmap C5 — Backend `geo.availability` ✅ (web pending)

| Repo | Commit | What |
|------|--------|------|
| Backend (`hustlexp-ai-backend`) | `6173fff0` | `feat(backend): C5 geo.availability — truthful local marketplace aggregate` — adds new `geo` router under SYSTEM domain with a single `availability` `publicProcedure.query`. Input: `{ zip: /^\d{5}$/ }` against an Eastside allow-list (Redmond/Sammamish/Bellevue/Kirkland/Issaquah) — unknown zips throw BAD_REQUEST. Three parallel SELECT aggregates over `tasks` + `task_assignments` for the mapped city: posted-last-7d totals + per-category breakdown, completed-last-30d totals + per-category counts, average minutes-to-accept. **k-anonymity guard:** `averageTimeToAcceptMinutes` returns `null` when N < 3 to prevent single-task inference. **Truthfulness invariants:** no PII columns selected (no email/phone/address/user_id/description), no writes, no fabrication; `nearbyHustlerCount` returns `0` with `hustlerSignalAvailable: false` until a real Hustler-proximity signal exists. `emptyState: true` when both 7-day and 30-day counts are zero. **Refactor:** `deriveIpKey` + the three-layer rate-limit (per-IP burst 5/60s fail-OPEN, per-IP daily 30/day fail-OPEN, GLOBAL 2000/day fail-CLOSED) lifted from `task.ts` into `backend/src/routers/_shared/publicRateLimit.ts` so all public anonymous endpoints share one invariant set. `task.draftEstimate` now imports the helper — behavior unchanged (128/128 task-router tests still pass). New tests in `backend/tests/unit/geo-router.test.ts`: 12 cases — happy path / empty state / k-anon below threshold / k-anon exact threshold / malformed ZIP / non-Eastside ZIP / burst rate-limit / global kill-switch / Redis-fail-closed / no-IP in production rejected / dev-local fallback / ZIP→city mapping (98075 → Sammamish). |

**Verification log:**
- `npx tsc -b` clean.
- `npx eslint backend/src` clean.
- `npx vitest run backend/tests/unit/geo-router.test.ts` → 12/12 passed.
- `npx vitest run backend/tests/unit/task-router.test.ts` → 128/128 passed (refactor confirmed non-breaking).
- `npm run emit:trpc-types` → `dist-types/AppRouter.d.ts` regenerated (5832 lines, +55 from C4 baseline for `geo.availability` route).

**Known remaining risks / carry-forward:**
- Hustler-proximity signal still absent. `nearbyHustlerCount` returns `0` + `hustlerSignalAvailable: false`; the web layer must hide any "Hustlers nearby" UI until a future roadmap item flips the signal on.
- No Redis caching layer on the aggregates yet. Three SELECTs per call are cheap at C5 volume; revisit if homepage QPS climbs.
- `tasks.city` is the join key (no `zip` column on `tasks`). The static ZIP→city map in `geo.ts` mirrors the web funnel allow-list. Adding a ZIP outside the allow-list requires touching both surfaces.
- No PostGIS / ST_DWithin. Simple city-equality WHERE clause. Acceptable until we serve multiple zips per city differently.

### Roadmap C5 — Web `<LocalAvailability>` ✅ (live-data browser acceptance pending DB fix)

| Repo | Commit | What |
|------|--------|------|
| Frontend (`HUSTLEXPFINAL1`) | `e9cba74` | `feat(web): add truthful local availability module` — synced `web/types/trpc/AppRouter.d.ts` from backend `dist-types/AppRouter.d.ts` (5831 lines; `geo.availability` query now visible to the client). New `web/components/local-availability.tsx` calls `trpc.geo.availability.useQuery({ zip }, { enabled, staleTime: 5min, refetchOnWindowFocus: false, retry: false })` and renders only fields backed by real backend values: `emptyState` → "HustleXP is opening availability in your area." + "Post a task to help us route the right Hustlers. Real marketplace data appears here as tasks complete."; `hustlerSignalAvailable === false` → no "Hustlers nearby" line at all (also gated on `nearbyHustlerCount > 0`); `averageTimeToAcceptMinutes === null` → hidden (k-anon); `popularCategories` rendered through a static slug→label map; error/undefined → subtle "Availability signal is temporarily unavailable." inline. Mounted at the bottom of `web/components/funnel-form.tsx` with `enabled={zipLooksValid && EASTSIDE_ZIPS.has(zip)}` so off-area ZIPs (`90210`, `99999`) never trigger a backend call. |

**Verification log (C5 web):**
- `npm run lint` → EXIT 0.
- `npx tsc --noEmit` → EXIT 0.
- `npm run build` → EXIT 0 (5 routes prerendered).
- SSR HTML grep for banned terms (`background.checked` / `insurance` / `protect` / `guaranteed` / `0 Hustlers nearby`) → 0 matches.
- Backend dev server starts; `GET /trpc/geo.availability?input={"zip":"98004"}` reaches the procedure (i.e. type contract is real and reachable).

### Roadmap C5.1 — Live schema alignment ✅

| Repo | Commit | What |
|------|--------|------|
| Backend (`hustlexp-ai-backend`) | `40268fde` | `fix(geo): align availability queries with live schema (C5.1)` — the original C5 backend referenced columns/tables not present on the live Neon DB (`tasks.city`, `tasks.status='completed'`, `task_assignments`). Without changing the AppRouter input/output shape, the three aggregate queries now filter via `location ILIKE '%' || $1 || '%'` against the ZIP→city-mapped name (case/format forgiving; degrades to zeros + `emptyState:true` when location is unpopulated — truthful), use `state = 'COMPLETED'` (matches casing in matchmaker.ts), and compute accept-time directly from `tasks.accepted_at - tasks.created_at` (no missing-table join). Single-param `[city]` contract preserved so existing tests still pin behavior. K-anonymity guard (N<3 → null) unchanged. No new column, no migration, no PII added. |

**Verification log (C5.1):**
- `npx tsc --noEmit` → EXIT 0.
- `npx eslint backend/src/routers/geo.ts` → EXIT 0.
- `npx vitest run backend/tests/unit/geo-router.test.ts` → 12/12 pass.
- `npx vitest run backend/tests/unit/task-router.test.ts` → 128/128 pass (shared rate-limit helper unaffected).
- Live curl against Neon DB:
  - `GET /trpc/geo.availability?input={"zip":"98004"}` → 200, `{ zip:"98004", emptyState:true, tasksPostedLast7Days:0, completedLast30Days:0, completedByCategory:{}, averageTimeToAcceptMinutes:null, popularCategories:[], hustlerSignalAvailable:false, nearbyHustlerCount:0 }`. No 500. Honest empty-state — no live tasks have Eastside locations populated yet.
  - `GET /trpc/geo.availability?input={"zip":"99999"}` → BAD_REQUEST "HustleXP is not yet available in this ZIP." (Eastside allow-list enforced).
  - `GET /trpc/geo.availability?input={"zip":"98075"}` → 200, `emptyState:true`, `zip:"98075"` (Sammamish mapping intact).
  - `POST /trpc/task.draftEstimate {zip:"98004"}` → 200, full estimate returned (C4 unaffected).
- Web SSR: homepage 200 OK, zero banned terms in HTML (`background.checked` / `insurance` / `protected` / `0 hustlers` / `hustlers nearby` all 0 matches).

### Roadmap C6 — Signup gate on Dispatch ✅ (ACCEPTED 2026-05-31)

**Acceptance run summary (2026-05-31, live Neon + Firebase `hustlexp-fly-new`, test user `test.hustler@hustlexp.app`):**

| Check | Result |
|-------|--------|
| Homepage loads + escrow promise headline | ✅ |
| ZIP 98004 → C5 LocalAvailability honest empty-state | ✅ |
| C4 draftEstimate (Moving help / standard_physical) → $30 / 1 hr 15 min | ✅ |
| Dispatch CTA visible in result panel | ✅ |
| Click Dispatch logged-out → auth gate appears with required headline + clickwrap | ✅ |
| Sign in via Firebase test user → draft preserved (492 B) | ✅ |
| Clickwrap accepted → user.register 200 → task.create **200** | ✅ |
| Post-create UI: "Task draft created. Secure payment is next." + "Nothing has been charged and no Hustler has been notified yet." | ✅ |
| Task id `a90f33a1-99b0-4c13-852e-a8f52698f570` persisted to Neon (state=OPEN, price=3000¢, location=98004, template_slug=standard_physical) | ✅ |
| Network audit: 0 Stripe / payment-intent / escrow.createPaymentIntent calls fired | ✅ |
| Banned-copy grep against rendered DOM + source: 0 hits (one self-referential comment in app/page.tsx documenting the ban — not rendered) | ✅ |
| Refresh after success: draft cleared, lastTaskId still in localStorage for C7, fresh-form view rendered | ✅ |
| Regression: off-area ZIP 90210 blocked client-side, 0 draftEstimate calls fired | ✅ |
| Regression: C4 estimate works, C5 availability works | ✅ |

**All schema drifts encountered + remediation:**

| # | Drift | Fix |
|---|-------|-----|
| 1 | `users` missing `is_banned`, `account_status`, `date_of_birth`, `is_minor` | Migration 008 step 1 (`ADD COLUMN IF NOT EXISTS` × 4) — applied |
| 2 | `users_trust_tier_check` rejected tier 0 that the code explicitly inserts for phone-less signups | Migration 008 step 2 (DROP + ADD with strict superset 0..4) — applied |
| 3 | `task_ratings` relation missing | Migration 008 step 3 (canonical CREATE TABLE IF NOT EXISTS + 3 indexes) — applied |
| 4 | `users` missing `plan`, `plan_expires_at` (PlanService) | Migration 008 step 4 — applied |
| 5 | `tasks` missing `xp_reward`, `risk_level`, `mode`, `live_broadcast_radius_miles`, `instant_mode`, `sensitive` (TaskService.create INSERT) | Migration 008 step 5 (extended) — applied |

**Non-DB blocker also encountered (NOT remediated, workaround only):**
- The Upstash Redis account is currently rate-limited at the account level ("Your database has been temporarily rate-limited"). When pipeline operations like `invalidateCacheByTag` (in `backend/src/cache/query-cache.ts:157`) call `pipeline.exec()` they don't catch the error-shaped response and surface a raw `TypeError: res.map is not a function` as INTERNAL_SERVER_ERROR. The acceptance run worked around this by launching the dev backend with `UPSTASH_REDIS_REST_URL=""` and `UPSTASH_REDIS_REST_TOKEN=""` so `getClient()` returns null and every cache op no-ops. **This is a real backend resilience bug, not a C6 issue** — the cache-invalidation helpers should fail-open like the rate-limit helper does. Recommend a small follow-up: wrap `pipeline.exec()` in `query-cache.ts` and any other invalidation helpers in try/catch, log + swallow, same shape as `redis.get`. Out of C6 scope but worth flagging for the next operator.

**Commits this round:**

| Commit | What |
|--------|------|
| Backend `0fcafea2` | `feat(db): C6 schema alignment migration + handoff update` — adds `backend/database/migrations/008-c6-schema-alignment.sql`. Idempotent (IF NOT EXISTS everywhere, the one constraint operation is DROP IF EXISTS + ADD strict superset). The migration file now documents all 5 steps. **Step 5 was extended after the original commit during the acceptance re-run** — the next operator should apply the file again on any non-dev env; re-running is a no-op for steps already in place. |

**Local dev-only side effects of the acceptance run (NOT committed):**
- `web/.env.local` was written with the Firebase web SDK config + test creds. `web/.gitignore` matches `.env*` so it is intentionally not tracked.
- `.claude/launch.json` + a `hustlexp-web` symlink under `~/Desktop/` were set up so the Claude Preview MCP server could run `next dev --port 8081` rooted at the right cwd. Both are local-only.

### Roadmap C6 — Signup gate on Dispatch ✅ (web shipped 2026-05-30 at HUSTLEXPFINAL1 d96f8ca — code summary, originally landed pre-acceptance)

**Acceptance attempt 2026-05-30 (test user `test.hustler@hustlexp.app` against live Neon + `hustlexp-fly-new` Firebase project):**

| Step | Result |
|------|--------|
| Web env wired (`web/.env.local`, never committed; `web/.gitignore` matches `.env*`) | ✅ |
| `npm run dev` web on `:8081`, backend dev on `:3000` (via `npx tsx --env-file=.env --watch backend/src/server.ts`) | ✅ |
| Homepage loads, headline + escrow promise render | ✅ |
| ZIP `98004` → C5 `<LocalAvailability>` renders truthful empty-state ("HustleXP is opening availability in your area.") — no fake counts, no "Hustlers nearby" line | ✅ |
| C4 `task.draftEstimate` for "Mount a 55-inch TV…" → 200, panel shows $30.00 / 1 hr 15 min / `in_home` / Normal | ✅ |
| "Dispatch task" CTA visible at bottom of result panel | ✅ |
| Click Dispatch logged-out → auth gate expands with headline "Create your account to dispatch this task", clickwrap "I agree to the Terms and Privacy Policy", New account / I have an account toggle | ✅ |
| Sign in with the Firebase test user via the "I have an account" tab | ✅ |
| Draft survives auth (localStorage `hustlexp.draft.v1` still 492 B after sign-in) | ✅ |
| Accept Terms + click Dispatch → `user.register` → 500 `column "is_banned" does not exist` | ❌ DRIFT-1 |
| After applying drift fix → `user.register` → 500 `users_trust_tier_check` violation (code inserts tier 0, constraint required ≥ 1) | ❌ DRIFT-2 |
| After relaxing constraint → `user.register` → 500 `relation "task_ratings" does not exist` (queried in `toMobileUser`) | ❌ DRIFT-3 |
| After creating empty `task_ratings` → `user.register` → 200 ✅, `task.create` → 412 `requires verified trust level` (correct product gate — `in_home` requires `verified`, test user is `rookie`) | ⚠️ (product gate, not a bug) |
| Re-ran with "Moving help" chip (`standard_physical`, accepts `rookie`) → C4 200 ✅, then `task.create` → 500 `column "plan" does not exist` (`PlanService.getUserPlan`) | ❌ DRIFT-4 |

**State at pause:** the web flow is correct end-to-end through the auth gate, clickwrap, Firebase sign-in, `user.register` (now succeeding), and the click-through to `task.create`. The dispatch fails at `task.create` only because the live `users` table is missing the `plan` + `plan_expires_at` columns the existing `PlanService` already expects. No banned UI copy ever appeared; no Stripe / `escrow.createPaymentIntent` call was reachable from the new code path; the draft was correctly preserved across every failure. **The C6 web shipping commit `d96f8ca` is unchanged — no web code edits were made during acceptance.**

**Schema drift remediation:**

| Commit | What |
|--------|------|
| Backend (this handoff commit) | `feat(db): C6 schema alignment migration` — adds `backend/database/migrations/008-c6-schema-alignment.sql`. The migration is fully idempotent (every `ALTER` is `ADD COLUMN IF NOT EXISTS`, every `CREATE` is `IF NOT EXISTS`, the one constraint operation is `DROP IF EXISTS` + re-`ADD` with a strict superset of the prior range). Header documents every drift encountered. **Steps 1–3 are already live on dev Neon** (applied during the acceptance run with explicit per-step user approval); **step 4 (`plan`/`plan_expires_at`) is NOT yet applied** — applying it is the next action required to advance C6. After step 4, re-run the acceptance flow exactly as documented above; expect either a green "Task draft created." or one more iteration of the same drift pattern (in which case extend the migration with the next missing column / table and re-apply). |

**Live-DB changes already applied to dev Neon on 2026-05-30 (steps 1–3 of the migration):**
- `users`: added `is_banned BOOLEAN DEFAULT false`, `account_status TEXT DEFAULT 'ACTIVE'`, `date_of_birth DATE`, `is_minor BOOLEAN DEFAULT false`. All purely additive; existing rows take defaults.
- `users_trust_tier_check`: relaxed from `1..4` to `0..4` to match the documented code intent (phone-less registration inserts tier 0 = UNVERIFIED). Strict superset — no rejection of any previously-accepted row.
- `task_ratings`: created empty per the canonical definition in `backend/database/constitutional-schema.sql` + 3 supporting indexes. `toMobileUser` aggregates resolve correctly against an empty table.

**Known follow-ons (NOT in C6 scope, but call out for the next operator):**
- After step 4 lands, repeat the acceptance flow. If new drift surfaces inside `TaskService.create` downstream of `PlanService` (e.g. more missing columns / relations), append to migration `008` (same shape) and re-apply.
- The `task_ratings` table is empty by design — the rating loop is not part of C6 scope. Adding real rows is a later roadmap item.
- The systemic drift between `backend/database/schema.sql` / `constitutional-schema.sql` and live Neon is a separate ops problem already flagged in the C5.1 carry-forward. It is the root cause of every error above. Recommend a single ops ticket to dump the canonical schema, diff against live, and reconcile in a sweep — independent of further roadmap C work.

### Roadmap C6 — Signup gate on Dispatch ✅ (web shipped 2026-05-30 at HUSTLEXPFINAL1 d96f8ca — code summary)

| Repo | Commit | What |
|------|--------|------|
| Frontend (`HUSTLEXPFINAL1`) | `d96f8ca` | `feat(web): add dispatch auth gate and task creation` — adds `web/components/dispatch-section.tsx` and wires it into the C4 result panel in `web/components/funnel-form.tsx`. Idle state shows a "Dispatch task" CTA. Clicking it expands an inline auth gate headlined "Create your account to dispatch this task" — sign-up (default) collects email/password/full name/DOB (`type="date"` capped at 13y ago for COPPA); sign-in toggle drops the name + DOB fields. A required "I agree to the Terms and Privacy Policy" checkbox gates the submit button. On submit: Firebase `createUserWithEmailAndPassword` or `signInWithEmailAndPassword`, then `getIdToken(true)` to force a fresh token, then `user.register` (idempotent — returns the existing user for sign-ins) with `defaultMode: 'poster'`, then `user.updateProfile({ defaultMode: 'poster' })` if the registered account came back as 'hustler' (existing accounts), then `task.create` with `{ title, description: cleanedDescription, price: recommendedPriceCents, location: zip, templateSlug: <C4-mapped slug>, requiresProof: true }`. Post-create state replaces the dispatch UI with "Task draft created. Secure payment is next." and hides the "Start over" button. The `hustlexp.draft.v1` localStorage entry is preserved through auth and only cleared after `task.create` returns successfully — every failure path (Firebase error, register error, role-flip error, create error) leaves the draft intact for retry. The returned task id is also persisted under `hustlexp.lastTaskId.v1` for the C7 funding step. **No backend changes** — the procedure shapes verified against `web/types/trpc/AppRouter.d.ts`. Web `npx tsc --noEmit` + `npm run lint` + `npm run build` all EXIT 0. |

**Field mapping (C4 draft → `task.create`):**
- `title` ← `result.title` (sliced to 255 chars defensively)
- `description` ← `result.cleanedDescription` (backend requires ≥10 chars; the AI-cleaned output reliably satisfies this)
- `price` ← `result.recommendedPriceCents`
- `location` ← `zip` (5-digit string fits under the 500-char limit)
- `templateSlug` ← the same backend slug used for the C4 `draftEstimate` call (already stored in form state)
- `requiresProof` ← `true` (default)
- `mode`, `instantMode`, `liveBroadcastRadiusMiles` ← omitted, defaults apply

**Compliance / fraud / trust gates on `task.create` (verified, unchanged):**
- `checkTaskCreateRateLimit` — 3 creates / 60s per user
- `fraudGuard({ action: 'task_post' })` — fail-open
- `ComplianceGuardianService.evaluate` — hard_block → BAD_REQUEST
- Trust-tier vs. `template.requiredTrustTier` — fail-closed
- `TaskRiskClassifier.classifyWithTemplate` — recorded
- Care-content + content-release detection — auto-applied

**Required copy verified present in source:**
- CTA: "Dispatch task"
- Auth gate headline: "Create your account to dispatch this task"
- Clickwrap: "I agree to the Terms and Privacy Policy"
- Post-create: "Task draft created. Secure payment is next."

**Banned copy verified absent:** "on the way" / "is live" / "matched" / "accepted" / "guaranteed" / "protected" / "insured" / "background checked" / fake supply claims — `grep -inE` returns no UI hits (only one self-referential comment that documents the ban — not rendered).

**Verification log (C6 web):**
- `npx tsc --noEmit` → EXIT 0
- `npm run lint` → EXIT 0
- `npm run build` → EXIT 0 (5 routes prerendered, no new dependencies)
- **Manual browser acceptance: PENDING.** Requires (1) backend dev server, (2) `cd web && npm run dev`, (3) a Firebase test user, and (4) a `default_mode='poster'` path through register. The implementer (running headless, no Firebase test credentials) could not exercise the live flow end-to-end. The next operator must: submit a valid C4 estimate, click Dispatch while logged out, confirm the gate appears, sign up with a Firebase test user, accept Terms/Privacy, confirm `task.create` succeeds and the post-create message renders, verify no Stripe call fires (Network tab), and hard-refresh mid-flow to confirm the draft survives.

**Known C6 carry-forward / risks:**
- The auth gate is inline within the result panel rather than a modal. Acceptable for a single-page funnel; revisit if the C8 dashboard needs a global auth flow.
- For *existing* accounts registered as 'hustler' that have active hustler-side tasks, `user.updateProfile({ defaultMode: 'poster' })` fails with PRECONDITION_FAILED ("Cannot switch role while you have active tasks"). The error surfaces to the user verbatim and the dispatch fails cleanly — no half-created task. Realistically rare for web funnel posters; mention only if a tester sees it.
- DOB is collected as YYYY-MM-DD (`<input type="date">`) and held in a module-level cache so it survives the Firebase sign-up round-trip even if the form unmounts. Reset is implicit — once a session signs up successfully, the cache is unused. No PII written to localStorage.
- Returning users who sign in with a Firebase account that has no HustleXP row yet will get one created via `user.register` on first dispatch — the register procedure is fully idempotent and protected by Firebase ID-token ownership verification.

---

**C5 done criteria — all met:**
- `geo.availability` no longer 500s on live DB ✅
- `98004` returns valid JSON ✅
- web module renders empty-state copy when backend reports empty ✅ (verified by static analysis of the `emptyState === true` branch; live homepage serves cleanly)
- no fake activity appears in any code path ✅
- C4 estimate still works ✅
- handoff says C5 accepted ✅ (this update)

**Known C5 carry-forward (NOT blockers, NOT in C5 scope):**
- No tasks in the live DB currently carry a Bellevue/Sammamish/Redmond/Kirkland/Issaquah substring in `location`, so every Eastside ZIP correctly returns `emptyState:true`. When real posters fill `location` (via task posting in C7+), counts begin populating without further code change.
- No Hustler-proximity signal yet. `hustlerSignalAvailable:false` and the web layer hides any "Hustlers nearby" line. Future roadmap item flips the signal on.
- No Redis caching on aggregates. Three SELECTs per call are cheap at C5 volume; revisit if homepage QPS climbs.
- `tasks.city` and `task_assignments` referenced in `backend/database/schema.sql` are not present on live Neon — this is broader schema drift, not a C5 concern. Other code paths (matchmaker.ts, etc.) already use `state` + `location_text`/`location` and work fine. Reconciling the canonical schema is a separate ops/migrations task.

---

## 4. Do-Not-Forget Constraints

- **No fake liquidity.** `geo.availability` returns real data or honest empty-state.
- **No fake trust badges.** No "background-checked" copy until Checkr is live (it's a stub at `BackgroundCheckService.ts:154`).
- **No insurance/self-protection claims.** Kill-switched OFF (`config.features.insurancePoolEnabled`).
- **No Hustler web flows.** Hustlers stay on Swift mobile (GPS/biometric/background can't run in-browser).
- **No full app parity.** Web mirrors the Poster outcome loop only.
- **Homepage starts with task input**, not brand fluff. Headline the escrow promise.
- **Signup only at Dispatch.** Draft is fully usable pre-auth.
- **Roadmap D battlefield test cannot be skipped after C.**
- **Design tokens are constitutional:** Black + Purple brand from `COLOR_SEMANTICS_LAW.md`. Green = success-only.
- **shadcn/ui** approved as base component system for C3+. Selective registry components (3-5 max). No animation that slows the conversion loop. (Not installed in C2 — strict scope.)
- **Regen the AppRouter snapshot whenever you touch the backend tRPC surface.** Web type-safety depends on it being current.

---

## 5. Roadmap C Next Steps (C4–C10)

### C4 — Draft Estimate Flow ✅ DONE
See **Roadmap C4 — Draft Estimate Flow ✅** in Section 3 above. Backend `293a508d` + `e3f09b9c`, web `3559da1`. Manual browser acceptance passed.

### C5 — Backend `geo.availability` ✅ + web `<LocalAvailability>` ✅ + live schema fix ✅
Backend shipped at `6173fff0` (procedure) + `40268fde` (live schema alignment); web shipped at `e9cba74`. Live `GET /trpc/geo.availability?input={"zip":"98004"}` returns 200 with truthful `emptyState:true`. Non-Eastside ZIPs reject. C4 draftEstimate unaffected. Full verification log in Section 3 under **Roadmap C5.1 — Live schema alignment ✅**. **C5 is closed. Next operator can start C6.**

### C6 — Signup gate on Dispatch ✅ ACCEPTED 2026-05-31
Web `d96f8ca` is the C6 web HEAD (unchanged). Manual acceptance passed end-to-end against live Neon + Firebase `hustlexp-fly-new`: dispatch from anonymous → auth gate → Firebase sign-in → clickwrap → `user.register` 200 → `task.create` 200 → post-create state with required copy. Task id `a90f33a1-99b0-4c13-852e-a8f52698f570` persisted. Zero Stripe / payment-intent calls. Zero banned copy. Full check list in **Section 3 → Roadmap C6 ✅**. The 5-step schema-alignment migration `008` is applied to dev Neon and committed to the repo. **Next step: C7 (Stripe Elements funding) only.**

### C7 — Stripe Elements funding ✅ ACCEPTED 2026-05-31

**Commits:**

| Repo | Commit | What |
|------|--------|------|
| Backend | `cc0de76c` | `fix(cache): fail-open invalidateCacheByTag on Upstash error (C7 pre-req)` — wraps `pipeline.exec()` / `smembers` / `del` in `invalidateCacheByTag`, `invalidateCache`, `storeInCache`, `clearAllCache` in try/catch (log + no-op). Defensive `Array.isArray` guard on `smembers`. +3 fail-open unit tests (28/28 query-cache tests pass). This is the C6-documented `res.map is not a function` crash; confirmed fixed live (`task.create` 200 under the real rate-limited Upstash). |
| Backend | `340d3ce8` | `feat(escrow): persist PENDING row + harden confirmFunding (C7)` — **(a)** `escrow.createPaymentIntent` now opens a `db.transaction` + `SELECT … FOR UPDATE` and reuses an existing PENDING escrow row or `INSERT`s one, attaches the new `stripe_payment_intent_id`, and returns `{…, escrowId}` (additive, non-breaking). FUNDED → `PRECONDITION_FAILED` (no double-charge); other terminal states → `CONFLICT`. This closed the gap where `EscrowService.create()` was only ever called from tests, so no production path created the PENDING row the webhook/confirmFunding need. **(b)** `escrow.confirmFunding` hardened: independently `StripeService.verifyPaymentIntent` and requires `status==='succeeded'` AND `metadata.task_id===escrow.task_id` AND `metadata.poster_id===caller` before funding; already-FUNDED with the same PI → idempotent success, different PI → `CONFLICT`. +12 escrow-router tests (77/77 pass); 5777/5777 backend unit tests pass; AppRouter bundle regenerated with `escrowId`. |
| Backend | `2c474abe` | `fix(db): C7 escrow schema alignment — add escrows.version (C7)` — migration `009-c7-escrow-version.sql`, additive `ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1` (canonical `constitutional-schema.sql:289`). Live Neon was missing the optimistic-locking column `EscrowService.fund()` needs. Applied to dev Neon with explicit user approval during acceptance. |
| Frontend | `e038545` | `feat(web): add Stripe funding step (C7)` — installs `@stripe/stripe-js` + `@stripe/react-stripe-js`; `lib/stripe.ts` loader singleton; `components/funding-step.tsx` (Payment Element, single-shot createPaymentIntent guard, polls `escrow.getByTaskId` and shows "Task funded. Next: Hustler matching." ONLY on backend `state==='FUNDED'`, 20s `confirmFunding` fallback for webhook-down, `return_url` redirect-resume + query-param strip, `hustlexp.funding.v1` persistence w/ 24h TTL); wires FundingStep into `dispatch-section.tsx` post-create panel; `funnel-form.tsx` defers the `draft.v1` clear until funded + adds mount-time funding resume + Start-Over clears all session keys. Web lint + tsc + build all EXIT 0. |

**Manual acceptance log (live Neon + Firebase `hustlexp-fly-new` + Stripe test mode, web `:8081` → backend `:3000`):**

| Check | Result |
|-------|--------|
| C4 estimate (dump-run / standard_physical) → $30.00 / 1 hr 15 min | ✅ |
| C5 `geo.availability` 98004 → 200 honest empty-state | ✅ |
| C6 auth gate → `user.register` 200 → `task.create` 200 | ✅ |
| `escrow.createPaymentIntent` → 200 `{paymentIntentId, clientSecret, amount:3000, escrowId}` | ✅ |
| PENDING `escrows` row persisted with `stripe_payment_intent_id` (the Step-1 fix) | ✅ |
| Funding UI: "SECURE PAYMENT" + "Your card is charged only through Stripe. Funds are released after proof is reviewed." + "Pay $30.00 to fund this task" | ✅ |
| Real Stripe test charge on the PI (4242 via `pm_card_visa`) → `status=succeeded`, single charge `ch_3Td2eQ…`, 3000¢ | ✅ |
| `return_url` redirect-resume → polling → 20s `confirmFunding` fallback (webhook-off) → PENDING→FUNDED | ✅ |
| UI shows **"Task funded. Next: Hustler matching."** only after backend FUNDED | ✅ |
| **DB probe:** escrow `4b69768c` task `349222ff` → `state=FUNDED`, `stripe_payment_intent_id` not null, `version=2`, `funded_at` set, **1 row** | ✅ |
| No duplicate charge / no duplicate escrow row | ✅ |
| Empty/incomplete card submit → clean error ("Your card number is incomplete.") + Try again | ✅ |
| Step 0 Upstash fail-open: `task.create` 200 under real rate-limited Upstash (no `res.map` crash) | ✅ |
| Banned copy ("on the way"/"matched"/"accepted"/"insured"/"protected"/"guaranteed"/"background checked") | ✅ 0 hits |

**C7 carry-forward / known limits:**
- **In-iframe keystrokes not automatable here.** Stripe Payment Element card inputs are in a cross-origin `js.stripe.com` iframe; the headless preview can't type into it. The PI was confirmed with the equivalent `pm_card_visa` (4242) via the Stripe API, and funding was driven through the real `return_url`→polling→`confirmFunding` path. A human running a real browser should still do one literal 4242-in-the-Element pass, plus a true hard-decline (`4000 0000 0000 0002`) and a 3DS card (`4000 0027 6000 3184`) — the code handles all three (`redirect:'if_required'` + error phase + redirect-resume) but only the incomplete-card error and the redirect-resume were exercised live.
- **No `stripe listen` / webhook locally.** PENDING→FUNDED was driven by the `confirmFunding` fallback, which is the intended webhook-off resilience path. In production, set `STRIPE_WEBHOOK_SECRET` and run the webhook so `payment_intent.succeeded` funds escrow without the client fallback. (The fallback stays as defense-in-depth and is safe — it re-verifies the PI with Stripe server-side.)
- **Migration `009` applied to dev Neon only.** Re-apply on any other env (idempotent). Same systemic schema-drift root cause flagged since C5.1 — a one-shot canonical-vs-live reconciliation is still the right ops ticket.
- **Local dev side effects (not committed):** `web/.env.local` holds the Firebase web config + the Stripe `pk_test_…` publishable key; backend `.env` `STRIPE_SECRET_KEY` was set to the real `sk_test_…` (was a placeholder). Both gitignored.

### C8–C10
C8 poster dashboard shell → C9 local pages (zip-targeted SEO) → C10 analytics (PostHog already env-stubbed). **Do not start C8 in this session.**

---

## 6. Key Files Reference

| Purpose | Path |
|---------|------|
| Backend tRPC router index | `backend/src/routers/index.ts` (exports `AppRouter` type) |
| Backend tRPC setup | `backend/src/trpc.ts` (`publicProcedure` at line 112) |
| Backend auth context | `backend/src/trpc.ts` (`createContext` — Firebase Bearer) |
| Backend CORS config | `backend/src/config.ts` (`app.allowedOrigins` from `ALLOWED_ORIGINS` env) |
| Backend CORS mount | `backend/src/server.ts` (dev allow-list already includes `http://localhost:3000`) |
| Backend rate limiting | `backend/src/middleware/security.ts` (categories + `checkRateLimit`) |
| Backend type-bundle emit script | `scripts/emit-approuter-types.ts` (run via `npm run emit:trpc-types`) |
| Backend bundled AppRouter type | `dist-types/AppRouter.d.ts` (committed; regen on AppRouter changes) |
| Web scaffold | `HUSTLEXPFINAL1/web/` (Next.js 16 + Tailwind v4) |
| Web env config | `web/lib/env.ts` + `web/.env.example` |
| Web globals/theme | `web/app/globals.css` (Tailwind v4 `@theme` tokens) |
| Web Firebase init | `web/lib/firebase.ts` (lazy browser-only) |
| Web tRPC client | `web/lib/trpc.ts` |
| Web tRPC provider | `web/providers/trpc-provider.tsx` (custom 401-refresh link + httpBatchLink + Bearer header) |
| Web Auth provider | `web/providers/auth-provider.tsx` (`useAuth()` context) |
| Web smoke page (dev only) | `web/app/dev/me/page.tsx` |
| Web type-sync script | `web/scripts/sync-trpc-types.sh` |
| Web vendored AppRouter type | `web/types/trpc/AppRouter.d.ts` (regen via sync script after backend bundle update) |
| Web homepage funnel (C3) | `web/app/page.tsx` (server) + `web/components/funnel-form.tsx` (client) |
| Design tokens source | `hustlexp-docs/reference/constants/colors.js` + `COLOR_SEMANTICS_LAW.md` |
| **This handoff** | `HUSTLEXP_HANDOFF_ROADMAP_C2.md` in `Sebdysart/hustlexp-ai-backend` on `claude/audit-backend-workflow-mFb7a` |

---

## 7. Recommended First Prompt for Next Session (C5)

Paste this into a new Claude Code session:

```
Fetch the handoff from GitHub:
Repo: Sebdysart/hustlexp-ai-backend
Branch: claude/audit-backend-workflow-mFb7a
File: HUSTLEXP_HANDOFF_ROADMAP_C2.md

We are continuing HustleXP Roadmap C. Roadmap B is closed. C1 (scaffold), C2 (tRPC + Firebase foundation), C3 (public poster funnel homepage), and C4 (public draftEstimate procedure + homepage wiring + localStorage-persistent draft, manually accepted) are all done. Your job is C5 ONLY: backend `geo.availability` + a truthful local-availability module on the homepage.

Repos:
- Backend: Sebdysart/hustlexp-ai-backend, branch claude/audit-backend-workflow-mFb7a, HEAD e3f09b9c
- Frontend: Sebdysart/HUSTLEXPFINAL1, branch claude/audit-backend-workflow-mFb7a, HEAD 3559da1
- Web app: HUSTLEXPFINAL1/web/ (Next.js 16 + Tailwind v4)
- Homepage: web/app/page.tsx (server shell) + web/components/funnel-form.tsx (C4 client funnel with live estimate + localStorage draft)

Read these before writing any code:
- backend/src/routers/task.ts — model on `task.draftEstimate` (lines around the new C4 block) for: publicProcedure shape, IP key derivation via `deriveIpKey`, three-layer rate limit (per-IP burst, per-IP daily, GLOBAL kill switch with fail-CLOSED on Redis outage), the `dev-local` fallback that only fires when `NODE_ENV !== 'production'`.
- backend/src/trpc.ts — `Context.req?: Request` is already wired through `createContext` for public procedures; do not narrow it in middleware.

C5 tasks (and ONLY C5):

1. Backend — add `geo.availability`:
   - `publicProcedure.query` at backend/src/routers/geo.ts (create the router if absent; mount it in backend/src/routers/index.ts).
   - Input: `{ zip: z.string().regex(/^\d{5}$/) }` and ONLY recognised Eastside zips (Redmond/Sammamish/Bellevue/Kirkland/Issaquah). Unknown → BAD_REQUEST.
   - Rate-limit pattern: same three-layer shape as `task.draftEstimate`. Per-IP layers fail OPEN, GLOBAL fails CLOSED. Reuse `deriveIpKey` (refactor it out of routers/task.ts into a small shared helper if needed — minimal change, keep the dev-local fallback).
   - Output is HONEST: `{ tasksLast7Days: number, dispatchedLast7Days: number, lastTaskAgo: string | null, isEastsideZip: boolean }`. Computed from real `tasks` rows (PostGIS `ST_DWithin` if the zip-centroid table exists; otherwise a straight `WHERE zip = $1 AND created_at > now() - interval '7 days'` is acceptable for the first cut). Never fabricate counts. When the count is zero, return zero — the web layer must surface "you'd be among the first" rather than rounding up.
   - Tests in backend/tests/unit/geo-router.test.ts: happy path, unknown zip BAD_REQUEST, rate-limit fires, global kill switch fires, dev-local fallback works without IP headers. Mock DB and rate limit at module level the same way task-router.test.ts does.
   - After: `npx tsc -b`, `npx eslint backend/src`, `npx vitest run backend/tests/unit/geo-router.test.ts`, then `npm run emit:trpc-types`.

2. Web — truthful availability module on the homepage:
   - Sync types: `web/scripts/sync-trpc-types.sh` if the gh path works, otherwise copy `backend/dist-types/AppRouter.d.ts` → `web/types/trpc/AppRouter.d.ts` directly.
   - New component `web/components/local-availability.tsx` (client). Calls `trpc.geo.availability.useQuery({ zip })` only when the funnel form's ZIP is a 5-digit Eastside value (mirror the EASTSIDE_ZIPS allow-list already in funnel-form.tsx). Use enabled/keepPreviousData appropriately.
   - Copy is honest:
     - tasksLast7Days > 0 → "{n} tasks posted in your zip in the last 7 days." Add "last posted {lastTaskAgo}" when present.
     - tasksLast7Days === 0 → "You'd be among the first in your zip — that's not a knock, it's an honest beta signal." Never invent counts. Never say "X Hustlers nearby" — we have no nearby-Hustler signal yet.
   - Place the module under the funnel form, above the trust bullets. Hidden until a valid Eastside ZIP is entered. Never blocks the existing draftEstimate flow.

Rules:
- No fake liquidity, no fake "average response time", no fake nearby Hustler counts, no "background-checked" copy, no insurance/protection claims.
- No signup gate, no task creation, no Stripe, no new UI library, no Hustler web flows.
- Strict scope: ONE backend procedure (+ tests) + ONE web component + sync types + handoff update. Do not also do C6 (signup gate) or C7 (Stripe).
- Commit separately:
  - Backend: `feat(geo): add public geo.availability procedure (C5)`
  - Web: `feat(web): add local availability module to homepage (C5)`
- Run lint + typecheck + tests in both repos before each commit.

Stop after the two C5 commits and the handoff update. Do not start C6.
```
