# HustleXP — Handoff: Roadmap C (C2 done, C3 next)

> Updated 2026-05-30 after C2 commit. For the next Claude Code session to pick up Roadmap C exactly where this one left off.

---

## 1. Current Objective

**Roadmap C: Poster-side web liquidity engine.** C2 is **done**. **Next step: C3 — public poster funnel homepage.**

Product goal (DONE-C): a Redmond stranger opens the web app, describes a real task, gets an estimate, signs up only at Dispatch, funds with Stripe test mode, and sees the task in a poster dashboard.

---

## 2. Repo / Branch State

| Repo | GitHub path | Branch | HEAD | Clean? |
|------|------------|--------|------|--------|
| Backend | `Sebdysart/hustlexp-ai-backend` | `claude/audit-backend-workflow-mFb7a` | `37d283a8` | Yes |
| Frontend/mobile | `Sebdysart/HUSTLEXPFINAL1` | `claude/audit-backend-workflow-mFb7a` | `27f7809` | Yes |

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

## 5. Roadmap C Next Steps (C3–C10)

### C3 — Public poster funnel homepage (NEXT)
Replace `web/app/page.tsx` (currently a coming-soon shell) with the real first-touch funnel: a task-input box that captures a one-line description, kicks off a draft estimate the moment the user pauses typing, and routes into the draft flow. No auth required to see the homepage or get an estimate; sign-up happens at Dispatch (C6).

**Prereqs already in place from C2:**
- tRPC client + React Query.
- Firebase Web SDK + AuthProvider (auth context available but no sign-in required for the homepage).
- `health.ping` proves the wire works end-to-end.

**C3 scope (only):**
- Install `shadcn/ui` (approved for C3+).
- Replace `app/page.tsx` with the funnel: task input → "Get estimate" CTA.
- Color law: black canvas + purple CTA + blue trust line. NO green on entry.
- Headline the escrow promise: "You only pay when the work is approved."
- Below the fold: 3-step explainer (Post → Match → Pay-on-approval).
- Add `app/(funnel)` route group if it helps isolate funnel layout from the future poster dashboard.
- No fake liquidity (no fake counts, no fake "Hustlers nearby" badges until C5).

**Verify:** `npm run build` clean. Manual: enter a task description, see the page state advance to a draft-pending state (real backend call comes in C4).

### C4 — Backend `task.draftEstimate` + web draft flow
- `task.draftEstimate`: `publicProcedure`, rate-limited, composes `ComplianceGuardianService.evaluate()` (no userId) → `ScoperAIService.analyzeTaskScope()` → `refineTaskDescription()`. All anonymous-safe.
- `publicProcedure` exists at `backend/src/trpc.ts:112`. Rate limiting via manual `checkRateLimit()` inside procedure (pattern at `task.ts:416–449`).
- After backend lands: regen `AppRouter.d.ts` in backend, run `sync-trpc-types.sh` in web, wire the homepage to actually call `trpc.task.draftEstimate`.

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
| Design tokens source | `hustlexp-docs/reference/constants/colors.js` + `COLOR_SEMANTICS_LAW.md` |
| **This handoff** | `HUSTLEXP_HANDOFF_ROADMAP_C2.md` in `Sebdysart/hustlexp-ai-backend` on `claude/audit-backend-workflow-mFb7a` |

---

## 7. Recommended First Prompt for Next Session (C3)

Paste this into a new Claude Code session:

```
Fetch the handoff from GitHub:
Repo: Sebdysart/hustlexp-ai-backend
Branch: claude/audit-backend-workflow-mFb7a
File: HUSTLEXP_HANDOFF_ROADMAP_C2.md

We are continuing HustleXP Roadmap C. Roadmap B is closed. C1 (scaffold) and C2 (tRPC + Firebase foundation) are done. Your job is C3: public poster funnel homepage.

Repos:
- Backend: Sebdysart/hustlexp-ai-backend, branch claude/audit-backend-workflow-mFb7a, HEAD 37d283a8
- Frontend: Sebdysart/HUSTLEXPFINAL1, branch claude/audit-backend-workflow-mFb7a, HEAD 27f7809
- Web app: HUSTLEXPFINAL1/web/ (Next.js 16 + Tailwind v4)

C3 tasks (and ONLY C3):
1. Install shadcn/ui as the base component system. Use the Black+Purple tokens already in app/globals.css.
2. Replace web/app/page.tsx with the real funnel:
   - One-line task input above the fold.
   - "Get estimate" CTA (purple, prominent).
   - Headline the escrow promise: "You only pay when the work is approved."
   - 3-step explainer below the fold (Post → Match → Pay-on-approval).
   - Color law: NO green on the entry surface. Blue for trust lines, purple for CTAs.
3. Add app/(funnel) route group if it helps isolate funnel layout from the future poster dashboard.
4. Do NOT call the backend yet — the actual `task.draftEstimate` procedure lands in C4. The homepage just captures input and routes to a placeholder draft state.

Rules:
- No fake liquidity, no fake trust badges, no "background-checked" copy, no insurance claims.
- No Hustler web flows.
- Homepage starts with the task input, not brand fluff.
- Signup only at Dispatch (C6).
- Commit separately: `feat(web): C3 public poster funnel homepage`.
- Run `npm run build` + `npm run lint` after. Push to the branch.

Stop after C3 commit. Do not start C4 until I approve.
```
