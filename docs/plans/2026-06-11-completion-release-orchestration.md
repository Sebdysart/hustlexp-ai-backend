# Completion → Release Orchestration (Happy-Path Payout)

**Date:** 2026-06-11 · **Status:** IMPLEMENTING · **Risk class:** FINANCIAL-CRITICAL

## Problem
No code path releases escrow when a task completes normally. `escrow.release` (poster) demands a
pre-existing `stripeTransferId` the mobile client cannot create; transfer creation exists only in
dispute (`escrow-action-worker`) and admin paths. Result: poster approves proof → task COMPLETED →
**money stuck in FUNDED forever** unless ops intervenes. This is the missing link of the beta gate
("payment/escrow/payout state is correct").

## Design (minimal-delta, reuses proven rails)
1. **`TaskService.complete`** (inside the existing SERIALIZABLE-equivalent tx, after the
   `PROOF_SUBMITTED→COMPLETED` UPDATE succeeds): look up the task's escrow. If `state='FUNDED'`
   **and** `tasks.payment_method` ∈ {NULL,'escrow'}: `writeToOutbox('escrow.completion_release_requested',
   {escrow_id, task_id, reason:'task_completed'}, queue critical_payments)` — transactional outbox ⇒
   task completion and release-request are atomic (INV-6). Any other escrow state or payment method ⇒
   no outbox row, structured log (ops-visible), completion unaffected.
2. **New worker `completion-release-worker.ts`** (new file; ZERO deltas to the dispute worker):
   - zod payload validation + HMAC `verifyJobSignature` (same defenses as dispute jobs)
   - TX1: `SELECT … FOR UPDATE` escrow; branch on state:
     `RELEASED` → idempotent no-op · `LOCKED_DISPUTE` → no-op (dispute machinery owns it) ·
     not `FUNDED` → CRITICAL log + no-op · else proceed. Verify task `COMPLETED` + `worker_id`.
   - Outside TX (Stripe is not transactional): if `stripe_transfer_id` absent →
     `computeFeeBreakdown(amount)` (unified fee+insurance module) → `StripeService.createTransfer`
     (`idempotencyKeySuffix:'completion_release'` — distinct from all other suffixes) →
     TX2 version-checked `FOR UPDATE NOWAIT` store of transfer_id (mirrors dispute worker T2).
   - Then **`EscrowService.release({escrowId, stripeTransferId})`** — the existing audited path does
     FUNDED→RELEASED (version-guarded, INV-7 double-release check in-tx), platform fee + insurance
     ledger, earnings unlock, XP auto-award (INV-2 ordering enforced by HX201 trigger).
   - Worker has NO direct revenue/insurance/XP writes — single source of truth stays `EscrowService.release`.
   - No Connect account → no-op + `notifyAdmins` (beta ops releases manually); NOT a retry loop.
   - Stripe account-restriction error → no-op + `notifyAdmins`, NOT retried; other Stripe errors → throw (BullMQ retry; replay resumes idempotently at the store/release step).
3. **`outbox-worker.ts`**: add event type to `FINANCIAL_EVENT_TYPES` (HMAC signing allowlist; now exported for test assert).
4. **`workers.ts`**: explicit route `escrow.completion_release_requested` → new worker.

## State-machine review (escrow-state-guard equivalent)
- Escrow: `PENDING→FUNDED→{RELEASED|REFUNDED|LOCKED_DISPUTE}`. This feature adds **no new states and
  no new transitions** — it only *triggers* the existing audited `FUNDED→RELEASED` transition.
- Task: no change. `COMPLETED` remains terminal; trigger `task_completed_requires_accepted_proof` (INV-3) untouched.
- Race: dispute filed between completion and job execution ⇒ escrow `LOCKED_DISPUTE` at TX1 ⇒ worker
  no-ops; dispute resolution path owns the money. No double-spend window: `EscrowService.release`
  re-checks state+version in its own FOR UPDATE tx.

## Invariant checklist
| INV | Protection |
|---|---|
| INV-1/5 (positive int cents) | amounts originate from `escrows.amount` (already validated); `computeFeeBreakdown` is the unified rounding module; no new arithmetic introduced |
| INV-2 (XP only after release) | XP awarded only inside `EscrowService.release` post-commit, gated by HX201 trigger — unchanged |
| INV-3 (release exactly once) | DB: UNIQUE `stripe_transfer_id` + version optimistic lock + `state='FUNDED'` WHERE-guard in release; worker: T2 `FOR UPDATE NOWAIT` + transfer-id idempotency + Stripe idempotency key |
| INV-4 (ledger append-only) | no ledger statements in new code |
| INV-6 (atomic + audit) | transactional outbox in same tx as COMPLETED update; `logEscrowEvent` inside `EscrowService.release` unchanged |
| INV-7 (double-release in-tx check) | enforced inside `EscrowService.release` (`state IN ('FUNDED','LOCKED_DISPUTE') AND version=$3`) — reused, not reimplemented |
| INV-8 (webhook idempotency) | untouched |

## Risk matrix
| Risk | P | Impact | Mitigation |
|---|---|---|---|
| Double transfer (job replay/race) | Low | CRITICAL | Stripe idempotency key (escrowId+amount+suffix) + T2 NOWAIT version check + transfer-id short-circuit; replay test |
| Release of disputed escrow | Low | CRITICAL | TX1 state branch no-ops on LOCKED_DISPUTE; test |
| Transfer created, release crash | Med | HIGH (money sent, state FUNDED) | BullMQ retry resumes: transfer-id present ⇒ skip Stripe ⇒ release only; replay test |
| Connect-less worker stuck | Med (beta) | MED | no-retry + notifyAdmins + ops force-release; Swift will gate accept on payout onboarding (client track) |
| Offline-payment task auto-released | Low | HIGH | payment_method gate at outbox-write AND worker double-checks; test |
| Regression in dispute path | — | CRITICAL | zero lines changed in escrow-action-worker; full suite must stay 6377/0 |

## DONE criteria
Red→green new tests; `vitest run` ≥6377 pass/0 fail; `tsc --noEmit` 0; `eslint . --max-warnings=0` 0; no new vitest excludes; this doc + verification evidence in final report.
