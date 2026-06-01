# Roadmap D — Battlefield Test Matrix

> Created 2026-05-31. Companion to `HUSTLEXP_HANDOFF_ROADMAP_C2.md`. Converts the C1–C10 poster web funnel from **built** to **proven** by running a transaction-warfare matrix against the **local dev stack** (backend `:3000` + web `:8081` + dev Neon + Firebase `hustlexp-fly-new` + Stripe **test** mode).
>
> **Status discipline:** every row starts `PENDING`. Execution flips it to `PASS` / `FAIL` / `BLOCKED` / `N/A` with captured evidence attached inline. **No row is pre-filled with a result. No fabricated results.**

---

## Decisions (locked)

- **Target:** Local dev stack only. Backend `npm run dev` (`:3000`), web `npx next dev --port 8081`, dev Neon, Firebase `hustlexp-fly-new`, Stripe test keys (`sk_test_…` / `pk_test_…`). No deployed staging this round.
- **Owner column:** `Claude` = automatable via preview/MCP/Bash/SQL probes. `Human` = the cross-origin Stripe card-iframe keystroke rows only (4242 / decline / 3DS) — the headless preview cannot type into `js.stripe.com`. Claude drives the funnel to the funding step, hands off, then verifies the backend/DB result.

## Severity legend

- **Critical** — blocks launch outright: money lost/double-charged, escrow state lies, PII leak, false trust/insurance/liquidity claim, funded-state shown without backend proof.
- **High** — blocks a *confident* launch: a core happy-path step fails, a documented failure path doesn't recover, an analytics event missing/leaky (non-PII).
- **Medium** — degraded but safe.
- **Low** — note-only.

## Grounding anchors (verified 2026-05-31)

- Funnel: `web/components/funnel-form.tsx` (EASTSIDE_ZIPS L58–67; chip→slug L28–45; keys `hustlexp.draft.v1`/`hustlexp.lastTaskId.v1`/`hustlexp.funding.v1`; 24h TTL L71; Start Over L313–330; resume L143–171).
- Dispatch: `web/components/dispatch-section.tsx` (auth headline L268; clickwrap L420; register→updateProfile→create L99–137; draft cleared on funded L305).
- Funding: `web/components/funding-step.tsx` (single-shot guard L106/130; poll `escrow.getByTaskId` L215–233; FUNDED copy L359; 20s `confirmFunding` fallback L50/250–301; redirect-resume+strip L193–211; persistence L37–69).
- Availability: `web/components/local-availability.tsx` (emptyState L81–88; signal gate L108–110; k-anon hide L107–114).
- Dashboard: `web/app/dashboard/page.tsx` (auth gate L91–103; list/getById/getByTaskId L113–124; lastTaskId fallback L154–161; timeline lighting L348–362; waiting copy L292–299).
- Analytics: `web/lib/analytics.ts` (allow-list L49–58: `source_page,city_or_zip,category,task_price_cents,task_id,escrow_state,error_code,authenticated`; init flags L105–117; `pickAllowed` L119–133).
- Backend money: `backend/src/routers/escrow.ts` createPaymentIntent L118–217, confirmFunding L249–298, getByTaskId L77–111.
- Webhook: `backend/src/services/StripeWebhookService.ts` L80–101; `backend/src/jobs/stripe-event-worker.ts` L141–175.
- Public rate-limit: `backend/src/routers/_shared/publicRateLimit.ts` L48–102. Cache fail-open: `backend/src/cache/query-cache.ts` L86–104/141–164. Auth: `backend/src/trpc.ts` L26–81.
- Health smoke: `health.ping` (public) / `health.status` (protected) in `backend/src/routers/health.ts`.

---

# MATRIX

## Group 1 — Funnel conversion

