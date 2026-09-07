# HISTORICAL SOURCE RECORD — NOT CURRENT AUTHORITY

Status: HISTORICAL / NOT CURRENT AUTHORITY
Current authority: Charter v1.3.0, Underwriting v3.4, Learning Rail v1.0, Frontend and WorkLink v1.1, Activation/Copy v2.0, Context v1.3.0, and /OPS v1.1.
Production effect: NONE

# HustleXP Payment, Transaction, and `/OPS` Architecture Convergence Record

Status: `PROPOSED_NOT_BUILT / DEV_SAFE / DOCUMENT_ACTION_EFFECTS_NONE`

Team target: [HustleXP Team Goal and Execution Contract](../HUSTLEXP_TEAM_ALIGNMENT.md). This file contains detailed proposed design and a source-dated implementation snapshot; it is not current implementation, program, processor, or production authority.

Baseline: `714e111efa7ae8615313b79338f4a65f71f1df41`

Base: `ab4a76cbc8ea32c663c36982eafe94b20d2dc879`

Prepared: 2026-08-23 America/Los_Angeles

Evidence refreshed: 2026-08-24 America/Los_Angeles

Decision: `RESHAPE`

This record is the forced architecture decision for the post-D1 convergence series. It is not processor approval, production authority, a migration, or launch evidence.

## 1. Evidence lock and source boundaries

The record is bound to the following sources within their own truth planes. Approval sources govern permission, target specifications govern intended architecture, exact source governs implementation claims, and provider/runtime evidence governs observed effects. No item in one plane rewrites another.

1. Google Doc `1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ`, title `HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3.1`, tab `t.0`, Docs revision `AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA`, modified `2026-08-19T01:35:10.015Z`, paragraphs 0 through 1,075 read.
2. `PaymentUnderwritingAuthorityV7.ts`, whose document identity, 20 unresolved decisions, `NO_GO`, and `DISABLED_PENDING_WRITTEN_APPROVAL` state match the source document.
3. The byte-preserved [backend audit/build mission](../source-contracts/HUSTLEXP_BACKEND_PR_AUDIT_AND_CONVERGENCE_MISSION.md), SHA-256 `437df53578b045f0b6ee55f99d1a302c2aee68fb288ad10c1083e0e411e25469`, and [`/OPS` control-plane specification](../source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md), SHA-256 `65aa1868547e73dae157393572e4fbf68113990b4b71d241c6a7512a9d47af96`.
4. HX/OS 2.0 Field Intelligence Product & Brand System sections 0, 2, 10, 12, 17, 18, 22, 23, 24, 33, 34, 38, 39, 41, 43, 47, and Operations done criteria.
5. Runtime inspection of this repository at the exact baseline above and read-only inspection of `Sebdysart/hustlexp-site` worktree `de0602e4639091ec4ed9b9c26d378cc82f39c1f5`.
6. Read-only delta inspection of the clean site candidate `45b3879e19043d6a52d735d70a0cafbb621b486a` (tree `6dccce4132003feb7c55dfa8ebe0a6c5057e20d2`), including its emitted development build identity and route chunks. This delta is evidence of changed reachability, not an accepted site release or production artifact.
7. Read-only GitHub API inspection on 2026-08-24: backend remote `main` remained `ab4a76cbc8ea32c663c36982eafe94b20d2dc879` (tree `4b1527e0d6d356292e10fae9a70c18e00251fdd8`); PR 274 remained at exact head `714e111efa7ae8615313b79338f4a65f71f1df41` (tree `2532e984d308a0c0db5b21be1210844d4ae7a4df`) and base `ab4a76cbc8ea32c663c36982eafe94b20d2dc879`.

Governor diagnostic at the 2026-08-24 architecture refresh was `FAIL`: the checkpoint, current state, dependency graph, and evidence ledger were each 684.80 hours stale, and no active code-changing node existed. That sentence is retained as source-dated preparation evidence, not current program state.

At the later 2026-08-25 documentation refresh, canonical Governor preflight was `FAIL` because the control worktree was dirty and the working Governor skill hash differed from its suite manifest; the diagnostic still named exactly one active node, `TASK_FIRST_FAKE_FSE_POSTGRES_AUTHORITY_REBUILD`. The updated working procedure permits isolated local work and a non-deploying shared candidate despite this diagnostic failure, but it grants no migration, provider, merge, deployment, or production proof.

Sections 5.1 through 5.7 are a historical implementation snapshot bound to candidate `714e111efa7ae8615313b79338f4a65f71f1df41`, not the active program base. A verified delta at active base `08c9dbd122f64a9c5721e5b44a2356de980a9684` shows `routers/web/ops.ts` importing `opsProcedure` and `opsSensitiveProcedure` and routing consequential writes through `WebOpsCommandService`. That delta closes the snapshot's exact `publicProcedure + adminKey + direct SQL` description for those migrated routes only; it does not prove that all `/OPS`, lead, action-link, admin, bridge, browser, or Supabase writers have converged. Regenerate the complete writer inventory before any runtime slice relies on it.

## 2. Forced decision

`tasks.id` will be the one canonical transaction identity for all relationship origins:

- `MARKETPLACE`
- `PROVIDER_OS`
- `BRING_YOUR_OWN_PROVIDER`

The identity is created when legitimate demand for one occurrence is accepted as a `TASK_DRAFT`. It is not replaced when that occurrence's quote is approved, a provider accepts, a Financial Security Event succeeds, a Work Order is materialized, or capture occurs. Those milestones are versioned state and child records under the same transaction identity. A recurring template or series is not a transaction root: every generated occurrence receives its own canonical `tasks.id`, which is then preserved for that occurrence.

Current `task_drafts` rows become a compatibility intake projection with a required one-to-one `engine_task_id` binding during migration. They do not remain a second task authority. New intake must call the engine before an opportunity can exist.

`escrows` cannot remain the target financial abstraction. The name and `PENDING/FUNDED/RELEASED` model collapse authorization, capture, settlement, and payout. Historical rows remain immutable evidence; new processor-neutral work uses explicit Financial Security Event, payment operation, ledger, settlement/funding, and reconciliation records.

## 3. Non-negotiable invariants

1. No legitimate `TASK_DRAFT` means no opportunity or claim link.
2. A claim link creates `EXPRESSED_INTEREST`, never assignment, reservation, earnings, or address access.
3. Provider payment eligibility and HustleXP task eligibility are separate facts.
4. No provider conditional acceptance means no Financial Security Event attempt.
5. No approved merchant context means no Financial Security Event attempt.
6. No successful, unexpired, reconciled Financial Security Event means no Work Order materialization, hard assignment, or exact-address release.
7. A reversible Financial Security Event is not capture, settlement, funding, payout, or escrow.
8. No approved completion, amount, incident, and notice gates means no capture.
9. Completion is not capture; capture is not settlement; settlement is not funding; funding is not reconciliation; reconciliation is not dispute finality.
10. No processor/ledger agreement means no transaction closure.
11. Every money-affecting call has a durable operation record and idempotency key before the provider call.
12. Provider calls run outside database transactions; phase-one claims commit before the call and phase-two finalization is version-checked.
13. Webhooks enter an authenticated, deduplicated inbox before normalization or domain effects.
14. Out-of-order and duplicate provider events cannot duplicate money or regress canonical state.
15. Supabase is acquisition, consent, communications, recovery, analytics, and read-model overlay only.
16. Browsers cannot directly mutate canonical transaction or money records.
17. Every accepted and rejected Operations command is attributable to a named actor and immutable audit result.
18. AI can recommend, classify, summarize, or organize evidence; policy outside the model owns consequential authority.
19. Exact location stays encrypted and masked until the server confirms the valid Financial Security Event and hard assignment.
20. All unresolved underwriting capabilities fail closed.
21. A release candidate is unacceptable unless production customer-money creation is structurally impossible before every external release gate passes.

