# HustleXP product analytics V1

Implementation status: source reviewed; tests, typechecks, builds, SQL execution and migrations were **not run**, at the user's request. Apply and validate before relying on reports. No deployment or commit is part of this implementation.

## Architecture and trust

Browser `trackEvent` → bounded `analytics.collect` → existing `AnalyticsService` → PostgreSQL `analytics_events`. Business services call `AnalyticsService.track` after their commit. OPS calls the fixed, capability-protected `analytics.productDashboard` queries at `/ops/analytics`. There is no new service, event bus, worker, warehouse, or public query builder.

The existing legacy analytics methods remain available. Their rows default to `event_version=0, source=legacy`; V1 reports only consume version 1. Existing column names map `event_type` → event name, `event_timestamp` → occurred time, `ingested_at` → received time. `task_category` remains the category column.

Browser activity is observed telemetry, not proof of payment, approval or completion. Server events distinguish `requested` and `committed`. The storage API supports `observed`, `reported`, and `derived`; current producers emit observed events. Derived calculations live in versioned metric definitions, never overwrite source events. No existing feedback narrative or unverified user-reported outcome is copied into analytics.

OPS authorization is scoped to the current Firebase UID. `OpsRouteGuard` mounts a new authorization subtree on identity change, so the previous profile cannot authorize a render for the next account. Logout/loading removes the protected subtree. Authorization errors fail closed. Analytics query keys include the UID locally, not as telemetry; requests verify the identity before and after completion. Unmount/account change cancels and removes that identity's report queries, including late results. Query errors hide cached report data. Backend `operationsAdminProcedure` authorization remains unchanged.

## Storage and deployment

`backend/database/migrations/20260916_product_analytics.sql` additively extends the existing analytics table with source, version, environment, evidence, anonymous identity, actor/internal flags, causality, outcome/reason, safe context, acquisition, entity IDs, profile, build and deduplication columns. Event-specific state remains in bounded JSONB. It also creates an hourly aggregate ingestion-health table (counts only).

Existing event/time, user/time, task/time and session/time indexes are reused. New indexes cover deduplication, anonymous/time, draft/time, business/time, correlation, product environment/time and intake-attempt/time. The last index supports first-start cohort lookup without scanning all historical attempts. There is no premature partitioning.

Application writes are append-only, using `INSERT ... ON CONFLICT DO NOTHING`; no product analytics updates/deletes are introduced. Existing GDPR erasure/unlink behavior remains intact. No database trigger is added that would prevent privacy erasure.

The migration is registered in `engine-automation-migration-files.ts`. Support migration `20260915_support_threads.sql` was already registered; do not apply it separately. Its original position at the beginning of the registry preceded its prerequisites. The targeted repair moves the existing proposal, completion-verification and support entries after their prerequisites, preserving their names, filenames, contents and applied-migration checkpoints. `20260718_business_workspace_contract` supplies organizations; `010_web_platform_tables` supplies drafts/quotes; proposals must precede support. Users/tasks come from the constitutional baseline. Analytics remains after support and the canonical marketplace migrations.

The runner applies **all pending registered migrations**, not only analytics, and then performs its existing task-location encryption backfill. Already-applied names are skipped; moving an entry does not replay its SQL. On an already-provisioned database, review the pending list and baseline shape before using the runner. On a fresh database, the runner bootstraps `constitutional-schema.sql` if `schema_versions` is absent. Correcting these three entries is not proof that the entire historical chain is universally fresh-database-safe; that requires Martin's disposable-database validation.

The analytics migration now runs a read-only catalog preflight **before its first V1 ALTER/CREATE statement**. It resolves `analytics_events` on the runner's search path and requires an existing ordinary/partitioned table with these baseline columns:

| Columns | Required type |
|---|---|
| `id`, `user_id`, `session_id`, `device_id`, `task_id` | UUID; `id` also needs its existing generated-ID default |
| `event_type` | Text or varchar of at least 100 characters |
| `event_category`, `task_category` | Text or varchar of at least 50 characters |
| `platform` | Text or varchar of at least 20 characters |
| `properties` | JSONB |
| `event_timestamp`, `ingested_at` | Timestamp with time zone |