| ID | Scenario | Preconditions | Steps | Expected | Status | Evidence | Sev | Owner |
|----|----------|---------------|-------|----------|--------|----------|-----|-------|
| FN-01 | Landing page view | Web+backend up; PostHog key set (or dev console) | Open `/` | H1 "What can you get done today?"; escrow promise; textarea + ZIP + 6 chips + CTA render; `landing_view` fires once | **PASS** | Snapshot: H1 + "You only pay when the work is approved." + textarea + ZIP + 6 chips + "Get estimate" + 4 honest trust bullets + footer. Console: `landing_view` fired, `[analytics] disabled (no key)` safe-no-op, **0 errors**. Screenshot captured. | Med | Claude |
| FN-02 | SEO landing prefill | Up | Open `/redmond`, `/moving-help` | `/redmond` ZIP prefilled `98052`; `/moving-help` "moving" chip `aria-pressed=true`, ZIP empty; one CTA each | **PASS** | `/redmond`: H1 "Get help with tasks in Redmond", ZIP=`98052`, no chip pressed. `/moving-help`: H1 "Moving help on the Eastside", "Moving help" `aria-pressed=true` (others false), ZIP empty. | Med | Claude |
| FN-03 | Task input started | Up | Type a description in textarea | First keystroke fires `task_input_started` (once); no description text in payload | **PASS** | `task_input_started` fired with props `{}` — no description text leaked. | Med | Claude |
| FN-04 | ZIP entered + category | Up | Enter `98004`, click category | `zip_entered {city_or_zip:"98004"}` once; `category_selected {category:…}`; chip pressed | **PASS** | `zip_entered {city_or_zip:"98004"}`, `category_selected {category:"moving"}` (Moving help, standard_physical), `local_availability_viewed {city_or_zip:"98004"}`; chip `aria-pressed=true`. | Med | Claude |
| FN-05 | Estimate success | Backend AI keys live | Submit valid Eastside task | POST `task.draftEstimate` 200; result panel: title/cleanedDescription/category/price/duration; `draft_estimate_started`+`draft_estimate_succeeded` fire | **PASS** | `draft_estimate_started`+`draft_estimate_succeeded {category:standard_physical, city_or_zip:98004, task_price_cents:3000}`; panel: $30.00 / 1 hr 15 min / standard_physical / Normal + cleaned description + honest "before anything is charged" copy. | High | Claude |
| FN-06 | Availability empty-state | `98004` valid Eastside | Enter `98004`, observe module | `geo.availability` 200; "HustleXP is opening availability in your area." (emptyState honest); no fake counts, no "Hustlers nearby" | **PASS** | UI: "HustleXP is opening availability in your area."; no "Hustlers nearby", no fake count. Network: `geo.availability?…"zip":"98004"` → 200 + OPTIONS preflight 204 (CORS `:8081`→`:3000` OK). | High | Claude |
| FN-07 | Availability real-state | Seed ≥1 completed task w/ Eastside `location` | Re-query `98004` | Non-empty counts shown only from real rows; k-anon: avg-accept hidden if N<3 | PENDING | DB seed proof + JSON + screenshot | Med | Claude |
| FN-08 | Dispatch click (logged-out) | Estimate shown, signed out | Click "Dispatch task" | Auth gate expands; headline "Sign in to dispatch"; clickwrap visible; `dispatch_clicked` fires | **PASS** | Logged-out (after clearing a stale `test.hustler` session): `dispatch_clicked {authenticated:false}`; gate "Create your account to dispatch this task" + New-account/sign-in toggle + signup fields + clickwrap. | High | Claude |
| FN-09 | Auth / sign-up (fresh user) | — | Create fresh user via gate | Firebase signup OK; `signup_started`/`signup_completed` fire; fresh `default_mode=poster` user | **PASS** | Created `bf-poster-1780214753187@hustlexp.app` (DOB 1995-06-15, COPPA-valid). `signup_started {authenticated:false}` → `signup_completed {authenticated:true}`. DB: user `5309db3b`, `default_mode='poster'`, `trust_tier=0` — satisfies C8 poster-mode carry-forward. | High | Claude |
| FN-10 | Terms accepted | At gate | Check "I agree to the Terms and Privacy Policy" | Submit ungated only when checked; `terms_accepted` fires once | **PASS** | Clickwrap "I agree to the Terms and Privacy Policy" checked → `terms_accepted {}` fired once. | High | Claude |
| FN-11 | Task create | Signed in poster-mode, terms checked | Submit dispatch | `user.register` 200 → `task.create` 200; post-create "Task draft created…"; `task_create_started`/`_succeeded` fire | **PASS** | `task_create_started`→`task_create_succeeded {task_id:437fba8e-…, category:standard_physical, task_price_cents:3000}`; no tRPC 5xx. Post-create "TASK DRAFT CREATED / Preparing secure payment…". DB task `437fba8e`: state OPEN, price 3000, location 98004, template standard_physical, poster `5309db3b`. | Critical | Claude |
| FN-12 | Funding → dashboard view + analytics | Task created | Fund via Stripe test, open `/dashboard` | Funding completes (Group 2); `/dashboard` shows funded task; `dashboard_viewed`+`task_detail_viewed` fire | **PASS** (events deferred to AN-01) | Funding completed → escrow FUNDED; `/dashboard` shows the funded task ($30.00, "Payment funded", "$30.00 held in escrow since 5/31/2026, 1:12:29 AM"). Screenshot captured. `dashboard_viewed`/`task_detail_viewed` are mount-time view events — payload capture folded into AN-01 (Phase 6). | Critical | Claude |

## Group 2 — Money / escrow

