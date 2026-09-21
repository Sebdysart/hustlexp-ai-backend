# M01 — authenticated provider-account operation through the actual worker

Classification: EXISTING MILESTONE / SOURCE-BOUND HANDOFF, 2026-09-21. Runtime acceptance: UNKNOWN; current source map: PARTIAL. Production effect: NONE.

## Objective and controlling source

Continue M01 in section 4 of the [Shared Goal, Execution & Review Log](https://docs.google.com/document/d/1Kstx5GO2FLeliaK7qTwjohD7FDYW8C8WD7My8byjvhY/edit): an authenticated participant requests the correct supported provider-account operation; restricted API/database persist a durable request; the actual queue and worker invoke an explicitly fake external adapter; the result persists and is rendered truthfully in provider and /OPS views. This is not full onboarding, payout readiness or a completed paid journey.

Use [current checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md) for exact source pair and CI. Business policy: current Context section 7.1 (processor-neutral V1A), Charter transaction/eligibility rules and applicable /OPS/activation requirements from the Canonical Index. Stable IDs below are handoff subrequirements, not invented claims that the governing documents used these IDs.

## Requirement → source → dependency → test → recovery

All paths refer to backend aaf0fcb013d7221b91db021cb1089f29d6a06013 unless otherwise stated. An inspected anchor is not proof that the M01 bridge exists there.

| ID / requirement | Inspected source or explicit missing link | Dependencies / present evidence | Required execution and recovery | Resolver |
|---|---|---|---|---|
| M01-A identity and command | backend/src/routers/index.ts registers stripeConnect; backend/src/routers/stripeConnect.ts getOnboardingStatus/createOnboardingLink invoke StripeConnectService under hustlerProcedure | Legacy/provider-specific route source PRESENT. This is NOT evidence of the current fake M01 operation or approved Tilled topology. Exact current M01 command/schema mapping UNKNOWN | Recover existing reviewed M01 command; bind actor/account/action; reject unauthenticated and wrong-account use before any effect. Do not invoke legacy external creation to simulate success | Backend source owner; assignment acknowledgment pending |
| M01-B durable request | Exact M01 request table, constraints, enqueue producer and fake adapter source are NOT RECOVERED from local-only packet | backend/src/jobs/workers.ts checks applied_migrations against REQUIRED_MIGRATION_FILES before startup. Manifest import: backend/src/jobs/engine-automation-migration-files.ts. Database readiness != request persistence proof | Identify migration by exact name and schema semantics, request ID, idempotency key and expected version. Show persisted pending state before worker. Crash/retry must not create a second request or reuse changed intent | Backend source owner; Sebastian resolves access/assignment |
| M01-C actual dispatch/worker | backend/src/jobs/workers.ts startWorkers; backend/src/jobs/worker-registration.ts processPaymentQueueJob and registerWorkers; backend/src/jobs/outbox-worker.ts and queues.ts are imports, not newly audited implementations | Inspected runtime validates latest migration/Redis and starts actual outbox worker. Inspected payment dispatcher delegates payment.* to payment-worker.ts. These are navigation anchors, NOT proof of fake account-operation routing | Recover exact existing queue/event/handler and enforce restricted identities. Trace the real worker from persisted request, not a direct materializer call. Retain safe retry/owned unknown; unexpected event must not create success | Backend source owner |
| M01-D adapter/result | backend/src/jobs/payment-worker.ts processPaymentJob inspected through line180: Stripe-event signature/schema/claim handling | Observed Stripe event path is not fake account creation. Exact M01 simulated adapter and account-result persistence remain UNKNOWN | Demonstrate explicit fake adapter only; record correlated authoritative pending/success/failure. External timeout/uncertainty must remain pending or an owned recovery state, never fabricated completion | Backend source owner |
| M01-E visible outcome | Web pair pinned in checkpoint; exact M01 page/read-model and /OPS handlers NOT INSPECTED | Shared-log local prototypes/results are LOCAL_ONLY and source-dated | Name actual components/query contracts after source recovery. Show reloaded provider + /OPS values from persisted result. No optimistic-only final success, KYC or payout-ready claim | Web source owner; assignment pending |
| M01-F evidence and negatives | Exact portable M01 test file/test runner artifacts NOT RECOVERED; package scripts and current failed CI are accessible | Mock unit outcomes, scoped historical pass counts and skipped DB tests do not establish this journey | Register real tests for unauthorized actor, wrong account, exact retry, changed intent, worker failure/timeout and recovery. Capture IDs/logs/UI readback and zero real external effects at same source/config | Source owner + separate reviewer, neither acceptance fabricated |

The M01 source map intentionally exposes missing links. The inspected Stripe anchors are not permission to replace the current intended provider topology or rebuild the parked M01 implementation. Current business-task-list source is another feature, not M01 acceptance.

## Next bounded change: recover and bind evidence before new code

1. Source owner retrieves the latest relevant local M01 handoff/patch using approved private access. Record exact backend/web bases and delta; preserve unrelated WIP and parked evidence. Do not restore a historical candidate wholesale.
2. Compare it with the pinned current pair. Fill the unresolved table entries with actual handler, schema migration, queue, adapter, read-model and test paths. Record retain/merge/obsolete disposition. If source truly cannot be recovered, document that finding before authorizing a bounded reimplementation.
3. On an approved disposable environment, run the existing operation once through authenticated API and real worker with a labeled fake adapter; include the necessary denial/retry/uncertainty cases. Resolve the first demonstrated blocker only. No new broad roadmap, unrelated rewrite or production approval request for ordinary isolated repairs.
4. Publish accessible source/test artifacts and truthful outcome, or exact first blocker. Use existing coordination log; do not count a local filesystem path as shared proof.

Accountability: the backend/web source owner performs source recovery and binding; Sebastian owns unresolved access and unacknowledged assignment. A named reviewer is still UNASSIGNED; do not invent acceptance. This is a proposed task allocation, not a recorded acknowledgment by Martin or anyone else.

## Acceptance evidence contract

Record requirement ID; current Google section/revision; backend/web commits and local delta; environment/migration identities; contained adapter; actor/account IDs in sanitized form; command and durable request correlation; real queue/worker evidence; authoritative result; provider and /OPS readback; each negative result; command exit statuses; skipped/unexecuted items; artifact access and reviewer.

Pass requires one real internal end-to-end transition plus relevant negatives. Seeded terminal rows, direct materializer invocation, static screenshots, health checks, fake production credentials and another source revision do not pass. An account record does not establish task eligibility or funding/payout readiness.

Stop dependent actions for missing authority, unidentified database, real external effects, missing source binding or uncertain outcomes. Preserve evidence and an owned next action. Do not suppress required recovery to obtain green status. Future scope/assignment/payment/fulfillment milestones remain on the existing plan; M01 neither replaces full V1A nor expands live authority.
