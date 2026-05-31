# HustleXP — Handoff: Roadmap E (Business Demand Mode)

> Updated 2026-05-31 (E4). **E4 (admin lead review queue) DONE & ACCEPTED — see §9. Live DB acceptance PASSED** against dev Neon (19/19 checks). Added two `adminProcedure` endpoints to `backend/src/routers/admin.ts`: `admin.listBusinessLeads` (offset pagination, `status` + `requiresReview` filters, newest-first) and `admin.reviewBusinessLead` (set `REVIEWED`/`APPROVED`/`REJECTED` + admin notes + optional approved template slugs; stamps `reviewed_at`/`reviewed_by`; lead UPDATE and `admin_actions` audit INSERT in one `db.transaction` so a review never commits without its audit row). Guards: missing lead → `NOT_FOUND`, `CONVERTED` lead → `CONFLICT` (E5 boundary, never set here), compliance-flagged APPROVE → `PRECONDITION_FAILED` unless `override:true`. **Backend only — no business dashboard, no admin UI, no account creation, no `CONVERTED`, no auto-approval, no subscriptions, no bulk posting, no analytics, no consumer-funnel / public / web changes.** Backend commit `d7015f23`; handoff commit `07c76252`. Unit tests: `admin-business-leads.test.ts` 20/20 + full unit suite 5807 pass. **Audit-schema finding resolved live (see §9).** **E5/E6 remain hard-gated — do NOT start E5.**
>
> Updated 2026-05-31 (E3). **E3 (backend lead capture + form wiring) DONE & ACCEPTED — see §8.** Added the `business_leads` table (migration `010-business-leads.sql` + mirrored into `constitutional-schema.sql`), a public `business.submitLead` tRPC mutation (anonymous, rate-limited, compliance-gated, PII-safe), and wired the E2 form to it. Every lead stores as `status='NEW'` + `requires_review=true` — **no auto-approval, no dashboard, no admin UI, no subscriptions, no bulk posting, no account creation, no analytics, no consumer-funnel changes.** Backend commit `7041596e`; web commit `26c7803`; handoff commit `502c9eba`. **Live DB acceptance PASSED** against dev Neon (migration applied; valid submit from /business → 200 + success copy + NEW/requires_review row with ip_hash and no raw IP; hard-block phrase → BAD_REQUEST + no row). Next step: E4 — **NOT started, hard-gated.**
>
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

---

## 8. E3 — Completed Work

E3 makes the E2 form real end-to-end — backend storage + a public intake mutation + form wiring — and **nothing more**.

### Backend (commit `7041596e`)
- **`backend/database/migrations/010-business-leads.sql`** (NEW) + mirrored into **`backend/database/constitutional-schema.sql`** — `business_leads` table:
  - `id uuid pk`, identity (`business_name`, `contact_name`, `email`, `phone`, `business_type`, `city`, `zip`), demand signal (`recurring_task_types jsonb`, `expected_frequency`, `avg_budget_cents int`, `urgency`, `notes`), risk/compliance (`risk_flags jsonb`, `contact_preference` CHECK `('form','call')`, `status` default `'NEW'` CHECK `('NEW','REVIEWED','APPROVED','REJECTED','CONVERTED')`, `compliance_score int`, `compliance_notes jsonb`, `requires_review` default `true`), review/conversion (`admin_notes`, `reviewed_at`, `reviewed_by`→users, `approved_templates jsonb`, `converted_user_id`→users), provenance (`source`, `ip_hash`), `created_at`/`updated_at`.
  - Indexes: `(status, created_at DESC)`, `(created_at DESC)`, `(email)`. Shared `update_updated_at_column()` trigger.
  - Migration is **additive** (`CREATE TABLE IF NOT EXISTS`) — apply directly, **never** via `db:migrate` (`migrate-pg.mjs` drops/rebuilds the whole schema from `constitutional-schema.sql`).