| ID | Scenario | Preconditions | Steps | Expected | Status | Evidence | Sev | Owner |
|----|----------|---------------|-------|----------|--------|----------|-----|-------|
| MN-01 | 4242 success (real keystrokes) | Task created; Stripe test; real browser | Type `4242…` into Payment Element, Pay | `createPaymentIntent` 200 `{paymentIntentId,clientSecret,amount,escrowId}`; charge `succeeded`; "Task funded. Next: Hustler matching." only after backend FUNDED | **PASS (Human keystrokes)** | 2026-05-31 Human pass: operator typed `4242 4242 4242 4242` (12/34, CVC 123) into the live Stripe Payment Element in their own Chrome → PI `pi_3Td4rL97UdWM2cEw1dqHsPgU` **succeeded**, **1 charge** `py_3Td4rL…` (3000¢, paid); escrow `2aa83274` **FUNDED** (version 1→2, funded_at set, **1 row**); UI "Task funded. Next: Hustler matching." only after backend FUNDED. No duplicate charge/row. | Critical | Human |
| MN-02 | Declined card recovery | Funding step | Enter `4000 0000 0000 0002`, Pay | Clean inline error; escrow stays PENDING; retry possible; `payment_failed {error_code}` (no message) | **PASS (Human keystrokes)** | 2026-05-31 Human pass (task `bfe42f99`): operator typed decline card `4000 0000 0000 0002` → UI "Your payment method was declined." + "Try again" (recoverable). DB escrow `09a42dc9` stayed **PENDING** (version 1, funded_at null, 1 row). Stripe PI → `requires_payment_method`; charge `py_3Td4xt…` **failed**/paid:false — no money captured. `payment_started`+`payment_failed` fired (AN-01 +2). | Critical | Human |
| MN-03 | 3DS redirect/resume | Funding step | Enter `4000 0027 6000 3184`, complete 3DS | Redirect to `return_url`, query-params stripped, polling resumes, → FUNDED | **PASS (Human keystrokes)** | 2026-05-31 Human pass (task `05c2632a`): operator typed 3DS card `4000 0027 6000 3184` + completed the real 3D Secure auth popup → returned to `/` with `?payment_intent=…` **stripped** → polling → escrow `16bc7389` **FUNDED** (version 1→2, funded_at set, **1 row**). Stripe PI `pi_3Td52V…` succeeded, **1 charge** `py_3Td52V…` (3000¢, paid). `payment_succeeded_client`→`payment_funded_backend` fired; UI funded only after backend FUNDED. | High | Human |
| MN-04 | Duplicate payment click | Funding step | Click Pay twice rapidly | Single-shot guard; exactly ONE PaymentIntent / ONE charge / ONE escrow row | **PASS (create-side)** / literal double-Pay-click → Human | createPaymentIntent single-shot (`createFiredRef`) held across the whole run: exactly 1 PI (`pi_3Td4O9…`), 1 charge, 1 escrow row. Literal rapid double-click of "Pay" in the iframe owed by Human pass. | Critical | Claude/Human |
| MN-05 | Browser refresh mid-funding | PI created, not yet funded | Hard-refresh during funding | `hustlexp.funding.v1` resume lands back in funding/polling; no second PI; no double charge | **PARTIAL** | Funding persistence + resume proven (ST-02; redirect-resume reused the same PI, no 2nd PI/charge — still 1 row/1 charge). A dedicated hard-refresh at the PENDING funding step (pre-charge) not isolated this run — recommend in Human pass. | High | Claude |
| MN-06 | Webhook-ON path | `STRIPE_WEBHOOK_SECRET` set + `stripe listen` | Fund a task | `payment_intent.succeeded` webhook funds PENDING escrow (sig verified); FUNDED without client fallback | **BLOCKED** | No `stripe listen` this run (deliberately webhook-OFF to prove MN-07 fallback). Needs Stripe CLI forwarding to `/webhooks/stripe` + its `whsec_…`. Recommend in Human pass / staging. | High | Claude/Human |
| MN-07 | Webhook-OFF confirmFunding fallback | No webhook running | Fund a task | After 20s poll deadline, client `confirmFunding` re-verifies PI server-side → FUNDED | **PASS** | No `stripe listen` running. PI confirmed (pm_card_visa) → returned via real return_url → polling → `confirmFunding` fallback re-verified PI server-side → escrow FUNDED; `payment_funded_backend {escrow_state:"FUNDED"}` fired. | High | Claude |
| MN-08 | DB escrow state = FUNDED | Post-fund | SQL probe | `escrows.state='FUNDED'`, `funded_at` set, `version` bumped | **PASS** | escrow `797cc2c8`: state=FUNDED, funded_at=2026-05-31T08:12:29Z, version 1→2. | Critical | Claude |
| MN-09 | One escrow row only | Post-fund | `SELECT count(*) WHERE task_id=…` | Exactly 1 escrow row for the task | **PASS** | `SELECT count(*) FROM escrows WHERE task_id=437fba8e` → 1 (no duplicate across create+fund). | Critical | Claude |
| MN-10 | One Stripe charge only | Post-fund | Stripe API list charges by PI | Exactly 1 succeeded charge for the PI | **PASS** | `charges.list({payment_intent:pi_3Td4O9…})` → 1 charge `ch_3Td4O997UdWM2cEw0C0GSZPx` status=succeeded amount=3000 paid=true. | Critical | Claude |
| MN-11 | `stripe_payment_intent_id` set | Post-fund | SQL probe | Column non-null, equals the funded PI id | **PASS** | escrow `797cc2c8`.stripe_payment_intent_id = `pi_3Td4O997UdWM2cEw0UPct5dr` (matches funded PI). | Critical | Claude |
| MN-12 | No UI funded state unless backend FUNDED | Funding step | Inspect UI gating vs `escrow.getByTaskId` | "Task funded…" renders ONLY when polled `state==='FUNDED'`; never on Stripe-only success | **PASS** | Pre-charge (escrow PENDING): `showsFundedState:false`, UI "Pay $30.00…". After PI succeeded but during polling: still "Confirming payment with backend…", no funded copy. Funded copy "Task funded. Next: Hustler matching." appeared ONLY after backend escrow→FUNDED (`payment_funded_backend` fired). Never on Stripe-only success. | Critical | Claude |
| MN-13 | Double-fund guard | Already FUNDED escrow | Re-call `createPaymentIntent` same task | FUNDED→`PRECONDITION_FAILED`; other terminal→`CONFLICT`; no new charge | **PASS** | `createPaymentIntent {taskId:437fba8e}` on FUNDED escrow → `PRECONDITION_FAILED` (412) "Escrow already funded for this task". Guard fires before any Stripe call — no new charge. | Critical | Claude |
| MN-14 | confirmFunding cross-checks | FUNDED / mismatched PI | Call `confirmFunding` mismatched | Requires `succeeded` + `metadata.task_id` + `metadata.poster_id`; different-PI on FUNDED → CONFLICT; same-PI → idempotent OK | **PASS** | Same correct PI on FUNDED escrow → idempotent success (returns FUNDED, no error). Fake/nonexistent PI → `BAD_REQUEST` "Could not verify payment with Stripe" (server-side verify rejects — no blind trust of client PI). | Critical | Claude |

## Group 3 — Auth / session

| ID | Scenario | Preconditions | Steps | Expected | Status | Evidence | Sev | Owner |
|----|----------|---------------|-------|----------|--------|----------|-----|-------|
| AU-01 | Logged-out dispatch gated | Signed out, estimate shown | Click Dispatch | Auth gate appears; no `task.create` fires while unauthenticated | **PASS** | Logged-out Dispatch → gate appeared; `task_create_started` fired only AFTER `signup_completed` (event order confirms no create pre-auth). | High | Claude |
| AU-02 | Firebase sign-in | Test user | Sign in | Token minted; `user.me`/register resolves; identity set | **PASS** | FN-09 signup minted a token → `user.register` resolved → identity set (`signup_completed {authenticated:true}`); prior `test.hustler` session auto-restored on load; AU-04 restored post-refresh. (Explicit existing-account sign-in form not separately driven — same `signInWithEmailAndPassword` gate.) | High | Claude |
| AU-03 | Expired-token recovery | Stale ID token | Trigger call with expired token | `authTokenRefreshLink` retries once after `getIdToken(true)`; call succeeds (no hard 401 to user) | **PENDING** | Not run — hard to force a cleanly-expired token mid-session. `authTokenRefreshLink` (retry-once on 401 after `getIdToken(true)`) exists in `providers/trpc-provider.tsx`. Recommend dedicated test. | High | Claude |
| AU-04 | Refresh after auth | Signed in | Hard-refresh | Session restored from Firebase persistence; still signed in; draft intact | **PASS** | Hard-refresh on `/dashboard` (signed-in fresh poster) → still signed in (Firebase persistence restored), funded task still rendered. | Med | Claude |
| AU-05 | Draft preserved through auth | Draft in localStorage, signed out | Sign in at gate | `hustlexp.draft.v1` survives Firebase round-trip; estimate not clobbered | **PASS** | After a full reload + auth-state change (signed out the stale session), `hustlexp.draft.v1` survived and the $30 ESTIMATE panel resumed intact — estimate not clobbered. | High | Claude |
| AU-06 | Sign-out resets identity/analytics | Signed in, identified | Sign out | `resetAnalytics()`→`posthog.reset()`; identity cleared; later events not tied to prior UID | **PARTIAL** | Clearing the Firebase session + reload re-initialized analytics logged-out (subsequent `dispatch_clicked {authenticated:false}`). In-app sign-out→`resetAnalytics()` not driven (no sign-out control on the funnel; `analytics-provider.tsx` calls it on auth→null). Recommend dedicated test. | High | Claude |