## 4. Target transaction model

### 4.1 Orthogonal rails

| Rail | Closed target states | Current source to adapt |
|---|---|---|
| Commercial | `TASK_DRAFT`, `NEEDS_DETAILS`, `SCOPE_READY`, `ESTIMATE_REQUIRED`, `QUOTED`, `QUOTE_APPROVED`, `PAYMENT_METHOD_READY`, `EXPIRED`, `CANCELLED` | `tasks`, `task_drafts`, `quotes`, `quote_versions`, `task_scope_versions`, `task_clarification_revisions` |
| Provider processor eligibility | `NOT_EVALUATED`, `PENDING`, `ELIGIBLE`, `RESTRICTED`, `INELIGIBLE`, `EXPIRED` | processor-account capability, restriction, merchant-context, and provider-eligibility records; the transaction stores an exact version witness rather than owning global provider status |
| HustleXP task/category/credential eligibility | `NOT_EVALUATED`, `PENDING`, `CONDITIONALLY_ELIGIBLE`, `ELIGIBLE`, `INELIGIBLE`, `EXPIRED` | `capability_profiles`, credentials, screening, region/category policy, and task-specific eligibility decisions |
| Sourcing and assignment | `NOT_SOURCING`, `SOURCING`, `INTEREST_EXPRESSED`, `SOFT_RESERVED`, `PROVIDER_CONDITIONALLY_ACCEPTED`, `HARD_ASSIGNED`, `REPLACEMENT_REQUIRED`, `RELEASED` | `task_applications`, `task_external_*`, `task_reservation_*`, and `task_reservations` |
| Financial security | `NONE`, `PENDING`, `SECURED`, `EXPIRING`, `EXPIRED`, `VOID_PENDING`, `VOIDED`, `FAILED`, `RECONCILIATION_REQUIRED` | legacy `escrows`, `quote_payments`; new target records required |
| Fulfillment | `NOT_READY`, `WORK_ORDER_MATERIALIZED`, `ASSIGNED`, `EN_ROUTE`, `ARRIVED`, `IN_PROGRESS`, `PAUSED`, `COMPLETION_SUBMITTED`, `COMPLETION_APPROVED`, `CANCELLED` | `tasks`, progress, proof, safety, scope-change services |
| Capture | `NOT_ELIGIBLE`, `ELIGIBLE`, `PENDING`, `PARTIALLY_CAPTURED`, `CAPTURED`, `FAILED` plus immutable captured-amount facts | legacy succeeded PaymentIntents, `escrows`, completion/capture services, provider events |
| Processor settlement | `NOT_STARTED`, `PENDING`, `SETTLED`, `FAILED`, `RECONCILIATION_REQUIRED` plus immutable batch/balance-movement facts | processor balance and transfer events, legacy release workers |
| Platform funding | `NOT_DUE`, `PENDING`, `FUNDED`, `FAILED`, `RETURN_PENDING`, `RETURNED`, `RECONCILIATION_REQUIRED` | platform ledger, processor balance, insurance/recovery records |
| Provider payout | `NOT_DUE`, `PENDING`, `SUBMITTED`, `PAID`, `FAILED`, `RETURN_PENDING`, `RETURNED`, `RECONCILIATION_REQUIRED` | payout/cash-out/transfer records and provider events |
| Reconciliation | `UNVERIFIED`, `MATCHED`, `MISMATCH`, `RECOVERY_PENDING`, `RESOLVED` | `revenue_ledger`, reconciliation cases/runs, provider events |
| Incident/dispute | Versioned cases with `OPEN`, `EVIDENCE_DUE`, `UNDER_REVIEW`, `LIABILITY_ALLOCATED`, `RESOLVED`, `CLOSED` | safety incidents, disputes, chargebacks, insurance claims, restriction records |
| Operations exception | `NONE`, `OPEN`, `OWNED`, `RECOVERY_PENDING`, `AWAITING_APPROVAL`, `RESOLVED`, `TERMINAL` | `operations_exception_*` and recovery records |
| Retention | `ONE_TIME`, `REBOOK_ELIGIBLE`, `REBOOKED`, `RECURRING_TEMPLATE`, `OCCURRENCE_SCHEDULED`, `PAUSED`, `TERMINATED` | recurring and retention records |

Each rail has its own version. Refunds, reversals, returns, and chargebacks are immutable operation, allocation, and exposure facts attached to the affected economic records; they do not overwrite historical capture, settlement, funding, or payout truth. No UI or service may infer a rail from another rail's state.

### 4.2 Transaction root

The root must expose at least:

```ts
type RelationshipOrigin =
  | 'MARKETPLACE'
  | 'PROVIDER_OS'
  | 'BRING_YOUR_OWN_PROVIDER';

type CanonicalTransactionIdentity = {
  taskId: string;
  relationshipOrigin: RelationshipOrigin;
  commercialVersion: number;
  providerProcessorEligibilityVersion: number;
  taskEligibilityVersion: number;
  sourcingAssignmentVersion: number;
  financialSecurityVersion: number;
  fulfillmentVersion: number;
  captureVersion: number;
  processorSettlementVersion: number;
  platformFundingVersion: number;
  providerPayoutVersion: number;
  reconciliationVersion: number;
  incidentDisputeVersion: number;
  operationsExceptionVersion: number;
  retentionVersion: number;
};
```

Marketplace, Provider OS, and BYOP are policy inputs, not separate schemas or alternate lifecycles.

## 5. Source-dated runtime findings and target dispositions

Disposition meanings:

- `KEEP`: authoritative primitive is valid; extend only through its owner.
- `ADAPT`: valid primitive has the wrong contract or insufficient state separation.
- `MIGRATE`: data remains evidence but new writes move to the target owner.
- `FREEZE`: no new positive-authority effect; recovery/reconciliation remains available.
- `DELETE`: remove only after zero runtime references, migration proof, and retention approval.

### 5.1 Persistence cohorts

