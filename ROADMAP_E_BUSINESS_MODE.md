# HustleXP — Handoff: Roadmap E (Business Demand Mode)

> Updated 2026-05-31 (E1). **E1 (business landing page) DONE & accepted.** Added a dedicated, **static** `/business` B2B demand-sensing landing page — a separate business-acquisition lane that does **not** touch the consumer poster funnel or C1–C10. Two net-new web files only: `web/app/business/page.tsx` (server route + `metadata`, renders `<BusinessLanding />`, no `<PageView>`) and `web/components/business-landing.tsx` (server component; no `"use client"`, no consumer `<FunnelForm>`; inline `TrustBullet` + SVG icons per existing convention). The page has a hero with two CTAs ("Register your business", "Request a call") that are **plain `<a href="#register">` anchors only** — they scroll to a `#register` placeholder ("We're onboarding Eastside businesses gradually. Registration opens in the next step."). Plus illustrative target business types, illustrative use cases, a mechanics-only trust/safety block, honest early-access framing, and the exact footer `© HustleXP · Eastside beta · No guaranteed timeline.` **Zero backend / tRPC / DB / admin / analytics touched.** Web commit `b1c5cfc`. **Next step: E2 (intake form component) — NOT started in this session.**

---

## 1. What E1 Is (and Isn't)

Roadmap E opens a **separate business-acquisition lane**: local Eastside businesses register *interest* in recurring task demand. It is **demand-sensing lead capture only** and must never touch the consumer funnel or C1–C10.

**E1 = a thin, honest, zero-promise static landing page.** Its real purpose is to answer one question: *is there business demand worth recruiting supply for?* It deliberately ships **no** form, backend, storage, admin review, dashboard, subscription, or analytics — those are E2–E6 and stay gated.

---

## 2. Repo / Branch State

| Repo | GitHub path | Branch | HEAD | Clean? |
|------|------------|--------|------|--------|
| Backend | `Sebdysart/hustlexp-ai-backend` | `claude/audit-backend-workflow-mFb7a` | `5a3af4f9` (+ this handoff commit) | Yes |
| Frontend/web | `Sebdysart/HUSTLEXPFINAL1` | `claude/audit-backend-workflow-mFb7a` | `b1c5cfc` (E1) | Yes |

> Local web checkout: `~/Desktop/hustlexp-web` (symlink → `~/Documents/HUSTLEXPFINAL1/web`). Backend: `~/Desktop/hustlexp-ai-backend`. **Backend was not modified by E1** — this handoff doc is the only backend change.

---

## 3. E1 — Completed Work

**Files shipped (web, 2 net-new, +327 lines):**
- `web/app/business/page.tsx` — server route, `export const metadata` (title "For local businesses — HustleXP"), renders `<BusinessLanding />`. No analytics component.
- `web/components/business-landing.tsx` — dedicated B2B landing. Mirrors the structure/tokens of `web/components/landing-page.tsx` **without** its embedded consumer `<FunnelForm>`. Sections: header (wordmark → `/` + "Eastside beta"), hero (2 anchor CTAs), target business types (illustrative), use cases (illustrative), trust/safety (`TrustBullet` mechanics only), `#register` placeholder, footer.

**Design / color law:** Black + purple brand, info-blue (`text-info`) for trust/value lines. **No green** on the entry surface (success/money greens are state-only).

**Tests / verification run:**
- `npm run lint` (eslint) → **EXIT 0**, no warnings.
- `npx tsc --noEmit` → **EXIT 0**.
- `npm run build` → **EXIT 0**. `/business` listed as `○ (Static)` prerendered; `/`, `/redmond`, `/sammamish`, `/bellevue`, `/dashboard` (+ all category routes) still build and remain static — no consumer-funnel regression.
- Live (dev server `:8081`): `/business` → **HTTP 200**. Rendered-DOM verified: headline, both CTAs, `id="register"` target, placeholder copy, exact footer, "No guaranteed timeline" all present. CTA click scrolls `scrollY 0 → 4971`, sets `location.hash = #register`, lands target at top via `scroll-mt-6`. Zero browser console errors.

**Copy audit — PASSED.** 0 rendered banned hits for `background.?check | insur | protected | guarantee | vetted | testimonial | SLA | guaranteed worker/fulfillment | fake liquidity/counts/logos`. Only "No guaranteed timeline" matches `guarantee`, which is the allowed honest negation. Banned terms appear **only** inside the source doc-comment that *describes* the bans (same convention as `landing-page.tsx`), never in rendered copy. No fabricated Hustler availability, no fake completed-task counts, no fake testimonials/logos/response-times.

**Scope adherence:** **No backend / tRPC / DB / admin / analytics touched.** No `<PageView>` import. CTAs are anchors only — no form, state, submit, or mutation. No change to the consumer poster funnel or any C1–C10 route/component.

---

## 4. Acceptance

E1 accepted by Sebastian (2026-05-31). All E1 done-criteria met: route 200, all sections render, CTAs are anchors-only scrolling to `#register`, route prerenders static, copy audit clean, zero backend/tRPC/DB/analytics touched, homepage + 8 SEO routes + dashboard regression-clean.

---

## 5. Remaining Risk

**No proven Hustler supply.** `geo.availability` still returns honest empty-state for every Eastside ZIP — there is **zero verified worker liquidity**. This is the single biggest risk in the whole roadmap, far bigger than any code. Therefore:

- **All business-facing copy must remain zero-promise.** No "vetted / insured / background-checked / guaranteed-worker / guaranteed-fulfillment / next-day / X Hustlers nearby" claims — ever. One such line to a business buyer is a legal/reputational liability the consumer funnel never carried. The copy rules are the real deliverable.
- Strong business demand from E1 is a **supply-acquisition signal** (go recruit Hustlers), **not** a green light to build business dashboards.
- **E5/E6 stay hard-gated** on BOTH (a) proven consumer conversion + repeat usage AND (b) a real, verifiable Hustler supply base in the target metro.

---

## 6. Next Step — E2 (NOT started)

E2 = a business intake form **component** (`web/components/business-intake-form.tsx`) with client-side Zod validation (required fields, 5-digit ZIP, email, 8 risk-flag checkboxes, contact preference) and an honest post-submit state — **not yet wired to a backend** (that's E3). E2 must not add backend/DB/analytics. Do **not** start E2 in this session.