Unbounded varchar is accepted. The full constitutional/launch baseline satisfies this contract. The minimal `005-mega-schema-alignment.sql` variant does not: it lacks several columns and uses text `session_id`. A mismatch raises SQLSTATE `55000` with the affected columns/types and an actionable prerequisite hint, before this migration makes any V1 changes. There is no automatic conversion, backfill, table recreation, or deletion of historical rows. A compatible repeat invocation performs the same preflight and retains the existing `IF NOT EXISTS` behavior.

Before deployment, Martin must confirm the target database/search path and inspect the existing table definition, its defaults, and the applied-migration ledger against this baseline. For an incompatible shape, stop and prepare a separately reviewed, data-preserving reconciliation; do not guess UUIDs or historical occurrence timestamps. Re-run only after that prerequisite is satisfied. The preflight does not certify arbitrary pre-existing V1 columns/indexes or the whole migration chain. If the analytics checkpoint was already applied, the runner skips the file, including this new preflight; inspect that database explicitly rather than deleting its checkpoint. Earlier pending migrations may already have committed before this file is reached. Ordinary index creation scans the existing table and can block writes; validate locally before deployment. Missing reporting tables produce unavailable sections, not invented zero counts.

## Analytics database budget

All V1 analytics SQL passes through `services/analytics/database.ts`: consent reads, role/test-context reads, event inserts, outbox completion observations, health upserts, and dashboard queries. Legacy analytics APIs are unchanged. The existing primary pool is reused; there is no second pool or analytics waiting queue.

- Per process: `min(3, floor(primaryPoolMax / 4))` concurrent borrowed/acquiring connections. With the default pool of 20, the limit is three (15%). Pools smaller than four disable V1 analytics.
- Admission also rejects when the pool already has waiters or at most two free/unallocated slots remain. Analytics capacity exhaustion drops telemetry or returns an unavailable report section.
- Acquisition deadline: 100 ms. A timed-out acquisition retains its analytics slot until the late connection resolves/rejects; a late connection is released without issuing SQL.
- Transaction-local statement timeout: 1,000 ms; lock timeout: 100 ms. Client deadline: 1,500 ms per query, including transaction setup/commit. The installed `pg` runtime supports this per-query deadline; a narrow type extension accommodates its older `QueryConfig` declarations.
- Successful operations commit and return the connection. Failed/timed-out operations destroy it, avoiding a running query or local settings leaking back to canonical work. No global business timeout changes were made.
- Browser batches and report sections execute sequentially so one normal request does not exhaust its own budget. Concurrent requests, observers and health flushing share the same budget. The outbox observer remains unawaited and does not change claim/enqueue/retry/acknowledgement logic.

This is per-process isolation, not a reservation across every deployment instance. Some shared CPU/I/O cost remains; there is no claim of zero resource use. Health writes themselves may be dropped under contention, and their lost counters are not recovered.

Configuration:

- `ANALYTICS_ENVIRONMENT`: optional backend override; otherwise existing build identity/environment. Use distinct values and separate canonical databases for production/staging.
- `ANALYTICS_INTERNAL_USER_IDS`: comma-separated internal/fixture user UUIDs, interpreted on the server.
- `VITE_BUILD_ID`: optional frontend build revision (letters/numbers/dot/underscore/hyphen, up to 80 chars). If unset, browser build remains unknown. Backend uses existing `buildIdentity.revision`.
- Existing Redis rate-limit configuration is reused. Its production fail-closed behavior is preserved.

## Identity, privacy and delivery

