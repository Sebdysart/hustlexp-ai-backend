# HustleXP — Handoff: Roadmap C (C3 done, C4 next)

> Updated 2026-05-30 after C3 commit. For the next Claude Code session to pick up Roadmap C exactly where this one left off.

---

## 1. Current Objective

**Roadmap C: Poster-side web liquidity engine.** C3 is **done**. **Next step: C4 — backend `task.draftEstimate` + web `/draft` route + wire the homepage submit.**

Product goal (DONE-C): a Redmond stranger opens the web app, describes a real task, gets an estimate, signs up only at Dispatch, funds with Stripe test mode, and sees the task in a poster dashboard.

---

## 2. Repo / Branch State

| Repo | GitHub path | Branch | HEAD | Clean? |
|------|------------|--------|------|--------|
| Backend | `Sebdysart/hustlexp-ai-backend` | `claude/audit-backend-workflow-mFb7a` | `3e8b1c49` | Yes |
| Frontend/mobile | `Sebdysart/HUSTLEXPFINAL1` | `claude/audit-backend-workflow-mFb7a` | `bff1607` | Yes |

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

### C4 — Backend `task.draftEstimate` + web `/draft` route (NEXT)
The C3 homepage captures task + ZIP + category and currently shows a stub "Generating estimate…" panel on submit. C4 makes that submit do real work.

**Backend (lands on the same audit branch):**
- `task.draftEstimate`: `publicProcedure`, rate-limited, composes `ComplianceGuardianService.evaluate()` (no userId) → `ScoperAIService.analyzeTaskScope()` → `refineTaskDescription()`. All anonymous-safe.
- Returns a draft id + the proposed scope/price band + any compliance flags.
- `publicProcedure` exists at `backend/src/trpc.ts:112`. Rate limiting via manual `checkRateLimit()` inside the procedure (pattern at `task.ts:416–449`).
- After the procedure lands: `npm run emit:trpc-types` in the backend + commit + push, then `./scripts/sync-trpc-types.sh` in `web/` to refresh `types/trpc/AppRouter.d.ts`.

**Web:**
- Add `web/app/draft/[id]/page.tsx` (server or client — TBD) that renders the AI estimate from the draft id.
- Swap the C3 stub in `web/components/funnel-form.tsx` for `trpc.task.draftEstimate.useMutation()` + `router.push('/draft/' + result.id)`.
- Loading + error states must be honest: real "Generating estimate…" while pending, friendly fallback if the AI fails (offer "Try again" or "Continue without estimate").

**Verify:** create a draft estimate via the homepage end-to-end against a running backend, confirm the new route renders, and that re-submitting bumps a fresh estimate. CORS must already work since the API base URL is the same as for C2's `/dev/me`.

**Strict scope reminder:** C4 is ONE backend procedure + ONE web route + the submit wiring. Do not also do C5 (geo.availability) or C6 (signup gate).

### C5 — Backend `geo.availability` + web module
- `geo.availability`: `publicProcedure`, rate-limited, PostGIS `ST_DWithin` queries on `tasks` table. Honest empty-state.
- Web shows real activity ("3 tasks in your zip in the last 7 days") or "you'd be among the first" — never fabricated.

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

## 7. Recommended First Prompt for Next Session (C4)

Paste this into a new Claude Code session:

```
Fetch the handoff from GitHub:
Repo: Sebdysart/hustlexp-ai-backend
Branch: claude/audit-backend-workflow-mFb7a
File: HUSTLEXP_HANDOFF_ROADMAP_C2.md

We are continuing HustleXP Roadmap C. Roadmap B is closed. C1 (scaffold), C2 (tRPC + Firebase foundation), and C3 (public poster funnel homepage) are all done. Your job is C4: backend `task.draftEstimate` + web `/draft` route + wire the C3 homepage submit to the real mutation.

Repos:
- Backend: Sebdysart/hustlexp-ai-backend, branch claude/audit-backend-workflow-mFb7a, HEAD 3e8b1c49
- Frontend: Sebdysart/HUSTLEXPFINAL1, branch claude/audit-backend-workflow-mFb7a, HEAD bff1607
- Web app: HUSTLEXPFINAL1/web/ (Next.js 16 + Tailwind v4)
- Homepage funnel: web/app/page.tsx (server) + web/components/funnel-form.tsx (client, currently shows a stub on submit)

C4 tasks (and ONLY C4):
1. Backend — add `task.draftEstimate`:
   - publicProcedure (no auth required), rate-limited.
   - Composes ComplianceGuardianService.evaluate() (no userId) → ScoperAIService.analyzeTaskScope() → refineTaskDescription(). All anonymous-safe paths.
   - Input: { task: string, zip: string, category?: string }. Output: { draftId, scope, priceBandCents: {low, high}, complianceFlags?: [] }.
   - Persist the draft in a `task_drafts` table (or a Redis TTL key — pick whichever fits the existing patterns) so the /draft page can read it back by id.
   - publicProcedure exists at backend/src/trpc.ts:112. Rate-limit pattern at backend/src/routers/task.ts:416–449.
   - After the procedure lands: `npm run emit:trpc-types` in backend, commit + push.

2. Web — bring the funnel to life:
   - In web/, run ./scripts/sync-trpc-types.sh to pull the fresh AppRouter.d.ts.
   - Replace the C3 stub in components/funnel-form.tsx with `trpc.task.draftEstimate.useMutation()`. On success, router.push(`/draft/${result.draftId}`).
   - Add web/app/draft/[id]/page.tsx that calls `trpc.task.getDraft.useQuery({id})` (or however the read endpoint shapes up) and renders the proposed scope + price band + a "Continue → Sign up" CTA (the actual signup gate lands in C6).
   - Honest loading + error states. No fake "average estimate" copy. If the AI fails, offer "Try again" or "Continue without an estimate."

Rules:
- No fake liquidity, no fake trust badges, no "background-checked" copy, no insurance claims.
- No Hustler web flows.
- Strict scope: ONE backend procedure + ONE web route + the submit wiring. Do not also do C5 (geo.availability) or C6 (signup gate).
- Commit separately:
  - `feat(backend): task.draftEstimate publicProcedure for anonymous web funnel`
  - `feat(web): wire homepage submit to task.draftEstimate and render /draft/[id]`
- Run lint + typecheck + build in both repos after. Push to the branch.

Stop after C4 commits. Do not start C5 until I approve.
```
