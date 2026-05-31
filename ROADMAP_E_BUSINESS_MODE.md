# HustleXP — Handoff: Roadmap E (Business Demand Mode)

> Updated 2026-05-31 (E2). **E2 (business intake form) DONE — see §7.** Added a client-side intake form component (`web/components/business-intake-form.tsx`) wired into the `/business` `#register` section, with inline client-side validation and an honest no-submit placeholder success state. **Zero backend / tRPC / DB / admin / analytics / account / charge touched.** No network call on submit; no PII persisted; nothing written to localStorage. Web commit `c09aadb` (on `b1c5cfc` / E1). **Next step: E3 (backend lead capture) — NOT started.**
>
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
| Frontend/web | `Sebdysart/HUSTLEXPFINAL1` | `claude/audit-backend-workflow-mFb7a` | `c09aadb` (E2) | Yes |

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

## 6. Next Step — E3 (NOT started)

E3 = backend lead capture: a `submitLead` mutation (tRPC), persistence, and admin manual-review surface to receive what the E2 form collects. E2 deliberately performs **no** network call — wiring it to a real endpoint is E3's job, hard-gated behind the same honesty/scope rules. E3 stays **out of scope** for this session. Do **not** start E3.

---

## 7. E2 — Completed Work

**Files shipped (web): 1 net-new + 1 edit.**
- `web/components/business-intake-form.tsx` (NEW, `"use client"`) — controlled intake form. Imports only `useState` / `FormEvent` from `react`. **No** `trpc`, **no** `capture`/analytics, **no** `localStorage`. Fields: business name\*, contact name\*, email\*, phone (optional), business type\* (select), city, ZIP\*, recurring task types (≥1 chip), expected frequency, average budget per task (optional), urgency, notes (≤1000), contact preference (radio: "Use this form" / soft "Prefer a call"), and the 8 risk-flag checkboxes (entering homes, handling keys, driving/delivery, alcohol/regulated goods, minors/schools, cash handling, customer-facing work, sensitive locations).
- `web/components/business-landing.tsx` (EDIT) — replaced the E1 `#register` placeholder body with `<BusinessIntakeForm />`; kept the section wrapper + heading so the two hero anchor CTAs still scroll to it. Remains a server component. `app/business/page.tsx` unchanged.

**Validation (inline, mirrors `funnel-form.tsx` convention — no Zod, no new dep):** required non-empty (business name / contact name / email / business type / ZIP); email regex; ZIP `^\d{5}$` **and** Eastside-allowlisted (allowlist duplicated locally — consumer funnel left untouched); ≥1 recurring task type; average budget, if given, a positive integer (digit-filtered input, rejects 0); notes ≤1000 chars; risk flags booleans. Errors render in a single `role="alert"`.

**Submit behavior:** on valid submit, **no** network/fetch/mutation and **no** storage write — renders an honest `role="status"` card: *"Thanks — this form is ready for review wiring in the next step. No account created, nothing submitted, and nothing charged."*

**Tests / verification run:**
- `npm run lint` (eslint) → **EXIT 0**, no warnings.
- `npx tsc --noEmit` → **EXIT 0**.
- `npm run build` → **EXIT 0**. `/business` still prerenders `○ (Static)` (4.07 kB w/ client form); `/`, `/dashboard`, `/redmond`, `/sammamish`, `/bellevue` (+ category routes) still build static — no consumer-funnel regression.
- Live (dev `:3000`): `/business` → form renders inside `#register`. Verified each validation path fires (empty required, bad email, non-Eastside/short ZIP, zero task types, budget=0). Valid submit → exact success copy shown, form unmounts. **Network log: only page load + static chunks + RSC prefetch — no POST / fetch / tRPC call on submit.** `localStorage` and `sessionStorage` both empty after submit — no PII persisted.

**Copy audit — PASSED.** Source grep of `business-intake-form.tsx` (comments included) for forbidden trust claims → 0 hits. Rendered-DOM scan → 0 hits. Only `guarantee` match is the allowed honest negation "no guaranteed timeline". Contact radio reads "Prefer a call" (no implied/guaranteed callback). Per review revision, forbidden phrases are **not** enumerated in code comments.

**Scope adherence:** Web only. No backend / tRPC / DB / `submitLead` / admin / dashboard / analytics / account / charge / auto-approval. No consumer-funnel changes (Eastside ZIP set duplicated, not imported).

**Acceptance:** pending Sebastian sign-off.

**Remaining risk (carried forward):** still **zero verified Hustler supply** (see §5) — the form now *collects* business demand but promises nothing; all copy stays zero-promise. The form intentionally drops its data on submit (no persistence) until E3, so no leads are captured yet — strong fill rates are a supply-recruitment signal, not a green light for E5/E6.
