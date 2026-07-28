# EPIC-03 — Stripe test-mode certification (while prod stays frozen)

**Rule:** Keep production `HX_PAYMENT_CREATION_MODE=frozen`. Do **not** enable live creation.  
Use Stripe **test** mode + staging/fixture paths only.

## Preconditions

- [x] Production freeze still reported by `/health` → `paymentCreation.mode=frozen` (see `EPIC03_KILL_SWITCH_EVIDENCE.md`, 2026-07-27T09:03:27Z)
- [ ] Stripe Dashboard can switch to **Test mode**
- [ ] Test webhook endpoint(s) configured (or Stripe CLI forward) for the engine
- [x] Engine unit guard suite green (`payment-creation-incident-guard.test.ts`)
- [x] Site freeze dual-rail + PosterAuthorizePayment freeze behavior green

## Cases to prove (attach receipt IDs only — no secret keys)

| # | Case | Stripe test receipt / event ID | Engine escrow/task ID | Status |
| --- | --- | --- | --- | --- |
| 1 | Authorization / PaymentIntent create | | | |
| 2 | Confirm / capture success | | | |
| 3 | Customer refund | | | |
| 4 | Connect / payout path (test) | | | |
| 5 | Webhook replay (deliver same event twice) | | | |
| 6 | Card decline / failure | | | |
| 7 | Kill switch: freeze still blocks new money on prod `/health` | | | |

## Kill switch check (prod)

```text
GET https://hustlexp-ai-backend-production.up.railway.app/health
Expect: paymentCreation.mode = frozen, acceptsNewCustomerMoney = false
```

## Done for this slice

All seven rows filled **in test** + prod freeze still true.  
Live/bounded unfreeze is a **later** authority decision after Pro backups + legal gates.