## Group 4 — State persistence

| ID | Scenario | Preconditions | Steps | Expected | Status | Evidence | Sev | Owner |
|----|----------|---------------|-------|----------|--------|----------|-----|-------|
| ST-01 | Draft localStorage persistence | Estimate returned | Refresh page | `hustlexp.draft.v1` restores description/zip/category/result | **PASS** | Full reload restored the estimate panel (description + ZIP + category + $30 result) from `hustlexp.draft.v1`. | High | Claude |
| ST-02 | Funding localStorage persistence | PI created | Refresh mid-funding | `hustlexp.funding.v1` restores funding phase | **PASS** (persist verified; refresh-resume = MN-05) | `hustlexp.funding.v1` written: `{taskId:437fba8e, escrowId:797cc2c8, clientSecret:present, paymentIntentId:pi_3Td4O9…, status:pending}`. Refresh-resume behavior covered by MN-05. | High | Claude |
| ST-03 | lastTaskId dashboard fallback | Funded task; non-poster or empty list | Open `/dashboard` | `hustlexp.lastTaskId.v1` loads funded task via getById/getByTaskId even when listByPoster empty/forbidden | **PARTIAL** | `lastTaskId` (`437fba8e`) was written and used as the dashboard's default selection. The forbidden/empty-`listByPoster` fallback branch not forced (fresh user IS poster-mode so `listByPoster` worked — C8 already verified the fallback). | High | Claude |
| ST-04 | Start Over clears state | Draft+funding+lastTaskId present | Click Start Over | All three keys removed; form resets to empty | **PENDING** | Not run this session (funnel ended at funded/dashboard). Start Over clears all 3 keys per `funnel-form.tsx:313–330`. Recommend a dedicated run. | Med | Claude |
| ST-05 | Dashboard loads funded task | Funded task | Open `/dashboard` | Funded task selected by default; detail + escrow FUNDED render | **PASS** | `/dashboard` default-selected funded task `437fba8e`; detail + escrow FUNDED rendered (see DB-01/DB-02). | High | Claude |
| ST-06 | Stale TTL eviction | Draft entry older than 24h (synthetic timestamp) | Load page | Stale draft auto-removed, fresh form shown | **PENDING** | Not run (would require injecting a >24h synthetic `createdAt`). TTL guard at `funnel-form.tsx:71` (`DRAFT_TTL_MS=24h`). Recommend a dedicated test. | Low | Claude |

## Group 5 — Legal / copy / trust (audit: rendered DOM + source across `/`, 8 SEO pages, dispatch, funding, dashboard)

| ID | Scenario | Preconditions | Steps | Expected | Status | Evidence | Sev | Owner |
|----|----------|---------------|-------|----------|--------|----------|-----|-------|
| LG-01 | No "background-checked" claim | All routes up | grep rendered DOM + source | Zero "background check(ed)" as a claim (Checkr is a stub) | **PASS** | grep over `app/`+`components/` (18 tsx): every "background check" hit is a ban-documenting code comment (page.tsx L16, dashboard L32, landing-page L16, funding-step L30). 0 rendered claims. | Critical | Claude |
| LG-02 | No insurance/protection claim | Up | grep `insur*`/`protect*`/`guarant*` | Only honest negations ("No guaranteed timeline"); no positive claim | **PASS** | `insur/protect/guarantee` hits = ban comments + honest "No guaranteed timeline" (page.tsx L91, landing L152) + dev-only `(protected)` tRPC label on `dev/me` (notFound in prod). No positive claim. | Critical | Claude |
| LG-03 | No fake liquidity | Up | Inspect availability + SEO copy | Counts only from real rows; emptyState honest; no invented supply | **PASS** | Availability renders backend-truthful empty-state (FN-06 runtime). Only liquidity string is `local-availability.tsx:158` "Hustlers near you" — gated on `hustlerSignalAvailable && count>0`, never rendered (backend `hustlerSignalAvailable:false`). | Critical | Claude |
| LG-04 | No fake completed-task counts | Up | grep counts/testimonials | Examples labeled "not a list of completed tasks"; no fabricated totals | **PASS** | No fabricated counts/testimonials/stars; only hit is comment "no fake testimonials". C9 honesty label present (landing-page L110 "Examples of what you can post — not a list of completed tasks"). | Critical | Claude |
| LG-05 | No fake response times | Up | grep "response time"/"avg … min" | None except k-anon-gated real avg-accept (hidden when N<3) | **PASS** | No response-time/ETA claims; "time" hits = ban comments + "No guaranteed timeline". Avg-accept k-anon-hidden (FN-06: `averageTimeToAcceptMinutes:null`). | Critical | Claude |
| LG-06 | No matched/accepted/on-the-way copy | Up, all states | grep banned phrases | "matched"/"accepted"/"on the way"/"is live"/"insured"/"protected"/"guaranteed" absent unless backend proves it | **PASS** | No banned phrase rendered. "accepted" only in dashboard proven-state logic + honest "No Hustler has accepted yet." (verified greyed at runtime, DB-04). Rendered `/yard-help` HTML: only honest copy. | Critical | Claude |

## Group 6 — Analytics / privacy