| Current objects | Disposition | Target |
|---|---|---|
| `tasks`, `task_create_requests`, `task_scope_versions`, `task_clarification_revisions`, `task_public_questions`, `task_location_vault`, `task_location_access_log` | `ADAPT` | One transaction root created at demand; versioned commercial rail; purpose-bound location access. |
| `task_drafts` | `MIGRATE` | Compatibility acquisition projection with required `engine_task_id`; delete independent status authority after cutover. |
| `quotes`, `quote_versions`, `price_book`, `price_book_quote_decisions`, `task_quote_shortlists` | `ADAPT` | Immutable scope/economics revisions under the root; accepted revision binds both parties. |
| `quote_payments`, `quote_payment_recovery_operations`, `quote_payment_recovery_events` | `FREEZE` then `MIGRATE` | Preserve orphan recovery evidence; replace positive creation with Financial Security Event and normalized payment operations. |
| `escrows`, `escrow_events` | `FREEZE` for new production creation; `MIGRATE` historical facts | Split into security-event, capture, settlement/funding, ledger, payout, and reconciliation records. Do not represent this table as legal escrow. |
| `revenue_ledger` | `KEEP` then `ADAPT` | Immutable economic evidence; certify balanced postings and explicit service GMV, provider economics, platform fee, processor cost, refund, loss, and recovery accounts. |
| `task_applications`, `task_external_bridge_events`, `task_external_offers`, `task_external_share_links`, `task_direct_invite_claims` | `ADAPT` | Opportunity and expressed-interest facts only; no pre-eligibility assignment semantics. |
| `task_reservation_requests`, `task_reservations`, `task_matching_scores`, `task_supply_candidate_evaluations`, `task_supply_confidence`, `task_supply_recovery_actions` | `ADAPT` | Conditional provider hold and hard assignment become distinct operations with TTL and expected version. |
| `capability_profiles`, `provider_credential_status`, `background_checks`, `identity_verification_*`, `license_verifications`, `insurance_verifications`, `worker_screening_*`, `verified_region_memberships`, `verified_trades` | `KEEP` and `ADAPT` | Separate processor payment eligibility, HX task eligibility, category credentials, region policy, and task-specific eligibility. |
| `proofs`, `proof_submissions`, `proof_photos`, `proof_videos`, `evidence`, `task_scope_checklist_progress`, `task_completion_delivery_events` | `KEEP` and `ADAPT` | Version-bound completion evidence. AI signals remain advisory. |
| `task_safety_*`, `disputes`, `dispute_evidence`, `payment_disputes`, `insurance_claims` | `KEEP` intake/review/evidence; `FREEZE` positive claim payout; `ADAPT` | Purpose-bound incident/dispute cases with independent authority, deadlines, immutable evidence, and a separately authorized claim-payout operation. |
| `stripe_events`, `processed_stripe_events` | `MIGRATE` | One provider-neutral webhook inbox with raw authenticated event, dedupe identity, normalized event, replay state, and processing attempt history. Historical Stripe identity remains labeled `STRIPE`. |
| `worker_cash_out_requests`, `worker_cash_out_events`, `worker_payout_settings`, `worker_stripe_accounts`, `business_provider_payout_*` | `FREEZE` for unresolved live capabilities; `ADAPT` for sandbox | Processor-neutral payout/funding operations and reconciliation; UI never equates submission with paid. |
| `recurring_tasks`, `recurring_task_series`, `recurring_task_template_revisions`, `recurring_task_occurrences`, `recurring_provider_reservations`, `recurring_schedule_exceptions`, `recurring_template_*` | `FREEZE` live money; `ADAPT` model | Each occurrence gets its own canonical transaction root and per-occurrence security/capture lifecycle. |
| `major_action_class_contracts`, `major_action_source_registry`, `major_action_events`, `major_action_outcomes` | `KEEP` and `ADAPT` | Immutable consequential-action audit; link every command result and provider operation. |
| `operations_exception_access_log`, `operations_exception_ownership`, `operations_exception_ownership_events`, `operations_exception_action_events`, `operations_exception_signals` | `KEEP` and `ADAPT` | Exception-first read model and typed command target; add expected-version command semantics and rejected-command audit. |
| `admin_roles` | `ADAPT` | Closed role/capability registry, named sessions, MFA/step-up state, two-person approval policy. No browser key. |
| `feature_flags` | `ADAPT` | Closed capability registry and kill switches. Arbitrary string keys cannot enable unresolved money capabilities. |
| `hxos_local_test_*` | `KEEP` isolated | Disposable local/fake-adapter certification only; unmistakable test identity and no production portability. |
| `notifications`, `notification_deliveries`, `email_outbox`, `sms_outbox`, `outbox_events`, `notification_log` | `KEEP` and `ADAPT` | Transactional outbox and user-visible truth; communications remain overlay effects, not lifecycle authority. |
| AI/recommendation/observation tables | `KEEP` and `ADAPT` | Observable recommendations and outcomes; never an authority record for money, identity, safety, assignment, or address. |
| Business, squad, reputation, skills, analytics, tax, badge, referral, and other ancillary domain tables | `KEEP` pending their domain slice | They may reference the canonical root but cannot introduce transaction, money, assignment, proof, or payout authority. |

No table is deleted in the foundation slice. `DELETE` requires a later zero-reference proof, data-retention decision, export, rollback point, and fresh-Postgres migration rehearsal.

### 5.2 Backend router dispositions

| Router/path | Current authority | Disposition |
|---|---|---|
| `routers/web/ops.ts` | `publicProcedure`, body `adminKey`, direct SQL, arbitrary status/flag writes | `FREEZE` mutations, `MIGRATE` reads to named `opsProcedure`, then `DELETE`. |
| `routers/web/leads.ts` | public acquisition plus shared-key admin reads/writes | `KEEP` public acquisition; `MIGRATE` admin operations to named Commands. |
| `routers/web/actionLinks.ts` | shared-key admin creation/status mutation | `MIGRATE` to signed opportunity service and named Commands; remove arbitrary status mutation. |
| `routers/operations.ts` | named Firebase session plus `can_manage_operations`; registered exception commands | `KEEP` and `ADAPT`; this is the Operations command foundation. |
| `routers/quotePayment.ts` | legacy quote payment/materialization entry | `FREEZE`; preserve read/recovery only until target lifecycle replaces it. |
| `routers/escrow-payment-procedures.ts` | task-first payment creation/confirmation, globally frozen except isolated tests | `FREEZE` positive production effects; adapt fake-adapter certification to FSE operations. |
| `routers/escrow-release-procedures.ts`, dispute/refund routes | recovery and historical money effects | `KEEP` under strict consequence capability; migrate to operation records. |
| task create/read/scope/application/discovery routes | registered canonical task services plus some legacy state assumptions | `KEEP` and `ADAPT` to root-at-demand and orthogonal rails. |
| assignment/accept/reservation routes | gate assignment on legacy `FUNDED` escrow | `MIGRATE` gate to `SECURED + reconciled + unexpired` FSE and provider acceptance. |
| `stripeConnect`, subscription, tipping, XP tax, cash-out routes | processor-shaped or unresolved capabilities | `FREEZE` live positive effects; retain containment and recovery. |
| business/recurring/service-business routes | alternative origin and recurrence surfaces | `ADAPT` to the same canonical lifecycle; every generated occurrence receives its own transaction root. |

### 5.3 Worker and webhook dispositions

