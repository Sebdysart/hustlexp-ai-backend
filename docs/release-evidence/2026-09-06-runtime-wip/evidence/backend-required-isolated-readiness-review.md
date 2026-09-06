# Full required readiness checkpoint

Completed 2026-09-06T20:44:11.102Z. Exit 1. **11034 passed, 24 failed, 15 skipped, 0 todo across 697 files. Gate FAIL.**

The isolated source snapshot is unchanged. This run includes the six reviewed readiness/runtime/incident-guard changes copied from the primary tree. Later primary preparation changes are excluded and require their own integration evidence. No commit, push, deployment or production effect is implied.

| File | Failed assertions | Skipped assertions | Failure evidence |
| --- | --- | --- | --- |
| backend/tests/system/hxos-canonical-lifecycle.pg.test.ts | 2 | 0 | Error: NONPRODUCTION_FAKE_FINANCE_REFUSED:LIVE_FAKE_FINANCE_SEALED_AUTHORITY_REQUIRED |
| backend/tests/system/prepared-financial-command-authority.pg.test.ts | 5 | 0 | AssertionError: expected [] to have a length of 6 but got +0; PreparedFinancialCommandAuthorityError: UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_ACTOR_ATTESTATION_REQUIRED |
| backend/tests/system/provider-observation-normalization.pg.test.ts | 1 | 0 | PreparedFinancialCommandAuthorityError: UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_ACTOR_ATTESTATION_REQUIRED |
| backend/tests/system/stage1-legacy-authority-containment.pg.test.ts | 1 | 0 | error: HXUV1-WOCMD-0A: Work Order trigger catalog mismatch (151 / f82f820234a2fd838b14d49734b3a29f2fce3b0ed1b9cf782a8ac874ab2941c4) |
| backend/tests/system/universal-v1-estimate-materialization.pg.test.ts | 13 | 0 | Error: WORK_ORDER_HISTORY_UNAVAILABLE; Error: expected Error: WORK_ORDER_HISTORY_UNAVAILABLE to match object { code: 'XX999', …(1) }; Error: expected Error: WORK_ORDER_HISTORY_UNAVAILABLE to match object { Object (code) }; error: HXFPCREC1-V13: DISPATCH requires one same-transaction sealed v13 admission |
| backend/tests/system/universal-v1-financial-security-expiry.pg.test.ts | 2 | 0 | PreparedFinancialCommandAuthorityError: UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_ACTOR_ATTESTATION_REQUIRED |
| backend/tests/system/universal-v1-work-order-command-ports-v1.pg.test.ts | 0 | 15 | Setup failure; inspect the archived full log |

Exact JSON report: [archived report](backend-required-isolated-readiness-vitest.json). Full log: [archived log](backend-required-isolated-readiness.log). Failure register and hashes: [receipt](backend-required-isolated-readiness-failures.json).
