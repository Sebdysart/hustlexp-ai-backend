# Provider OS premium notifications

Stage three uses the existing PostgreSQL outbox, `user_notifications` BullMQ queue,
SMS worker, and Twilio adapter. It does not add another queue or send from HTTP
handlers. Subscription billing remains out of scope.

## Durable capture

Migration `20260920_provider_os_premium_events.sql` follows organization ownership
and quote-origin migrations in the startup manifest. Historical migrations and
the old `provider_os_notification_events` ledger remain unchanged.

Database AFTER triggers insert `provider_os_domain_events` and `outbox_events` in
the canonical transaction. Rolling back that transaction rolls back its event.
There is no detached post-commit fan-out to lose on process exit.

| Event | Canonical write | Unique event key |
| --- | --- | --- |
| CLIENT_JOINED | First consent-bearing organization/customer relationship INSERT during `acceptProviderOsInvite` | `joined:<organization>:<relationship>` |
| CLIENT_TASK_POSTED | Eligible user-owned draft INSERT, including canonical `webPostTask.start`; one event for each active, entitled related organization | `posted:<organization>:<draft>` |
| QUOTE_ACCEPTED | Selected `task_drafts.quote_id` changes to a Provider OS quote in `quote_send_ready`, inside `quoteDecision.accept` | `accepted:<organization>:<quote>` |
| TASK_READY | `quote_payments` becomes `SUCCEEDED`, with the selected Provider OS quote linked to an already materialized, ACCEPTED canonical business task | `ready:<organization>:<quote>` |

Payment success is deliberately captured before the later `quotes.status = paid`
write. The current finalizer can replay an already successful payment without
repeating that later write. Waiting for it would leave a crash gap. This changes
no payment or task transition; it observes the successful payment write.

No events are backfilled. Invitation preview/repeated acceptance, duplicate intake
submission, payment initiation, failed payments, and idempotent payment replay do
not create new premium events. Claim/proposal quote origins do not emit these
quote events. Relationship IDs identify the consent epoch; no recipient phone is
stored on the domain event.

## Processing and recipient policy

The existing dispatcher delivers `provider_os.premium_event` jobs. The processor
locks the event and atomically writes its fan-out, recipient ledger, SMS outbox
rows, and processed/skipped result. Failures roll back fan-out only; retries can
complete it without duplicating recipients. Error details are retained in the
canonical outbox. Terminal failures remain available for operator inspection.

Before fan-out, and again immediately before SMS delivery, policy requires:

- The exact organization is ACTIVE and provider-enabled.
- Its entitlement is active, started, and unexpired.
- The event's consent-bearing organization/customer relationship remains active.
- The client account remains active, not banned, and not on trust hold.
- Draft/quote/task ownership still matches the event. New-request events additionally
  require current feed eligibility, including no active quote from that organization.
- The recipient is an active OWNER, ADMIN, or DISPATCHER of this organization and
  passes existing READ_WORKSPACE and ASSIGN_CREW action policies.
- The recipient account is active, not banned, and not on trust hold.
- Existing global `notification_preferences.sms_enabled` is explicitly true.
- The current `users.phone` is usable E.164 (`+` followed by 8–15 digits).

No preference row means no SMS. No first-membership selection, worker-mode
shortcut, user-owned relationship, or serialized queue authorization is used.
Quiet hours use the existing `NotificationPolicy.nextQuietHoursEnd` and stored
`quiet_hours_timezone`. Invalid settings fail closed. Quiet-hour deferral does
not consume a provider attempt. Membership/preference/phone changes after enqueue
are respected. Authorization is checked immediately before the external request;
an SMS already handed to Twilio cannot be recalled by subsequent revocation.

Events with no currently eligible SMS recipients are terminally skipped, with an
outcome. They are not retroactively sent when someone later opts in. Per-member
skip reasons are recorded where a candidate member exists; organization-wide
ineligibility/no candidates is recorded on the event.

## Delivery, retries and legacy protection

`sms_outbox.provider_os_event_id` and a unique `(event_id,user_id)` index establish
provenance and recipient dedupe. `provider_os_event_recipients` additionally records
skipped, queued, sent, retry, and uncertain outcomes. Deleting/anonymizing accounts
cannot transfer authority: nullable event references fail closed; user delivery
rows follow existing user deletion behavior.

