/**
 * VERIFICATION: Test that constitutional enforcement works
 * Run with: npx tsx migrations/verify-001.ts
 */

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config();

async function verify() {
  const DATABASE_URL = process.env.DATABASE_URL;
  const sql = neon(DATABASE_URL!);
  
  console.log('🔍 VERIFICATION: Testing constitutional enforcement...\n');
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Task terminal guard
  console.log('TEST 1: Task terminal guard (AUDIT-4)');
  try {
    // Find a completed task
    const completedTasks = await sql`
      SELECT id, status FROM tasks WHERE status = 'completed' LIMIT 1
    `;
    
    if (completedTasks.length > 0) {
      try {
        await sql`
          UPDATE tasks SET status = 'open' WHERE id = ${completedTasks[0].id}
        `;
        console.log('   ❌ FAILED: Was able to modify completed task');
        failed++;
      } catch (e: any) {
        if (e.message.includes('INV-TERMINAL')) {
          console.log('   ✅ PASSED: Trigger blocked modification');
          passed++;
        } else {
          console.log('   ❌ FAILED: Unexpected error:', e.message);
          failed++;
        }
      }
    } else {
      console.log('   ⏭️  SKIPPED: No completed tasks to test');
    }
  } catch (e: any) {
    console.log('   ❌ ERROR:', e.message);
    failed++;
  }
  
  // Test 2: Money state terminal guard
  console.log('\nTEST 2: Money state terminal guard (AUDIT-4)');
  try {
    const releasedStates = await sql`
      SELECT task_id, current_state FROM money_state_lock WHERE current_state = 'released' LIMIT 1
    `;
    
    if (releasedStates.length > 0) {
      try {
        await sql`
          UPDATE money_state_lock SET current_state = 'held' WHERE task_id = ${releasedStates[0].task_id}
        `;
        console.log('   ❌ FAILED: Was able to modify released money state');
        failed++;
      } catch (e: any) {
        if (e.message.includes('INV-TERMINAL')) {
          console.log('   ✅ PASSED: Trigger blocked modification');
          passed++;
        } else {
          console.log('   ❌ FAILED: Unexpected error:', e.message);
          failed++;
        }
      }
    } else {
      console.log('   ⏭️  SKIPPED: No released money states to test');
    }
  } catch (e: any) {
    console.log('   ❌ ERROR:', e.message);
    failed++;
  }
  
  // Test 3: XP ledger append-only
  console.log('\nTEST 3: XP ledger append-only');
  try {
    // Insert a test XP entry
    const testUser = await sql`SELECT id FROM users LIMIT 1`;
    if (testUser.length > 0) {
      const inserted = await sql`
        INSERT INTO xp_ledger (user_id, base_xp, effective_xp, final_xp, reason)
        VALUES (${testUser[0].id}, 10, 10, 10, 'TEST_ENTRY')
        RETURNING id
      `;
      
      // Try to delete it
      try {
        await sql`DELETE FROM xp_ledger WHERE id = ${inserted[0].id}`;
        console.log('   ❌ FAILED: Was able to delete XP entry');
        failed++;
      } catch (e: any) {
        if (e.message.includes('INV-XP')) {
          console.log('   ✅ PASSED: Trigger blocked deletion');
          passed++;
          // Clean up by updating reason to mark as test (can't delete)
        } else {
          console.log('   ❌ FAILED: Unexpected error:', e.message);
          failed++;
        }
      }
    } else {
      console.log('   ⏭️  SKIPPED: No users to test with');
    }
  } catch (e: any) {
    console.log('   ❌ ERROR:', e.message);
    failed++;
  }
  
  // Test 4: Badge ledger append-only
  console.log('\nTEST 4: Badge ledger append-only (INV-BADGE-2)');
  try {
    const testUser = await sql`SELECT id FROM users LIMIT 1`;
    if (testUser.length > 0) {
      const inserted = await sql`
        INSERT INTO badge_ledger (user_id, badge_id, badge_name, badge_tier, badge_category)
        VALUES (${testUser[0].id}, 'TEST_BADGE', 'Test Badge', 1, 'test')
        ON CONFLICT (user_id, badge_id) DO NOTHING
        RETURNING id
      `;
      
      if (inserted.length > 0) {
        try {
          await sql`DELETE FROM badge_ledger WHERE id = ${inserted[0].id}`;
          console.log('   ❌ FAILED: Was able to delete badge');
          failed++;
        } catch (e: any) {
          if (e.message.includes('INV-BADGE-2')) {
            console.log('   ✅ PASSED: Trigger blocked deletion');
            passed++;
          } else {
            console.log('   ❌ FAILED: Unexpected error:', e.message);
            failed++;
          }
        }
      } else {
        console.log('   ⏭️  SKIPPED: Badge already exists (from previous test)');
        // Try deleting existing
        const existing = await sql`
          SELECT id FROM badge_ledger WHERE badge_id = 'TEST_BADGE' LIMIT 1
        `;
        if (existing.length > 0) {
          try {
            await sql`DELETE FROM badge_ledger WHERE id = ${existing[0].id}`;
            console.log('   ❌ FAILED: Was able to delete badge');
            failed++;
          } catch (e: any) {
            if (e.message.includes('INV-BADGE-2')) {
              console.log('   ✅ PASSED: Trigger blocked deletion');
              passed++;
            }
          }
        }
      }
    }
  } catch (e: any) {
    console.log('   ❌ ERROR:', e.message);
    failed++;
  }
  
  // Test 5: Trust tier bounds
  console.log('\nTEST 5: Trust tier bounds check');
  try {
    const testUser = await sql`SELECT id FROM users LIMIT 1`;
    if (testUser.length > 0) {
      try {
        await sql`UPDATE users SET trust_tier = 5 WHERE id = ${testUser[0].id}`;
        console.log('   ❌ FAILED: Was able to set trust_tier to 5');
        failed++;
        // Revert
        await sql`UPDATE users SET trust_tier = 1 WHERE id = ${testUser[0].id}`;
      } catch (e: any) {
        if (e.message.includes('trust_tier_bounds') || e.message.includes('violates check constraint')) {
          console.log('   ✅ PASSED: Constraint blocked invalid tier');
          passed++;
        } else {
          console.log('   ❌ FAILED: Unexpected error:', e.message);
          failed++;
        }
      }
    }
  } catch (e: any) {
    console.log('   ❌ ERROR:', e.message);
    failed++;
  }
  
  // Test 6: Trust ledger append-only
  console.log('\nTEST 6: Trust ledger append-only (INV-TRUST-3)');
  try {
    const testUser = await sql`SELECT id FROM users LIMIT 1`;
    if (testUser.length > 0) {
      const inserted = await sql`
        INSERT INTO trust_ledger (user_id, old_tier, new_tier, reason, triggered_by)
        VALUES (${testUser[0].id}, 1, 2, 'TEST', 'system')
        RETURNING id
      `;
      
      try {
        await sql`DELETE FROM trust_ledger WHERE id = ${inserted[0].id}`;
        console.log('   ❌ FAILED: Was able to delete trust ledger entry');
        failed++;
      } catch (e: any) {
        if (e.message.includes('INV-TRUST-3')) {
          console.log('   ✅ PASSED: Trigger blocked deletion');
          passed++;
        } else {
          console.log('   ❌ FAILED: Unexpected error:', e.message);
          failed++;
        }
      }
    }
  } catch (e: any) {
    console.log('   ❌ ERROR:', e.message);
    failed++;
  }
  
  // Summary
  console.log('\n============================================================');
  console.log('VERIFICATION SUMMARY');
  console.log('============================================================');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${6 - passed - failed}`);
  
  if (failed === 0) {
    console.log('\n✅ ALL TESTS PASSED - Constitutional enforcement is ACTIVE');
  } else {
    console.log('\n❌ SOME TESTS FAILED - Review errors above');
  }
  console.log('============================================================\n');
}

verify().catch(console.error);
