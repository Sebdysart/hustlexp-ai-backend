# Provider OS composed backend and in-app notification audit

Audit date: 2026-09-19. Backend starting commit: `cfe45abdece6a7cc60633efdb013638e8251a05b`, branch `feat/provider-os-foundation`. Frontend route source: the same feature branch, starting at `37e8846`.

This is the final consolidated source-audit report. [The follow-up](provider-os-hardening-followup.md) records the additional notification commit-boundary fixes and validation. [The producer inventory](provider-os-notification-producers.md) contains every current shared-writer/wrapper call site and raw destination.

## Conclusion and limits

The inspected Provider OS architecture is coherent as an organization-scoped, controlled-test product. This pass fixes concrete authorization, notification persistence, destination, and certification-gate defects. No remaining cross-organization acquisition bypass was found in the inspected paths. This is **not live production certification** and is **not approval to charge real money**: only the existing controlled provider is implemented.

Premium events and SMS have durable recovery and current authorization checks. The audit also closed ordinary application/proof/assignment/acceptance/rejection/completion/payout notification crash gaps using the existing transactional outbox. Tip/unlock/payment in-app inserts now commit with their associated local state writes. This changes notification persistence, not business decisions, payment amounts, proof requirements or execution policy. No source-confirmed Critical/High/Medium issue remains open in the inspected Provider OS acquisition, purchase and premium-delivery paths after these fixes.

This conclusion is bounded: it is a source audit and targeted hardening pass, not a guarantee that every optional legacy/native feature or external service is production certified. Infrequent legacy operational/security producers retain their existing notification delivery policy; this pass inventories and safely projects their destinations rather than migrating the entire platform to a new event architecture. Repository-wide baseline tests are not all green (details below).

No production database, Railway deployment, live payment, Redis service, Twilio delivery, or browser integration was exercised. PostgreSQL tests below used a disposable loopback cluster, with provider/network mocks.

## Architecture map

```text
exact business organization + current account/member/action
  -> effective Provider OS entitlement
  -> customer-consented organization/customer relationship
  -> eligible client draft and authorized intake photos
  -> verified business + ASSIGN_CREW
  -> canonical quote and version (server origin = provider_os)
  -> canonical customer selection
  -> canonical payment/materialization
  -> ordinary task, address, proof, completion and payout authorization

organization + MANAGE_BILLING (no premium entitlement required)
  -> explicit server test catalog -> provider_os_purchase
  -> standalone controlled product intent and success ledger
  -> independent server verification -> locked purchase + organization/entitlement
  -> shared audited entitlement writer

canonical transition -> SQL trigger -> Provider OS domain event + canonical outbox
  -> existing user_notifications worker -> current org/relationship/recipient checks
  -> recipient ledger + deduped sms_outbox + outbox
  -> existing SMS worker -> current authorization/phone/preference -> Twilio
```

The purchase and premium-notification systems consume the same entitlement; neither replaces it. Browser success and notification possession confer no authority.

## Authorization matrix

All authenticated operations also pass the normal protected procedure. `ProviderOsAccess` additionally re-reads the actor account as ACTIVE, not banned, not under trust hold, and locks the exact active membership; business action is evaluated by the existing database policy. The organization must be ACTIVE and provider-enabled.

