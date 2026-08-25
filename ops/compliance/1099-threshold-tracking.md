# Information-reporting decision and data requirements

Status: `PROPOSED_NOT_BUILT / COUNSEL_AND_PROCESSOR_DECISION_REQUIRED`

Production effects authorized: `NONE`

This document is not legal or tax advice and intentionally contains no threshold, TPSO classification, form assignment, payout block, or filing instruction. Those depend on current law, the executed processor/account model, merchant-of-record and funds-flow decisions, provider classification, jurisdictions, tax year, and contractual responsibility.

## Written decisions required

Qualified counsel, tax advisors, and the approved processor must identify:

1. which entity is responsible for each information return and recipient statement;
2. applicable federal, state, and local forms, thresholds, aggregation rules, and deadlines by tax year;
3. whether the processor, HustleXP, or another party collects tax identity and performs filing/delivery;
4. correction, mismatch, backup-withholding, account restriction, appeal, and support procedures;
5. privacy, encryption, access, retention, deletion, legal-hold, and breach obligations;
6. provider communications that are legally accurate and do not misstate earnings or withholding;
7. sandbox and production evidence required before any automated restriction or filing.

## Target data contract

The canonical backend must retain immutable, reconcilable economic facts without deriving legal conclusions:

- provider/legal entity and jurisdiction identifiers;
- transaction occurrence and relationship origin;
- captured, refunded, disputed, reversed, settled, funded, paid, returned, and reconciled amounts as separate facts;
- processor account and payout evidence;
- fees, adjustments, withholding where legally authorized, and corrections;
- tax-policy/version witness and source period;
- filed-form, delivery, correction, acknowledgement, and support-case references;
- actor, approval, idempotency, and immutable audit results.

Do not aggregate legacy `RELEASED escrow` rows as payout or reportable-income truth. Reconciliation across canonical operations, processor statements, bank movements, and approved tax rules is required.

## Gate

**Done Criteria:** Written responsibility and current threshold decisions exist for the exact model/year/jurisdictions; canonical data reconciles; privacy/security controls and correction/support procedures pass; an independent reviewer accepts the implementation.

**Test Plan:** Vary tax year, state, provider entity type, refund/chargeback timing, returned payout, and processor responsibility. The system must select an approved versioned rule or fail closed—never reuse a hard-coded stale threshold.

See [the Team Goal and Execution Contract](../../docs/HUSTLEXP_TEAM_ALIGNMENT.md) and `production-legal-approval-handoff.md`.
