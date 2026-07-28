# EPIC-03 — Payment unfreeze gate

**Current production:** `paymentCreation.mode=frozen` (session `/health` 2026-07-27)

## In-repo controls

- `backend/src/services/NewPaymentCreationGuard.ts`
- `ops/runbooks/PAYMENT_CERTIFICATION_CHECKLIST.md`

## Unfreeze rule (non-negotiable)

1. Complete every receipt row in the certification checklist (test, then bounded live fixture).
2. Prove kill switch returns to frozen without rewriting unrelated config.
3. Enable only for an approved cell/fixture — never global enablement as first step.
4. Site bridge must continue to refuse `PAYMENT_INTENT_READY` while frozen (reconcile suite).
5. Refresh site current-state artifact after any mode change.

## Explicit hold

Do not set production payment creation to enabled from this engineering session without completed checklist receipts attached.
