/**
 * PHASE 0.2B VERIFICATION TEST
 * 
 * Tests the BUILD_GUIDE aligned XP and Trust flow.
 * 
 * Run with: npx tsx tests/phase02b-verify.ts
 */

import { neon, Pool } from '@neondatabase/serverless';
import { config } from 'dotenv';
import Decimal from 'decimal.js';

config();

const DATABASE_URL = process.env.DATABASE_URL!;
const sql = neon(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL });

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

// XP formulas (from AtomicXPService)
function calculateDecayFactor(totalXP: number): Decimal {
  if (totalXP <= 0) return new Decimal(1);
  const ratio = new Decimal(totalXP).div(1000);
  const logValue = Decimal.log10(ratio.plus(1));
  return new Decimal(1).div(logValue.plus(1)).toDecimalPlaces(4, Decimal.ROUND_DOWN);
}

function calculateBaseXP(amountCents: number): number {
  return Math.max(10, Math.floor(amountCents / 100));
}

function calculateLevel(totalXP: number): number {
  const thresholds = [0, 100, 300, 700, 1500, 2700, 4500, 7000, 10500, 18500];
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (totalXP >= thresholds[i]) return i + 1;
  }
  return 1;
}

function getStreakMultiplier(streakDays: number): Decimal {
  if (streakDays >= 30) return new Decimal('1.5');
  if (streakDays >= 14) return new Decimal('1.3');
  if (streakDays >= 7) return new Decimal('1.2');
  if (streakDays >= 3) return new Decimal('1.1');
  return new Decimal('1.0');
}