| Operation | Actor and organization binding | Permission | Effective entitlement | VERIFIED business | Relationship / object authority |
|---|---|---|---|---|---|
| accessStatus | authenticated member, explicit organization | READ_WORKSPACE | reported, not required to inspect | no | none |
| createInvite | member, explicit organization | MANAGE_MEMBERS | required | no | server-generated token hash; creator audited |
| previewInvite | bearer token; organization only from stored token | public exception | required | no | open, unexpired token; limited preview |
| acceptInvite | current ACTIVE, non-banned customer; DB email matches intended email when set | customer consent, not organization membership | owning org required | no | token-bound org; cannot accept own invite; unique org/customer |
| listClients | member, explicit organization | READ_WORKSPACE | required | no | active org relationships, ACTIVE clients |
| listDrafts / getDraft | same | READ_WORKSPACE | required | no | exact active relationship, ACTIVE client, eligible unclaimed/unselected/unmaterialized draft |
| draft photo read | same through existing media authorization | READ_WORKSPACE | required | no | locks matching draft, relationship, ACTIVE client; eligibility required |
| setQuote | member, explicit organization, rechecked inside transaction | ASSIGN_CREW + canonical quote validation | required | **yes** | locks draft and active relationship; now also locks/rechecks ACTIVE client |
| quote history / detail | member, explicit organization | READ_WORKSPACE | required by current policy | no | quote organization + provider_os origin; versions bound to quote; relationship may have been revoked |
| purchaseStatus / createPurchase | eligible member, exact organization | MANAGE_BILLING | not required | no; response reports verification requirement | own org purchase, configured catalog; no active/unlimited/scheduled/admin-blocked duplicate purchase |
| controlled completion / refresh | same | MANAGE_BILLING | not required | no | purchase ID AND org; original purchaser is revalidated before paid grant |
| Ops entitlement inspect/change | operationsAdminProcedure | existing operations capability | not required | no | explicit org, organization lock, audited mutation |
| Ops purchase inspection | operationsAdminProcedure | existing operations capability | not required | no | bounded organization purchase history |
| canonical accepted/paid work | normal task participant/fulfilling-business policies | existing execution permissions | **not required** | canonical policy | task assignment, ownership and address-release policy |

No worker-mode, first-membership, email-only onboarding or client-supplied origin authority was found in Provider OS services. The frontend claim continuation bug was first-workspace selection in a canonical claim page, not a Provider OS server authorization bypass.

## Entitlement state and audit

One row per organization; stored states are active/suspended/revoked. No row means inactive. Active with `starts_at > now` is scheduled; expiry `<= now` is expired; null expiry is unlimited active access after its start. Service helpers use these inequalities; SQL premium checks use equivalent `starts_at <= NOW()` and null-or-future expiry. Application time is used in service classification, database time in SQL and paid duration calculation; normal clock synchronization remains an operational dependency.

Manual and paid writers converge on `writeProviderOsEntitlement`. Organization locks serialize Ops changes and purchase grants. Every mutation records before/after in `ops_action_audit`. Suspension/revocation keeps the existing grant source/purchase reference. A subsequent manual grant can replace the current-row source, but the prior audit and successful purchase/grant timestamps remain intact. Historical purchase evidence is not rewritten.

Paid extension uses `max(database now, existing finite expiry) + purchased period`. New purchases are not sold as missing access while effective access exists. A finite Ops grant arriving during checkout is preserved and extended. A paid purchase encountering suspension, revocation, an ineligible org/purchaser, or scheduled/unlimited access is held with paid evidence and a resolution reason; it cannot override Ops policy. No automatic reactivation of revoked relationships was introduced.

## Purchase and controlled-test findings

`provider_os_purchases` has pending/succeeded/failed/canceled states, unique provider IDs, a partial one-pending-purchase-per-org index, and immutable provider ledger bindings. Local intent identity is deterministic per purchase. Verification compares purchase, org, purchaser, product, amount, currency, period and test identity. No frontend status or transaction ID is accepted as payment truth.

Creation and confirmation now both require the full `providerOsProduct` gate, including direct adapter calls. A small pure `LocalCertificationPaymentConfig` module holds the existing base gate, re-exported by the old provider module for compatibility. Task controlled-payment gate semantics did not change.

| Gate | Accepted configuration |
|---|---|
| provider | PAYMENT_PROVIDER exactly local_test |
| explicit local permission | HXOS_ALLOW_LOCAL_TEST_PAYMENT exactly true |
| production | NODE_ENV exactly production additionally requires HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION exactly true |
| mode sentinels | ENGINE_API_MODE exactly test; STRIPE_MODE exactly test |
| shared test secret | HXOS_LOCAL_TEST_PAYMENT_SECRET trimmed length at least 32; never returned/logged |
| creation permission | existing NewPaymentCreationGuard: explicit enabled; missing defaults frozen in production, enabled otherwise; mode normalized there |
| product enablement | PROVIDER_OS_TEST_PURCHASE_ENABLED exactly true |
| test amount | Number parsing; positive safe integer, at most 99,999,999 cents |
| currency | PROVIDER_OS_TEST_CURRENCY exactly usd |
| period | Number parsing; integer 1–366 days |

