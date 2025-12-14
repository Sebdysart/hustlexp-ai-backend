# FINANCIAL KERNEL LOCK

**Status: FROZEN**  
**Locked: 2025-12-14**  
**Certification: Phase 10 - All 9 Tests PASS**

---

## Frozen Files

Any modification to these files requires:
1. Manual approval from project lead
2. Full crash test suite re-run
3. Phase 10 re-certification

### Core Money Flow
- `src/services/ledger/LedgerService.ts`
- `src/services/ledger/LedgerGuardService.ts`
- `src/services/ledger/LedgerLockService.ts`
- `src/services/StripeMoneyEngine.ts`

### Recovery & Safety
- `src/infra/recovery/RecoveryEngine.ts`
- `src/infra/recovery/PendingReaper.ts`
- `src/infra/recovery/DLQProcessor.ts`
- `src/infra/recovery/BackfillService.ts`

### Ordering & Guards
- `src/infra/ordering/TemporalGuard.ts`
- `src/infra/ordering/OrderingGate.ts`
- `src/infra/KillSwitch.ts`

### Schema (Money Tables)
- `ledger_transactions`
- `ledger_entries`
- `ledger_accounts`
- `ledger_locks`
- `money_state_lock`
- `money_events_audit`
- `stripe_outbound_log`
- `killswitch`

---

## Certification Evidence

| Test | Status | Artifact |
|------|--------|----------|
| Crash Test #1 (Pre-Stripe) | PASS | Pending reaper cleans orphans |
| Crash Test #2 (Post-Stripe) | PASS | Recovery commits from Stripe evidence |
| A1 Acceptance Storm (200) | PASS | 1 winner, 199 rejected |
| A2 Cancel/Accept Thrash | PASS | 89 cycles stable |
| A3 Retry Storm (100) | PASS | 1 completion |
| B1 Admin Force Refund | PASS | Zero-sum preserved |
| B2 Admin Force Payout | PASS | 1 Stripe transfer |
| B3 KillSwitch Drill | PASS | Ops blocked/resumed |
| C1 Money Truth Check | PASS | Drift = $0.00 |
| C2 Incident Readiness | PASS | 502ms query |
| C3 Pause Safety | PASS | Safe to unpause |

---

## Breaking the Lock

To modify frozen files:

```bash
# 1. Create branch with KERNEL- prefix
git checkout -b KERNEL-fix-description

# 2. Make changes

# 3. Run full crash test suite
npm run test:crash

# 4. Run Phase 10 suite
npm run test:phase10

# 5. All tests must PASS

# 6. PR requires explicit approval with justification
```

---

## Why This Lock Exists

These files represent **proven financial correctness**.

- Money cannot be lost
- Money cannot be duplicated  
- Ledger cannot corrupt
- Recovery is deterministic
- Operators cannot accidentally break invariants

Changing them without re-certification introduces **unknown risk**.

The kernel is **read-only** unless a production incident forces a patch.