- Browser anonymous UUID persists in localStorage. A shared browser session UUID expires after 30 minutes of inactivity; navigation does not create a new session.
- An intake attempt is stored in sessionStorage, survives ordinary reload/authentication, and expires after a day or a committed draft. Pending auth submission carries optional analytics context. Duplicating a tab can copy sessionStorage: it does **not** guarantee independent identities. The report refuses to attach outcomes when that reused ID produces multiple drafts or conflicting identities. Two copied tabs with the same user/anonymous ID and no distinct draft evidence are indistinguishable and can still share one observed start. Revisiting an unfinished attempt may also represent a new task; no broad intake lifecycle redesign is included. The completion marker only remembers the most recently finished attempt, not an unlimited history.
- Authenticated `user_id` comes exclusively from existing backend auth context. Browser input rejects user ID, role, environment, evidence/source and internal flags. Analytics does not change auth behavior.
- Queued authenticated observations carry an in-memory Firebase identity epoch (not a serialized user claim). Logout/account replacement discards incompatible queued observations; an in-flight token lookup is checked again before sending. Anonymous observations stay anonymous after login and are sent without Authorization. Their continuity with a later authenticated draft comes from the attempt/anonymous IDs, not retroactive attribution to the new user. Permission is checked again after token acquisition and before each retry.
- Browser Do Not Track and `hx:analytics:v1:opt_out=true` stop collection/transmission. Backend respects existing explicit analytics consent denial and fails closed on consent lookup failure. Existing policy permits collection when there is no consent row; V1 does not introduce a new consent policy or UI.
- Only centrally allowed event names/version and bounded structured properties are accepted. No raw task input, free-text answer, support/message body, credential, payment instrument or arbitrary request/error body is captured.
- Known dynamic paths become templates, including `/claim/:token` and `/dashboard/drafts/:id/quote`. Unknown paths become `/:unknown`; all query/fragment values are discarded. Same-origin referrer is a safe route; external referrer is origin only, with credentials, path, query and fragment omitted. Server independently sanitizes routes/referrers. Both allowlists include `/auth-debug` (existing route) and `/earn` (existing public navigation destination; no dedicated page component is created). Route values never determine trusted internal status.
- UTM values are limited to the five marketing keys and restricted slugs. First-touch attribution is persisted separately from session attribution. Dashboard source/campaign cohorts use the session attribution at intake start, not a multi-touch model.
- Device class, coarse browser family and viewport width are recorded; raw user agent, IP and fingerprints are not stored in analytics. A hashed existing auth/IP identity is used only for rate limiting.
- Queue capacity is 100 events in memory (oldest queued event discarded on overflow), batches of 10, a short asynchronous flush timer, and page-hide/visibility flush. Token acquisition has a 2-second deadline; each fetch plus acknowledgement has a 5-second deadline/abort. There are at most two transmission attempts using identical IDs. `available=true` with a valid accepted count is terminal, including duplicates/consent skips; unavailable/partial writes, network failures and retryable HTTP responses get one retry. Other 4xx responses are terminal. `sending` is released in `finally`. No persistent delivery queue is added. Loss during closure, blockers, offline use or outage remains possible; events queued after an unload flush are not guaranteed delivery.
- Ingestion accepts 1–20 events, up to 4 KB per validated event, at 30 batch requests/minute per existing auth/IP limit. The server also has its existing request-body cap. All SQL uses the smaller shared budget above; capacity drops are counted best effort. Business calls never await telemetry and analytics exceptions are swallowed.
- Browser deduplication key is `browser:<anonymous_id>:<client event id>`; committed server keys are `backend:<event name>:<business entity/version id>`. Unkeyed request observations may repeat. Canonical financial metrics do not depend on exactly-once event delivery.
- Quote approval chains carry browser click ID as `causation_id`, shared `correlation_id`, and an `action_attempt_id` through requested/committed events. Browser logical IDs can be located in deduplication keys; table row UUIDs are server generated. Intake attempts correlate browsing and committed drafts. Outbox lifecycle events use the outbox ID as causation and task ID as correlation.

## Events actually wired

| Family | Browser observation | Server evidence |
| --- | --- | --- |
| Navigation/acquisition | `page_viewed`, `cta_click`, `signup_started`, `business_signup_started`, `claim_opened`, `proposal_viewed` | None inferred from navigation |
| Intake | `task_intake_started`, `task_category_resolved`, `task_intake_question_viewed`, `task_intake_question_answered`, `task_intake_question_skipped`, `task_intake_completed`, `task_preview_viewed` | `task_draft_created` after a new `webPostTask.start` transaction commits; replay does not re-emit |
| Existing intake observations | `lead_form_started`, `task_scope_started`, `adaptive_questions_completed`, `task_scope_confirmed` preserved through the same client | Not used as duplicate funnel completion signals |
| Quotes | `quote_started` on first quote-form interaction, `quote_viewed` when quote data is loaded into the draft view, `quote_approval_clicked` | `quote_created` and `quote_submitted` after `businessProposal.quote` commits; `quote_approval_requested` before acceptance transaction; `quote_approved` after a non-replayed commit |
| Payment | `checkout_started` at a valid quote's Pay action | `payment_succeeded` after paid-quote finalization; deduped by quote version |
| Task lifecycle | None invented | `task_started` from committed `task.progress_updated → WORKING` outbox records; `task_completed` only after a completion-release outbox record is matched to canonical COMPLETED state and timestamp |
| Support | `support_opened` | `support_thread_created` and `support_reply_sent` after customer support SQL commits; IDs only. Replies carry the authorized thread's draft/task/quote/proposal/organization context; proposal-only test context is resolved through its canonical quote. |
| Friction | `validation_failed` at explicit validation failures; `action_request_failed` for network/HTTP failure with safe code and latency; `upload_failed`; `draft_recovered`; `flow_exited`; `flow_error_observed` with unknown reason for otherwise unclassified errors | Never relabeled as failed charge or failed business transition |