| Worker | Disposition | Required target behavior |
|---|---|---|
| `payment-worker.ts` | `KEEP` containment, then `ADAPT` | Consume normalized inbox facts; never create positive authority while frozen. |
| `stripe-event-worker.ts`, `stripe-event-dispatcher.ts` | `KEEP` reconciliation, then `MIGRATE` | Stripe becomes one adapter input. Frozen positive facts may reconcile but cannot grant entitlement, funding, assignment, or success state. |
| `payout-event-worker.ts` | `FREEZE` new live payout, `KEEP` recovery | Normalize funding/payout facts and reconcile exact operation/ledger records. |
| escrow action/reconciliation workers | `KEEP` historical recovery, then `MIGRATE` | Refund, void, reversal, dispute, and reconciliation survive; new FSE/capture semantics replace release-as-payout. |
| completion release workers | `ADAPT` | Completion approval triggers capture eligibility, not immediate generic escrow release; settlement/funding proceeds separately. |
| dispatch/instant matching workers | `ADAPT` | May source and soft-reserve; cannot hard assign without provider eligibility, acceptance, and FSE. |
| recurring workers | `FREEZE` live money, `ADAPT` sandbox | Every occurrence receives its own root, security event, capture facts, and reconciliation result. |
| outbox/notification workers | `KEEP` | Idempotent delivery with canonical event references and exception projection. |

### 5.4 Supabase/site overlay dispositions

The inspected site has 50 function directories. Thirty function families reference `OPS_ADMIN_KEY` or `x-admin-key`: `action-link-admin`, `ai-ops-admin`, `ai-ops-approvals`, `autonomy-controller`, `dispatch-candidates`, `dispatch-engine`, `engine-bridge-admin`, `engine-task-bridge`, `funnel-health-sentinel`, `hermes-card-notify`, `hermes-executor`, `hermes-runner`, `hermes-webhook`, `inbound-admin`, `inbound-intake`, `inbound-parser`, `landing-surface-probe`, `lead-admin`, `lifecycle-autopilot`, `manual-assignment-admin`, `nextdoor-intent`, `prospect-outreach`, `quote-admin`, `quote-generator`, `sms-inbound`, `supply-admin`, `task-admin`, `task-bridge`, `task-payment`, and `task-quote-admin`.

Disposition rules:

- `KEEP`: public acquisition, consent capture, unsubscribe, public supply projection, analytics collection, inbound provider signature verification, and communication delivery when they do not write canonical lifecycle state.
- `ADAPT`: bridge and automation functions become authenticated service identities that submit typed engine commands with correlation, idempotency, expected version, and reason code.
- `FREEZE`: `task-payment`, manual assignment, dispatch, quote acceptance/materialization, recurring money, and any function that can create a positive task/payment/assignment state without the engine command gate.
- `MIGRATE`: admin reads to versioned engine read models; admin mutations to named-session BFF calls; overlay rows retain `engine_task_id` and acquisition/communication state only.
- `DELETE`: shared-key browser gates, shared-key mutation handlers, and direct canonical SQL after parity, retention, and zero-reference proof.

At the original site evidence SHA, the browser persisted the shared credential in `/OPS` components including `OpsGate`, `OpsV2Preview`, `OpsTaskDrafts`, `OpsPaymentStatus`, `OpsSecurePayment`, `OpsApprovals`, and `OpsInbound`. Candidate `45b3879e...` removes those browser clients, and its inspected runtime browser source (excluding test fixtures) and emitted assets contain no `OPS_ADMIN_KEY` or `x-admin-key`. That closes the browser-secret storage and emission surface only; it does not remove the server authority. All 30 Edge function families listed above still contain the shared-key contract or a dependent call path at `45b3879e...`.

### 5.5 Current site-to-engine and overlay effect paths

| Current path at site candidate `45b3879e...` | Current writer or provider effect | Failure against the target | Disposition and required owner |
|---|---|---|---|
| `PosterTasksView.tsx` -> `PosterAuthorizePayment.tsx` -> `engineTaskBridgeApi.prepareEnginePayment` -> `engine-task-bridge` `prepare_payment` | The Edge bridge calls engine `task.create`, checkpoints an engine task pointer in Supabase, then enters the legacy payment-intent/escrow lane. The emitted `PosterTasks` route chunk contains the path. | Positive task materialization remains browser-reachable before a processor-neutral FSE exists; the bridge is configured with `verify_jwt = false` and implements its own dual authentication. | `FREEZE`; replace with one engine command that creates the root-at-demand, conditional hold, fake FSE, and Work Order transition under the target owner. The site may render only the command result/read model. |
| `EarnSetup.tsx` -> `hustler-self-service` `create_onboarding_link` -> engine `stripeConnect.createOnboardingLink` | Engine creates or reads processor account/onboarding-link state; the emitted development `EarnSetup` route chunk contains the action. | Provider-account creation and onboarding-link creation are positive processor effects but are not customer-payment creation, so the legacy payment-creation guard is the wrong authority boundary. | `FREEZE`; engine owns a separate closed positive-effect capability for processor account creation and onboarding-link creation. The site remains an authenticated BFF/read-model consumer. |
| `HustlerWallet.tsx` -> `wallet.requestCashOut` | Engine records a cash-out request and can call the payout provider; the emitted wallet and tRPC chunks contain the route. | Cash-out is a positive payout/bank effect with no processor-neutral operation/capability gate in the inspected baseline. | `FREEZE`; engine owns `INITIATE_PROVIDER_BANK_PAYOUT` with durable claim, idempotency, reconciliation, and recovery. |
| `task-payment` Edge function | The implementation still contains shared-key/flagged create, capture, refund, Connect-test, and payout branches, but candidate `45b3879e...` returns `503` for every positive operation before credential lookup, database access, or provider effects. Only bounded recovery, reconciliation, and sync operations remain reachable and may write overlay evidence. | It is not a live second positive-money authority at the exact candidate. The dormant processor-shaped branches, shared-key server contract, and recovery writes remain convergence debt; recovery evidence must never become canonical lifecycle or money truth. | `KEEP` the fail-closed containment and bounded recovery; `MIGRATE` recovery/reconciliation to typed engine operations and read models; `DELETE` dormant positive branches and shared-key authority after parity and retention proof. |
| `quote-admin` | Shared key writes quote/version economics, arbitrary negotiation status, pay tokens, and audit rows directly in Supabase. | Caller is not a named actor; writes are non-canonical and do not use expected version, one command idempotency boundary, or the engine audit contract. | `FREEZE` writes; `MIGRATE` to typed engine quote commands; retain only overlay reads after parity. |
| `task-bridge`, `manual-assignment-admin`, `dispatch-engine` | Shared key and feature flags invoke Supabase RPCs that materialize tasks, assign workers, open match windows, reserve candidates, or enqueue approvals. | They constitute a second task/assignment lifecycle and can manufacture authority without the canonical engine rails. | `FREEZE`; replace with named service identities submitting strict engine commands; `DELETE` lifecycle RPC writers after zero-reference proof. |
| `action-link-admin` | Shared key creates links, accepts caller-provided `pay_url` and operator text, and writes link status/events. | The overlay can mint task/payment-shaped instructions and actor evidence outside the closed command and capability registries. | `FREEZE` task/payment-shaped creation; `MIGRATE` to signed, purpose-bound engine opportunity commands; `DELETE` shared-key mutation. |
| Public acquisition, consent, unsubscribe, communication delivery, and redacted read projections | Supabase overlay facts only. | Safe only while they cannot advance canonical task, assignment, address, money, proof, completion, or payout state. | `KEEP` under explicit table/field allowlists and engine pointer contracts. |

