/**
 * Test worker_id query directly
 */

import { db } from '../backend/src/db';

async function testQuery() {
  try {
    // Test the exact query from TrustTierService
    const userId = '00000000-0000-0000-0000-000000000000';
    
    const result = await db.query<{ completed_count: string }>(
      `SELECT COUNT(*) FILTER (WHERE state = 'COMPLETED' AND worker_id = $1) as completed_count
       FROM tasks
       WHERE worker_id = $1`,
      [userId]
    );
    
    console.log('✅ Query succeeded, result:', result.rows[0]);
    process.exit(0);
  } catch (error: any) {
    console.error('❌ Query failed:', error.message);
    console.error('Error code:', error.code);
    console.error('Error detail:', error.detail);
    process.exit(1);
  }
}

testQuery();
