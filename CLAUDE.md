# HustleXP backend implementation instructions

Production launch: `NO-GO`

[AGENTS.md](AGENTS.md) is the binding workflow and release contract. This file adds implementation-level review rules; it does not grant Governor, provider, migration, merge, deployment, or production authority.

## Runtime shape

The backend is Node.js 22, TypeScript, Hono, tRPC, BullMQ, Redis, and PostgreSQL. Railway PostgreSQL is canonical. The web and worker processes are separate service roles built from one exact source/image identity.

## Commands

```sh
npm run typecheck
npm run lint -- --max-warnings 0
npm test -- --maxWorkers=1
npm run compile
npm audit --omit=dev --audit-level=high
git diff --check
```

Run focused tests while iterating, but do not substitute them for the protected full matrix. Do not inject a dummy global `DATABASE_URL`; no-database skips must remain visible. PostgreSQL trigger, migration, role, replay, and recovery claims require the CI PostgreSQL harness.

## Non-negotiable invariants

- New production payment, account, onboarding-link, payout, or other positive processor creation must fail before external and canonical database effects.
- A future money-creation design is task-first and processor-neutral. A successful PaymentIntent is never authority to create the canonical task.
- Preserve negative/recovery lanes: refund, void, cancellation, dispute, restriction, webhook replay, reconciliation, and kill-switch behavior.
- Financial amounts are integer cents. Shared money helpers own fee math; fee, insurance, and provider net must reconcile exactly to gross.
- Terminal task, escrow, ledger, audit, and outbox facts are protected by PostgreSQL constraints/triggers and typed services. Never mutate them through ad hoc SQL or arbitrary status values.
- Refund creation requires one immutable escrow-scoped pre-provider claim, a database-clock replay deadline, exact provider metadata discovery after the safe window, an exact succeeded witness, and claim-bound terminalization.
- Outbox database identity is the durable `_outbox_key`; BullMQ identity is `outboxTransportJobId(_outbox_key)`. Validate the mapping and required signature before claim, dispatch, or ACK.
- Webhooks verify the correct destination signature, normalize once, claim with a token-fenced lease, process idempotently, and ACK durable outbox rows only after exact terminal inbox evidence.
- Operations endpoints use authenticated, role-scoped `opsProcedure` or `opsSensitiveProcedure`, typed commands, expected versions, reason codes, step-up where required, and immutable actor-attributed audit events.
- Use parameterized SQL, shared provider clients, circuit breakers, and explicit transaction boundaries. Do not instantiate Stripe or AI clients ad hoc.

## Review protocol

1. Establish the exact base, active Governor node, and allowed path set.
2. Write or preserve a hostile test that demonstrates the failure mode.
3. Implement the smallest runtime-connected correction without weakening assertions.
4. Verify focused behavior, full typecheck, zero-warning lint, compile, full tests, migration harnesses, audit, and whitespace.
5. Obtain fresh independent review of the exact final tree. A builder or author cannot provide independent proof.
6. Publish only through signed commits, protected checks, resolved threads, and exact-final-push approval.

Test counts, coverage percentages, dependency versions, SHAs, deployments, and alert counts are mutable evidence. Never hard-code them here; record source-dated observations in [the current checkpoint](docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md).
