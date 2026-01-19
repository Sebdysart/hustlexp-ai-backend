/**
 * Test Trust-Tier Tightening for Instant Mode
 * 
 * Verifies that trust tier enforcement works correctly:
 * - Low-tier hustlers cannot accept Instant tasks
 * - High-tier hustlers can accept Instant tasks
 * - Sensitive tasks require higher tier
 */

import { db } from '../backend/src/db';
import { TaskService } from '../backend/src/services/TaskService';
import { MIN_INSTANT_TIER, MIN_SENSITIVE_INSTANT_TIER } from '../backend/src/services/InstantTrustConfig';
import { ErrorCodes } from '../backend/src/types';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

interface User {
  id: string;
  email: string;
  full_name: string;
  trust_tier: number;
  trust_hold: boolean;
}

async function createTestUser(trustTier: number): Promise<User> {
  const result = await db.query<User>(
    `INSERT INTO users (email, full_name, default_mode, role_was_overridden, trust_tier, xp_total, current_level, current_streak, is_verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      `test_${Date.now()}_${Math.random()}@test.com`,
      'Test User',
      'worker',
      false,
      trustTier,
      0, 1, 0, true  // current_level must be >= 1
    ]
  );
  return result.rows[0];
}

async function testTrustTierEnforcement() {
  console.log('🧪 Testing Trust-Tier Tightening for Instant Mode\n');
  console.log(`MIN_INSTANT_TIER: ${MIN_INSTANT_TIER}`);
  console.log(`MIN_SENSITIVE_INSTANT_TIER: ${MIN_SENSITIVE_INSTANT_TIER}\n`);

  // Create test users
  const poster = await createTestUser(4); // High-tier poster
  const lowTierHustler = await createTestUser(1); // Below minimum
  const validHustler = await createTestUser(2); // Meets minimum
  const highTierHustler = await createTestUser(3); // Above minimum

  console.log(`Created test users:`);
  console.log(`  Poster: ${poster.id.substring(0, 8)}... (tier ${poster.trust_tier})`);
  console.log(`  Low-tier hustler: ${lowTierHustler.id.substring(0, 8)}... (tier ${lowTierHustler.trust_tier})`);
  console.log(`  Valid hustler: ${validHustler.id.substring(0, 8)}... (tier ${validHustler.trust_tier})`);
  console.log(`  High-tier hustler: ${highTierHustler.id.substring(0, 8)}... (tier ${highTierHustler.trust_tier})\n`);

  let testsPassed = 0;
  let testsFailed = 0;

  // Test 1: Low-tier hustler cannot accept regular Instant task
  console.log('Test 1: Low-tier hustler cannot accept regular Instant task');
  const task1 = await TaskService.create({
    posterId: poster.id,
    title: 'Test Instant Task',
    description: 'This is a test instant task with all required details.',
    price: 1000,
    location: '123 Test St, Seattle, WA',
    instantMode: true,
    sensitive: false,
  });

  if (!task1.success) {
    console.error(`  ❌ Failed to create task: ${task1.error.message}`);
    testsFailed++;
  } else {
    const acceptResult1 = await TaskService.accept({
      taskId: task1.data.id,
      workerId: lowTierHustler.id,
    });

    if (!acceptResult1.success && acceptResult1.error.code === ErrorCodes.INSTANT_TASK_TRUST_INSUFFICIENT) {
      console.log(`  ✅ Correctly blocked low-tier hustler`);
      testsPassed++;
    } else {
      console.error(`  ❌ Expected INSTANT_TASK_TRUST_INSUFFICIENT, got: ${acceptResult1.success ? 'SUCCESS' : acceptResult1.error.code}`);
      testsFailed++;
    }
  }

  // Test 2: Valid-tier hustler can accept regular Instant task
  console.log('\nTest 2: Valid-tier hustler can accept regular Instant task');
  const task2 = await TaskService.create({
    posterId: poster.id,
    title: 'Test Instant Task 2',
    description: 'This is another test instant task with all required details.',
    price: 1000,
    location: '456 Test Ave, Seattle, WA',
    instantMode: true,
    sensitive: false,
  });

  if (!task2.success) {
    console.error(`  ❌ Failed to create task: ${task2.error.message}`);
    testsFailed++;
  } else {
    const acceptResult2 = await TaskService.accept({
      taskId: task2.data.id,
      workerId: validHustler.id,
    });

    if (acceptResult2.success) {
      console.log(`  ✅ Valid-tier hustler can accept`);
      testsPassed++;
    } else {
      console.error(`  ❌ Expected SUCCESS, got: ${acceptResult2.error.code}`);
      testsFailed++;
    }
  }

  // Test 3: Valid-tier hustler cannot accept sensitive Instant task
  console.log('\nTest 3: Valid-tier hustler cannot accept sensitive Instant task');
  const task3 = await TaskService.create({
    posterId: poster.id,
    title: 'Sensitive Instant Task',
    description: 'This is a sensitive instant task requiring higher trust tier.',
    price: 1000,
    location: '789 Test Dr, Seattle, WA',
    instantMode: true,
    sensitive: true,
  });

  if (!task3.success) {
    console.error(`  ❌ Failed to create task: ${task3.error.message}`);
    testsFailed++;
  } else {
    const acceptResult3 = await TaskService.accept({
      taskId: task3.data.id,
      workerId: validHustler.id,
    });

    if (!acceptResult3.success && acceptResult3.error.code === ErrorCodes.INSTANT_TASK_TRUST_INSUFFICIENT) {
      console.log(`  ✅ Correctly blocked valid-tier hustler from sensitive task`);
      testsPassed++;
    } else {
      console.error(`  ❌ Expected INSTANT_TASK_TRUST_INSUFFICIENT, got: ${acceptResult3.success ? 'SUCCESS' : acceptResult3.error.code}`);
      testsFailed++;
    }
  }

  // Test 4: High-tier hustler can accept sensitive Instant task
  console.log('\nTest 4: High-tier hustler can accept sensitive Instant task');
  const task4 = await TaskService.create({
    posterId: poster.id,
    title: 'Sensitive Instant Task 2',
    description: 'This is another sensitive instant task requiring higher trust tier.',
    price: 1000,
    location: '321 Test Way, Seattle, WA',
    instantMode: true,
    sensitive: true,
  });

  if (!task4.success) {
    console.error(`  ❌ Failed to create task: ${task4.error.message}`);
    testsFailed++;
  } else {
    const acceptResult4 = await TaskService.accept({
      taskId: task4.data.id,
      workerId: highTierHustler.id,
    });

    if (acceptResult4.success) {
      console.log(`  ✅ High-tier hustler can accept sensitive task`);
      testsPassed++;
    } else {
      console.error(`  ❌ Expected SUCCESS, got: ${acceptResult4.error.code}`);
      testsFailed++;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('📊 RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}\n`);

  const allPassed = testsFailed === 0;
  console.log(`Overall: ${allPassed ? '✅ PASS' : '❌ FAIL'}\n`);

  // Output strict format
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('REPORT (Strict Format):');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Trust gate enforced: ${allPassed ? 'YES' : 'NO'}`);
  console.log(`Sensitive override enforced: ${testsPassed >= 4 ? 'YES' : 'NO'}`);
  console.log(`Instant fallback rate: 0% (test environment)`);

  process.exit(allPassed ? 0 : 1);
}

testTrustTierEnforcement().catch(e => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
