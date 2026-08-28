# HustleXP Universal V1 review rules

Business authority is the HustleXP Business and Universal V1 Charter v1.1.0 at signed SHA `0b80c71e118d7cab70474bbbf6df778811fe4fe8`. Review repository code against that authority and the exact candidate; never infer current truth from historical counts or deployment receipts.

## Blocking lifecycle rules

1. A privacy-safe TaskDraft and emergency/prohibited screening precede fulfillment or transaction state.
2. Routing must produce one truthful outcome: fulfillment candidate, estimate required, manual sourcing, referral, waitlist, or decline.
3. Estimate, scope version, change order, provider interest, eligibility, conditional hold, Financial Security Event, Work Order, evidence, completion, capture, settlement, payout, and reconciliation remain distinct.
4. Interest is not assignment; authorization is not capture; release is not bank settlement.
5. `VERIFIED_TRADE_BUSINESS` eligibility requires current issuing-authority evidence for the jurisdiction, scope, and permitted category. Reputation is not credential evidence.
6. Production customer-money creation, hard assignment, real settlement/payout, production migration, and deployment are deny-by-default and currently frozen.

Flag as critical any change that collapses these states, invents fulfillment, exposes exact location early, treats a processor field as domain authority, or permits one flag/secret to enable a positive money effect.

## Financial and database rules

- Domain services use provider-neutral financial ports, HustleXP operation IDs, idempotency keys, expected versions, external references, and provider kinds.
- Webhook handlers verify authenticity, persist idempotent inbox facts, and reconcile without treating delivery order as state authority.
- Consequential mutations use transactions, row/version guards where applicable, immutable audit facts, and outbox delivery.
- Legacy positive-amount, append-only ledger, terminal-state, and single-release PostgreSQL guards remain blocking compatibility safeguards. Do not weaken or bypass them while migrating away from legacy escrow/Stripe semantics.
- Migrations are append-only. API and worker startup may attest checksums but may not write schema.

## Security and operator rules

- No browser-pasted shared admin keys, service-role material, passwords, tokens, API keys, full payment details, or unnecessary PII in clients or logs.
- Consequential operations require named identity, MFA/step-up, scoped RBAC, expected-version commands, immutable audit, and required two-person approval.
- Public endpoints require typed validation, rate limiting where appropriate, and fail-closed authorization.
- Database queries use parameters; external calls use the approved adapter/circuit-breaker boundary; AI calls use the governed router and deterministic nonproduction mode where required.

## Release rules

- Do not approve deleted, weakened, skipped, or todo tests as a fix.
- Required evidence is TypeScript zero errors, lint zero warnings, complete Vitest zero failures/skip/todo, security audit, dependency review, CodeQL, Build Validation, and the remaining exact ruleset context on the same signed SHA.
- A branch name never authorizes auto-merge. Require independent approval, last-push approval, resolved conversations, linear history, exact signed provenance, and no bypass.
- Production deployment and money capability remain held unless a separate explicit release decision proves the complete signed manifest and environment gates.
