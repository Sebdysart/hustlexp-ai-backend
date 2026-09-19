# Hardening continuation: durable lifecycle notices and recipient eligibility

This continues the source audit after backend commit `5a558617`. The broader goal remains active: this checkpoint closes additional confirmed defects, not every outstanding notification delivery gap.

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

Lease recovery now includes these ledger-backed requests, in the same bounded SKIP LOCKED recovery loop as premium work. Completed/failed BullMQ copies are removable so a recovered durable request can reuse its job ID. Attempt exhaustion remains visible in the existing failed-outbox/operator path. A new forward migration, `20260922_notification_request_dispatch.sql`, adds the matching partial lease index and is registered after existing Provider OS migrations. No historical migration was edited.

## Validation

- Backend build, compile and scoped source lint passed; diff checks passed.
- Final focused run: **31 files / 510 tests passed**, including Provider OS access/product/purchase/event tests, notification/SMS/outbox tests, new request tests, application bridge and isolated PostgreSQL fixtures.
- Task application/proof/review router selection: **35 passed**, 162 unrelated tests filtered.
- Admin helper selection: **13 passed**, 52 unrelated tests filtered.
- New migration was applied successfully to the isolated PostgreSQL fixture; its partial index and manifest order are checked.
- Full task-router suite still has one unrelated stale getById projection expectation, reproduced on untouched `cfe45abd`. Its 196 other tests pass. The worker-registration test's pre-existing missing outbox mock was also reproduced there; that focused harness now mocks its dependency and tests the new request dispatch.
- The six previously documented broader baseline failures remain separate. The old migration-count assertion predates this new forward migration too.
- No live database, Redis delivery, Twilio, charge, browser, push or production deployment verification.

## Remaining evidence/work before full completion

The first report's post-commit caveat is narrowed but not eliminated. Assignment/acceptance, rejection/completion, payout notices, verification-unlock, tip notices and ordinary quote-paid fan-out still need their respective commit/recovery boundaries evaluated and closed where a source-confirmed loss is fixable within the notification-only scope. Payment/task execution policy must not be redesigned to accomplish that.

The final completion audit must reconcile every original A–U and N1–N23 requirement against current source/tests and revise the main report/inventory after the remaining changes. Premium-loss canonical execution, verified-only quoting, entitlement authority, controlled-only purchases, legacy SMS suppression, explicit organization context and safe return handling remain mandatory invariants. Product-policy questions (pricing, refunds, recurring billing, expired premium history access, pending verification and retention policy) remain out of scope rather than guessed.
