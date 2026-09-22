# Hardening continuation: durable lifecycle notices and recipient eligibility

This continues the source audit after backend commit `5a558617`. The final consolidated audit is in provider-os-production-readiness.md; this file records the continuation in detail.

## Confirmed defects fixed

| Severity | Source | Failure | Correction / evidence |
|---|---|---|---|
| High | task-lifecycle-notifications / application and proof callers | default notification identity was category + recipient + task + version 1, so the second applicant or proof attempt could be suppressed | concrete application/proof identity, including rejection notice identity; regression failed against old helper |
| High | TaskApplicationProcedures, taskExternalBridge, TaskExecutionProcedures | committed application/proof could lose its notice if the process died before the post-commit helper | record notification request in the same existing transaction; real PostgreSQL rollback and concurrent replay fixture |
| Medium | AdminNotificationHelper | distinct security incidents could collapse onto shallow `/admin/escrows` object identity | explicit admin-alert identity hashes title, destination and source-ID metadata; diagnostic error text does not create a new retry identity; per-recipient key |
| Medium | NotificationService business/Ops fan-out | active membership/admin role still selected suspended/banned/trust-held accounts | current account eligibility; business READ_WORKSPACE policy also checked; real PostgreSQL regression failed before fix |

No task state transitions, proof evidence requirements, completion rules, payment amounts, providers, escrow, payout behavior, or frontend visuals changed. Router changes move notification intent into existing transactions; they do not change the underlying operation's authorization or state machine.

## Existing outbox reused

`NotificationRequestService.enqueueNotificationRequest(query, params)` writes `notification.create_requested` through the existing transactional outbox helper. Explicit source/recipient dedupe is mandatory. There is no new queue, notification category, public endpoint, channel or transport.

The existing user-notifications worker reads the request from PostgreSQL using the persisted outbox identity. It ignores the queue's serialized recipient/body. The stored payload is validated before use. Current account status is rechecked; ordinary NotificationService still applies task participation, preferences, class/channel policy, quiet hours, frequency and delivery state.

For delayed application/proof requests, current source rows must still belong to the task/recipient and remain actionable. Withdrawn applications, closed task opportunities and already-reviewed proof attempts produce a recorded skipped outcome rather than a misleading new action request.

Transient storage failures leave the request unacknowledged for retry. Ineligible/deleted recipients, lost participation and disabled preferences are terminal skipped outcomes recorded in `outbox_events.error_message`; only stable reason codes are stored there. The notification key is unchanged on retry, including failure after the notification row is inserted but before request acknowledgment. Existing channel-delivery recovery continues independently.

Lease recovery now includes these ledger-backed requests, in the same bounded SKIP LOCKED recovery loop as premium work. Completed/failed BullMQ copies are removable so a recovered durable request can reuse its job ID. Attempt exhaustion remains visible in the existing failed-outbox/operator path. A new forward migration, `20260919_notification_request_dispatch.sql`, adds the matching partial lease index and is registered after existing Provider OS migrations. No historical migration was edited.

## Validation

- Backend build, compile and scoped source lint passed; diff checks passed.
- Final focused run: **31 files / 510 tests passed**, including Provider OS access/product/purchase/event tests, notification/SMS/outbox tests, new request tests, application bridge and isolated PostgreSQL fixtures.
- Task application/proof/review router selection: **35 passed**, 162 unrelated tests filtered.
- Admin helper selection: **13 passed**, 52 unrelated tests filtered.
- New migration was applied successfully to the isolated PostgreSQL fixture; its partial index and manifest order are checked.
- Full task-router suite still has one unrelated stale getById projection expectation, reproduced on untouched `cfe45abd`. Its 196 other tests pass. The worker-registration test's pre-existing missing outbox mock was also reproduced there; that focused harness now mocks its dependency and tests the new request dispatch.
- The six previously documented broader baseline failures remain separate. The old migration-count assertion predates this new forward migration too.
- No live database, Redis delivery, Twilio, charge, browser, push or production deployment verification.

## Final commit-boundary hardening

- Assignment and instant acceptance now record their existing notice in their domain transaction. Router post-commit hooks were removed.
- Proof rejection carries the actual proof ID into the existing task-reset transaction. Delayed feedback is skipped if a newer proof exists or that task/worker no longer needs the action.
- Poster-confirmed completion records notice intent next to completion evidence. A replay does not emit again. No completion/approval rule changed.
- Escrow release records the existing payment_released intent, keyed by escrow/recipient, only with provider transfer evidence and no manual-reconciliation hold. The recipient is revalidated against canonical release/task/payout evidence before NotificationService applies its ordinary channel/preferences rules. Business recipients additionally require current workspace permission and use /business/tasks/:id; premium expiry cannot block that canonical link. No payout math or transfer behavior changed.
- Tip receipt and earned verification unlock insert their existing in-app notice with their existing local state write. Failed inserts roll back the local notification claim, so retries can publish. No new tip/verification product behavior.
- Ordinary quote-payment finalization groups final quote/version/payment updates and existing in-app fan-out into one transaction, using canonical quote -> version -> payment lock order. External provider verification, prior materialization and funding remain outside that notification transaction. A failed local insert remains recoverable; external payment is never repeated by the notification writer.

All generic lifecycle intents reuse notification.create_requested and the existing user_notifications queue. No new transport, category, public notification endpoint, payment rail or separate worker exists. Preference/authorization skips are recorded. Transient delivery/storage failures retry under the existing bounded outbox/worker policy; attempt exhaustion is visible to operators. No claim of exactly-once external transport is made.

## Final validation

- Consolidated focused Provider OS/product/premium/SMS/in-app/outbox/lifecycle run: **34 files / 587 passing tests**.
- Final task application/assignment/acceptance/proof/review/completion selection plus PostgreSQL paid-notice test: **89 passed**, 245 unrelated tests filtered.
- Earlier admin helper selection: **13 passed**; frontend unchanged since its **7 files / 67 passing tests**, build and lint.
- New PostgreSQL tests run real local quote/version/payment/notice SQL after stubbing already-completed provider verification/materialization. Failure rolls back final paid state and notice rows; retry and repeat yield exactly two intended recipient notices. Verification-unlock transaction similarly rolls back its notification claim and publishes once after retry.
- Additional payout/request tests cover business versus worker destination, exact released recipient, removed authority, and absence of premium entitlement in canonical release access. Existing account/preference/premium checks remain covered by their dedicated suites.
- Six additional task/escrow fixture failures reproduce on the untouched audit baseline (three task-create expectations; three no-worker/missing-task expectations). They are separate from the six earlier migration/config baseline failures and one full task-router projection expectation. No unrelated assertions were rewritten to hide them.
- No production migration, network payment, Twilio send, Redis end-to-end delivery, browser run, push or main merge.

The original A–U and N1–N23 scope is cross-referenced in the final report. Remaining pricing/refund/recurring/history-expiry/pending-verification/retention decisions stay deferred, rather than being silently implemented.