Verification/finalization intentionally require the base controlled-provider gate, not a currently available catalog or creation switch. Thus already-confirmed payment recovers when creation is frozen or product configuration becomes invalid. Turning off the underlying certification provider itself still prevents verification; durable evidence is retained for later recovery/Ops review.

The minute scheduler dispatches reconciliation through the maintenance worker. It claims at most 50 due pending purchases with SKIP LOCKED, leases for five minutes, locks org then purchase during grant, and rechecks success under lock. Verification errors defer ten minutes; policy holds defer one hour. Concurrent finalizers cannot extend twice. An intent is never automatically confirmed by reconciliation. Failed/canceled provider states are terminal for automatic polling; explicit refresh can reverify a later authoritative change. Local controlled confirmation cannot ordinarily revive a terminal intent.

No new provider, checkout, subscription, pricing, task quote-payment table, escrow, assessment charge, Connect or payout behavior was added or changed.

## Premium event and SMS findings

| Event | Canonical emission | Deterministic identity | Destination |
|---|---|---|---|
| CLIENT_JOINED | successful INSERT of consented relationship; acceptance transaction also updates invitation accounting/audit | organization + relationship ID | /provider-os?organizationId=org |
| CLIENT_TASK_POSTED | INSERT of owned eligible draft; one event per currently entitled related org | organization + draft ID | /provider-os/drafts/draft?organizationId=org |
| QUOTE_ACCEPTED | draft selected quote changes to an actual quote_send_ready quote with provider_os origin | organization + quote ID | /provider-os/quotes/quote?organizationId=org |
| TASK_READY | successful quote payment with matching materialized canonical task | organization + quote ID | /business/tasks/task |

Event and generic outbox rows commit in the transition transaction. Idempotent draft creation replay does not reinsert; acceptance/payment triggers have unique event keys. Null/claim/direct-proposal origins do not produce premium quote events. Failed/rolled-back transitions produce no events.

Fan-out locks the event; one transaction writes recipient outcomes, SMS rows/outbox, joined/new-request in-app notices and acknowledgment. Exact org OWNER/ADMIN/DISPATCHER recipients must have READ_WORKSPACE and ASSIGN_CREW, ACTIVE account, no ban/trust hold. Global SMS preference must be true, phone valid, and quiet hours respected. Entitlement and consented active relationship/client are revalidated. TASK_READY uses the canonical payment/task binding rather than acquisition-feed eligibility.

SMS delivery trusts the persisted event and recipient ledger, not queue-provided phone/body. It rechecks org entitlement, relationship, account, member actions, preference and phone; regenerates copy/destination; and uses existing row locks/CAS. Event/recipient uniqueness and saved Twilio SID prevent known resend. A stale sending row without SID becomes uncertain/suppressed rather than blindly retried. Definitive provider rejection remains retryable; quiet hours defer. External acceptance between authorization and a later revocation cannot be undone; this unavoidable boundary is not represented as exactly-once external delivery.

Legacy user-owned queued Provider OS SMS remains suppressed. New v2 provenance is mandatory. Only joined/new-request get additional canonical in-app notices; quote/payment notices use their existing types, avoiding duplicate categories. No ordinary-marketplace Twilio expansion or marketing SMS changes.

## Canonical execution and provenance

The server assigns `quotes.acquisition_origin`; the initial quote version scope snapshot retains it. History filters org + origin and uses quote/version/draft/task records, not fake claims. Provider OS remains VERIFIED-only; pending verification still needs an origin-aware activation policy before it can be enabled. Quote creation uses canonical organization-before-draft locking and canonical quote helpers. No service-profile or business-location configuration was reinstated.

The API guard is confined to acquisition/history/photos, not canonical task execution. Task get/read, business execution, location-vault release, proof/checklist, completion and payout retain their existing authority. Paid/task-ready notification destinations point directly to business tasks. Historical quote notifications now resolve a canonical task successor when the selected quote has materialized for that same org, even if premium access later expires.

## In-app notification architecture and inventory