Question observations carry key, importance, required state, order, answered/skipped/edited state, category and profile. Answers themselves are not sent. Views and edits may repeat; completion and funnel queries count distinct attempt IDs. Completion means preview reached, not draft created. Preview/back/reload cannot inflate distinct completion counts. Exit is an observation; it does not state why someone left.

The outbox worker observes already-committed records without changing delivery, acknowledgements, queue payloads or retries. Analytics observation itself remains best effort; the outbox is not a new guaranteed analytics queue.

## Reserved events / intentionally unwired paths

These names are typed in the contract but must not be interpreted as a complete collection feed:

- `signup_completed`: Firebase authentication and backend user auto-creation are not a single verified product signup-completion boundary.
- `business_onboarding_completed`: no unique completed-onboarding transition established by this work.
- `payment_requested`, `payment_failed`: a generic request/processor failure can mean validation, freeze, transport ambiguity or declined charge; do not equate them. Checkout/request observations and canonical payment records remain available. A processor-specific reason contract can be added separately.
- `task_proof_submitted`: proof has multiple enclosing transaction paths; no guessed pre-commit success event was added.
- `provider_os_opened`, `client_invite_created`, `client_onboarded`, `client_task_viewed`, `provider_os_quote_submitted`: this checkout has no distinct Provider OS invitation/onboarding surface identified. Existing business workspace usage is not relabeled as Provider OS usage. Dashboard explicitly states this rather than claiming zero adoption.
- Quote creation through other claim/manual/generation paths, support creation in other flows and OPS support replies are not completely instrumented. Canonical quote/support reporting includes those records independently; health coverage exposes important missing telemetry.
- No feedback-reason emitter added: no approved closed feedback vocabulary/authoritative record boundary established. `reported` evidence is available for a future safe integration; narrative stays in its owning subsystem.
- Stale-link reason, user-declared abandonment reason, payment recovery and retention are not guessed from a navigation or generic failure. Repeated action/checkout observations can be counted, without inventing retry semantics.

## Metrics and honest unknowns

Definitions are centralized/versioned in `services/analytics/metrics.ts`, returned by the API, and displayed in OPS. The repaired metric definitions/report are version 3; event schema version remains 1. All timestamps are UTC. Date windows are `[start,end)`, default 30 days, selectable 7/30/90 or bounded custom range. UI renders observation time locally and labels custom date inputs UTC. Cohort outcomes are observed through report retrieval time, not incorrectly assumed final at cohort end. Separate section queries do not constitute an exact shared database snapshot.

