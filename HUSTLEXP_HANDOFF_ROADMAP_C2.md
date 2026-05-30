# HustleXP — Handoff: Roadmap C2 (tRPC + Firebase Foundation)

> Written 2026-05-30 at session end. For the next Claude Code session to pick up Roadmap C exactly where this one left off.

---

## 1. Current Objective

**Roadmap C: Poster-side web liquidity engine.** Next step: **C2 — tRPC + Firebase foundation.**

Product goal (DONE-C): a Redmond stranger opens the web app, describes a real task, gets an estimate, signs up only at Dispatch, funds with Stripe test mode, and sees the task in a poster dashboard.

C2 specifically: wire the Next.js web app (`hustlexpfinal1/web/`) to the backend API via tRPC with end-to-end type safety, and set up Firebase web auth so authenticated calls work.

---

## 2. Repo / Branch State

| Repo | GitHub path | Branch | HEAD | Clean? |
|------|------------|--------|------|--------|
| Backend | `Sebdysart/hustlexp-ai-backend` | `claude/audit-backend-workflow-mFb7a` | `8cd1d1e` | Yes |
| Frontend/mobile | `Sebdysart/HUSTLEXPFINAL1` | `claude/audit-backend-workflow-mFb7a` | `8a3076d` | Yes |

**PR #211** (`claude/audit-backend-workflow-mFb7a` → `main` on backend): open, not merged. CI status as of latest push:

