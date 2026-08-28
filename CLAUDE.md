# HustleXP canonical backend — implementation instructions

For general repository instructions, see [AGENTS.md](AGENTS.md). Business meaning comes solely from the [HustleXP Business and Universal V1 Charter v1.1.0 at signed SHA `0b80c71e118d7cab70474bbbf6df778811fe4fe8`](https://github.com/Sebdysart/HUSTLEXP-DOCS/blob/0b80c71e118d7cab70474bbbf6df778811fe4fe8/governance/HUSTLEXP_BUSINESS_AND_UNIVERSAL_V1_CHARTER.md).

## Project boundary

This Node.js 22 backend uses Hono, tRPC, PostgreSQL, Redis, and BullMQ. It owns the canonical HustleXP TaskDraft, routing, estimate/scope, provider, Work Order, evidence, completion, financial-event, and reconciliation facts. Supabase is a contained acquisition/read overlay, not a competing lifecycle writer.

Production customer-money creation, hard assignment, real settlement/payout, database migration, and deployment remain held. No branch name, environment variable, green local run, or agent action can enable them.

## Required commands

- **Complete release test gate:** `npm run test:required` with the exact disposable loopback PostgreSQL/Redis identities. Any failed, skipped, pending, or todo test fails the gate.
- **Diagnostic tests:** `npm test`. This may conditionally omit database cohorts and is not release evidence.
- **Type check:** `npm run typecheck`
- **Lint:** `npm run lint -- --max-warnings=0`
- **Compile/build identity:** `npm run compile`
- **Single test file during development:** `npx vitest run backend/tests/<file>.test.ts`

Before presenting a candidate, run the complete required gate, typecheck, zero-warning lint, Build Validation contracts, security contracts, and `git diff --check`. Hosted checks and protected approvals must bind to the eventual exact signed SHA.

## Universal V1 invariants

### Truthful routing and providers

- Broad legitimate-work intake creates a privacy-safe TaskDraft before any opportunity or transaction state.
- Emergency and prohibited work fails closed.
- Routing ends in exactly one truthful outcome: fulfillment candidate, estimate required, manual sourcing, referral, waitlist, or decline.
- `GENERAL_SERVICE_PROVIDER` and `VERIFIED_TRADE_BUSINESS` are distinct first-class provider types.
- A trade qualification requires issuing authority, jurisdiction, license scope, status, expiry, evidence, verification time, and permitted work categories. Reputation or search ranking never substitutes for government credentials.

### Lifecycle separation

- Estimate, scope version, change order, provider interest, eligibility, conditional hold, Financial Security Event, Work Order, evidence, completion, capture, settlement, payout, and reconciliation are separate states and operations.
- Provider interest is not assignment. Eligibility is not acceptance. A conditional hold is not hard assignment.
- Authorization is not capture. Securing value is not capture. Capture is not settlement. Platform funding is not provider payout. Release is not bank settlement.
- Exact-address release and any future hard assignment require the separately approved lifecycle gates; both remain frozen in production.
- Use expected versions, HustleXP operation IDs, idempotency keys, immutable audit facts, inbox/outbox records, and database transactions for consequential mutations.

### Financial infrastructure

- Core domain code depends on provider-neutral ports. Processor identifiers and `stripe_*` fields are temporary compatibility projections, never canonical state.
- New-money effects resolve only through the capability policy, exact authenticated release manifest, approved environment, configured provider adapter, and runtime health proof. No single environment variable can enable them.
- Local, PR, and staging journeys use the deterministic database-backed fake provider. Ambient live provider credentials must be scrubbed or rejected.
- Every external webhook verifies authenticity, records an idempotent inbox fact, and reconciles provider observations without collapsing domain states.
- Refund/recovery for existing records is separately bounded from new-money creation.

### Operator and deployment authority

- Browsers never hold a shared administrator key. Consequential operations require named identity, MFA/step-up, scoped RBAC, expected-version commands, immutable audit, and two-person approval where specified.
- Runtime startup performs read-only migration attestation. Schema writes occur only through explicit, environment-approved migration commands.
- Production deployment is unavailable from this repository while the hold is active. Never add Git-push deployment, hidden provider activation, or a direct local-to-production path.

### Legacy compatibility safeguards

Existing escrow/payment tables retain defensive PostgreSQL invariants such as positive amounts, append-only ledgers, terminal-state protection, and single-release behavior. Preserve those guards while adapting callers to the Universal V1 lifecycle. Their names and legacy states do not make escrow or Stripe the business authority.

Other baseline rules remain blocking: parameterized database queries, Zod validation for typed inputs, circuit breakers for external calls, least-privilege authorization, no secret/PII logging, and atomic outbox/audit writes.

## Change protocol

1. Read the Charter, root README, controlling lifecycle contract, and exact code around the change.
2. Add a failing regression or contract test before changing behavior where practical.
3. Preserve append-only migrations and provider-neutral boundaries; do not weaken or delete tests to pass a gate.
4. Keep production effects frozen and record any legacy writer that remains contained.
5. Verify locally, then form one intentional signed candidate only with an approved signing identity.
6. Push through a PR; obtain every required hosted check, independent approval, last-push approval, and resolved conversation. Never infer merge authority from a branch name.

Mutable test counts, issue states, deployment metadata, and provider status are source-dated evidence. Regenerate them from the exact candidate instead of copying historical numbers forward.