| Report | Definition / source |
| --- | --- |
| Sessions / known users | Distinct browser session / authenticated user IDs in event window. No synthetic server session IDs included. Consent and collection loss make these observed populations, not all visitors. |
| Intake | First intake start in window, selected before build filtering; distinct attempt IDs, preview completion, duration, returned browser sessions. An older resumed start is not a new cohort member. Latest category-bearing event supplies category and profile together; a missing/incompatible profile clears the previous one. Conflicting identities do not receive a category/profile attribution. |
| In progress / inactive | Uncompleted attempt; last activity within / outside 30 minutes. Derived status, not customer intent or a permanent failure. |
| Questions | Distinct seen/answered/skipped attempts, separate repeated edit observations. View identity and inactive-last-view attribution use category + profile + question key. Inactive-last-view identifies the last viewed question on an inactive uncompleted attempt; it is not a reason for abandonment. |
| Funnel | Same start cohort; exactly one committed backend draft with valid canonical ownership and consistent user/anonymous identities is linked. Missing, multiple, conflicting, invalid-owner and excluded draft mappings remain explicitly unresolved, with no downstream outcomes. Stages remain independently observed. Each transition rate is the count reaching both adjacent stages divided by those reaching the previous stage; independent cohort-relative counts are also retained. Zero denominator displays a dash, missing data displays Unknown. A later outcome never fabricates an earlier stage. |
| Approval | Linked quote **and scheduled service date** written by customer acceptance. The generation service can also set quote_id/quote_send_ready_at without acceptance. Undated linked quotes are shown as approval unknown. No click is counted as approval. |
| Marketplace | Draft-created cohort from task_drafts, quotes, quote_versions, quote_payments, tasks and escrows. Paid includes subsequent refunds. Full/partial refunds count distinct paid quote IDs linked via `quote_payments.task_id` to escrows in `REFUNDED`/`REFUND_PARTIAL` state. Duplicate payment rows cannot multiply these refund counts. Missing payment/task linkage cannot be attributed. These are current-state counts, not refund amounts or revenue adjustments. Assignment uses worker/state evidence. Customer quote cents are not revenue, GMV policy, profit or margin accounting. |
| Support | Canonical thread-created cohort, current OPEN/IN_PROGRESS/RESOLVED state and elapsed time to current resolved_at. No message content queried. |
| Acquisition/device/build | Same distinct intake cohort split by session UTM source/campaign, device, profile/category/build; starts, completions, drafts and paid outcomes with explicit denominators. Build is association, not causal release impact. |
| Friction | Separate observation and distinct-session counts by event/reason; unknown remains explicit. No composite friction score. |

Build filter applies to browser telemetry/intake starts; canonical marketplace/support counts intentionally are not filtered by frontend build. The UI states that limitation. Financial/task business state is derived from canonical tables, not browser claims.

Default filtering excludes server-identified operators, configured user IDs and known test quote links. Explicit test/non-PRODUCTION quote records remain excluded from business reporting. `includeInternal` includes identified internal people, not a request to combine test quotes into production counts. Canonical tables have no universal deployment/test discriminator: isolation relies on separate deployment databases; unmarked demo drafts, anonymous employee activity and fixtures cannot be recognized reliably. Do not label such mixed databases as production-only evidence.

Refund authority was checked against `EscrowRefundTransaction.terminalizeRefund` and `EscrowPartialRefundTransaction.terminalizePartialRefund`, which update `escrows`; a payment status alone is not refund evidence. Funnel linkage examines same-environment identity evidence even if individual rows are internal/test-filtered, so contradictory evidence cannot disappear through filtering. This does not authenticate browser attempt IDs or provide independent copied-tab identity.

Selection/approval latency is omitted from V1, both API and OPS display. `quoteDecision.accept` writes `quote_send_ready_at`, but quote generation and OPS send-ready operations overwrite it. Neither mutable quote/task timestamps nor best-effort analytics or recipient-dependent notification records establish a reliable canonical acceptance timestamp for every draft. No replacement duration is invented; dated-approval counts and draft-to-completion timing remain unchanged. No new business timestamp is added.

Deferred findings outside this targeted repair remain relevant before release: cohort-level exclusion of later-identified internal users; unverified browser entity associations; broader intake new-attempt/unload coordination; build-selector options derived from filtered results; and malformed frontend build metadata. This document does not certify those areas or claim production readiness.

## Analytics health

Accepted, duplicate, invalid, rate-limited, storage-failed, consent-skipped and capacity-dropped counters are coalesced in memory and persisted in ten-second batches to hourly buckets. No rejected payload is logged. Process termination/outage may lose buffered counts; invalid includes schema/timestamp rejection and is not a complete network rejection metric. Hour-boundary aggregation can include the partial first hour of a custom window.

OPS shows ingestion delay, last receive time, missing draft references and counters, plus canonical draft/dated approval/paid-quote entities matched to backend event entity IDs. Coverage is a diagnostic, never an operation gate. Historical pre-instrumentation records, consent opt-outs and missing path coverage can lower it. Canonical coverage ignores frontend build. Missing tables/read failures produce unavailable sections, not 0% or 100% coverage.

## Validation for Martin (not executed by the agent)

From the backend repo root (commands below are instructions only, not executed):

```powershell
npm run typecheck
npm run build
npm run compile
npx vitest run backend/tests/unit/product-analytics.test.ts backend/tests/unit/product-analytics-database.test.ts backend/tests/unit/product-analytics-migration-order.test.ts backend/tests/unit/product-analytics-migration-schema.test.ts backend/tests/unit/analytics-router.test.ts backend/tests/unit/analytics-feed-batch.test.ts backend/tests/unit/outbox-worker.test.ts backend/tests/unit/outbox-worker-lock.test.ts
```

