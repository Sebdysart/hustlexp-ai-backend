# Payment Certification Checklist (EPIC-03)

Payment creation remains **frozen** in production until every row below is `PROVEN` for the bounded cell/fixture and the kill switch is re-verified.

Guard: `backend/src/services/NewPaymentCreationGuard.ts`  
Live probe (session): `GET /health` → `paymentCreation.mode=frozen`, `acceptsNewCustomerMoney=false`.

## Provider receipts

| Case | Mode (test/live) | Provider receipt ID | Idempotency key | Engine escrow/task IDs | `/ops` agrees | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Authorization create | | | | | | |
| Authorization confirm / capture | | | | | | |
| Customer refund | | | | | | |
| Provider payout / Connect transfer | | | | | | |
| Webhook replay (duplicate delivery) | | | | | | |
| Provider failure / decline | | | | | | |
| Bank arrival (payout destination) | | | | | | |

## Freeze / kill switch

| Check | Command / evidence | Status |
| --- | --- | --- |
| Default production mode is frozen | `/health` paymentCreation | |
| Scoped enablement limited to approved cell/fixture | flag + policy hash | |
| Kill switch returns to frozen without deploy rewrite | evidence | |
| Bridge never returns `PAYMENT_INTENT_READY` while frozen | site reconcile suite | |
| Poster UX routes freeze to task-center recovery | `enginePaymentBlocker.ts` | |

## Explicit non-goals until bounded enablement

- Global `HX_PAYMENT_CREATION_MODE=enabled`
- Public acquisition into payment paths
- Counting fixture receipts as GMV