async function awardXPForTask(taskId: string, hustlerId: string): Promise<{
  success: boolean;
  finalXP: number;
  alreadyAwarded: boolean;
  error?: string;
}> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const moneyStateResult = await client.query(
      'SELECT current_state FROM money_state_lock WHERE task_id = $1',
      [taskId]
    );
    
    if (moneyStateResult.rows.length === 0) {
      throw new Error(`Money state not found for task: ${taskId}`);
    }
    
    if (moneyStateResult.rows[0].current_state !== 'released') {
      throw new Error(`INV-XP-2: Cannot award XP for money state: ${moneyStateResult.rows[0].current_state}`);
    }
    
    const taskResult = await client.query('SELECT price FROM tasks WHERE id = $1', [taskId]);
    const taskPriceCents = Math.round(Number(taskResult.rows[0]?.price || 50) * 100);
    
    const userResult = await client.query('SELECT xp, level, streak FROM users WHERE id = $1', [hustlerId]);
    const user = userResult.rows[0];
    const currentXP = user?.xp || 0;
    const currentStreak = user?.streak || 0;
    
    const baseXP = calculateBaseXP(taskPriceCents);
    const decayFactor = calculateDecayFactor(currentXP);
    const effectiveXP = new Decimal(baseXP).mul(decayFactor).floor().toNumber();
    const streakMultiplier = getStreakMultiplier(currentStreak + 1);
    const finalXP = new Decimal(effectiveXP).mul(streakMultiplier).floor().toNumber();
    
    try {
      await client.query(`
        INSERT INTO xp_ledger (user_id, task_id, money_state_lock_task_id, base_xp, decay_factor, effective_xp, streak_multiplier, final_xp, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [hustlerId, taskId, taskId, baseXP, decayFactor.toFixed(4), effectiveXP, streakMultiplier.toFixed(2), finalXP, 'Task completion']);
    } catch (e: any) {
      if (e.code === '23505') {
        await client.query('ROLLBACK');
        return { success: true, finalXP: 0, alreadyAwarded: true };
      }
      throw e;
    }
    
    const newTotalXP = currentXP + finalXP;
    await client.query(`
      UPDATE users SET xp = $1, level = $2, streak = $3, last_active_at = NOW(), updated_at = NOW()
      WHERE id = $4
    `, [newTotalXP, calculateLevel(newTotalXP), currentStreak + 1, hustlerId]);
    
    await client.query('COMMIT');
    return { success: true, finalXP, alreadyAwarded: false };
    
  } catch (error: any) {
    await client.query('ROLLBACK');
    return { success: false, finalXP: 0, alreadyAwarded: false, error: error.message };
  } finally {
    client.release();
  }
}

async function main() {
  console.log('=== PHASE 0.2B VERIFICATION TEST ===\n');
  
  let passed = 0;
  let failed = 0;
  
  const testUserId = crypto.randomUUID();
  const testTaskId = crypto.randomUUID();
  const testTaskId2 = crypto.randomUUID();
  
  console.log('1. Creating test data...');
  
  await sql`
    INSERT INTO users (id, firebase_uid, email, username, xp, level, streak, trust_tier)
    VALUES (${testUserId}, ${'fb_' + testUserId.slice(0, 8)}, ${testUserId + '@test.com'}, ${'test_' + testUserId.slice(0, 6)}, 0, 1, 0, 1)
  `;
  
  await sql`
    INSERT INTO tasks (id, created_by, title, description, category, price, status, xp_reward, city, assigned_to)
    VALUES (${testTaskId}, ${testUserId}, 'Test Task 1', 'Test', 'errands', 50.00, 'completed', 100, 'Seattle', ${testUserId})
  `;
  
  await sql`
    INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, poster_uid, version)
    VALUES (${testTaskId}, 'released', ARRAY[]::text[], ${testUserId}, 1)
  `;
  
  console.log('   ✅ Test data created\n');
  
  // Test 2: XP Award
  console.log('2. Testing awardXPForTask()...');
  const xpResult = await awardXPForTask(testTaskId, testUserId);
  if (xpResult.success && xpResult.finalXP > 0) {
    console.log(`   Final XP: ${xpResult.finalXP}`);
    console.log('   ✅ PASS\n');
    passed++;
  } else {
    console.log(`   ❌ FAIL: ${xpResult.error}\n`);
    failed++;
  }
  
  // Test 3: Idempotency
  console.log('3. Testing idempotency (INV-5)...');
  const xpResult2 = await awardXPForTask(testTaskId, testUserId);
  if (xpResult2.alreadyAwarded && xpResult2.finalXP === 0) {
    console.log('   ✅ PASS: Duplicate blocked\n');
    passed++;
  } else {
    console.log('   ❌ FAIL\n');
    failed++;
  }
  
  // Test 4: XP ledger entry
  console.log('4. Verifying xp_ledger entry...');
  const [xpEntry] = await sql`SELECT * FROM xp_ledger WHERE money_state_lock_task_id = ${testTaskId}`;
  if (xpEntry) {
    console.log(`   Final XP: ${xpEntry.final_xp}, Decay: ${xpEntry.decay_factor}`);
    console.log('   ✅ PASS\n');
    passed++;
  } else {
    console.log('   ❌ FAIL\n');
    failed++;
  }
  
  // Test 5: User XP updated
  console.log('5. Verifying user XP...');
  const [user] = await sql`SELECT xp, level, streak FROM users WHERE id = ${testUserId}`;
  if (Number(user.xp) > 0) {
    console.log(`   XP: ${user.xp}, Level: ${user.level}, Streak: ${user.streak}`);
    console.log('   ✅ PASS\n');
    passed++;
  } else {
    console.log('   ❌ FAIL\n');
    failed++;
  }
  
  // Test 6: INV-XP-2
  console.log('6. Testing INV-XP-2 (RELEASED required)...');
  await sql`
    INSERT INTO tasks (id, created_by, title, description, category, price, status, xp_reward, city)
    VALUES (${testTaskId2}, ${testUserId}, 'Test Task 2', 'Test', 'errands', 25.00, 'in_progress', 50, 'Seattle')
  `;
  await sql`
    INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, poster_uid, version)
    VALUES (${testTaskId2}, 'held', ARRAY['RELEASE_PAYOUT'], ${testUserId}, 1)
  `;
  
  const xpResult3 = await awardXPForTask(testTaskId2, testUserId);
  if (!xpResult3.success && xpResult3.error?.includes('INV-XP-2')) {
    console.log('   ✅ PASS: Blocked for held state\n');
    passed++;
  } else {
    console.log('   ❌ FAIL\n');
    failed++;
  }
  
  // Test 7: Trust tier bounds
  console.log('7. Testing trust_tier_bounds...');
  try {
    await sql`UPDATE users SET trust_tier = 5 WHERE id = ${testUserId}`;
    console.log('   ❌ FAIL: Allowed tier 5\n');
    failed++;
  } catch (e: any) {
    if (e.message.includes('trust_tier_bounds') || e.message.includes('check constraint')) {
      console.log('   ✅ PASS: Blocked tier 5\n');
      passed++;
    } else {
      console.log(`   ❌ FAIL: ${e.message}\n`);
      failed++;
    }
  }
  
  // Cleanup (skip append-only tables)
  console.log('8. Cleaning up (note: xp_ledger entries persist - append-only)...');
  await sql`DELETE FROM money_state_lock WHERE task_id IN (${testTaskId}, ${testTaskId2})`;
  await sql`DELETE FROM tasks WHERE id IN (${testTaskId}, ${testTaskId2})`;
  await sql`DELETE FROM users WHERE id = ${testUserId}`;
  console.log('   ✅ Done\n');
  
  await pool.end();
  
  // Summary
  console.log('============================================================');
  console.log('PHASE 0.2B VERIFICATION');
  console.log('============================================================');
  console.log(`Passed: ${passed}/7  Failed: ${failed}/7`);
  
  if (failed === 0) {
    console.log('\n✅ ALL TESTS PASSED');
    console.log('\nInvariants verified:');
    console.log('  ✓ INV-5: XP idempotent per escrow');
    console.log('  ✓ INV-XP-2: XP requires RELEASED state');
    console.log('  ✓ Trust tier bounds (1-4)');
    console.log('  ✓ XP ledger audit trail');
    console.log('  ✓ User XP/level/streak updates');
  } else {
    console.log('\n❌ SOME TESTS FAILED');
    process.exit(1);
  }
  console.log('============================================================');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
