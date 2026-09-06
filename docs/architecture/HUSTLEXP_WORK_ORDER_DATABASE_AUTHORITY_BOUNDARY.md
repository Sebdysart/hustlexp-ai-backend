# Universal V1 Work Order database authority boundary

Status: `AUTHORIZED_LOCAL_NONPROD_IMPLEMENTATION_PENDING /
RELEASE_BLOCKED_PENDING_IMPLEMENTATION_AND_INDEPENDENT_REVIEW`

Production effects: `NONE`

Production money: `FROZEN`

Production hard assignment: `FROZEN`

Independent security/release approval: `ABSENT`

## Current truth

The repository does not currently prove a least-privilege database command
boundary for Work Order materialization. The accepted local and Railway
contracts bind migration, API, and worker processes to the same PostgreSQL
login (`PGUSER` / `DATABASE_URL`). The current Work Order witness uses a
transaction-local setting, but any session holding that same database login can
set a custom PostgreSQL setting. It is therefore request provenance, not an
independent authorization boundary.

The hold artifact is
`backend/database/work-order-command-authority.HOLD.json`. The read-only
verifier is
`backend/src/jobs/work-order-command-role-authority.ts`. Neither creates a
role, changes an ACL, applies a migration, or grants release authority.
After the exact candidate has been compiled and the eight role identities are
explicitly configured, run the read-only live check with
`npm run db:verify:work-order-authority`. A nonzero exit or a `BLOCKED` report
is a release stop, never evidence that the verifier should be bypassed.

## Required sealed shape

Before the Work Order path can be called release-ready, live readback must
prove all of the following on the exact target database:

1. Eight explicitly configured and pairwise-distinct roles exist: one-shot
   migration, API, worker, isolated attester, and `NOLOGIN` Work Order command,
   assertion, finance, and telemetry owners. Runtime database target v3 binds
   their canonical topology digest to the database/environment/release/build
   target identity.
2. The command owner is `NOLOGIN`, has no superuser, role-creation,
   database-creation, replication, or row-security-bypass attribute, and owns
   the exact command function.
3. Every command function is `SECURITY DEFINER`, `VOLATILE`, fixes its search
   path to `pg_catalog`, fully qualifies non-catalog objects, and derives its
   actor from an exactly bound, consumed assertion rather than an actor argument.
4. `PUBLIC` and the migration role cannot execute runtime functions. The
   attester may execute only sealed assertion issuance, the API only approved
   human command entrypoints, and the worker only approved recovery entrypoints.
5. API, worker, and attester roles neither own nor have direct `INSERT`, `UPDATE`, `DELETE`,
   or `TRUNCATE` authority on `task_work_order_command_requests`,
   `task_provider_eligibility_decisions`, `task_work_orders`,
   `task_work_order_execution_facts`, `task_reservations`, or
   `task_applications`. The final three are part of the same atomic
   finalization write surface: materialization appends its initial execution
   fact, releases the conditional hold, and closes the provider interest.
6. Exact privilege readback succeeds after provisioning and again from the
   immutable release candidate environment.

## Owner-authorized decision; implementation and independent review required

The owner selected Option A: an isolated attester issues opaque, one-time actor
assertions whose random 256-bit token is represented in PostgreSQL only by its
SHA-256 digest and whose database-owned maximum lifetime is 60 seconds. This
decision applies only to synthetic local, preview, and staging implementation.
It grants no production, payment, hard-assignment, migration, deployment, or
release authority and is not independent approval.

Implementation must still provide, without placing credentials, bearer tokens,
plaintext assertion tokens, or role passwords in source:

- the exact pairwise-distinct migration, API, worker, attester, `NOLOGIN`
  command-owner, `NOLOGIN` assertion-owner, and `NOLOGIN` finance-owner role
  identities for local, preview, and staging;
- the approved system that provisions those roles and distributes only each
  service's own credential through an approved secret reference;
- the implemented token-digest issuance and one-time consumption protocol;
- the sealed Work Order command family and complete alternate-writer
  disposition before direct DML is revoked;
- the reviewed function/table privilege matrix, live role/ACL readback, exact
  tests, and independent human approval.

`CREATE ROLE` is deliberately absent from ordinary application migrations.
Until the decision is implemented and the live readback report is `READY`, the
exact command function remains absent, the current direct-write path is a known
P1 release blocker, and no production deployment or money capability is
authorized.

## Actor-channel trace

`backend/src/trpc-context.ts` verifies Firebase, local-certification, or
deployed-synthetic bearer identity and resolves that identity to a named user.
The Universal V1 router passes only `ctx.user.id` to the Work Order application,
and `backend/src/services/UniversalV1WorkOrderPostgresRepository.ts` receives
only that UUID. PostgreSQL therefore cannot distinguish a UUID derived from a
verified request from the same UUID selected by code holding the runtime
credential. The existing transaction-local custom setting is writable by that
same runtime login and is explicitly insufficient.

This trace rules out silently treating request middleware as a database actor
protocol. An accepted design must deliver an assertion PostgreSQL can verify
without trusting a runtime-writable setting; until then, provisioning roles or
revoking table writes would strand the application behind a function that
cannot safely be authored.

## Completion-delivery service actor trace

Completion delivery now has two deliberately separate synthetic paths, but
neither closes this database-authority hold. The legacy migration-121 callback
authenticates exact raw request bytes with a callback-only HMAC and remains
available only for completion facts that have no migration-138 notice request.
Migration 138 makes the normal path asynchronous: completion submission
atomically creates one immutable request, one pending EMAIL row, and one pending
outbox event; the worker may call only the configured `smtp_sink`, then
materializes one exact request-bound `SYNTHETIC_SINK` delivery fact from the
persisted receipt. Configuration supplies the actor UUID, the service identity
is derived as `hustlexp.synthetic-communications-sink.v1:<actor-uuid>`, and the
pre-provider authority transaction requires an active, adult, non-banned actor,
the exact poster/scope/completion/execution, a current payment-frozen
`CONTROLLED_TEST` task, and no assignment.

SMTP final DATA `250` is the synthetic provider acceptance point; QUIT is
best-effort. Exact receipt replay converges without a second send. A crash after
DATA acceptance but before receipt persistence is conservatively terminalized
as `provider_outcome_unknown` unless a separately specified deterministic sink
lookup can prove the receipt; blind resend is forbidden. Pre-marker authority
revocation or a post-enqueue recipient opt-out terminally suppresses the notice.
Because suppression is not EMAIL delivery, approval remains unavailable and
only rejection or separately authorized manual/customer-seen recovery may
proceed—no delivery evidence is fabricated. Existing opt-out fails completion
submission before the request is created.

These are strong request, transport, and row-shape controls, not an independently
verifiable database service principal. The shared runtime login still performs
the append and materialization, and the current user schema does not distinguish
a provisioned service actor from an ordinary active user. Therefore neither the
HMAC callback nor the request-bound SMTP worker proves the required
least-privilege role, sealed command, direct-DML revocation, or database-verifiable
actor protocol. Both remain nonproduction synthetic review candidates under
this `AUTHORIZED_LOCAL_NONPROD_IMPLEMENTATION_PENDING /
RELEASE_BLOCKED_PENDING_IMPLEMENTATION_AND_INDEPENDENT_REVIEW` hold and grant no live
provider, assignment, private-address, payment, capture, settlement, payout, or
production capability.