`build` is this repository's no-emit typecheck; `compile` emits the distributable and existing build identity. Do not use `db:migrate` (disabled) or the destructive DB reset script. The normal runner also checks encryption configuration and existing migration contracts; review pending migrations before invoking it on a deployed database.

Only after reviewing the prerequisites above, with the usual local database and task-location encryption configuration:

```powershell
# Applies ALL pending registered migrations, then the location encryption backfill.
npx tsx --env-file-if-exists=.env -e "import('./backend/src/jobs/engine-automation-migration.ts').then(m => m.runEngineAutomationMigration()).then(console.log).catch(e => { console.error(e); process.exitCode = 1; })"
```

Optional SQL-semantic fixture tests require an explicitly supplied, dedicated local test DB. They otherwise skip, do not fall back to `DATABASE_URL`, and use connection-private temporary tables/rolled-back fixture transactions. They exercise the actual metric query strings, but do not validate the migration or the existing database's schema:

```powershell
$env:ANALYTICS_TEST_DATABASE_URL = '<dedicated local test database connection string>'
npx vitest run backend/tests/integration/product-analytics-metrics.test.ts
Remove-Item Env:ANALYTICS_TEST_DATABASE_URL
```

From the frontend repo root:

```powershell
npx tsc -b --pretty false
npx vitest run --config vitest.analytics.config.ts
npm run build
```

The focused test config avoids reading the development HTTPS certificates. The existing Vite build configuration still expects its configured certificate files. No build config or certificate setup was changed.

Focused coverage authored for the repairs (not run): budget admission/connection release/deadlines; pending or failed analytics without outbox retry interference; sequential batch collection/partial acknowledgements; migration prerequisite order; full and partial refunds with duplicate joins; ambiguous draft/user/anonymous linkage and anonymous-to-authenticated continuity; non-nested stage intersections; stable first-start build selection; coherent profile clearing and question identity; route spoofing; account-switch/logout/token/consent races; bounded unavailable/network timeout retries. The final blocking-repair tests additionally cover identity-scoped OPS caches, late-response rejection/cancellation, denied initial/logout rendering, omission of mutable selection timing, and the static preflight contract. The OPS tests use the existing Node test architecture and server rendering, not a mounted browser account-switch simulation. The schema test inspects SQL source without executing it. Copied-tab identity and full application/migration integration still need local validation.

Manual integration checks after applying migrations: anonymous page event accepted; browser business-success/user spoof rejected; ordinary user denied dashboard; OPS succeeds; same event ID deduplicated; claim token absent from stored route; customer draft/approval/payment count stays canonical during an analytics outage; replayed draft/approval does not add success events; recommended skip/edit/back paths do not inflate completion; browser session rotation and auth recovery preserve cohort linkage; test/operator filtering works; missing support/analytics schema renders unavailable; canonical approval-unknown is distinct from approved.

Static inspection confirms the intended call placement and trust boundaries, not runtime correctness. Sentry's backend first import is unchanged. No frontend Sentry integration was found in this checkout; adding one is outside scope. Existing auth, classifier, questionnaires, payment, support, Provider OS and production freeze/safety behavior were not redesigned.

## File inventory (complete V1 working tree)

Backend created:

- `backend/database/migrations/20260916_product_analytics.sql`
- `backend/src/services/analytics/contract.ts`
- `backend/src/services/analytics/database.ts`
- `backend/src/services/analytics/store.ts`
- `backend/src/services/analytics/metrics.ts`
- `backend/tests/unit/product-analytics.test.ts`
- `backend/tests/unit/product-analytics-database.test.ts`
- `backend/tests/unit/product-analytics-migration-order.test.ts`
- `backend/tests/integration/product-analytics-metrics.test.ts`
- `docs/analytics-v1.md`

Backend modified:

- `backend/src/services/AnalyticsService.ts`
- `backend/src/routers/analytics.ts`
- `backend/src/jobs/engine-automation-migration-files.ts`
- `backend/src/jobs/outbox-worker.ts`
- `backend/src/routers/web/postTask.ts`
- `backend/src/routers/quoteDecision.ts`
- `backend/src/routers/businessProposal.ts`
- `backend/src/routers/support.ts`
- `backend/src/services/QuotePaymentFinalizationService.ts`
- `backend/tests/unit/analytics-router.test.ts`
- `backend/tests/unit/outbox-worker.test.ts`