See [the complete source producer inventory](provider-os-notification-producers.md) for each producer, title/message, recipient and entity context. The inventory includes the generic helper wrappers and the former direct SQL emitters, not just Provider OS.

Two write lanes remain: typed web in-app writes and generic policy-driven/native writes with channel outboxes. Both persist in `notifications`. The web `notification.list` API projects destinations; the navbar validates the projected internal route, marks read best-effort, then uses router navigation without dropping query context. Native getList contracts are preserved.

### Final destination contract

| Existing types / source | Recipient | Final web route | Authority / stale behavior |
|---|---|---|---|
| QUOTE_RECEIVED | draft poster | /dashboard/drafts/draft | owned draft; materialized draft exposes canonical task link |
| QUOTE_ACCEPTED, QUOTE_REJECTED | active business recipients | canonical task if selected/materialized; otherwise Provider OS quote+org, exact direct proposal, or verified claim+org | org READ_WORKSPACE and canonical record binding during projection; target independently authorizes; missing/removed authority gives no action |
| PAYMENT_CONFIRMED | poster | /dashboard/tasks/task | canonical task ownership |
| CUSTOMER_PAYMENT_RECEIVED | business | /business/tasks/task | canonical assignment; no premium entitlement |
| TASK_PROPOSAL_RECEIVED | invited business | /business/proposals/proposal | proposal determines org; current membership required |
| ASSESSMENT_REQUESTED | Ops | /ops/drafts/draft | Ops capability |
| ASSESSMENT_APPROVED, ASSESSMENT_COMPLETED | poster | /dashboard/drafts/draft | customer ownership |
| ASSESSMENT_PAID, ASSESSMENT_SCHEDULED, ASSESSMENT_REJECTED | business | exact proposal or claim+org; canonical task successor if assigned | same resolver as quote notices; no invented claim |
| SUPPORT_REQUEST_CREATED, SUPPORT_USER_REPLY | authorized Ops recipients | /ops/support/thread | operationsAdminProcedure |
| SUPPORT_OPS_REPLY | original opener | /support/thread | opener or authorized member of stored support org; closed conversations remain readable |
| PROVIDER_OS_CLIENT_JOINED | eligible org operators | /provider-os?organizationId=org | exact org access/entitlement |
| PROVIDER_OS_CLIENT_TASK_POSTED | eligible org operators | /provider-os/drafts/draft?organizationId=org | exact org/relationship/eligible draft; stale request unavailable |
| task_accepted, task_completed, proof_submitted, proof_rejected; task-linked new_matching_task/instant events | canonical poster/worker | old /task(s)/id variants project to /dashboard/tasks/id or /business/tasks/id from actual participation | unsupported/unrelated recipients get no guessed task action |
| escrow_funded, refund_issued, payment_failed | canonical poster | /dashboard/tasks/task | actual participation resolved; payment copy follows authoritative event |
| payment_released | actual recorded payout recipient | business release: /business/tasks/task; worker earnings route projects to /support | release-bound durable intent; current recipient/business permission recheck, no premium entitlement; no invented wallet page |
| payout_failed; payment_due XP-tax reminders; wallet/settings-payment native links | worker/account owner | /support | supported web fallback, no invented wallet page |
| business_operational_digest | permitted business recipient | /business/dashboard | old operations/week route has no matching web page; safe overview fallback, not cross-org resource authority |
| security_alert / account_suspended with support link | affected account | /support | protected/auth behavior; suspension still blocks protected API, no bypass |
| financial/admin security_alert (/admin/escrows or stripe-events) | existing privileged admin recipient set | /ops/tasks | broad existing Ops overview; target still enforces capabilities; no fake escrow detail page |
| moderation, biometric review, admin fraud, email-outbox, expertise invite, profile/native-only security alerts | their existing actors | no web action | unsupported feature destinations remain suppressed; native contracts retained |
| message_received | task participant | canonical task page | no separate web messaging page invented |
| tip_received | existing worker recipient | legacy task URL projected by current participation | now valid shared in-app write; no tip/payment changes |
| EARNED_VERIFICATION_UNLOCKED | existing earning user | /support | nonexistent /verification web link replaced with safe existing support; no price/policy change |

