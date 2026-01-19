/**
 * Test the exact query that's failing
 */

import { db } from '../backend/src/db';
import { TrustTierService } from '../backend/src/services/TrustTierService';

async function testQuery() {
  try {
    // Create a test user
    const userId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, full_name, default_mode, trust_tier, is_verified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [userId, `test-${userId}@example.com`, 'Test User', 'worker', 1, true]
    );

    // Create a test task with worker_id
    const taskId = crypto.randomUUID();
    const posterId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, full_name, default_mode, trust_tier, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT DO NOTHING`,
      [posterId, `poster-${posterId}@example.com`, 'Test Poster', 'poster', 1]
    );
    await db.query(
      `INSERT INTO tasks (id, poster_id, title, description, price, state, risk_level, worker_id, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [taskId, posterId, 'Test Task', 'Test', 1000, 'COMPLETED', 'LOW', userId]
    );

    console.log('✅ Test data created');

    // Try the exact query from TrustTierService
    const result = await db.query<{
      completed_count: string;
      dispute_count: string;
      on_time_count: string;
      total_count: string;
    }>(
      `SELECT 
         COUNT(*) FILTER (WHERE t.state = 'COMPLETED' AND t.worker_id = $1) as completed_count,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM disputes d WHERE d.task_id = t.id
         ) AND t.worker_id = $1) as dispute_count,
         COUNT(*) FILTER (WHERE t.state = 'COMPLETED' 
           AND (t.deadline IS NULL OR t.completed_at <= t.deadline)
           AND t.worker_id = $1) as on_time_count,
         COUNT(*) FILTER (WHERE t.worker_id = $1) as total_count
       FROM tasks t
       WHERE t.worker_id = $1`,
      [userId]
    );

    console.log('✅ Query succeeded:', result.rows[0]);

    // Now try evaluatePromotion
    const eligibility = await TrustTierService.evaluatePromotion(userId);
    console.log('✅ evaluatePromotion succeeded:', eligibility);

    // Cleanup
    await db.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await db.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userId, posterId]);

    process.exit(0);
  } catch (error: any) {
    console.error('❌ Failed:', error.message);
    console.error('Error code:', error.code);
    console.error('Error detail:', error.detail);
    console.error('Error position:', error.position);
    process.exit(1);
  }
}

testQuery();