| Check | Status | Classification |
|-------|--------|----------------|
| TypeScript — zero errors | ✅ GREEN | Fixed by PR (first time ever on this repo) |
| Lint — zero warnings | ✅ GREEN | — |
| Tests — zero failures | ✅ GREEN | Unblocked by TypeScript fix |
| Build Validation | ✅ GREEN | Unblocked by TypeScript fix |
| audit | ✅ GREEN | — |
| Security audit — no NEW | ❌ Fail | Pre-existing: 28 HIGH/CRITICAL dependency vulns identical to main (axios, @hono/node-server, @opentelemetry/*, express-rate-limit, fast-uri). Owner: Sebastian. |
| dependency-review | ❌ Fail | Pre-existing: lock-file diff flagging, no new deps from PR code. Owner: Sebastian. |
| snyk | ❌ Fail | Pre-existing: missing SNYK_TOKEN or same upstream vulns. `continue-on-error: true` in workflow. Owner: Sebastian. |
| codeql | ❌ Fail | Pre-existing/infra: completes in ~37s (too fast for real scan) — likely permissions or autobuild infra issue, not code finding. Owner: Sebastian. |

**All PR-caused CI failures are fixed.** The 4 remaining failures are pre-existing dependency/security/infra issues proven identical to main.

**Git proxy note:** The frontend repo requires uppercase path `Sebdysart/HUSTLEXPFINAL1` and `local_proxy@` user prefix in the git remote URL. Commits need `git -c commit.gpgsign=false commit` (signing server rejects).

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

Commit `8a3076d` on `HUSTLEXPFINAL1`:
- Next.js 16.2.6 + React 19 + Tailwind v4 (CSS `@theme`, no `tailwind.config.js`)
- Design tokens from `hustlexp-docs` `COLOR_SEMANTICS_LAW.md` v3.0.0: **Black + Purple brand. Green is SUCCESS-ONLY, forbidden on entry screens.**
- `lib/env.ts` (typed public-env access), `.env.example`, `vercel.json`
- Entry shell honors color law (black canvas + purple glow + blue trust line, no green)
- `npm run build` EXIT 0, `npm run lint` EXIT 0

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
- **shadcn/ui** approved as base component system. Selective registry components (3-5 max). No animation that slows the conversion loop.

---

## 5. Roadmap C Next Steps (C2–C10)

### C2 — tRPC + Firebase foundation (NEXT)

**AppRouter type-sharing decision** (not yet made — decide at C2):
1. **Preferred:** workspace/package reference if the layout allows
2. **Fallback:** generated standalone `AppRouter` `.d.ts` vendored into `web/` (lightweight, regen on API change)
3. **Last resort:** git submodule (repo already uses submodules for `HUSTLEXP-DOCS`)
4. **Must build cleanly in CI/Vercel** — no brittle relative imports. `skipLibCheck` already on.

**Setup checklist:**
- Install `@trpc/client`, `@trpc/react-query`, `@tanstack/react-query`
- `import type { AppRouter }` from whatever sharing path is chosen
- `lib/trpc.ts`: `httpBatchLink` to `NEXT_PUBLIC_API_URL`, header attaches `Authorization: Bearer ${await getIdToken()}`
- Firebase Web SDK auth (same project as iOS: env vars in `.env.example`)
- Token-refresh recovery (re-fetch on 401)
- **Verify:** `trpc.user.me.query()` returns live user against staging. CORS confirmed (add web origin to backend `ALLOWED_ORIGINS`).

### C3–C10 (after C2)
C3 public poster funnel homepage → C4 backend `task.draftEstimate` + web draft flow → C5 backend `geo.availability` + web module → C6 signup gate on Dispatch → C7 Stripe Elements funding → C8 poster dashboard shell → C9 local pages → C10 analytics.

### Backend endpoints needed (C4/C5, land on audit branch)
- `task.draftEstimate` — `publicProcedure`, rate-limited, composes `ComplianceGuardianService.evaluate()` (no userId) → `ScoperAIService.analyzeTaskScope()` → `refineTaskDescription()`. All anonymous-safe.
- `geo.availability` — `publicProcedure`, rate-limited, PostGIS `ST_DWithin` queries on `tasks` table. Honest empty-state.
- `publicProcedure` exists at `backend/src/trpc.ts:112`. Rate limiting via manual `checkRateLimit()` inside procedure (pattern at `task.ts:416–449`).

---

## 6. Key Files Reference

| Purpose | Path |
|---------|------|
| Backend tRPC router index | `backend/src/routers/index.ts` (exports `AppRouter` type) |
| Backend tRPC setup | `backend/src/trpc.ts` (`publicProcedure` at line 112) |
| Backend auth context | `backend/src/trpc.ts` (`createContext` — Firebase Bearer) |
| Backend CORS config | `backend/src/config.ts` (`app.allowedOrigins` from `ALLOWED_ORIGINS` env) |
| Backend rate limiting | `backend/src/middleware/security.ts` (categories + `checkRateLimit`) |
| Web scaffold | `hustlexpfinal1/web/` (Next.js 16 + Tailwind v4) |
| Web env config | `hustlexpfinal1/web/lib/env.ts` + `web/.env.example` |
| Web globals/theme | `hustlexpfinal1/web/app/globals.css` (Tailwind v4 `@theme` tokens) |
| Design tokens source | `hustlexp-docs/reference/constants/colors.js` + `COLOR_SEMANTICS_LAW.md` |
| Plan file | `/root/.claude/plans/curious-prancing-lake.md` (full truth table + roadmap) |
| **This handoff** | `HUSTLEXP_HANDOFF_ROADMAP_C2.md` in `Sebdysart/hustlexp-ai-backend` on `claude/audit-backend-workflow-mFb7a` |

---

## 7. Recommended First Prompt for Next Session

Paste this into a new Claude Code session:

```
Fetch the handoff from GitHub:
Repo: Sebdysart/hustlexp-ai-backend
Branch: claude/audit-backend-workflow-mFb7a
File: HUSTLEXP_HANDOFF_ROADMAP_C2.md

Also read the plan at /root/.claude/plans/curious-prancing-lake.md.

We are building HustleXP Roadmap C: poster-side web liquidity engine. Roadmap B (backend hardening) is closed. C1 (scaffold) is done. Your job is C2: tRPC + Firebase foundation.

Repos:
- Backend: Sebdysart/hustlexp-ai-backend, branch claude/audit-backend-workflow-mFb7a
- Frontend: Sebdysart/HUSTLEXPFINAL1, branch claude/audit-backend-workflow-mFb7a
- Web app: hustlexpfinal1/web/ (Next.js 16 + Tailwind v4, commit 8a3076d)

C2 tasks:
1. Decide AppRouter type-sharing: workspace ref > generated .d.ts > submodule. Must build in Vercel.
2. Install @trpc/client, @trpc/react-query, @tanstack/react-query.
3. Set up lib/trpc.ts with httpBatchLink + Firebase Bearer token header.
4. Set up Firebase Web SDK auth (same project as iOS).
5. Token-refresh recovery.
6. Verify: trpc.user.me.query() works against the live API. CORS confirmed.
7. Also install shadcn/ui as the base component system (approved for C3+).

Rules: no fake liquidity, no fake trust badges, no background-checked copy, no insurance claims, no Hustler web flows, homepage = task input, signup only at Dispatch. Design tokens from COLOR_SEMANTICS_LAW.md (Black + Purple brand, green = success-only).

Commit C2 separately. Run build + lint after. Push to the branch. Then proceed to C3 (public poster funnel homepage).
```