Declared notification-policy vocabulary without a concrete producer in this scan is not evidence of a live feature. This includes several growth, badge/trust, recurring, dispute and welcome/recap categories. No new categories were introduced to make the inventory look complete.

### Auth, organization and stale links

AuthenticatedRoute preserves validated pathname/search/hash in returnTo. Unified sign-in, AuthCallback/email-link completion and onboarding consume the existing safe return contract. Wrong accounts are denied by target APIs; no membership/entitlement is inferred from a notification. The session QueryClient is retired on identity change, preventing previous-user notification cache reuse.

Provider OS keeps exact organization query context, keys access/history requests by org, and never selects another org to recover a denied deep link. Its access query refetches every 30 seconds, on focus and mount. Quote history remains premium-gated by current policy. Purchase is outside the premium guard; inactive/unavailable purchase UI does not redirect into the workspace.

Canonical claim pages now honor organizationId against the user's workspaces. Missing context is inferred only when exactly one workspace exists; multi-org ambiguity or an unauthorized explicit org fails safely. Dashboard claim links now carry their known org. No current-selected-org state replaces a notification's org.

Backend and frontend reject external, protocol-relative, encoded, malformed and unsupported notification URLs. Only explicit UUID/organization query forms are allowed; no arbitrary redirect query. Frontend validation no longer accepts arbitrary descendants merely because they begin with /business or /ops.

For historical business quote/assessment notifications, one bounded batch resolves current canonical records. A correct proposal replaces the former claim assumption; provider_os origin is never guessed from null history. A selected materialized task takes precedence. Missing/deleted objects or lost org permission have no action. Other target pages show existing unavailable/access-denied states. No historical rows were rewritten, no bearer claim links generated, and no redirect loops introduced.

### Dedupe, unread and ordering

The shipped schema has a global unique dedupe_key index in addition to the later user/key index. Web fan-out now uses `in_app:userId:eventKey`; database uniqueness handles concurrent replay. A same-user old raw-key record prevents historical duplicate delivery. Other missing recipients can receive their own new rows. Generic/native dedupe semantics are unchanged.

Read, click and mark-all updates remain scoped by authenticated user ID. List and unread count share the expiry predicate. Ordering now uses created_at DESC, id DESC, eliminating equal-timestamp ambiguity. Existing offset pagination is bounded but still subject to normal insert-between-pages drift; a cursor redesign was not added. Navbar count refresh and read invalidation remain unchanged.

## Findings and implemented fixes