Frontend created:

- `src/lib/analyticsPrivacy.ts`
- `src/lib/analytics.test.ts`
- `src/components/AnalyticsNavigation.tsx`
- `src/features/get-help/useIntakeAnalytics.ts`
- `src/features/ops/analytics.ts`
- `src/pages/ops/OpsAnalytics.tsx`
- `vitest.analytics.config.ts`

Frontend modified:

- `src/lib/analytics.ts`
- `src/App.tsx`
- `src/api/trpc.ts`
- `src/features/ops/components/OpsShell.tsx`
- `src/features/get-help/pendingRequest.ts`
- `src/features/tasks/api.ts`
- `src/features/businessQuote/BusinessQuoteForm.tsx`
- `src/pages/GetHelp.tsx`
- `src/pages/AuthCallback.tsx`
- `src/pages/DraftDetail.tsx`
- `src/pages/QuotePayment.tsx`
- `src/vitest.d.ts` (remove the ambient API stub that masked the installed test framework types)

## Earlier targeted repair inventory

The complete V1 inventory above includes work that predates this repair. The repair itself changes these existing implementation files:

- Backend: `backend/src/jobs/engine-automation-migration-files.ts`; `backend/src/routers/analytics.ts`; `backend/src/routers/support.ts`; `backend/src/services/analytics/contract.ts`; `backend/src/services/analytics/store.ts`; `backend/src/services/analytics/metrics.ts`; `backend/tests/unit/product-analytics.test.ts`; `backend/tests/unit/analytics-router.test.ts`; `backend/tests/unit/outbox-worker.test.ts`; `docs/analytics-v1.md`.
- Frontend: `src/lib/analytics.ts`; `src/lib/analyticsPrivacy.ts`; `src/lib/analytics.test.ts`; `src/features/get-help/useIntakeAnalytics.ts`; `src/pages/ops/OpsAnalytics.tsx`.
- New in this repair: `backend/src/services/analytics/database.ts`; `backend/tests/unit/product-analytics-database.test.ts`; `backend/tests/unit/product-analytics-migration-order.test.ts`; `backend/tests/integration/product-analytics-metrics.test.ts`.

That earlier repair did not change migration SQL contents, canonical query timeouts, business transaction semantics, outbox bookkeeping, classifier, intake questionnaire or authentication implementation. Existing analytics hooks from the original V1 work remain in the working tree. No test/build/typecheck/migration/SQL execution was performed by the agent.

## Final blocking-repair inventory (latest review H2/H3/M1)

Modified backend files:

- `backend/database/migrations/20260916_product_analytics.sql` — catalog preflight before V1 DDL; no legacy data transformation.
- `backend/src/services/analytics/metrics.ts` — remove selection latency; definitions version 3.
- `backend/tests/unit/product-analytics.test.ts` — prevent reintroduction of mutable selection timing.
- `backend/tests/integration/product-analytics-metrics.test.ts` — optional fixture assertion that send-ready changes cannot create selection latency.
- `docs/analytics-v1.md` — prerequisite, metric, cache-isolation and validation documentation.

Created backend file: `backend/tests/unit/product-analytics-migration-schema.test.ts` (static SQL contract checks).

Modified frontend files:

- `src/components/OpsRouteGuard.tsx` — fresh identity-keyed authorization; fail closed.
- `src/pages/ops/OpsAnalytics.tsx` — identity-scoped query/render/cleanup; remove selection-latency column.
- `vitest.analytics.config.ts` — include focused OPS account-boundary tests.

Created frontend files: `src/features/ops/analyticsAccess.ts` and `src/features/ops/analyticsAccess.test.tsx`.

This pass changes the pending analytics migration's preflight behavior and the OPS authorization lifecycle only as needed for account isolation. Backend authorization and canonical business writes remain unchanged. The deferred new-attempt, unload-order, internal-cohort, entity-association, build-selector and build-metadata findings are not repaired by this pass. No validation command was run.

Future work: validate/report real collection coverage before making decisions; wire the explicitly deferred authoritative paths; define retention/archive and multi-device/privacy governance when needed; add Provider OS only when a concrete workflow exists. No session replay, A/B engine, predictive churn, accounting redesign, synthetic success backfill or durable analytics-only pipeline is introduced.