- **`backend/src/routers/business.ts`** (NEW) — `business.submitLead` `publicProcedure.mutation`:
  - Anonymous, no auth. Server-side Zod validation (the authority): email, 5-digit Eastside-allowlisted ZIP, ≥1 recurring task type (enum), optional positive-int `avgBudgetCents`, notes ≤1000, risk-flag booleans, `contactPreference ∈ {form,call}`.
  - Rate-limited via the shared 3-layer helper **before** any DB/compliance work — category `business:intake`, burst **3/60s**, daily **20/86400s**, global kill switch **500/86400s**.
  - Derives IP via `deriveIpKey`; stores **only** `sha256(ip)` as `ip_hash` — never a raw IP (also passes the hash, not the raw IP, to compliance).
  - Runs `ComplianceGuardianService.evaluate` on `notes + recurring task types`: **`hard_block` → `BAD_REQUEST`, writes no row**; `soft_flag`/`clean` insert. `status` hardcoded `'NEW'`, `requires_review` always `true` (no auto-approval). Persists `compliance_score`/`compliance_notes`.
  - Returns safe output only: `{ status: 'NEW', requiresReview: true, message }` — **no `id`, no PII echoed back.**
- **`backend/src/routers/index.ts`** — mounted `business: businessRouter`. Regenerated **`dist-types/AppRouter.d.ts`** (`npm run emit:trpc-types`).

### Web (commit `26c7803`, repo `Sebdysart/HUSTLEXPFINAL1`)
- **`web/components/business-intake-form.tsx`** — valid submit now calls `trpc.business.submitLead.useMutation().mutateAsync` (dollars → `avgBudgetCents`). Loading state (`Submitting…`, button disabled), E3 success card, safe error copy mapped from `err.data.code` (`TOO_MANY_REQUESTS` → "Too many attempts…"; `BAD_REQUEST` → compliance-block copy; else generic). **No** localStorage/sessionStorage, **no** analytics, **no** account, **no** redirect. Option arrays `as const` for typed payload.
- **`web/types/trpc/AppRouter.d.ts`** — synced from the pushed backend branch via `scripts/sync-trpc-types.sh`; `trpc.business.submitLead` is typed.

### Tests / verification run
- **Backend:** `npx tsc -b` → clean. `npx eslint backend/src` → **EXIT 0**. `npx vitest run backend/tests/unit/business-router.test.ts` → **10/10 pass** (happy path → NEW row; hard_block → BAD_REQUEST + no row; soft_flag → row + `requires_review`; risk flag → `requires_review`; bad email rejected; non-Eastside ZIP rejected; zero task types rejected; rate-limit → `TOO_MANY_REQUESTS` + no row; `ip_hash`=sha256 stored, raw IP absent; status only `NEW`/no `id` in response). `npm run emit:trpc-types` → bundle contains `submitLead` with output `{status:"NEW";requiresReview;message}`.
  - *Note:* `npx eslint backend/tests/...` errors with a pre-existing `parserOptions.project` quirk (reproduces on `geo-router.test.ts` too) — not introduced by E3; `eslint backend/src` is clean.
