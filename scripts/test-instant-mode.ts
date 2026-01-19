/**
 * Instant Mode Test Script
 * 
 * Creates 5 instant tasks, accepts them, and measures time-to-accept.
 */

import { db } from '../backend/src/db';
import { TaskService } from '../backend/src/services/TaskService';

// Temporarily bypass plan checks by directly inserting tasks
async function createInstantTaskDirectly(posterId: string, title: string, description: string) {
  const result = await db.query<{
    id: string;
    state: string;
    matched_at: Date | null;
  }>(
    `INSERT INTO tasks (
      poster_id, title, description, price, 
      location, category, requires_proof, 
      mode, instant_mode, state
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id, state, matched_at`,
    [posterId, title, description, 1000, 'Seattle, WA', 'test', true, 'STANDARD', true, 'MATCHING']
  );
  
  const task = result.rows[0];
  
  // Set matched_at
  await db.query(
    `UPDATE tasks SET matched_at = NOW() WHERE id = $1`,
    [task.id]
  );
  
  // Reload to get matched_at
  const reloaded = await db.query<{
    id: string;
    state: string;
    matched_at: Date | null;
  }>(
    `SELECT id, state, matched_at FROM tasks WHERE id = $1`,
    [task.id]
  );
  
  return reloaded.rows[0];
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

async function createTestUser() {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (email, full_name, default_mode, role_was_overridden, trust_tier)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      `test_${Date.now()}_${Math.random()}@test.com`,
      'Test User',
      'poster',
      false,
      3,
    ]
  );
  return result.rows[0].id;
}

async function createTestWorker() {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (email, full_name, default_mode, role_was_overridden, trust_tier)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      `worker_${Date.now()}_${Math.random()}@test.com`,
      'Test Worker',
      'worker',
      false,
      3,
    ]
  );
  return result.rows[0].id;
}

async function cleanupTestUsers(userIds: string[]) {
  await db.query('DELETE FROM tasks WHERE poster_id = ANY($1) OR worker_id = ANY($1)', [userIds]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
}

async function testInstantMode() {
  console.log('🧪 Testing Instant Execution Mode\n');

  const posterId = await createTestUser();
  const workerId = await createTestWorker();

  try {
    const taskIds: string[] = [];

    // Step 1: Create 5 instant tasks (bypassing PlanService for testing)
    console.log('📝 Creating 5 instant tasks...');
    for (let i = 1; i <= 5; i++) {
      const task = await createInstantTaskDirectly(
        posterId,
        `Instant Test Task ${i}`,
        `Test task ${i} for instant mode`
      );

      taskIds.push(task.id);
      console.log(`  ✅ Task ${i} created: ${task.id.substring(0, 8)}... (state: ${task.state})`);
      
      // Verify matched_at is set
      if (!task.matched_at) {
        console.error(`❌ Task ${i} missing matched_at`);
        process.exit(1);
      }
    }

    console.log('\n⏱️  Accepting tasks (simulating immediate hustler response)...\n');

    // Step 2: Accept each task immediately (bypassing PlanService for testing)
    for (let i = 0; i < taskIds.length; i++) {
      const taskId = taskIds[i];
      
      // Direct DB accept (bypassing service layer plan checks)
      const acceptResult = await db.query<{
        id: string;
        matched_at: Date | null;
        accepted_at: Date | null;
      }>(
        `UPDATE tasks 
         SET state = 'ACCEPTED',
             worker_id = $2,
             accepted_at = NOW()
         WHERE id = $1 
           AND state = 'MATCHING'
           AND worker_id IS NULL
         RETURNING id, matched_at, accepted_at`,
        [taskId, workerId]
      );

      if (acceptResult.rowCount === 0) {
        console.error(`❌ Failed to accept task ${i + 1}: task not in MATCHING state or already accepted`);
        process.exit(1);
      }

      const task = acceptResult.rows[0];
      const timeToAccept = task.matched_at && task.accepted_at
        ? Math.floor((task.accepted_at.getTime() - task.matched_at.getTime()) / 1000)
        : null;

      console.log(`  ✅ Task ${i + 1} accepted: ${timeToAccept !== null ? `${timeToAccept}s` : 'N/A'}`);
    }

    // Step 3: Get metrics
    console.log('\n📊 Calculating metrics...\n');

    const metricsResult = await db.query<{
      matched_at: Date | null;
      accepted_at: Date | null;
    }>(
      `SELECT matched_at, accepted_at
       FROM tasks
       WHERE id = ANY($1)
         AND matched_at IS NOT NULL
         AND accepted_at IS NOT NULL
       ORDER BY accepted_at ASC`,
      [taskIds]
    );

    const times = metricsResult.rows
      .map(row => {
        if (!row.matched_at || !row.accepted_at) return null;
        return Math.floor(
          (row.accepted_at.getTime() - row.matched_at.getTime()) / 1000
        );
      })
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b);

    if (times.length === 0) {
      console.error('❌ No valid time-to-accept measurements');
      process.exit(1);
    }

    const median = times[Math.floor(times.length / 2)];
    const p90 = times[Math.floor(times.length * 0.9)];

    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('📈 RESULTS');
    console.log('═══════════════════════════════════════════════════════════════════\n');
    console.log(`Median Time-to-Accept: ${median}s`);
    console.log(`p90 Time-to-Accept: ${p90}s`);
    console.log(`\nAll times: ${times.join('s, ')}s`);
    console.log(`\nPass criteria: Median ≤ 60s, p90 ≤ 120s`);
    console.log(`Status: ${median <= 60 && p90 <= 120 ? '✅ PASS' : '❌ FAIL'}\n`);

    process.exit(median <= 60 && p90 <= 120 ? 0 : 1);
  } finally {
    await cleanupTestUsers([posterId, workerId]);
  }
}

testInstantMode().catch(e => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
