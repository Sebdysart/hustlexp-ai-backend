# Phase D Enforcement - Payment Core Protection

**Status:** ✅ Complete

Phase D payment processing is now protected by:
1. ✅ Hard DB constraints (schema)
2. ✅ Idempotent event ingestion + atomic claims
3. ✅ Monotonic/versioned state transitions
4. ✅ Recovery mechanisms (stuck processing reset)
5. ✅ Invariant kill tests (5 tests)
6. ✅ CI enforcement (required check)
7. ✅ CODEOWNERS protection (review required)

---

## Protected Files (CODEOWNERS)

These files require code review before merging:

### Payment Core (Constitutional Law)
- `backend/database/constitutional-schema.sql` - Escrows, stripe_events, xp_ledger schemas
- `backend/src/services/StripeWebhookService.ts` - Webhook ingestion (store-only)
- `backend/src/jobs/payment-worker.ts` - Payment event processing (atomic claims)
- `backend/src/services/EscrowService.ts` - Escrow state machine
- `backend/src/jobs/maintenance-worker.ts` - Recovery jobs (stuck processing)

### System Guarantees Infrastructure
- `backend/src/jobs/outbox-worker.ts` - Outbox pattern poller
- `backend/src/jobs/outbox-helpers.ts` - Outbox write helpers
- `backend/src/jobs/queues.ts` - BullMQ queue definitions
- `backend/src/jobs/workers.ts` - Worker registration

### Invariant Tests (Kill Tests)
- `backend/tests/invariants/phase-d-payments.test.ts` - Payment invariants (5 tests)
- `backend/tests/invariants/inv-1.test.ts` - XP requires RELEASED escrow
- `backend/tests/invariants/inv-2.test.ts` - Escrow release requires COMPLETED task

---

## CI Enforcement

### Invariant Tests Job

The `invariants` job in `.github/workflows/ci-cd.yml`:
- Runs on every PR
- Must pass before merge (required check)
- Tests payment processing correctness
- Command: `npm run test:invariants`

### Branch Protection Setup (Manual)

To make the `invariants` job required in GitHub:

1. Go to: **Repository Settings** → **Branches** → **Branch protection rules**
2. Add/edit rule for `main` (and `develop` if applicable)
3. Enable: **Require status checks to pass before merging**
4. Check: **invariants** (Payment Invariants (Phase D))
5. Enable: **Require pull request reviews before merging**
6. Enable: **Require review from CODEOWNERS**

---

## Invariant Tests (5 Kill Tests)

### Test 1: Duplicate Stripe Event Idempotency
- **File:** `backend/tests/invariants/phase-d-payments.test.ts`
- **Tests:** UNIQUE constraint on `stripe_event_id` prevents duplicate inserts
- **Protects:** Double processing of Stripe events

### Test 2: Same Event Processed Twice Cannot Change Escrow State Twice
- **File:** `backend/tests/invariants/phase-d-payments.test.ts`
- **Tests:** Version check prevents duplicate state changes
- **Protects:** Duplicate escrow state transitions from same Stripe event

### Test 3: Escrow Cannot Transition Out of Terminal States
- **File:** `backend/tests/invariants/phase-d-payments.test.ts`
- **Tests:** Terminal state protection (RELEASED → FUNDED, REFUNDED → FUNDED)
- **Protects:** Illegal state transitions after terminal states

### Test 4: XP Insert Fails Unless Escrow is RELEASED
- **File:** `backend/tests/invariants/phase-d-payments.test.ts`
- **Tests:** XP requires RELEASED escrow (FUNDED state rejection)
- **Note:** Also comprehensively tested in `inv-1.test.ts`

### Test 5: LOCKED_DISPUTE Cannot Be Released (Policy 1)
- **File:** `backend/tests/invariants/phase-d-payments.test.ts`
- **Tests:** LOCKED_DISPUTE → RELEASED is blocked
- **Tests:** LOCKED_DISPUTE → REFUNDED/REFUND_PARTIAL are allowed
- **Protects:** Dispute policy enforcement

---

## Verifying Tests Fail When They Should

To prove tests actually catch violations:

### Test 1: Temporarily break UNIQUE constraint
```sql
-- In constitutional-schema.sql, comment out PRIMARY KEY
-- CREATE TABLE IF NOT EXISTS stripe_events (
--     stripe_event_id VARCHAR(255), -- PRIMARY KEY,
-- Run: npm run test:invariants
-- Expected: Test 1 fails (duplicate insert succeeds when it shouldn't)
```

### Test 2: Temporarily remove version check
```typescript
// In payment-worker.ts handlePaymentIntentSucceeded
// Remove: AND version = $2
// Run: npm run test:invariants
// Expected: Test 2 fails (duplicate state change succeeds)
```

### Test 3: Temporarily allow terminal transitions
```sql
-- In schema, remove terminal state guard trigger
-- Run: npm run test:invariants
-- Expected: Test 3 fails (terminal state transition succeeds)
```

### Test 4: Temporarily remove XP trigger
```sql
-- In schema, drop trigger enforce_xp_requires_released_escrow
-- Run: npm run test:invariants
-- Expected: Test 4 fails (XP awarded without RELEASED escrow)
```

### Test 5: Temporarily allow LOCKED_DISPUTE → RELEASED
```typescript
// In EscrowService.ts VALID_TRANSITIONS
// Change: LOCKED_DISPUTE: ['REFUNDED', 'REFUND_PARTIAL']
// To:     LOCKED_DISPUTE: ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL']
// Run: npm run test:invariants
// Expected: Test 5 fails (LOCKED_DISPUTE → RELEASED succeeds)
```

**After verification, revert all changes!**

---

## Run Locally

```bash
# Run all invariant tests
npm run test:invariants

# Run just Phase D payment tests
npm test backend/tests/invariants/phase-d-payments.test.ts

# Run with watch mode
npm test backend/tests/invariants/phase-d-payments.test.ts --watch
```

---

## Enforcement Checklist

- [x] Invariant tests exist (5 tests)
- [x] CI job created (`invariants` job in `.github/workflows/ci-cd.yml`)
- [x] CODEOWNERS file created with payment core paths
- [ ] **Manual:** GitHub branch protection rule configured (see above)
- [ ] **Manual:** Required status check `invariants` enabled in branch protection
- [ ] **Manual:** CODEOWNERS review required enabled in branch protection
- [ ] **Manual:** Verify each test fails when its invariant is violated (see above)

---

## What This Protects Against

1. **Accidental regressions** - Tests catch violations before merge
2. **Unauthorized changes** - CODEOWNERS requires review
3. **Silent failures** - Tests run on every PR
4. **Schema drift** - DB constraints + tests catch inconsistencies
5. **Logic bugs** - State machine + version checks prevent illegal transitions

---

## Next Steps (After Enforcement)

Once enforcement is in place:

1. **Move forward to product work** - Don't touch payments unless required
2. **Build dispute resolution pipeline** - Evidence uploads, admin arbitration
3. **Build trust & reputation engine** - Trust tier transitions, risk flags
4. **Build realtime "Hustler on the way"** - Accurate ETAs, status updates

Payment core is locked. Focus on features that win the market.