| Severity | Location | Concrete failure | Status |
|---|---|---|---|
| High | NotificationService.insertNotification | shared fan-out key collided with global unique index; only first business/Ops recipient received a notice | fixed: recipient key + legacy same-user replay check; real PostgreSQL concurrent regression |
| High | LocalCertificationPaymentProvider / ProviderOsPurchaseService | confirmation and direct product-intent creation omitted catalog/creation gates, permitting controlled completion with unavailable product config | fixed: canonical full gate at both boundaries; verification recovery kept separate |
| High | AdminNotificationHelper | five-minute cached administrator list, including stale-cache fallback, could authorize new sensitive sends after role removal | fixed: fresh role/account lookup for every fan-out; lookup failure sends to nobody |
| Medium | ProviderOsService.setProviderOsDraftQuote | deactivated client hidden from feed/photos could still be quoted via known draft ID | fixed: ACTIVE client join and shared row lock in mutation |
| Medium | business quote/assessment destinations | direct proposals incorrectly sent to nonexistent claim history; historical Provider OS claim links could remain stale | fixed: canonical shared resolver at business insert and historical list projection |
| Medium | BusinessClaimDetail | notification for org B read first workspace A and displayed unavailable/wrong context | fixed: validated exact org; unambiguous single-workspace compatibility only; emitting dashboard links include org |
| Medium | notification.list | migration defaults type=general/message='' hid canonical category/body | fixed: explicit fallback preserving genuine web type/message |
| Medium | support create/user reply/Ops reply | message committed before notice; failures stranded notices and create retries reused silent thread; resolved-state race | fixed: single transaction with locks; analytics only after support commit; concurrent same-opener creation serialized |
| Medium | assessment complete | completion committed before its notice; retry could no longer produce notice | fixed: update and canonical in-app insert in one transaction |
| Medium | EarnedVerificationUnlockService / TippingService notification blocks | raw legacy inserts omitted required identity/dedupe fields; fallback used obsolete data schema | fixed: shared in-app writer and deterministic existing-event keys; financial/verification rules untouched |
| Low | NotificationService.getUserNotifications | equal created_at timestamps produced unstable ordering | fixed: UUID tie-break |
| Low | frontend notification validator | broad prefix accepted unsupported descendants/traversal-like paths | fixed: current exact route contract |
| High | task-lifecycle notification identity | second applicant/proof attempt collapsed onto task/category/version 1 | fixed: concrete application/proof identities, including rejection |
| High | canonical lifecycle notification callers | crash between domain commit and post-commit notice lost application/proof/assignment/acceptance/rejection/completion/release notices | fixed: existing outbox intent written on the existing domain transaction; no transport in the transaction |
| Medium | ordinary quote-paid, tip, verification unlock notices | state committed without its in-app row; unlock replay could never publish again | fixed: atomic local-state/notice transaction; quote/version/payment lock order; PG rollback/retry tests |
| Medium | payout notice recipient | generic task participation rejected delegated/business payout recipient, with the wrong business destination | fixed: release-bound recipient provenance and current authorization; canonical business task link; no entitlement requirement |
| Medium | AdminNotificationHelper identity | distinct alerts collapsed onto a shallow admin path | fixed: stable source/type/destination hash and recipient-specific key |
| Medium | NotificationService business/Ops fan-out | active membership selected suspended/banned/trust-held accounts | fixed: current account eligibility and business READ_WORKSPACE action |
| Scaling limitation | Provider OS listClients | entire active-client list and aggregate open counts are returned | documented; adding pagination is a separate API/UX contract; draft feed/history/reconciliation/notification reads remain bounded |

## Migration, deployment and retention

New forward migration `20260922_notification_request_dispatch.sql` adds the partial index for bounded durable-notification lease recovery. It is appended to the manifest after purchases. No historical SQL was changed. Existing chain: legacy relations/invites -> organization_access (20260918) -> quote_origin (20260919) -> premium_events (20260920) -> purchases (20260921). Prerequisites for business entities, photos, quote payments and the canonical outbox precede these. Legacy user-owned invitations/relationships were conservatively revoked without choosing a first organization; old rows remain evidence. No retroactive origin inference.

Deployment contract remains migrations before serving work: API production start runs engine migrations before server.js; worker startup awaits the same migration runner before registering workers/schedules/outbox readiness. Runner checkpoints each migration under advisory lock and transaction. A partly applied chain resumes at the next unapplied migration; blindly replaying raw historical SQL is not supported. New-table-dependent features should fail on unsupported schema skew, not fall back to user-owned authorization. Do not manually apply production migrations from this audit.

Purchase/intent/event evidence uses RESTRICT on purchase/org relationships; purchaser/actor IDs can SET NULL. Domain-event canonical references SET NULL and then fail delivery authorization. Recipient-ledger user deletion cascades; existing GDPR logic anonymizes/removes user notification content. Retention duration and whether historical recipient evidence should survive hard user deletion remain policy questions, not silently redesigned here.

Indexes cover active org/client lookup, open invites, org-origin quote history, pending purchase uniqueness/due polling, premium pending events and SMS event/recipient uniqueness. Feed eligibility/exclusion occurs in SQL before LIMIT 100 and is org-, not actor-scoped. The new destination projection is a single batch for at most 50 inbox items, with bounded proposal lookup; no per-recipient N+1 reads were added. No speculative indexes or benchmark claims.

## Validation

Final continuation: backend build/typecheck, compile, scoped lint and diff checks pass. **34 files / 587 tests pass** in the consolidated Provider OS/product/premium/in-app/SMS/outbox/lifecycle run. Another targeted lifecycle run passes **89 tests** (245 unrelated cases filtered), including application, assignment, acceptance, proof/review/completion routers/services and the final paid-state PostgreSQL boundary. The final index migration was applied to the isolated fixture. Source tests verify intent ownership, release recipient routing, and no repeated completion intent on replay. PostgreSQL tests exercise rollback and concurrent request replay; the final quote-notification boundary test stubs provider verification/materialization and uses real PostgreSQL for the paid-state transaction, not a live charge.

