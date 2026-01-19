# Phase D Payment Invariants - Verification Guide

## Purpose

This document describes how to verify that the 5 Phase D payment invariant tests correctly fail when their constraints are violated.

## Prerequisites

- Database connection configured (`DATABASE_URL`)
- Test database available (recommended: use a test/staging database)
- Node.js 20+ installed
- Dependencies installed (`npm ci`)

## Running the Tests

```bash
# Run all invariant tests
npm run test:invariants

# Run only Phase D payment tests
npm run test:invariants -- phase-d-payments.test.ts
```

## Test Verification Matrix

Each test should **FAIL** when the constraint it protects is violated. The verification process involves:

1. **Run the test normally** → Should PASS (constraint enforced)
2. **Temporarily disable the constraint** → Test should FAIL (proves test works)
3. **Re-enable the constraint** → Test should PASS again

### Test 1: Duplicate Stripe Event Idempotency

**What it protects:** UNIQUE constraint on `stripe_events.stripe_event_id`

**How to verify it fails:**
1. Temporarily remove the PRIMARY KEY constraint on `stripe_events.stripe_event_id`
2. Run the test → Should fail (duplicate insert should succeed, test expects it to fail)
3. Restore the PRIMARY KEY constraint

**Expected behavior:**
- ✅ Test PASSES when UNIQUE constraint exists (duplicate insert fails)
- ❌ Test FAILS when UNIQUE constraint is removed (duplicate insert succeeds)

### Test 2: Escrow Version Check Prevents Duplicate State Changes

**What it protects:** Optimistic locking via `version` column

**How to verify it fails:**
1. Temporarily remove the version check from the UPDATE query
2. Run the test → Should fail (second update should succeed, test expects it to fail)
3. Restore the version check

**Expected behavior:**
- ✅ Test PASSES when version check exists (second update fails, `rowCount === 0`)
- ❌ Test FAILS when version check is removed (second update succeeds, `rowCount > 0`)

### Test 3: Terminal State Protection

**What it protects:** Database trigger preventing transitions from terminal states

**How to verify it fails:**
1. Temporarily disable the terminal state trigger (`escrow_terminal_state_guard`)
2. Run the test → Should fail (RELEASED → FUNDED should succeed, test expects it to fail)
3. Re-enable the trigger

**Expected behavior:**
- ✅ Test PASSES when trigger exists (transition fails with error code 'HX002')
- ❌ Test FAILS when trigger is disabled (transition succeeds)

### Test 4: XP Requires RELEASED Escrow

**What it protects:** Database trigger preventing XP award unless escrow is RELEASED

**How to verify it fails:**
1. Temporarily disable the XP trigger (`xp_requires_released_escrow`)
2. Run the test → Should fail (XP insert should succeed, test expects it to fail)
3. Re-enable the trigger

**Expected behavior:**
- ✅ Test PASSES when trigger exists (XP insert fails with error code 'HX101')
- ❌ Test FAILS when trigger is disabled (XP insert succeeds)

### Test 5: LOCKED_DISPUTE Cannot Transition to RELEASED

**What it protects:** State machine constraint preventing LOCKED_DISPUTE → RELEASED

**How to verify it fails:**
1. Temporarily allow LOCKED_DISPUTE → RELEASED in the state machine
2. Run the test → Should fail (transition should succeed, test expects it to fail)
3. Restore the state machine constraint

**Expected behavior:**
- ✅ Test PASSES when constraint exists (transition fails with error code 'HX002')
- ❌ Test FAILS when constraint is removed (transition succeeds)

## Automated Verification Script (Optional)

For automated verification, you can create a script that:

1. Runs each test normally (baseline)
2. Temporarily disables the constraint
3. Runs the test again (should fail)
4. Restores the constraint
5. Runs the test again (should pass)

**Note:** This requires careful manipulation of database constraints/triggers and should only be run in a test environment.

## CI Verification

The CI workflow (`.github/workflows/ci-cd.yml`) runs these tests on every PR:

```yaml
invariants:
  name: Payment Invariants (Phase D)
  needs: lint
  steps:
    - name: Run payment invariant tests
      run: npm run test:invariants
```

The `build` job depends on `invariants`, so **merge is blocked if any test fails**.

## Summary

All 5 tests are designed to **PASS when constraints are enforced** and **FAIL when constraints are violated**. This proves that:

1. The constraints work (tests pass)
2. The tests work (tests fail when constraints are disabled)

This dual verification ensures both the protection mechanism and the test itself are correct.