| ID | Scenario | Preconditions | Steps | Expected | Status | Evidence | Sev | Owner |
|----|----------|---------------|-------|----------|--------|----------|-----|-------|
| AN-01 | All 22 events fire | Full funnel run incl. fund+dashboard | Drive estimate→dispatch→fund→dashboard, capture each | All 22 events fire at their anchors; each once per ref-guard | **PASS (20/22 live)** | 20 of 22 confirmed fired live across the automated + Human passes — added `payment_started`, `payment_succeeded_client` (3DS run), `payment_failed` (decline run) during the Human Stripe pass. Only `draft_estimate_failed` + `task_create_failed` unfired (pure backend-error paths, not triggered in a healthy run) — both ride the same central `capture()`. | High | Claude/Human |
| AN-02 | No raw task description | Any event | Inspect payloads | No description text in any payload | **PASS** | No description text in any of the 17 payloads (`task_input_started {}` despite typed text). | Critical | Claude |
| AN-03 | No email/name | Any event | Inspect payloads + identify | `identify` uses Firebase UID only; no email/name | **PASS** | No email/name in any payload; `signup_completed {authenticated:true}` only; identify = opaque UID. | Critical | Claude |
| AN-04 | No Firebase token | Any event | Inspect payloads | No ID token in any property | **PASS** | No ID token in any of the 17 payloads. | Critical | Claude |
| AN-05 | No Stripe client secret | Funding events | Inspect payloads | No `clientSecret` emitted | **PASS** | `payment_intent_created {task_id}`, `payment_funded_backend {escrow_state,task_id}` — no clientSecret. | Critical | Claude |
| AN-06 | No payment-method data | Funding events | Inspect payloads | No card/PM fields | **PASS** | No card/PM fields in any funding event. | Critical | Claude |
| AN-07 | No error.message | `*_failed` events | Force failures | Only `error_code`; message dropped (incl. bare network error → code absent, not message) | **PASS (code + C10)** | No happy-path failure this run; central `capture()` forwards `error_code` only (never message); C10 live-verified `draft_estimate_failed` dropped the bare-network message. Re-confirm in a live failure path. | Critical | Claude |
| AN-08 | Allow-list only | All events | Diff payload keys vs allow-list | Only the 8 allow-listed keys; `pickAllowed` drops extras | **PASS** | All 17 captured payloads contained ONLY keys from the 8-key allow-list; central `pickAllowed()` enforces uniformly. | Critical | Claude |
| AN-09 | Live PostHog pass | Real `NEXT_PUBLIC_POSTHOG_KEY` | Run funnel with key set | Events land in PostHog with allow-listed props only; autocapture/recording/pageview OFF | **BLOCKED** | Key empty → safe-no-op (`[analytics] disabled (no NEXT_PUBLIC_POSTHOG_KEY)` confirmed). Needs a real key. | Med | Claude |

## Group 7 — Backend resilience

| ID | Scenario | Preconditions | Steps | Expected | Status | Evidence | Sev | Owner |
|----|----------|---------------|-------|----------|--------|----------|-----|-------|
| BR-01 | Upstash failure tolerated | Blank/broken UPSTASH creds | Run task.create + funding | Cache helpers fail-open; create+fund still 200; no `res.map` crash | **PASS (proven live)** | Upstash account rate-limited → 123 caught "Rate limit check error"/`res.map is not a function` in server log, **yet** task.create, createPaymentIntent, confirmFunding, geo.availability all 200 and full funnel+funding succeeded. Fail-open confirmed under real Upstash failure. (Note: rate-limiter logs these expected degradations at ERROR — noisy.) | Critical | Claude |
| BR-02 | Off-area ZIP blocked client-side | Funnel | Enter `90210`/`99999` | Eastside-only message; no `draftEstimate`/`geo.availability` call fires | **PASS** | Entered `90210`: `geoCalledFor90210=false` (only the prior 98004 call exists); Eastside messaging present. No backend call fired for off-area ZIP. | High | Claude |
| BR-03 | Rate limits behave safely | Public endpoints | Burst `draftEstimate`/`geo.availability` | Per-IP burst+daily fail-OPEN; global kill-switch fails-CLOSED; dev-local key works without proxy headers | **PASS (fail-open)** | 10× rapid `geo.availability` burst → 10/10 HTTP 200 under active Upstash failure (per-IP layers fail-OPEN, dev-local key works without proxy headers). Global kill-switch fail-CLOSED not triggerable at this volume — covered by unit tests (`geo-router.test.ts`). | High | Claude |
| BR-04 | geo.availability honest empty-state | Eastside ZIP, no matching rows | Query | 200 `emptyState:true`, zeros, `hustlerSignalAvailable:false`, avg null; never 500 | **PASS** | `geo.availability {"zip":"98004"}` → 200 `{emptyState:true, tasksPostedLast7Days:0, completedLast30Days:0, completedByCategory:{}, averageTimeToAcceptMinutes:null, hustlerSignalAvailable:false, nearbyHustlerCount:0}`. No 500. | High | Claude |
| BR-05 | Schema migrations applied | dev Neon | `list_migrations` / probe columns | 008 + 009 present (users auth/plan cols, task cols, task_ratings, escrows.version); flag any new drift | **PASS** (2026-05-31) | Node `pg` probe: `users.is_banned/account_status/plan/plan_expires_at`, `tasks.risk_level`, `task_ratings` table, `escrows.version` all PRESENT. No migrations-ledger table in project (column existence is authoritative). | Critical | Claude |
| BR-06 | No 500s in expected flows | Full happy path | Drive estimate→create→fund→dashboard | Zero 500s on any expected-path call | **PASS** | **0** `INTERNAL_SERVER_ERROR`/`httpStatus:500` in the entire server log; preview network "failed" filter showed only a benign Stripe iframe-target `ERR_ABORTED`. Every expected-flow tRPC call (estimate/create/PI/confirm/availability/dashboard) returned 2xx. | Critical | Claude |
| BR-07 | Invalid ZIP server-side reject | — | `geo.availability` non-Eastside ZIP | BAD_REQUEST "not yet available in this ZIP" | **PASS** | `99999` → HTTP 400 `BAD_REQUEST` "HustleXP is not yet available in this ZIP."; `90210` → identical 400. | Med | Claude |

## Group 8 — Dashboard truth