Earlier checkpoint results (same task; retained for traceability):

Backend: normal `npm run build` (TypeScript no emit), `npm run compile`, and scoped ESLint pass. Final focused run: **26 files / 466 tests pass**, including real isolated PostgreSQL purchase, premium event, notification fan-out and support/assessment rollback fixtures; notification/channel/outbox, Provider OS policy/history/media/router, product config and existing controlled task-provider tests. Additional focused admin helper: **12 pass**, 52 unrelated cases intentionally filtered. The final run includes **53 passing legacy-emitter tests** in two existing service suites. New fan-out concurrency uses separate PostgreSQL connections/transactions, not only mocks.

Frontend: normal `npm run build` passes; **7 files / 67 tests pass** covering notification routes, auth/session boundary, Provider OS and launch contracts. Scoped ESLint and diff checks pass. Existing Vite large-chunk warning remains. Changes were isolated in a feature-branch worktree; the live/deploy visual checkout was not switched or modified.

Broader backend run: **436 pass / 6 fail** across 28 files. All six failures reproduce on untouched starting commit cfe45abd in a separate sparse worktree:

1. engine-automation-migration: stale hardcoded expected migration list (98 vs current 143).
2. same file: individual Docker-copy/path assertion (also Windows path handling) despite directory COPY.
3. same file: stale fresh-upgrade convergence fixture count.
4. local-certification-payment-migration: old individual Docker COPY expectation.
5. notification-delivery-contract: old individual Docker COPY expectation.
6. quote-payment-preflight: requires NODE_ENV to be explicitly set, while canonical helper deliberately permits missing/non-production NODE_ENV with other gates.

Further broad lifecycle checks reproduce six additional failures on the untouched starting commit: three task-create fixtures (old positional scope hash, plan-check mock, old request hash), and three escrow fixtures expecting old no-worker wording/INVALID_STATE instead of current fulfiller/NOT_FOUND semantics. The full task-router suite also has the previously reproduced unrelated getById projection expectation. The worker-registration mock dependency issue was repaired in the focused harness while adding the new dispatch test.

These are reported, not hidden by changing unrelated assertions. Existing focused Provider OS migration-order/origin/catalog checks pass; this is not a full production baseline migration rehearsal. No live end-to-end/browser/SMS/payment integration claim.

## Exact change scope

Backend services: AdminNotificationHelper, BusinessNotificationDestination (new), EarnedVerificationUnlockService (notification block only), LocalCertificationPaymentConfig (new), LocalCertificationPaymentProvider (gate reuse only), NotificationService, ProviderOsProduct, ProviderOsPurchaseService (confirmation gate only), ProviderOsService (client eligibility), TippingService (notification block only), WebNotificationDestination.

Backend routers: notification, support, businessAssessment (notification completion boundary and types only), web/ops (support reply boundary only). Tests: in-app-notification-fanout and support-notification-transaction (new isolated PG fixtures), provider-os-purchases, provider-os-premium-events, provider-os-stage-two, notification-router, web-notification-destination, stripe-payment-services-batch (admin helper cases only), service-verification-unlock, tipping-service.

Frontend: features/business/organizationContext (new), features/notifications/destination and providerOsDestinations.test, BusinessClaimDetail, BusinessDashboard (claim URLs only). No CSS, logo, hero, navbar markup or visual components changed.


Additional backend changes in the final continuation: NotificationRequestService; task-lifecycle-notifications; TaskApplicationProcedures; taskExternalBridge; TaskExecutionProcedures; TaskAssignmentProcedures; TaskAcceptProcedures/TaskAcceptService; TaskReviewProcedures/TaskExecutionService/TaskCompletionService; EscrowReleaseTransaction (notice only), completion-release-orchestrator and automation (remove post-commit duplicate hooks); QuotePaymentFinalizationService (atomic final paid-state/in-app boundary only); TippingService and EarnedVerificationUnlockService (in-app boundary only); worker-registration, outbox-worker, migration manifest and the new dispatch-index migration. Additional tests are recorded in the follow-up report.

