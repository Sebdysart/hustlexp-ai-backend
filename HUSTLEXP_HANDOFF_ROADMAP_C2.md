# HustleXP — Handoff: Roadmap C (C4 done, C5 next)

> Updated 2026-05-30 after C4 acceptance. For the next Claude Code session to pick up Roadmap C exactly where this one left off.

---

## 1. Current Objective

**Roadmap C: Poster-side web liquidity engine.** C4 is **accepted** (backend `task.draftEstimate` + web homepage wired with localStorage-persistent draft + browser manual acceptance passed). **Next step: C5 — backend `geo.availability` + a truthful availability module on the homepage.**

Product goal (DONE-C): a Redmond stranger opens the web app, describes a real task, gets an estimate, signs up only at Dispatch, funds with Stripe test mode, and sees the task in a poster dashboard.

---

## 2. Repo / Branch State

| Repo | GitHub path | Branch | HEAD | Clean? |
|------|------------|--------|------|--------|
| Backend | `Sebdysart/hustlexp-ai-backend` | `claude/audit-backend-workflow-mFb7a` | `e3f09b9c` | Yes |
| Frontend/mobile | `Sebdysart/HUSTLEXPFINAL1` | `claude/audit-backend-workflow-mFb7a` | `3559da1` | Yes |

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

### C5 — Backend `geo.availability` + web module (NEXT)
- `geo.availability`: `publicProcedure`, rate-limited, PostGIS `ST_DWithin` queries on `tasks` table. Honest empty-state.
- Web shows real activity ("3 tasks in your zip in the last 7 days") or "you'd be among the first" — never fabricated.
- Apply the C4 dev-IP-fallback pattern: use the same `deriveIpKey` helper for rate limiting (now lifted to a reusable spot in `routers/task.ts`), or duplicate the per-IP burst + global kill switch shape — anonymous endpoints must keep a wallet-drain ceiling.
- After the procedure lands: `npm run emit:trpc-types` in the backend + commit, then resync `web/types/trpc/AppRouter.d.ts`.

### C6 — Signup gate on Dispatch
- Draft is fully usable pre-auth.
- Hitting "Dispatch" triggers the Firebase sign-in flow (use the existing `AuthProvider` plus a real sign-in UI; the C2 dev-only `/dev/me` form is the seed pattern).
- After sign-in: dispatch proceeds via authenticated tRPC calls.

### C7 — Stripe Elements funding
- Stripe Web SDK + Elements, publishable key from env (already in `env.ts`).
- PaymentIntent created server-side via existing `escrow.create` flow (verify the procedure accepts the web client's payload shape).

### C8–C10
C8 poster dashboard shell → C9 local pages (zip-targeted SEO) → C10 analytics (PostHog already env-stubbed).

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
