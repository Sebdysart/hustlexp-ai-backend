/**
 * Stripe Integration Verification Script
 * 
 * Automated verification for Steps 2-3:
 * - Step 2: Plan Transition Scenarios (Monotonicity)
 * - Step 3: End-User Gating
 * 
 * Step 1 (Stripe CLI) and Step 4 (Production) require manual execution.
 */

import { db } from '../backend/src/db';
import { PlanService } from '../backend/src/services/PlanService';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

async function createTestUser(plan: 'free' | 'premium' | 'pro' = 'free') {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (email, full_name, default_mode, role_was_overridden, plan, trust_tier)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      `test_${Date.now()}_${Math.random()}@test.com`,
      'Test User',
      'poster',
      false,
      plan,
      3, // trust_tier for Pro eligibility
    ]
  );
  return result.rows[0].id;
}

async function cleanupTestUser(userId: string) {
  await db.query('DELETE FROM plan_entitlements WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
}

// ============================================================================
// STEP 2: Plan Transition Scenarios (Monotonicity)
// ============================================================================

async function verifyPlanTransitions() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('STEP 2: Plan Transition Scenarios (Monotonicity)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const userId = await createTestUser('free');

  try {
    // Test 1: Free → Premium
    console.log('Test 1: Free → Premium');
    await db.query(
      `UPDATE users SET plan = 'premium', plan_subscribed_at = NOW(), plan_expires_at = NOW() + INTERVAL '30 days' WHERE id = $1`,
      [userId]
    );
    const plan1 = await PlanService.getUserPlan(userId);
    console.log(`  ✅ Plan: ${plan1} (expected: premium)`);
    assert(plan1 === 'premium', `Expected premium, got ${plan1}`);

    // Test 2: Premium → Pro (upgrade)
    console.log('\nTest 2: Premium → Pro (upgrade)');
    await db.query(
      `UPDATE users SET plan = 'pro', plan_expires_at = NOW() + INTERVAL '30 days' WHERE id = $1`,
      [userId]
    );
    const plan2 = await PlanService.getUserPlan(userId);
    console.log(`  ✅ Plan: ${plan2} (expected: pro)`);
    assert(plan2 === 'pro', `Expected pro, got ${plan2}`);

    // Test 3: Pro → Premium (downgrade) - should remain active until expiry
    console.log('\nTest 3: Pro → Premium (downgrade) - should remain active until expiry');
    const futureExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000); // 20 days
    await db.query(
      `UPDATE users SET plan = 'premium', plan_expires_at = $1 WHERE id = $2`,
      [futureExpiry, userId]
    );
    const plan3 = await PlanService.getUserPlan(userId);
    console.log(`  ✅ Plan: ${plan3} (expected: premium - still active until expiry)`);
    assert(plan3 === 'premium', `Expected premium, got ${plan3}`);

    // Test 4: Cancel - access remains until expiry
    console.log('\nTest 4: Cancel - access remains until expiry');
    // Simulate cancellation by setting expiry in future
    await db.query(
      `UPDATE users SET plan_expires_at = NOW() + INTERVAL '10 days' WHERE id = $1`,
      [userId]
    );
    const plan4 = await PlanService.getUserPlan(userId);
    console.log(`  ✅ Plan: ${plan4} (expected: premium - still active)`);
    assert(plan4 === 'premium', `Expected premium, got ${plan4}`);

    // Test 5: Expired - entitlement auto-invalid
    console.log('\nTest 5: Expired - entitlement auto-invalid');
    await db.query(
      `UPDATE users SET plan_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [userId]
    );
    const plan5 = await PlanService.getUserPlan(userId);
    console.log(`  ✅ Plan: ${plan5} (expected: free - expired)`);
    assert(plan5 === 'free', `Expected free, got ${plan5}`);

    console.log('\n✅ STEP 2: All plan transition tests passed');
  } finally {
    await cleanupTestUser(userId);
  }
}

// ============================================================================
// STEP 3: End-User Gating
// ============================================================================

async function verifyEndUserGating() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('STEP 3: End-User Gating');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const userId = await createTestUser('free');

  try {
    // Test 1: Attempt gated action without entitlement → blocked
    console.log('Test 1: Attempt gated action without entitlement → blocked');
    const check1 = await PlanService.canCreateTaskWithRisk(userId, 'HIGH');
    console.log(`  ✅ Allowed: ${check1.allowed} (expected: false)`);
    console.log(`  ✅ Reason: ${check1.reason}`);
    assert(check1.allowed === false, 'Expected blocked');
    assert(check1.reason?.includes('Premium plan required') === true, 'Expected premium required reason');

    // Test 2: Grant entitlement → allowed
    console.log('\nTest 2: Grant entitlement → allowed');
    const eventId = `evt_test_${Date.now()}`;
    await db.query(
      `INSERT INTO plan_entitlements (user_id, risk_level, source_event_id, expires_at)
       VALUES ($1, 'HIGH', $2, NOW() + INTERVAL '24 hours')`,
      [userId, eventId]
    );
    const check2 = await PlanService.canCreateTaskWithRisk(userId, 'HIGH');
    console.log(`  ✅ Allowed: ${check2.allowed} (expected: true)`);
    assert(check2.allowed === true, 'Expected allowed with entitlement');

    // Test 3: Expire entitlement → blocked again
    console.log('\nTest 3: Expire entitlement → blocked again');
    await db.query(
      `UPDATE plan_entitlements SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1`,
      [userId]
    );
    const check3 = await PlanService.canCreateTaskWithRisk(userId, 'HIGH');
    console.log(`  ✅ Allowed: ${check3.allowed} (expected: false)`);
    assert(check3.allowed === false, 'Expected blocked after expiry');

    // Test 4: Restart server → behavior unchanged (simulated by re-querying)
    console.log('\nTest 4: Restart server → behavior unchanged');
    // Simulate server restart by querying again (DB truth, not memory)
    const check4 = await PlanService.canCreateTaskWithRisk(userId, 'HIGH');
    console.log(`  ✅ Allowed: ${check4.allowed} (expected: false - DB truth)`);
    assert(check4.allowed === false, 'Expected blocked after expiry (DB truth)');

    console.log('\n✅ STEP 3: All end-user gating tests passed');
  } finally {
    await cleanupTestUser(userId);
  }
}

// ============================================================================
// MAIN
// ============================================================================

function assert(condition: boolean, message?: string) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function main() {
  console.log('🔍 Stripe Integration Verification (Steps 2-3)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  try {
    await verifyPlanTransitions();
    await verifyEndUserGating();

    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log('✅ VERIFICATION COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════════\n');
    console.log('📋 Manual Steps Required:');
    console.log('   Step 1: Stripe CLI webhook replay (see scripts/verify-stripe-webhook.sh)');
    console.log('   Step 4: Production webhook verification\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ VERIFICATION FAILED:', error);
    process.exit(1);
  }
}

main();