The existing SMS worker routes from the persisted record. The premium branch
requires a matching recipient ledger and `provider_os:v2:sms:<event>:<user>` key.
It ignores queue-supplied phones/bodies and regenerates the template using current
phone and trusted canonical context. It retains row locking/CAS, retry counts,
SID-first persistence, and sent/SID replay protection.

Definite Twilio rejection or missing credentials can retry through the same
outbox, after 30 seconds, up to the existing per-row maximum (default three).
An ambiguous transport failure, success without a SID, or a stale sending claim
without a saved SID is suppressed as `delivery_uncertain_requires_review`.
Do not automatically reset these rows: Twilio may already have accepted them.
Investigate provider evidence first. This is conservative duplicate prevention,
not a claim of exactly-once external delivery or verified handset receipt.

For v2 premium jobs only, completed/failed BullMQ jobs are removed so a durable
retry can reuse its deterministic job ID. Enqueued outbox leases older than ten
minutes are recovered, with the existing five-dispatch-attempt ceiling. Ordinary
marketplace queue retention and delivery policies remain unchanged. Redis/DB
dispatch failures never require re-running a marketplace action.

Legacy `provider_os:` messages without the new event provenance stay suppressed
both by migration and worker. Existing SIDs are acknowledged without resending.
The old user-owned emitter is a permanently disabled compatibility stub; no
current producer uses it and it cannot opt into v2.

## Copy, links and in-app behavior

SMS contains no customer name, task scope/title, service address, or payment token.
The HTTPS origin uses existing `SITE_URL` configuration (existing application
fallback `https://hustlexp.app`). Operator configuration must point to the actual
frontend. Internal identifiers occur only in canonical deep-link paths.

| Event | Copy | Destination |
| --- | --- | --- |
| Joined | HustleXP: A client has joined your Provider OS workspace. | `/provider-os?organizationId=<org>` |
| New request | HustleXP: A connected client posted a new request. | `/provider-os/drafts/<draft>?organizationId=<org>` |
| Accepted | HustleXP: A client accepted your Provider OS quote. | `/provider-os/quotes/<quote>?organizationId=<org>` |
| Ready | HustleXP: Client payment is confirmed and your job is ready. | `/business/tasks/<task>` |

Frontend/backend notification destination validation permits only concrete UUID
Provider OS workspace/draft/quote routes with exactly one organization parameter.
No claim token or fabricated claim link is created.

Joined/new-request events create deduped in-app notices through the existing
NotificationService for eligible members, even if SMS is disabled. Quote accepted
and payment/task-ready retain their existing canonical in-app notices, without
new duplicates. Ordinary marketplace notifications and SMS are not expanded.

Provider OS quote history remains entitlement gated. SMS checks current access,
but access may change after send; read-only history after premium loss remains a
separate product decision. Canonical task execution, proof, exact address access,
completion, payment, and payout do not acquire an entitlement requirement.

## Operations and validation

Inspect `provider_os_domain_events.status/outcome`,
`provider_os_event_recipients.outcome`, `sms_outbox.error_message/twilio_sid`, and
`outbox_events.status/error_message/attempts`. For event dispatch, the outbox key
is `provider_os:v2:event:<event-id>`. For delivery it is
`provider_os:v2:sms:<event-id>:<user-id>`.

Durable event insertion is part of the domain commit contract and requires its
migration to exist. Recipient lookup, preferences, missing phones, queue failures,
Twilio failures, and notification fan-out all run later and cannot undo a committed
relationship, request, quote selection, payment, or task materialization.

Focused unit tests run normally. The isolated PostgreSQL fixture suite uses
`PROVIDER_OS_TEST_DATABASE_URL` and accepts only localhost/127.0.0.1 port 55439.
It creates/drops a random schema, applies the new migration to a minimal canonical
fixture, and mocks Twilio/in-app transport. Without that variable it skips. It is
not a full production schema migration rehearsal or live Twilio/Redis verification.

Remaining separate work: billing/paywall checkout, entitlement-loss history policy,
optional complete pending-verification origin support, and small client UX/pagination
improvements. Provider OS quoting remains VERIFIED-only.