The current site CI is not cross-repository convergence evidence. `.github/workflows/ci.yml` pins engine revision `d861f25984d0bebcbdfe7176bdee9f869222a5d1`, while the record baseline is `714e111e...`, and the workflow does not run the site's `verify:schema` command as a distinct gate. The exact candidate verifier also contains order-sensitive source-pattern checks rather than typed or compiled contract evidence. `ADAPT`: pin the accepted signed engine SHA, run `verify:schema`, and replace source-order regexes with exported-schema or compiled-contract checks.

### 5.6 Source-dated backend writer ledger

The following ledger is bound to candidate `714e111e...`. Paths outside the D1 diff were verified byte-identical to remote `main` `ab4a76c...`; D1 payment paths were inspected at the candidate itself.

| Consequential path | Current writer, persistence, idempotency, audit, and gate | Missing or conflicting authority | Disposition and target owner |
|---|---|---|---|
| Canonical task creation | `TaskCreateProcedures.ts` -> `TaskCreateService.ts` -> `TaskCreatePersistence.ts`; one transaction writes `tasks`, `task_create_requests`, and a legacy `PENDING` escrow under a client idempotency key, region/compliance/price checks, and database invariants. | It materializes the Work Order and escrow-shaped financial state before provider conditional acceptance and a reconciled FSE; no closed relationship-origin or underwriting-capability gate exists. | `KEEP` the transaction/idempotency primitive; `ADAPT` the owner to root-at-demand followed by explicit rail transitions. |
| Quote payment creation/finalization | `quotePayment.ts`, `StripeQuotePaymentProvider.ts`, `QuotePaymentFinalizationService.ts`, `quote_payments`, and the D1 `NewPaymentCreationGuard`. Candidate `714e111e...` permits positive creation only inside the exact isolated Vitest/test-mode cohort and blocks materialization while frozen. | The legacy unfrozen design is processor-first and uses a succeeded PaymentIntent as the precondition for task creation; `quote_payments` is not a processor-neutral operation/FSE record. | `FREEZE` positive production effects; `KEEP` the bounded orphan recovery lane; `MIGRATE` to durable operation + FSE records. |
| Direct escrow payment creation/confirmation | `escrow-payment-procedures.ts` -> provider resolver/Stripe service -> legacy `escrows`; creation is guarded before route reads/writes/provider calls. Confirmation may read the escrow and return an exact idempotent replay of an already-`FUNDED` row, but the guard runs before any new provider verification, duplicate-payment query, or funding effect. Exact price/ownership checks and new effects follow only in the isolated cohort. | Legacy `PENDING/FUNDED` collapses FSE, capture, settlement and funding; no accepted decision/capability registry owns the effect. | `FREEZE` production; `ADAPT` fake certification to the processor-neutral FSE owner. |
| Subscription, tipping, and XP-tax PaymentIntent creation | Their routers/services enter the same D1 creation guard before positive effects. | Product-specific Stripe lanes remain processor-shaped and do not establish task lifecycle, operation, settlement, or reconciliation authority. | `FREEZE`; later route through the processor-neutral command owner only when their decisions are approved. |
| Connect account and onboarding-link creation | `stripeConnect.ts` -> `StripeConnectService.ts`; `accounts.create` is followed by a `users.stripe_connect_id` write, and `accountLinks.create` returns the onboarding URL. CircuitBreaker exists; no durable operation claim or global capability freeze exists. | This positive processor-account effect is outside `NewPaymentCreationGuard`, has no accepted provider-eligibility/merchant-context authority, and can leave provider/database split state. | `FREEZE`; add a separate closed `CREATE_PROCESSOR_ACCOUNT` / `CREATE_PROCESSOR_ONBOARDING_LINK` capability owner with recovery. |
| Worker wallet cash-out | `hustlerWallet.ts` -> `HustlerWalletService` -> `HustlerWalletProvider.ts`; caller supplies an idempotency key and Stripe receives it for `payouts.create`. | No underwriting/capability freeze, normalized operation claim, settlement/funding reconciliation, step-up, or bank-arrival authority. | `FREEZE`; engine-owned `INITIATE_PROVIDER_BANK_PAYOUT` command and operation ledger. |
| Self-insurance claim review/payout | `insurance.ts` exposes `payClaim` through `escrowAdminProcedure`; `SelfInsurancePoolService.payClaim` locks the claim/pool and uses a claim-scoped transfer key, but commits `insurance_claims.status = 'paid'` before `StripeService.createTransfer` and attaches the provider transfer ID in a later write. | Positive claim payout has no accepted insurance/loss-waterfall capability, recent financial step-up, two-person approval, expected version, durable pre-call operation claim, or atomic command result. Provider failure can leave `paid` without a receipt; retry remains provider-shaped. | `KEEP` claim filing, review, and recovery evidence; `FREEZE` positive payout; `MIGRATE` to `PAY_INSURANCE_CLAIM` with a durable operation/idempotency claim, provider call outside the transaction, versioned phase-two receipt or `RECONCILIATION_REQUIRED`, immutable audit, step-up, and dual approval. |
| Completion-triggered payout/release | Task completion and completion-release workers write outbox/release state and may create transfers through legacy Stripe services. | Completion can advance payout obligations without an explicit post-completion capture rail, processor-neutral settlement/funding record, or one reconciliation owner. | `ADAPT`; completion owner emits capture eligibility only, then separate capture, settlement/funding, payout, and reconciliation commands advance their rails. |
| Refund, void, reversal, dispute, and orphan recovery | Escrow release/refund, dispute, Stripe reversal, and quote-recovery services retain necessary negative/recovery actions; D1 explicitly preserves them. | Several paths still call provider-shaped services or mutate legacy escrow/dispute records without a universal pre-call operation claim, expected-version command, and atomic immutable audit result. | `KEEP` availability; `ADAPT` each to a typed operation and immutable recovery/reconciliation owner. |
| Stripe webhook ingestion and dispatch | `serverWebhookRoutes.ts`, `stripe_events`, outbox/queue dispatch, `payment-worker.ts`, and `stripe-event-worker.ts` verify inbound events and use durable event identities. Candidate D1 suppresses positive canonical effects while retaining reconciliation facts. | Two worker interpretations plus legacy `StripeService.processWebhookEvent` fragment the same payment/refund/transfer lifecycle; no provider-neutral inbox, normalized event, or single reconciliation case owner exists. | `KEEP` verified ingress/dedupe; `MIGRATE` all interpretation to one provider-neutral inbox/normalizer/reconciliation owner; delete dormant duplicate processing after reference proof. |
| Assignment and reservation | `assignment.ts`, reservation repositories/policy, task-acceptance and administrative writers update worker/task/application facts with legacy `FUNDED` and eligibility checks. | Multiple assignment writers do not share one reservation/expected-version boundary; broad admin/bridge authority and external-origin applications bypass a Decision-19 gate. | `ADAPT`; one command owns soft hold and hard assignment with provider acceptance, eligibility, unexpired reconciled FSE, origin, and expected version. |
| External opportunity bridge | Registered `taskExternalBridge.ts` creates/discloses links and writes claims, applications and offers; ordinary assignment can consume them. | Decision 19 is unresolved, but no closed capability gate blocks the path in the baseline. | `FREEZE`; preserve evidence, then `ADAPT` to redacted `EXPRESSED_INTEREST` only. |
| Engine bridge workload authority | `trpc-context.ts` accepts `ENGINE_BRIDGE_WRITE_KEY`; `adminOrEngineBridgeProcedure` grants assignment, controlled automation, unattended completion, rating, and recurring commands to one configured actor. | Shared service credential receives human-admin-equivalent authority; commands lack one closed allowlist/envelope and can reach canonical commitment or payout-triggering state. | `FREEZE` consequential bridge writes; `MIGRATE` to narrow named service identities and typed workload commands; `DELETE` human-admin equivalence. |
| Named exception Operations | `operations.ts` -> `OperationsExceptionService.ts`; Firebase identity, `operationsAdminProcedure`, transactional UUID idempotency, actor attribution, purpose-bound reads, ownership versions, and append-only events form the strongest control-plane path in the bound snapshot. | Commands accept no `expectedVersion` and do not use the common `CommandEnvelope`; `admin`/`founder` bypass individual capability flags; no step-up exists. | `KEEP` foundation; `ADAPT` to strict envelope, expected version, step-up policy, and rejected-command audit. |
| Shared-key web `/OPS`, lead, and action-link mutations | `routers/web/ops.ts`, `web/leads.ts`, and `web/actionLinks.ts` use `publicProcedure` plus caller-supplied `adminKey`; they directly write quotes, versions, drafts, leads, flags, links and statuses. | No named actor/session, MFA, expected version, common idempotency boundary, atomic audit, or closed reason/status registry. | `FREEZE` all writes, `MIGRATE` required behavior to named typed commands, then `DELETE` the shared-key procedures. |
| Legacy admin and flags | `admin.ts`, `flags.ts`, and `FlagsService.ts` can ban/suspend users, override escrow, mutate dispute/task state, grant roles, and set arbitrary flags. Some audit occurs after effects and failure can be swallowed; `admin_actions` is not fully update-immutable. | Consequential effects lack consistent step-up, two-person approval, expected version, capability/decision binding, and atomic accepted/rejected audit. | `FREEZE` high-consequence mutation; `MIGRATE` to command owners; `ADAPT` flags into a closed capability/kill-switch registry. |
| Recurring, business, service-business, and retention writers | Registered services create or regenerate tasks through the existing task-creation owner. | They do not persist one closed `relationshipOrigin`, and recurring occurrences can inherit the same premature escrow/work-order semantics. | `ADAPT`; every occurrence receives its own transaction root and advances through the same canonical rails. |