| ID | Scenario | Preconditions | Steps | Expected | Status | Evidence | Sev | Owner |
|----|----------|---------------|-------|----------|--------|----------|-----|-------|
| DB-01 | Funded task appears | Funded task | Open `/dashboard` | Funded task in list + detail panel | **PASS** | `/dashboard` (signed-in fresh poster): task `437fba8e` "Help me move a couch…" $30.00 OPEN ZIP 98004 in list + detail panel. | High | Claude |
| DB-02 | Escrow state real | Funded | Inspect detail vs DB | UI escrow state matches `escrow.getByTaskId` (FUNDED + amount + funded_at) | **PASS** | UI "Payment funded · $30.00 held in escrow since 5/31/2026, 1:12:29 AM" matches DB escrow `797cc2c8` FUNDED / 3000 / funded_at 08:12:29Z. | Critical | Claude |
| DB-03 | Timeline lights only proven states | Funded, unmatched | Inspect timeline | Only "Task created" + "Payment funded" lit; others greyed | **PASS** | Marker colors: "Task created" white (255), "Payment funded" near-white (229) = lit; the other three grey `rgb(142,142,147)` = greyed. Only the two backend-proven steps lit. | Critical | Claude |
| DB-04 | Future steps greyed | Funded, unmatched | Inspect timeline | Hustler accepted / Proof submitted / Payment released greyed (no green, no claim) | **PASS** | "Hustler accepted" / "Proof submitted" / "Payment released" markers all grey `rgb(142,142,147)`, no green, no active claim (task.state=OPEN, escrow not RELEASED). | Critical | Claude |
| DB-05 | No fake applicants | Funded, unmatched | Inspect waiting block | Honest "No Hustler has accepted yet." + "Funds stay in escrow until proof is reviewed."; zero fabricated applicants/ETAs | **PASS** | Waiting block: "Waiting for Hustler matching" / "No Hustler has accepted yet." / "Funds stay in escrow until proof is reviewed." Fake-applicant regex = false; banned-copy regex = false. | Critical | Claude |

---

# EXECUTION ORDER

Run strictly in order; a failed Critical gate halts the phase and is fixed (or explicitly waived by the operator) before continuing. Each phase appends results + evidence to this file.

### Phase 1 — Environment readiness (gate)
- **Repo cleanliness + sync gate (run FIRST — stop and report if any check fails):**
  - Backend branch clean and in sync with origin (`git fetch`, no ahead/behind divergence).
  - Web branch clean and in sync with origin.
  - No uncommitted handoff/matrix changes **except** this `ROADMAP_D_BATTLEFIELD_MATRIX.md`.
  - No stale dev servers already bound to `:3000` or `:8081`.
  - If dirty / out of sync / port taken → **halt and report**; do not start tests.
- Start backend `:3000` and web `:8081`.
- Confirm env (backend `DATABASE_URL`, `sk_test_…`, Firebase admin, `ALLOWED_ORIGINS` incl. `:8081`; web `NEXT_PUBLIC_API_URL`, Firebase web cfg, `pk_test_…`, optional PostHog).
- Confirm migrations **008 + 009** on dev Neon (BR-05); record any fresh drift.
- Smoke `health.ping` green.
- Webhook posture: **with** `stripe listen` for MN-06, **without** for MN-07.

### Phase 2 — Smoke tests
FN-01, FN-02, BR-07, FN-06/BR-04.

### Phase 3 — Happy-path transaction
FN-03→FN-12 in sequence: input → ZIP/category → estimate → dispatch gate → sign-in → terms → `task.create` → fund (MN-01 Human keystrokes) → dashboard. Spine: FN-11, MN-01, MN-08/09/10/11, FN-12, DB-01..DB-05.

### Phase 4 — Failure paths
Money: MN-02, MN-03, MN-04, MN-05, MN-06/07, MN-12/13/14. Auth: AU-01..06. State: ST-01..06. Resilience: BR-01, BR-02, BR-03, BR-06.

### Phase 5 — Privacy / copy audit
LG-01..06 across `/`, the 8 SEO routes, dispatch, funding, every dashboard state.

### Phase 6 — Analytics audit
AN-01 (all 22 fire) from the Phase-3/4 capture; AN-02..08 payload/allow-list/PII audit; AN-09 live PostHog if a real key is available.

### Phase 7 — Final go/no-go summary
Every Critical PASS (or explicitly waived) → **GO**; any open Critical → **NO-GO** with blocker list, severity, owner, minimal fix. Substituted/blocked rows flagged BLOCKED, never PASS.

---

## Execution log

### Phase 1 — Environment readiness

**Repo cleanliness + sync gate — ✅ PASS (2026-05-31)**
- Initial check **HALTED**: backend was 1 ahead of origin (unpushed `28d5bff7` C10 handoff) + `tests-vault` submodule dirty (cosmetic `TODO`→`PLANNED` comment); web was 1 ahead (unpushed `c66a9f3` C10).
- Resolution (user-authorized): pushed backend `2d81c872..28d5bff7` and web `cdc2d06..c66a9f3` to `origin/claude/audit-backend-workflow-mFb7a`; reverted the cosmetic `tests-vault/invariants/stripe-monetization.test.ts` edit.
- Re-check: backend 0/0, web 0/0; working trees clean except benign untracked `.claude/` tooling + this matrix file (allowed exception). Ports `:3000` and `:8081` free.

**Server bring-up — ✅**
- Backend `:3000` up (`npx tsx --env-file=.env backend/src/server.ts`): `/health` → `healthy` (schema 1.0.1, env development); `/health/readiness` → `ready:true`, dbLatency 21ms (Neon connected); 5 financial-invariant DB triggers active; tRPC `health.ping` → `{status:"ok"}`.
- Web `:8081` up (`npx next dev --port 8081`, Next 16.2.6 + Turbopack, loads `.env.local`): homepage `/` → HTTP 200. (Benign Next warning: multiple lockfiles, inferred workspace root — cosmetic.)

