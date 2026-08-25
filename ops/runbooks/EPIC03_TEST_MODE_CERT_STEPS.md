> Documentation status: `HISTORICAL_EVIDENCE / LEGACY_STRIPE_TEST_ONLY`
>
> This body and its receipt references are preserved verbatim. They prove only the recorded legacy Stripe test boundary and cannot authorize a processor, sandbox rerun, payment enablement, or production claim.

# EPIC-03 — Stripe test-mode certification (while prod stays frozen)

**Rule:** Keep production `HX_PAYMENT_CREATION_MODE=frozen`. Do **not** enable live creation.  
Use Stripe **Test mode** + staging/fixture paths only.

## Preconditions

- [x] Production freeze still reported by `/health` → `paymentCreation.mode=frozen` (see `EPIC03_KILL_SWITCH_EVIDENCE.md`, 2026-07-31T08:48:50Z)
- [x] Stripe Dashboard **Test mode** + local `.env.epic03.local` (`sk_test_…`, gitignored)
- [x] Stripe CLI webhook replay via `npm run verify:epic03-webhook-replay`
- [x] Engine unit guard suite green (`payment-creation-incident-guard.test.ts`)
- [x] Site freeze dual-rail + PosterAuthorizePayment freeze behavior green
- [x] Webhook idempotency unit suite green (`stripe-webhook-branches.test.ts`)

## Fast path (preferred)

```powershell
cd D:\projects\hustlexp-ai-backend
copy .env.epic03.local.example .env.epic03.local
# Edit .env.epic03.local — put your Stripe Test secret (sk_test_…)
npm run verify:epic03-stripe-test
```

Writes receipt IDs to `ops/runbooks/EPIC03_TEST_MODE_RECEIPTS.json` (IDs only; no secrets).  
Exit codes: `0` all seven PROVEN · `3` partial (OPEN/PARTIAL remain) · `1` FAILED · `2` missing/wrong key.

## Cases to prove (attach receipt IDs only — no secret keys)

| # | Case | Stripe test receipt / event ID | Engine escrow/task ID | Status |
| --- | --- | --- | --- | --- |
| 1 | Authorization / PaymentIntent create | `pi_3TzDmh97UdWM2cEw0BrqqrqV` | n/a (Stripe API cert) | PROVEN |
| 2 | Confirm / capture success | charge `ch_3TzDmh97UdWM2cEw0DXYqTO5` | n/a | PROVEN |
| 3 | Customer refund | `re_3TzDmh97UdWM2cEw0FaWqs15` | n/a | PROVEN |
| 4 | Connect / payout path (test) | Express `acct_1TzCeu7BxLRGjXMY` + dest PI `pi_3TzDmm97UdWM2cEw1zvlyhrT` / `ch_3TzDmm97UdWM2cEw1ngoTfU4` | n/a | PROVEN |
| 5 | Webhook replay (deliver same event twice) | `evt_3TzDtM97UdWM2cEw1PvHp5ud` (3 deliveries, 1 store + 2 dup acks) | see `EPIC03_WEBHOOK_REPLAY_EVIDENCE.json` | PROVEN |
| 6 | Card decline / failure | `pi_3TzDmi97UdWM2cEw1q6FbjYt` (`card_declined`) | n/a | PROVEN |
| 7 | Kill switch: freeze still blocks new money on prod `/health` | health @ 2026-07-31T10:35:22Z | n/a | PROVEN |

After the runner succeeds for 1–4 + 6, copy IDs from `EPIC03_TEST_MODE_RECEIPTS.json` into this table and into `PAYMENT_CERTIFICATION_CHECKLIST.md`.

## Case 5 — webhook replay (CLI)

```powershell
# Install Stripe CLI if needed, then:
stripe login
stripe listen --forward-to http://localhost:5000/webhooks/stripe
# separate terminal: run engine locally with test webhook secret from CLI
stripe trigger payment_intent.succeeded
stripe events resend <EVENT_ID>
stripe events resend <EVENT_ID>
npx tsx scripts/step1-check-results.ts
```

Alternate: use Dashboard → Developers → Events → Resend twice against the test endpoint.

## Kill switch check (prod)

```text
GET https://hustlexp-ai-backend-production.up.railway.app/health
Expect: paymentCreation.mode = frozen, acceptsNewCustomerMoney = false
```

## Done for this slice

All seven rows filled **in test** + prod freeze still true.  
Live/bounded unfreeze is a **later** authority decision after Pro backups + legal gates.