At the bound snapshot, no row above had all five required proofs: one authoritative owner, one canonical record, one committed idempotency boundary before external effects, one immutable audit trail, and one accepted capability gate. Re-test every row at the active implementation base; absence in this snapshot is not automatically a current defect, and a later code path is not accepted without exact evidence.

### 5.7 Duplicate-writer and invariant-failure ledger

| Invariant | Exact snapshot evidence | Required convergence |
|---|---|---|
| One physical task writer | `TaskCreatePersistence.ts` is the sole production `INSERT INTO tasks`. Marketplace, business, quote, rebook, recurring, replacement and squad entry points converge on `TaskCreateService`. | Preserve that writer; require every caller to supply the closed origin and capability instead of inferring origin from optional linkage fields. |
| One application eligibility decision | Marketplace applications use `TaskEligibilityPolicy`; `taskExternalBridge.ts` writes the same `task_applications` table through the narrower `ExternalTaskBridgePolicy` subset. | External and BYOP acquisition remain overlay metadata until the canonical eligibility owner admits the application. |
| One assignment/reservation witness | Intended owner is `assignment.reserve` -> `TaskReservationService` -> `TaskReservationRepository`. `TaskAssignmentProcedures.ts`, `TaskAcceptProcedures.ts`, and `TaskAcceptService.ts` each update `tasks.state = 'ACCEPTED'` without creating the reservation row that `TaskExecutionService` requires. | Migrate all three direct writers to the reservation command. An accepted task without one active reservation is invalid and must not start or release an address. |
| One exact-address authorization witness | `TaskLocationService` checks assigned worker, `ACCEPTED`, funded escrow, deadline, trust/account state and encrypted location, then records access. It relies on `tasks.worker_id/state`, not the active reservation. | Add the canonical reservation/FSE witnesses to the decryption predicate; direct-assignment state cannot authorize plaintext. |
| One terminal task-state owner | Proof/execution/completion services own the normal path, while dispute, admin ban/suspension, fraud, trust, payment-failure and recurrence services contain direct `tasks.state` writes. | Replace direct SQL with versioned close/reopen/complete commands and one immutable result/outbox boundary. |
| One economic-obligation idempotency key | Candidate `StripeService.createTransfer` builds keys from escrow, amount, destination and an optional caller suffix (`StripeService.ts:103-116,424-478`). Completion, dispute and partial-refund callers can therefore send distinct Stripe keys for one escrow obligation. | The operation ledger allocates one key per economic obligation; caller identity is audit metadata, never a way to create another provider effect. |
| Release means externally supported economic truth | `admin.escrowOverride` can call force release; the release transaction can classify manual reconciliation, mark `escrows.RELEASED`, and trigger revenue, insurance, earnings, tax and XP effects without a provider transfer receipt. | Freeze force release. Only a reconciled settlement/funding operation may advance economic truth; manual work opens an exception rather than fabricating `RELEASED`. |
| Insurance claim `paid` means a provider receipt exists | `SelfInsurancePoolService.payClaim` marks the claim `paid` in one transaction, performs the provider transfer afterward, and records `stripe_transfer_id` separately; failure can preserve a paid claim with no provider receipt. | A durable `PAY_INSURANCE_CLAIM` operation claims the obligation before the provider call. Only version-checked receipt finalization may mark the claim paid; ambiguous outcomes become `RECONCILIATION_REQUIRED`. |
| One recurring lifecycle | Legacy recurring routes and controlled-v2 routes are registered together. Legacy occurrence handling does not materialize the canonical task consistently; controlled v2 uses `TaskCreateService` but its provider-reservation record has no acceptance bridge into `TaskReservationService`. | Delete legacy recurrence after migration; adapt v2 so every occurrence creates its own root and canonical reservation, then keep production activation frozen pending Decision 16. |
| One webhook interpretation | Verified Stripe ingestion writes `stripe_events` and outbox evidence, but dispatcher routing, `payment-worker`, `stripe-event-worker`, and dormant `StripeService.processWebhookEvent` can interpret overlapping payment/refund/transfer semantics. | Keep verification/dedupe; normalize once; assign each operation type one handler and reconciliation owner; delete wildcard/dormant processors after zero-reference proof. |

At the bound snapshot, these were runtime contradictions rather than documentation gaps. Revalidate reachability at the active base; any replacement slice that leaves a proven duplicate writer reachable fails the convergence record even if its new schema and tests are internally green.

## 6. Authority foundation

### 6.1 Command envelope

All consequential Operations and system commands use one envelope:

```ts
type CommandEnvelope<TPayload> = {
  commandId: string;
  actorId: string;
  reasonCode: ReasonCode;
  correlationId: string;
  idempotencyKey: string;
  expectedVersion: number;
  payload: TPayload;
};
```

Rules:

- `actorId` comes from the authenticated server context; callers cannot impersonate another actor.
- `commandId`, `correlationId`, and `idempotencyKey` are opaque, bounded, and validated.
- `expectedVersion` is mandatory for canonical mutation and returns a typed conflict when stale.
- Payload schemas are strict and command-specific.
- Reason codes and commands are closed registries; arbitrary status strings are forbidden.
- Idempotent replay returns the original command result. Same key plus different request hash is a conflict.
- Accepted and rejected results are immutable and actor-attributed.

### 6.2 Closed capability classes

The foundation registry must distinguish at least:

- read-only Operations access
- acquisition administration
- provider eligibility review
- task/supply operations
- sensitive-data reveal
- financial-security void/recovery
- capture approval
- refund approval
- dispute handling
- settlement/reconciliation
- payout/funding review
- safety/identity restriction
- worker-rights/deactivation decision
- policy/configuration administration

Capabilities bind to the exact named role/restriction matrix in [the Team Goal and Execution Contract](../HUSTLEXP_TEAM_ALIGNMENT.md#81-named-ops-roles-and-explicit-denials) and the frozen [`/OPS` source contract](../source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md#4-roles-permissions-and-separation-of-duties). `admin` and `founder` may be break-glass roles only when step-up, reason, audit, expiry, and incident review apply. There is no permanent universal browser credential.

### 6.3 Step-up and dual approval

| Action class | Minimum control |
|---|---|
| A0/A1 observation and reversible internal retry | named session, capability, audit |
| A2 user-impacting reversible action | named session, capability, reason, idempotency |
| A3 money-sensitive action | recent MFA/step-up, financial capability, expected version, immutable result |
| A4 safety/identity restriction | recent step-up, specialized capability, purpose-bound evidence |
| A5 irreversible/regulatory action | two-person approval or explicit external authority; no self-approval |

## 7. Processor-neutral boundary

The current `PaymentProvider` exposes only `createPaymentIntent` and `verifySucceededPayment`; `QuotePaymentProvider` adds Stripe-shaped orphan recovery. That is insufficient and remains legacy.

The target adapter must cover:

```ts
interface ProcessorNeutralAdapter {
  getAccountEligibility(input: AccountEligibilityInput): Promise<AccountEligibilityResult>;
  createTokenReference(input: TokenReferenceInput): Promise<TokenReferenceResult>;
  createFinancialSecurityEvent(input: SecurityEventCreateInput): Promise<SecurityEventResult>;
  readFinancialSecurityEvent(input: SecurityEventReadInput): Promise<SecurityEventResult>;
  voidFinancialSecurityEvent(input: SecurityEventVoidInput): Promise<SecurityEventResult>;
  capture(input: CaptureInput): Promise<CaptureResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  readSettlementOrFunding(input: SettlementReadInput): Promise<SettlementResult>;
  readDisputesAndRestrictions(input: DisputeReadInput): Promise<DisputeResult>;
  verifyWebhook(input: RawWebhookInput): Promise<VerifiedWebhook>;
  normalizeWebhook(input: VerifiedWebhook): Promise<NormalizedProcessorEvent>;
  reconcile(input: ReconciliationInput): Promise<ReconciliationResult>;
}
```

No live adapter is implemented until the exact relevant underwriting decisions are accepted in writing. The fake adapter must implement the same interface and deterministic timeout, duplicate, out-of-order, partial-failure, refund, dispute, and reconciliation scenarios.

## 8. Underwriting decision gates

| # | Decision | Capabilities disabled while unresolved |
|---:|---|---|
| 1 | Casual sole-proprietor eligibility | individual provider payment activation and paid assignment |
| 2 | Provider bank account eligibility | sole-proprietor funding/payout |
| 3 | Unified Marketplace + Provider OS relationship | Provider OS payments and shared provider resource assumptions |
| 4 | MoR/account topology/descriptors/support | checkout, receipt, statement, refund authority |
| 5 | Conditional provider before FSE | open-marketplace security event and hard assignment |
| 6 | Capture/disbursement model | capture and controlled funding |
| 7 | Tokenization/portability | replacement, recurring reuse, cross-context credentials |
| 8 | Platform economics | fees, splits, transfers, residuals |
| 9 | Amount change | automated change orders, incremental auth, partial capture |
| 10 | Provider replacement | automated replacement and overlapping holds |
| 11 | Ultimate loss waterfall | reserves, recourse, post-funding loss allocation |
| 12 | Provider/platform risk isolation | provider-scoped restriction and cross-provider offset |
| 13 | Categories/MCCs | unsupported and regulated categories |
| 14 | Limits/reserves/settlement/capacity | production amount and volume ceilings |
| 15 | Restriction/termination handling | automated continuity after provider/platform restriction |
| 16 | Recurring occurrences | recurring payment automation and annual prepayment |
| 17 | Regulatory role/licensing | production platform payment model |
| 18 | Commercial terms | production financial model and fee configuration |
| 19 | Task-opportunity onboarding | external task-link acquisition to paid assignment |
| 20 | Written architecture signoff | every processor-specific implementation |

The registry stores source revision, decision status, approver identity/class, evidence reference, effective interval, supersession, and impacted capability keys. Persisted status follows the `/OPS` contract and is closed: `NOT_SUBMITTED`, `SUBMITTED`, `IN_REVIEW`, `REDLINED`, `APPROVED`, `REJECTED`, `SUPERSEDED`, `EXPIRED`. `UNRESOLVED` remains an aggregate containment classification, not a competing persisted state. Only a written external authority record may produce `APPROVED`, and no approval may enable a capability without the required step-up, two-person governance command, certification evidence, and kill-switch transition.

## 9. End-to-end trace and required owner

| Stage | Current path | Target owner and gate | Current verdict |
|---|---|---|---|
| legitimate demand | Supabase intake and backend `task_drafts`; direct `TaskCreateService` also creates `tasks` | engine creates `tasks.id` at `TASK_DRAFT`; overlay receives pointer | `MIGRATE` |
| scope/quote | quote services and direct web Ops SQL | versioned engine scope/quote commands | `ADAPT` |
| opportunity | task discovery/external links | real root, signed redacted link, open sourcing state | `ADAPT` |
| provider interest | application/external offer paths | `EXPRESSED_INTEREST` only | `ADAPT` |
| provider eligibility | capability, credential, screening, region services | processor eligibility + HX eligibility + task-specific policy | `ADAPT` |
| conditional acceptance | reservation/offer services | short TTL soft hold on accepted scope/economics | `ADAPT` |
| Financial Security Event | absent; legacy succeeded PaymentIntent/`FUNDED` escrow stands in | new processor-neutral operation and security-event records | `BLOCKED` |
| Work Order materialization | `tasks` created earlier in direct path, later in quote path | same root advances to `WORK_ORDER_MATERIALIZED` atomically after reconciled FSE | `MIGRATE` |
| hard assignment | accept/assign routes gate on legacy `FUNDED` | accepted provider + eligibility + unexpired FSE + expected version | `MIGRATE` |
| address release | encrypted vault; gate on `ACCEPTED` + `FUNDED` | hard assignment + valid FSE + purpose-bound access audit | `ADAPT` |
| execution/scope change | task progress/scope/safety services | fulfillment rail and immutable accepted revisions | `ADAPT` |
| completion approval | proof/completion services | completion, amount, incident, customer-notice gates | `ADAPT` |
| capture | legacy payment is already succeeded before assignment | post-completion capture operation | `BLOCKED` |
| settlement/funding | escrow release/transfers/provider events | normalized settlement/funding records and ledger postings | `MIGRATE` |
| refund/dispute | refund/dispute/chargeback services | operation record, allocation, evidence deadline, reconciliation | `ADAPT` |
| reconciliation | revenue ledger and specialized workers | one run compares every open provider and ledger object | `ADAPT` |
| closure | task/escrow terminal states | only after ledger/provider agreement; dispute exposure remains explicit | `MIGRATE` |
| recurring | recurring schemas/services | each occurrence receives its own root and uses the same canonical lifecycle | `FREEZE` live, `ADAPT` sandbox |

Any row marked `BLOCKED` preserves production `NO-GO`.

## 10. PR disposition lock

Live state below was observed through the GitHub API on `2026-08-25`. The disposition is the architecture outcome; a closed state does not prove its prerequisite or evidence-retention condition.

| PR | Observed state | Disposition | Enforcement / unresolved proof |
|---:|---|---|---|
| 263 | `CLOSED`, unmerged | `SUPERSEDE` | evidence-retention acceptance remains `UNKNOWN` |
| 264 | `MERGED` | merged legacy state | quarantine and decompose unsafe auth, screening, and payment behavior |
| 265 | `CLOSED`, unmerged | `CLOSE_WRONG_ARCHITECTURE` | no vendor-heavy bundle merge |
| 266 | `CLOSED`, unmerged | `CONSOLIDATE` into 274 | head `31a6b0252e445130fccdbfdc7aac31bca5b9c965` is the merge base and exact Git ancestor of PR 274 head `714e111efa7ae8615313b79338f4a65f71f1df41`, with PR 274 nine commits ahead and zero behind; ancestry is proven, but exact relevant-tree equivalence before closure remains `UNKNOWN` |
| 267–273 | `CLOSED`, unmerged | `SUPERSEDE` | branches/evidence remain source-dependent prototypes; merge none |
| 274 | `OPEN` | `MERGE_AFTER_CHANGES` | exact record-bound containment candidate `714e111e…`; block remains until complete repository enforcement and authorized merge |

### 10.1 Repository-enforcement evidence

The GitHub API confirms active repository-ruleset configuration `20840525` on `Sebdysart/hustlexp-ai-backend` default branch `main`. The applicable-rules API reports deletion and non-fast-forward protection, required signatures, linear history, one approving review, stale-review dismissal on push, last-push approval, resolved review threads, eight strict required checks, and CodeQL; the ruleset has no bypass actors and reports `current_user_can_bypass: never`.

This is configuration evidence, not observed rejection behavior. The rule-suite query returned no evaluated suites, and no controlled direct-push or unapproved-merge attempt was executed. The legacy branch-protection endpoint returning `404` does not negate the ruleset configuration. Independent review root `01c0433009c62160f86fb295927490a1f1c10a5d1c11dec1c86c8ac5cebbe5a5` (`SHA-256(SHA256SUMS)`) concluded `ACTIVE_REPOSITORY_CONTAINMENT_NOT_HEALTHY_ENTERPRISE_ENFORCEMENT`. None of this is merge evidence for PR 274:

- all eight required checks are green on exact head `714e111e...`;
- the PR is `OPEN`, not draft, and remains `BLOCKED / REVIEW_REQUIRED` with reviewer `whitehorse1016` requested;
- all ten commits in the PR report `verified: false` and `reason: unsigned`, conflicting with the active signature rule;
- no merge, branch rewrite, approval, or policy bypass is authorized by this record.

The `HustleXP-LLC` organization has an Enterprise plan and the authenticated operator is an active organization admin, but the organization-ruleset API returns an empty set, organization MFA enforcement is disabled, no SAML identity provider is configured, web commit signoff is disabled, and the only inspected organization repository has no repository ruleset. The canonical public backend remains personally owned, so organization policy does not govern it. Full Enterprise-account topology is `BLOCKED_SCOPE` without `read:enterprise` or `admin:enterprise`. Enterprise entitlement and API access are not control convergence.

## 11. Replacement slice order

1. Authority foundation: closed capability and underwriting registries, named Operations procedure, typed command envelope, immutable command results, kill switches.
2. Canonical lifecycle: root-at-demand, orthogonal rails, conditional hold, provider/task eligibility separation, address gate.
3. Processor boundary: payment operations, fake adapter, webhook inbox, normalized events, reconciliation cases.
4. `/OPS` convergence: versioned reads and typed commands through named sessions; remove browser key and direct SQL.
5. Sandbox money lifecycle: FSE, capture, refund, settlement/funding, replacement, recurring only when their decisions permit.

Each slice must register its schema in the runtime migration manifest, wire a registered route/worker, add authorization and observability, pass fresh/upgrade/replay Postgres, and document rollback or containment. A table or type without a demonstrated runtime read/write owner is rejected.

## 12. Falsifiable certification matrix

The architecture record fails if any trace shows:

- more than one canonical transaction identity
- a Supabase lifecycle writer without an engine command and pointer
- a browser credential with canonical mutation authority
- an arbitrary state/status string in a consequential command
- a provider call without a prior durable operation claim
- more than one provider idempotency key for the same economic obligation
- a duplicate/out-of-order webhook that can duplicate or regress money
- an accepted or assigned task without exactly one active canonical reservation
- assignment or address release without an unexpired reconciled FSE
- capture before completion/amount/incident/notice approval
- `RELEASED`, earnings, revenue, tax, insurance, or XP evidence without a reconciled settlement/funding receipt
- an insurance claim marked `paid`, or an insurance transfer attempted, without an accepted loss-waterfall/limits capability, a durable claim-payout operation, required step-up/dual approval, and a reconciled provider receipt
- task closure before reconciliation
- a shared browser or service credential with human-admin-equivalent lifecycle authority
- processor-account creation, onboarding-link creation, transfer, or cash-out without its closed positive-effect capability
- AI output used as final money, identity, safety, dispute, deactivation, or assignment authority
- unresolved decision capability enabled
- a site contract workflow pinned to an engine revision other than the accepted exact candidate
- migration added but not executed against fresh, upgrade, and replay Postgres
- test-only identity or provider resource usable in production

Required scenarios include duplicate interest, duplicate soft hold, concurrent provider acceptance, authorization expiry, provider replacement, amount change, void, refund, dispute, chargeback, webhook replay, provider timeout, post-effect database conflict, reconciliation discrepancy, kill-switch activation, recurring occurrence, and termination/restriction continuity.

## 13. Done criteria for this record

This record is complete as a local architecture decision when:

- exact evidence identities remain unchanged
- all money and `/OPS` authority paths at the bound snapshot are classified, and the active-base delta is explicitly marked for regeneration
- every target transition has one owner and one explicit gate
- the 20 processor decisions map to disabled capabilities
- the first runtime slice can be derived without inventing a second lifecycle
- repository diff and Markdown structure checks pass

It does not authorize production. Production remains `NO-GO` until written underwriting approval, commercial terms, secure onboarding, category/limit approval, sandbox certification, independent review, controlled pilot authority, daily reconciliation, and incident/termination handling all bind to one exact candidate SHA.