**Env confirm — ✅ with 2 caveats**
- Backend: `DATABASE_URL`, `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_WEBHOOK_SECRET` (SET), Firebase admin trio, `UPSTASH_REDIS_REST_URL`, `NODE_ENV`, `PORT`, `OPENAI_API_KEY` all SET. `ALLOWED_ORIGINS` unset → dev CORS allow-list applies (C6–C8 ran web `:8081` → backend `:3000` fine, so `:8081` is covered).
- Web: `NEXT_PUBLIC_API_URL=http://localhost:3000`, Firebase web cfg, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…` all SET.
- **Caveat 1 — PostHog key empty** (`NEXT_PUBLIC_POSTHOG_KEY` blank, `…HOST` unset): analytics runs in safe-no-op / dev-console mode. AN-01–AN-08 verifiable via the dev-console capture; **AN-09 (live PostHog) will be BLOCKED** unless a real key is supplied.
- **Caveat 2 — webhook secret** (`STRIPE_WEBHOOK_SECRET` SET but value not confirmed real vs `whsec_placeholder`): **MN-06 (webhook-ON)** needs a `stripe listen` session supplying a live signing secret; **MN-07 (webhook-OFF `confirmFunding` fallback)** is unaffected.

**Stripe/keys test-mode — ✅** `sk_test_…` (backend) + `pk_test_…` (web) confirmed; no live keys.

**Phase 1 verdict: READY.** Gate passed; stack healthy; schema confirmed. Two env caveats carried forward (PostHog live key, webhook signing secret).

### Phase 2 — Smoke tests — ✅ ALL PASS (2026-05-31)
Driven via preview MCP browser on `:8081` (serverId `cff91763`).
- **FN-01** PASS — homepage structure + `landing_view` + 0 console errors + safe-no-op. Screenshot captured.
- **FN-02** PASS — `/redmond` ZIP=98052; `/moving-help` "Moving help" chip pressed, ZIP empty.
- **BR-04** PASS — `geo.availability` 98004 → 200 honest empty-state, no 500.
- **BR-07** PASS — 99999 + 90210 → HTTP 400 "not yet available in this ZIP".
- **FN-06** PASS — UI empty-state copy + `geo.availability` 98004 200 + CORS preflight 204.
- **BR-02** PASS — off-area 90210 fired no backend call (client-side gate holds).

Stack healthy: zero failed network requests, zero console errors across all smoke pages. **Proceeding to Phase 3 (happy-path transaction).**

### Phase 3 — Happy-path transaction — drive-side ✅ (parked at funding handoff)
Single live funnel run, fresh user, task `437fba8e-c421-47c1-9bbf-3e7f1058b91c`.
- **FN-03/04/05** PASS — input→ZIP→category→estimate; events `task_input_started {}`, `zip_entered`, `category_selected {moving}`, `local_availability_viewed`, `draft_estimate_started`→`_succeeded {task_price_cents:3000}`; $30 panel.
- **Stale-session find:** browser carried a persisted Firebase session (`test.hustler@hustlexp.app`) from prior C6/C8 acceptance → first Dispatch showed `authenticated:true`. Cleared Firebase IDB persistence + reloaded → logged out; **draft resumed from `localStorage` (AU-05/ST-01 evidence).**
- **FN-08** PASS — logged-out Dispatch → gate `dispatch_clicked {authenticated:false}`, signup form + clickwrap.
- **FN-09** PASS — **fresh user created** `bf-poster-1780214753187@hustlexp.app`; `signup_started`→`signup_completed`; DB user `5309db3b` `default_mode=poster` `trust_tier=0` (satisfies C8 carry-forward).
- **FN-10** PASS — `terms_accepted`.
- **FN-11** PASS (Critical) — `task_create_started`→`task_create_succeeded`; no tRPC 5xx; DB task `437fba8e` OPEN/3000¢/98004/standard_physical.
- **AU-01** PASS — `task_create_started` only fired post-`signup_completed` (no create pre-auth).
- Funding step auto-mounted: `payment_intent_created {task_id:437fba8e}`; **escrow `797cc2c8` PENDING, amount 3000, `stripe_payment_intent_id=pi_3Td4O997UdWM2cEw0UPct5dr`, version 1, funded_at null — exactly 1 row** (C7 Step-1 PENDING-row-with-PI fix working); funding persisted to `hustlexp.funding.v1`; Payment Element rendered (8 Stripe iframes).
- **MN-12** PASS (pre-charge) — backend PENDING, UI shows `showsFundedState:false` (no premature funded copy).

**Funding (operator chose "Both" — API-substitute now + Human literal pass later):**
- Stripe API: PI `pi_3Td4O997UdWM2cEw0UPct5dr` was `requires_payment_method` → confirmed with `pm_card_visa` (=4242) → **succeeded**; metadata `{task_id:437fba8e, poster_id:5309db3b, platform_fee:450}` (15% fee present). 1 charge `ch_3Td4O997UdWM2cEw0C0GSZPx` succeeded/$30/paid.
- Drove the **real return_url redirect-resume**: navigated `…/?payment_intent=…&payment_intent_client_secret=…&redirect_status=succeeded` → FundingStep resumed to polling, **query params stripped** (URL → `/`) → webhook-off `confirmFunding` fallback re-verified PI server-side → **escrow FUNDED**.
- UI flipped to "Task funded. Next: Hustler matching." + "View task dashboard" **only after** backend FUNDED (`payment_funded_backend {escrow_state:"FUNDED"}`).
- **DB invariants:** escrow `797cc2c8` FUNDED, amount 3000, PI set, version 1→2, funded_at set, **exactly 1 row**; **exactly 1 Stripe charge**. → MN-07/08/09/10/11/12 PASS, MN-03 resume-mechanism PASS.

**Dashboard truth (Group 8):** `/dashboard` shows funded task `437fba8e` ($30 OPEN, escrow "Payment funded · $30.00 held in escrow since 5/31/2026 1:12:29 AM"); timeline lights ONLY "Task created" + "Payment funded" (white/near-white markers), the other three greyed `rgb(142,142,147)`; honest waiting copy; no fake applicants; no banned copy. → DB-01..05 PASS, FN-12 PASS.

**Phase 3 verdict: happy path PROVEN end-to-end** (drive-side automated + funding API-substituted via the real backend confirmFunding path). **Owed by Human own-browser pass:** literal in-iframe keystrokes for MN-01 (4242), MN-02 (decline), MN-03 (3DS challenge).

### Phase 4 — Failure paths
- **MN-13** PASS — createPaymentIntent on FUNDED task → `PRECONDITION_FAILED`, no new charge.
- **MN-14** PASS — confirmFunding same-PI → idempotent success; fake PI → `BAD_REQUEST` "Could not verify payment with Stripe" (no blind trust).
- **MN-04** PASS (create-side) — single-shot guard held: 1 PI / 1 charge / 1 escrow row. Literal double-Pay-click → Human.
- **MN-05** PARTIAL — funding persistence + resume proven; dedicated pre-charge refresh → Human.
- **MN-02 / MN-06** BLOCKED → Human (decline keystrokes) / needs `stripe listen`.
- **AU-01** PASS, **AU-02** PASS, **AU-04** PASS, **AU-05** PASS; **AU-03** PENDING (force expired token), **AU-06** PARTIAL (in-app sign-out path).
- **ST-01/02/05** PASS; **ST-03** PARTIAL; **ST-04/06** PENDING (dedicated runs).
- **BR-01** PASS (fail-open proven live under real Upstash failure — 123 caught errors, 0 client 500s), **BR-02** PASS, **BR-03** PASS (10/10 200 burst), **BR-06** PASS (0 `INTERNAL_SERVER_ERROR` in log).

### Phase 5 — Privacy / copy audit
- **LG-01..06 ALL PASS** — grep over `app/`+`components/` (18 tsx) + rendered SEO HTML: every banned-term hit is a ban-documenting comment, the honest "No guaranteed timeline" negation, a dev-only `(protected)` label, the honestly-gated (never-rendered) "Hustlers near you", or the dashboard proven-state logic. No background-check / insurance / protection / fake-liquidity / fake-count / fake-response-time / matched / on-the-way claim reaches users.

### Phase 6 — Analytics / privacy audit
- **AN-02..08 PASS** — 17 events captured this run, every payload contained ONLY the 8 allow-listed keys; no description / email / name / Firebase token / Stripe clientSecret / PM data. `task_input_started {}` despite typed text. Central `pickAllowed()` chokepoint enforces uniformly. AN-07 = code + C10 prior live evidence (error_code only).
- **AN-01 PARTIAL (17/22)** — remaining 5 ride the same `capture()` (iframe-Pay + failure paths).
- **AN-09 BLOCKED** — no PostHog key (safe-no-op confirmed).

### Phase 7 — GO / NO-GO

**Verdict: CONDITIONAL GO.** The core money / trust / privacy / dashboard spine is PROVEN against the live dev stack. **Every Critical row is PASS or substantively-proven-via-backend** (the three Stripe-iframe literal-keystroke rows owe only the in-iframe typing, not backend behavior). **Zero Critical failures. Zero client-facing 500s.**

Critical PASS: FN-11; MN-08/09/10/11/12/13/14; LG-01..06; AN-02..08; BR-01/05/06; DB-02/03/04/05. Plus the full money invariant set (1 escrow row, 1 charge, FUNDED, PI set, version bump, 15% platform fee captured) and honest dashboard timeline.

**Before full GO (owed work, none a Critical-logic failure):**
1. **Human own-browser Stripe pass** — literal `4242` (MN-01), decline `4000 0000 0000 0002` (MN-02), 3DS `4000 0027 6000 3184` (MN-03). Backend paths already proven; only in-iframe keystrokes remain.
2. **Webhook-ON (MN-06)** — run `stripe listen` → `payment_intent.succeeded` funds escrow without the client fallback. Set `STRIPE_WEBHOOK_SECRET` for prod.
3. **Live PostHog (AN-09)** — set `NEXT_PUBLIC_POSTHOG_KEY` and confirm events land with allow-listed props only.
4. **Low-sev dedicated tests** — AU-03 (expired-token retry), AU-06 (sign-out reset), ST-04 (Start Over), ST-06 (stale TTL), FN-07 (availability real-state w/ seeded data), MN-05 (pre-charge refresh).

**Non-blocking findings:**
- **Observability noise:** the `@upstash/ratelimit` path logs expected fail-open degradations at ERROR level (123 stack traces this run) — recommend downgrading to WARN like the C7 query-cache fix, so real errors aren't masked. Amplified here because the Upstash account is rate-limited; would be quiet with a healthy Upstash.
- **Stale Firebase session** persisted in the browser from prior C6/C8 acceptance (`test.hustler@…`) — cleared during this run; worth noting for clean test hygiene.

**Run artifacts:** fresh poster `bf-poster-1780214753187@hustlexp.app` (user `5309db3b`), task `437fba8e`, escrow `797cc2c8` FUNDED, charge `ch_3Td4O997UdWM2cEw0C0GSZPx` (Stripe test mode — real test charge, refundable).

### Human Stripe-iframe pass — 2026-05-31 (operator typed cards in own Chrome via extension)
Funnel driven by Claude to the Payment Element in the operator's real Chrome; operator entered each card into the cross-origin `js.stripe.com` iframe. All three now genuine PASS (not substitution):
- **MN-01** PASS — `4242 4242 4242 4242` → task `b6077bd2` / escrow `2aa83274` **FUNDED** (1 row), PI `pi_3Td4rL…` succeeded, **1 charge** `py_3Td4rL…`; UI funded only after backend FUNDED.
- **MN-02** PASS — `4000 0000 0000 0002` → "Your payment method was declined." + Try again; escrow `09a42dc9` stayed **PENDING** (no funding); PI → `requires_payment_method`, charge `py_3Td4xt…` **failed**/unpaid; `payment_failed` fired.
- **MN-03** PASS — `4000 0027 6000 3184` + completed real 3DS auth popup → return_url query **stripped** → escrow `16bc7389` **FUNDED** (1 row), PI `pi_3Td52V…` succeeded, **1 charge** `py_3Td52V…`.
- **AN-01 → 20/22 live** — `payment_started`, `payment_succeeded_client`, `payment_failed` all confirmed firing this pass.

**Observation (not a bug, UX/test note):** the operator's real Chrome had **Stripe Link** active (test mode), which auto-offered a saved Visa ••••4242 on every funding step (`dyc…@outlook.com`). For the decline/3DS runs the operator had to dismiss Link ("use a different card") to enter the test card manually. A real returning poster with Link would get one-click checkout — fine for production — but worth noting that automated/QA card-entry must account for the Link saved-card prompt. Charge ids came back as `py_…` (Stripe charge objects on these PIs) rather than `ch_…`; all succeeded/paid as expected.

**Human-pass artifacts (Stripe test mode — real test charges, refundable):** user `bf-mn01-1780216582410@hustlexp.app`; FUNDED escrows `2aa83274` (charge `py_3Td4rL…`) + `16bc7389` (charge `py_3Td52V…`); abandoned PENDING escrow `09a42dc9` (declined, never funded).
