# Phase 0.2A: Database Enforcement — Execution Instructions

## Files Created

| File | Purpose |
|------|---------|
| `migrations/001_constitutional_enforcement.sql` | Database triggers + constraints |
| `migrations/001_verification_queries.sql` | Verification queries |
| `migrations/001_rollback.sql` | Rollback script (if needed) |
| `src/services/AtomicXPService.ts` | XP award with BUILD_GUIDE formulas |
| `tests/AtomicXPService.test.ts` | Unit tests for XP formulas |

---

## Step 1: Install Missing Dependency

```bash
cd /Users/sebastiandysart/HustleXP/hustlexp-ai-backend
npm install decimal.js
```

---

## Step 2: Apply Database Migration

Connect to your Neon database and run:

```bash
# Option A: Using psql
psql $DATABASE_URL -f migrations/001_constitutional_enforcement.sql

# Option B: Using Neon console
# Copy contents of 001_constitutional_enforcement.sql
# Paste into Neon SQL Editor
# Execute
```

---

## Step 3: Verify Migration

Run the verification queries:

```bash
psql $DATABASE_URL -f migrations/001_verification_queries.sql
```

**Expected Results:**
- 6 triggers should exist
- 2 constraints should exist
- All verification queries should return 0 problematic rows

---

## Step 4: Run Tests

```bash
npm run test -- tests/AtomicXPService.test.ts
```

**Expected:** All tests pass

---

## Step 5: Test Trigger Protection

Uncomment the test queries in `001_verification_queries.sql` and verify they FAIL:

```sql
-- This should fail with: INV-TERMINAL: Cannot modify task in terminal state
BEGIN;
UPDATE tasks SET title = 'HACKED' WHERE status = 'completed' LIMIT 1;
ROLLBACK;
```

---

## What This Migration Adds

### Triggers (6)

| Trigger | Table | Purpose |
|---------|-------|---------|
| `task_terminal_guard` | `tasks` | Blocks updates to completed/cancelled/expired tasks |
| `escrow_terminal_guard` | `escrow_holds` | Blocks updates to released/refunded escrows |
| `escrow_amount_immutable` | `escrow_holds` | Prevents amount changes |
| `badge_no_delete` | `badges` | Append-only enforcement |
| `xp_no_delete` | `xp_events` | Append-only enforcement |
| `trust_ledger_no_delete` | `trust_ledger` | Append-only enforcement |

### Constraints (2)

| Constraint | Table | Purpose |
|------------|-------|---------|
| `xp_events_escrow_id_unique` | `xp_events` | INV-5: One XP per escrow |
| `trust_tier_bounds` | `users` | Trust tier 1-4 only |

### New Columns (2)

| Column | Table | Purpose |
|--------|-------|---------|
| `escrow_id` | `xp_events` | Link XP to escrow (not task) |
| `trust_tier` | `users` | 4-tier trust system |

### New Tables (2)

| Table | Purpose |
|-------|---------|
| `trust_ledger` | Audit log for trust changes |
| `admin_roles` | Formal admin authority matrix |

---

## Rollback (If Needed)

```bash
psql $DATABASE_URL -f migrations/001_rollback.sql
```

**WARNING:** This removes constitutional protection. Only use if migration causes issues.

---

## Next Steps

After verification passes:

1. **Update GamificationService** to use `AtomicXPService.awardXPForEscrow()` instead of current XP logic
2. **Update StripeMoneyEngine** to call `releaseEscrowWithXP()` instead of separate operations
3. Proceed to **Phase 0.2B: Business Logic Fixes**

---

## Invariants Now Enforced at Database Level

| Invariant | Enforcement |
|-----------|-------------|
| AUDIT-4 | Terminal state triggers |
| INV-4 | Escrow amount immutable trigger |
| INV-5 | XP escrow_id UNIQUE constraint |
| INV-BADGE-2 | Badge delete trigger |
| INV-TRUST-3 | Trust ledger append-only |

---

**Status:** Ready for execution. Say "done" after completing steps 1-5.