The quote/payment/escrow files above were **not wholly untouched**: notification persistence moved alongside their existing state writes. Provider verification, monetary calculations, escrow state rules, payout rails, task materialization, completion evidence, and exact-address rules were preserved. This distinction is intentional and should not be described as a payment architecture rewrite.

## Requirement evidence cross-check

| Requested scope | Evidence and outcome |
|---|---|
| A authorization, K/L/M acquisition/relationships/feed | matrix above; ProviderOsAccess/ProviderOsService/providerOs router, BusinessClaimService, ProviderOsDraftPhotoAuthority; exact org/action, consent, VERIFIED acquisition, SQL eligibility before limit, active relationship; current-member read and client-lock regression tests |
| B/C entitlement/manual-vs-paid | ProviderOsEntitlementService, ProviderOsAccess and purchase finalizer; canonical window rules, organization/entitlement locks, audited before/after, suspension holds, finite extension, no repeat grant |
| D/E/F purchases/gates/reconciliation | dedicated purchase + controlled intent/event ledgers, canonical full creation/confirmation gates; base-gated verification recovery, minute scheduler/maintenance dispatch, bounded leased SKIP LOCKED claims; PG purchase replay/policy-hold tests |
| G/H/I events/recipients/SMS | four canonical SQL-trigger events, ProviderOsPremiumEvents and sms-worker; persisted event + recipient ledger, current exact org/member/actions/preferences/phone, SID and uncertainty handling; premium PG/policy/channel tests |
| J canonical work after premium loss | ordinary task/business/address/proof/completion APIs have no Provider OS entitlement gate; paid links target canonical business task; new release authorization also has no premium gate |
| N/O/P/Q/R migrations/deploy/audit/retention/performance | append-only migration chain and startup migration ordering; event/purchase/Ops audit evidence; documented deletion policy questions; indexed bounded feed/event/purchase/dispatch queries; no speculative performance rewrite |
| S/T/U tests/targeted fixes/exclusions | findings table and validation above; only confirmed defects fixed; no billing/provider/price/verification-policy or visual redesign |
| N1/N2/N3/N4/N14/N15/N16/N17/N18 producers/routes/content/legacy | 63-call AST inventory plus raw-SQL search (only central writers); canonical route table above; no guessed claim links, bearer tokens, exact address, phone or credentials added to user notices; unsupported web features have no action |
| N5/N6/N7/N8/N9/N19/N20 click/safety/auth/org/guards | notification API projection -> strict frontend destination validator -> router navigation; validated returnTo retained through auth; explicit org URL remains authoritative context, never permission; target APIs reauthorize; paid canonical task is outside premium guard |
| N10 stale links | canonical task successor for materialized business quotes; customer draft exposes task continuation; deleted/removed-authority business refs become no action; lost entitlement shows access-required; no org guessing or redirect loop; delayed proof/application intents revalidate current source |
| N11/N12/N13 dedupe/read/order | recipient/event-specific SQL uniqueness, locked premium fan-out, outbox request keys and retry; all read/click mutations bind current user, unread/list share visibility; created_at/id ordering, bounded legacy offset API retained |
| N21/N22/N23 tests/severity/report | destination/auth/org tests and focused backend/PG suites, explicit findings/severity table, baseline results; no browser integration claimed |

## Deferred decisions and remaining work

- Approved real price/provider credentials and any recurring/refund/cancellation product policy.
- Read-only Provider OS quote history after premium expiry; current premium guard preserved.
- Optional pending-verification quote acquisition needs complete origin-aware activation, not fake claims.
- Revoked client relationships require support resolution; fresh invitation does not silently restore them.
- Any future decision to give all optional native/operational alert producers premium-level durable domain-event guarantees; critical inspected lifecycle notices now have atomic intent/row persistence.
- Client-list pagination, notification cursor pagination and wider legacy-native feature/web parity.
- Retention policy for hard-deleted account recipient evidence.

No new payment rail, real charge, subscription, premium SMS redesign, exact-address/proof/completion fork, main merge or push was performed. Commit identities are supplied with the implementation report rather than embedded self-referentially in this file.
