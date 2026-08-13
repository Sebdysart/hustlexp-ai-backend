# Payment Certification Checklist (EPIC-03)

Payment creation remains **frozen** in production until every row below is `PROVEN` for the bounded cell/fixture and the kill switch is re-verified.

Guard: `backend/src/services/NewPaymentCreationGuard.ts`  
Live probe (session): `GET /health` → `paymentCreation.mode=frozen`, `acceptsNewCustomerMoney=false`.

## Provider receipts

| Case | Mode (test/live) | Provider receipt ID | Idempotency key | Engine escrow/task IDs | `/ops` agrees | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Authorization create | test | `pi_3TzDmh97UdWM2cEw0BrqqrqV` | epic03_*_auth | n/a (API cert) | n/a | PROVEN |
| Authorization confirm / capture | test | `ch_3TzDmh97UdWM2cEw0DXYqTO5` | epic03_*_capture | n/a | n/a | PROVEN |
| Customer refund | test | `re_3TzDmh97UdWM2cEw0FaWqs15` | epic03_*_refund | n/a | n/a | PROVEN |
| Provider payout / Connect transfer | test | `acct_1TzCeu7BxLRGjXMY` / `pi_3TzDmm97UdWM2cEw1zvlyhrT` | epic03_*_dest_pi | n/a | n/a | PROVEN |
| Webhook replay (duplicate delivery) | test | `evt_3TzDtM97UdWM2cEw1PvHp5ud` | CLI resend ×2 | idempotent (1 store / 2 dup acks) | n/a | PROVEN |
| Provider failure / decline | test | `pi_3TzDmi97UdWM2cEw1q6FbjYt` | epic03_*_decline | n/a | n/a | PROVEN |
| Bank arrival (payout destination) | test | | | | | OPEN |

## Freeze / kill switch

| Check | Command / evidence | Status |
| --- | --- | --- |
| Default production mode is frozen | `/health` paymentCreation @ 2026-07-31T08:48:50Z | PROVEN |
| Scoped enablement limited to approved cell/fixture | flag + policy hash | OPEN |
| Kill switch returns to frozen without deploy rewrite | evidence | OPEN |
| Bridge never returns `PAYMENT_INTENT_READY` while frozen | site `paymentFreezeDualRailReconcile.test.ts` | PROVEN |
| Poster UX routes freeze to task-center recovery | `enginePaymentBlocker.ts` | PROVEN |

## Explicit non-goals until bounded enablement

- Global `HX_PAYMENT_CREATION_MODE=enabled`
- Public acquisition into payment paths
- Counting fixture receipts as GMV