- **Web:** `npm run lint`, `npx tsc --noEmit`, `npm run build` → all clean. `/business` still prerenders `○ (Static)`; `/`, `/dashboard`, and all consumer/category routes still build static — **no consumer-funnel regression.**
- **Web (live, local dev `:8081`):** `/business` renders the form. A valid submit fires **exactly one** POST to `/trpc/business.submitLead` (vs E2's zero calls), the failure (no local backend on the configured `apiUrl` `:3000`) is handled gracefully with the generic safe copy, and **`localStorage`/`sessionStorage` stay empty** — no PII, no analytics endpoint hit.

### Live DB acceptance — PASSED (2026-05-31, dev Neon `neondb`)
Run against dev Neon (`ep-young-shape-af9wgdv0-pooler…neon.tech`, `sslmode=require`) with the backend running locally on `:3000` (web `apiUrl`) and the web dev server on `:8081`.

1. **Migration apply** — `psql` was not installed locally, so 010 was applied **additively** via Node + `pg` (loading `DATABASE_URL` from `.env`), running the exact `010-business-leads.sql` file — **not** `db:migrate`. Result: `business_leads` created (was absent), **28 columns**, indexes `business_leads_pkey, idx_business_leads_status_created, idx_business_leads_created, idx_business_leads_email`, trigger `business_leads_updated_at`.
2. **Valid submit from `/business`** (Property manager, ZIP 98074, task "Event setup", risk flag "Entering homes"): network **200** to `/trpc/business.submitLead`; the exact E3 success copy rendered ("Thanks — we received your business registration interest…"); form unmounted; **`localStorage`/`sessionStorage` empty** (no PII, no analytics endpoint hit).
3. **SQL probe** (`ORDER BY created_at DESC LIMIT 1`) →
   ```
   id=e881b697-88e3-448f-8695-b31b1b589bd2  business_name='Eastside Acceptance LLC'
   status=NEW  requires_review=true  contact_preference='form'
   risk_flags={"enteringHomes":true, …7 others false}
   ip_hash=32f6050ffbc1d8c0b7d607d81dd2c14b6fdab2d2bb1ff345e21fcc3f76c008ce  (sha256 — no raw IP)
   ```
   ✓ status NEW · ✓ requires_review true · ✓ risk_flags persisted · ✓ contact_preference persisted · ✓ ip_hash present · ✓ no raw IP · ✓ no auto-approval.
4. **Hard-block test** — `notes` containing banned phrases ("discreet delivery, no questions asked…") → **HTTP 400 `BAD_REQUEST`** with the compliance-block copy; row count **unchanged (2 → 2)** — **no row written**.

> Two acceptance rows remain in dev Neon (`Eastside Acceptance LLC` from the browser submit + a `Curl Sanity Co` backend sanity row). Harmless test data; clear if desired.

### Scope adherence
Backend storage + one public mutation + form wiring only. **No** business dashboard · **no** admin review UI · **no** subscriptions · **no** bulk posting · **no** auto-approval · **no** account creation · **no** consumer-funnel changes · **no** analytics · **no** redirect · **no** localStorage. `status` always `NEW`; `requires_review` always `true`.

### Remaining risk (carried forward)
Still **zero verified Hustler supply** (see §5) — leads are now captured but the platform promises nothing; all business-facing copy stays zero-promise. Strong fill rates are a **supply-recruitment** signal, not a green light for E4+. **E4/E5/E6 remain hard-gated.**

> **Deploy note:** acceptance was run against a *local* backend (`:3000`) pointed at dev Neon. The backend branch still needs to be **deployed** before the public web app's `apiUrl` serves `business.submitLead` in any non-local environment.

**Commits:** backend `7041596e` · web `26c7803` · handoff `502c9eba` (+ this acceptance update).

**Acceptance:** ✅ **E3 ACCEPTED** — code complete, all unit tests green, and live DB acceptance PASSED against dev Neon (valid submit → 200 + NEW/requires_review row with ip_hash/no-raw-IP; hard-block → BAD_REQUEST + no row).

---

## 9. E4 — Completed Work (admin lead review queue)

E4 adds the **admin-only review surface** over the `business_leads` rows E3 captures — and nothing more. Two endpoints, an audit row, a transaction. No UI, no account creation, no `CONVERTED`, no auto-approval.

### Backend (commit `d7015f23`)

- **`backend/src/routers/admin.ts`** (EDIT) — two new `adminProcedure` procedures appended to the existing `adminRouter` (same offset-pagination + audit conventions as `listTasks`/`setUserBan`):
  - **`admin.listBusinessLeads`** (`.query`) — input `{ limit 1..100=20, offset ≥0=0, status?: NEW|REVIEWED|APPROVED|REJECTED|CONVERTED, requiresReview?: boolean }`. Two-query offset pattern (`SELECT … ORDER BY created_at DESC LIMIT/OFFSET` + `COUNT(*)`), parameterized filters, returns `{ leads, total }`. Admin-gated, so contact PII is intentionally returned; `ip_hash` and `compliance_notes` are omitted from the list payload.
  - **`admin.reviewBusinessLead`** (`.mutation`) — input `{ leadId: uuid, status: REVIEWED|APPROVED|REJECTED, adminNotes?: ≤2000, approvedTemplates?: known TaskTemplate slugs, override?: boolean=false }`. Wrapped in a single **`db.transaction`**:
    1. `SELECT … FOR UPDATE`; missing → `NOT_FOUND`.
    2. `CONVERTED` lead → `CONFLICT` (E5 boundary; this endpoint never sets `CONVERTED`).
    3. On `APPROVED`, if `ComplianceGuardianService._scoreTotier(compliance_score) !== 'clean'` (score ≥21, soft-flag) and `!override` → `PRECONDITION_FAILED`. (Hard-block leads were never inserted by E3, so this gates soft-flag approvals; reuses the service threshold, not a magic number.)
    4. `UPDATE business_leads SET status, admin_notes, approved_templates = COALESCE($::jsonb, approved_templates), reviewed_at = NOW(), reviewed_by = $admin, updated_at = NOW() … RETURNING …`.
    5. `INSERT INTO admin_actions` audit row.
  - Input validation: `status` Zod-enum excludes `NEW`/`CONVERTED` (rejected pre-DB); `approvedTemplates` validated against `TEMPLATE_SLUGS` from `TaskTemplateRegistry` (unknown slug rejected).
- **`dist-types/AppRouter.d.ts`** — regenerated via `npm run emit:trpc-types` (E3 committed this file, so it's kept in sync); both new procedures present in the bundle.

### Audit-schema finding (the approval blocker) — RESOLVED

The codebase had **three conflicting `admin_actions` insert shapes**. Read-only introspection of the **live dev Neon** schema (`information_schema.columns`) settled it. Live `admin_actions` columns: `id, admin_user_id (NOT NULL), admin_role (NOT NULL), action_type (NOT NULL), action_details jsonb (NOT NULL), target_user_id/target_task_id/target_escrow_id/target_dispute_id (nullable), result (NOT NULL), result_details (nullable), performed_at`. **There is no `admin_id`, `target_id`, `reason`, or `metadata` column.**

- E4 therefore uses the **live-valid** shape (the one `ui.ts`/`XPTaxService`/`server.ts`/`BetaService`/`ExpertiseSupplyService` already use): `INSERT INTO admin_actions (admin_user_id, admin_role, action_type, action_details, result) VALUES ($1, 'admin', 'business_lead_review', $2::jsonb, 'success')`. The business-lead id lives **inside `action_details`** because `target_user_id` FKs to `users(id)`, not leads.
- The lead UPDATE + audit INSERT share one `db.transaction` (the helper ROLLBACKs + rethrows on any error), so **a review never commits without its audit row** — if the audit insert fails, the status change is rolled back. Unit-tested (case "audit-insert failure rolls back the review").

> **⚠️ Pre-existing latent bug flagged (NOT fixed in E4, out of scope):** `admin.ts`'s own `setUserBan`/`escrowOverride` and `EarnedVerificationUnlockService.adminGrantUnlock` insert into `admin_actions` using columns that **do not exist live** (`admin_id, target_id, reason, metadata` / `target_type`). These audit writes would fail against the real DB. They are masked in unit tests by `db` mocks. **Recommend a separate ticket** to reconcile those inserts (or the schema) — do not rely on those audit trails until fixed.

### Tests / verification run

- **New:** `backend/tests/unit/admin-business-leads.test.ts` — **20/20 pass.** Covers: list returns `{leads,total}`; `total` is full count; `status` + `requiresReview` filters add the right SQL/params; newest-first ordering; non-admin → `FORBIDDEN` on list & review; missing lead → `NOT_FOUND` (no UPDATE); REVIEWED stamps `reviewed_by`/`reviewed_at` + audit row; APPROVE clean lead; REJECT; `approvedTemplates` persisted; APPROVE soft-flagged blocked without `override` and allowed with it; `CONVERTED` → `CONFLICT`; Zod rejects `CONVERTED`/`NEW`/unknown slug; audit-insert failure rolls back; no `INSERT INTO users` (no account created).
- **Regression fix:** added a `ComplianceGuardianService` mock to `admin-router.test.ts`, `admin-branches.test.ts`, `attack-admin.test.ts` — `admin.ts` now imports that service (for `_scoreTotier`), which transitively pulls the `AIClient` chain; the mock keeps it out of those unit tests (same recipe `business-router.test.ts` already uses). No test logic changed.
- `npx tsc -b` → clean. `npx eslint backend/src` → **EXIT 0**. `npx vitest run backend/tests/unit/` → **5807 pass / 7 skipped / 0 fail** (248 files). `npm run emit:trpc-types` → bundle contains `listBusinessLeads` + `reviewBusinessLead`.
- `git status`: only `backend/src/routers/admin.ts`, the four test files, and `dist-types/AppRouter.d.ts` changed. **No web files, no migration files** (the `business_leads` and `admin_actions` tables already exist live).

### Scope adherence
Two admin endpoints + transactional audit only. **No** business dashboard · **no** admin/web UI · **no** account creation · **no** `CONVERTED` (never set; transition blocked) · **no** auto-approval (APPROVED only via explicit admin call) · **no** subscriptions · **no** bulk posting · **no** analytics · **no** consumer-funnel / public changes · **no** migrations.

### Remaining risk (carried forward)
Still **zero verified Hustler supply** (see §5) — admins can now triage business demand, but approving a lead grants **nothing** yet (no account, no access; that's E5). All business-facing copy stays zero-promise. Plus the flagged `admin_actions` column mismatch in the *other* (pre-existing) audit inserts above. **E5/E6 remain hard-gated.**

### Live DB acceptance — PASSED (2026-05-31, dev Neon `neondb`) — 19/19 checks

Run via the repo-blessed **admin test caller** path (`adminRouter.createCaller`) pointed at the **real dev Neon DB** (not mocks), so the actual procedure code + real SQL + the live `adminProcedure` middleware (`admin_roles` lookup) all executed. The HTTP server + Firebase-token path was unnecessary for this — `createCaller` exercises the identical procedure + gate. Throwaway harness (not committed) under `/tmp`, removed after.

> **Admin grant — authorized, disposable, net-zero.** Dev Neon had **zero** `admin_roles` rows, so the harness temporarily granted `role='admin'` to an existing disposable test user (`test-poster-6@hustlexp.test`, `4d736d46…`) **with Sebastian's explicit authorization**, then **revoked it in teardown**. Post-run `SELECT COUNT(*) FROM admin_roles` = **0**. No users created; no standing privilege left behind.

Proof:
1. **`admin.listBusinessLeads`** → `{ leads, total }` with `total=2`; rows returned. ✓ leads array · ✓ numeric total.
2. **Filters** — `status='NEW'` → 2 rows, all `status=NEW`; `status='REVIEWED'` (pre-review) → 0; `requiresReview=true` → 2 (all `requires_review=true`); `requiresReview=false` → 0. ✓ status filter · ✓ requiresReview filter.
3. **`admin.reviewBusinessLead`** on a NEW lead (`a0362c75…`, disposable E3 "Curl Sanity Co" sanity row) with `status:'REVIEWED'`, `adminNotes:'E4 live smoke review'` → returned `status=REVIEWED`. DB row after: `status=REVIEWED` · `reviewed_at` set (`2026-05-31T20:44:21Z`) · `reviewed_by = 4d736d46…` (the admin) · `admin_notes='E4 live smoke review'`. ✓ all four.
4. **Audit row** — `SELECT action_type, action_details, result FROM admin_actions WHERE action_type='business_lead_review' ORDER BY performed_at DESC LIMIT 1` →
   ```
   action_type   = business_lead_review
   result        = success
   admin_user_id = 4d736d46…  (the reviewing admin)
   action_details = {"leadId":"a0362c75-0327-4130-9730-0605a6f113b1","status":"REVIEWED",
                     "override":false,"hadAdminNotes":true,"approvedTemplates":null}
   ```
   ✓ action_type · ✓ result=success · ✓ action_details contains leadId + status. (Insert used the live-valid `admin_actions` column shape — no failure, confirming the §9 schema finding against the real DB.)
5. **Non-admin blocked** — `listBusinessLeads` via a caller with no `admin_roles` grant (`test-worker-6`) → threw `FORBIDDEN`. ✓ live gate enforced.
6. **CONVERTED** not exercised live (no disposable CONVERTED row; covered by unit test). No account created at any step.

> Dev Neon now holds `business_leads`: NEW=1, REVIEWED=1 (the reviewed "Curl Sanity Co" row is harmless disposable E3 test data; clear if desired). `admin_roles` empty.

**Acceptance:** ✅ **E4 ACCEPTED** — code complete, unit tests green (20/20 targeted + 5807 full suite), and live DB acceptance PASSED against dev Neon (list + filters + review→REVIEWED with reviewed_at/reviewed_by/admin_notes + audit row result=success with leadId/status + non-admin FORBIDDEN; admin grant revoked, no account created).

**Next step:** E5 — **NOT started, hard-gated. Do not start.**
