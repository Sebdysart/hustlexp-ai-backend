/**
 * INV-1 Kill Test: XP requires RELEASED escrow
 * 
 * PURPOSE: Prove that the database enforces INV-1
 *          This test MUST FAIL if INV-1 enforcement is broken
 * 
 * INVARIANT: XP cannot be awarded unless escrow is RELEASED
 * SPEC: PRODUCT_SPEC §2 (INV-1)
 * ENFORCEMENT: schema.sql trigger `xp_requires_released_escrow`
 * ERROR CODE: HX101
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { 
  createTestPool, 
  cleanupTestData, 
  createTestUser, 
  createTestTask, 
  createTestEscrow 
} from '../setup';

let pool: pg.Pool;

beforeAll(async () => {
  pool = createTestPool();
  
  // Verify connection
  const result = await pool.query('SELECT version FROM schema_versions LIMIT 1');
  console.log('Connected to database with schema version:', result.rows[0]?.version);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await cleanupTestData(pool);
});

// Helper: Attempt XP award
async function attemptXPAward(
  userId: string, 
  taskId: string, 
  escrowId: string
): Promise<void> {
  await pool.query(
    `INSERT INTO xp_ledger (
      user_id, task_id, escrow_id, base_xp, effective_xp,
      user_xp_before, user_xp_after, user_level_before, user_level_after, user_streak_at_award
    ) VALUES ($1, $2, $3, 100, 100, 0, 100, 1, 1, 0)`,
    [userId, taskId, escrowId]
  );
}

// =============================================================================
// INV-1 KILL TESTS
// =============================================================================

describe('INV-1: XP requires RELEASED escrow', () => {
  
  it('MUST REJECT: XP award when escrow is PENDING', async () => {
    const posterId = await createTestUser(pool, `test-poster-1-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-1-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'PENDING');
    
    await expect(
      attemptXPAward(workerId, taskId, escrowId)
    ).rejects.toMatchObject({
      code: 'HX101',
    });
  });

  it('MUST REJECT: XP award when escrow is FUNDED', async () => {
    const posterId = await createTestUser(pool, `test-poster-2-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-2-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    await expect(
      attemptXPAward(workerId, taskId, escrowId)
    ).rejects.toMatchObject({
      code: 'HX101',
    });
  });

  it('MUST REJECT: XP award when escrow is LOCKED_DISPUTE', async () => {
    const posterId = await createTestUser(pool, `test-poster-3-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-3-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'LOCKED_DISPUTE');
    
    await expect(
      attemptXPAward(workerId, taskId, escrowId)
    ).rejects.toMatchObject({
      code: 'HX101',
    });
  });

  it('MUST REJECT: XP award when escrow is REFUNDED', async () => {
    const posterId = await createTestUser(pool, `test-poster-4-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-4-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'REFUNDED');
    
    await expect(
      attemptXPAward(workerId, taskId, escrowId)
    ).rejects.toMatchObject({
      code: 'HX101',
    });
  });

  it('MUST REJECT: XP award when escrow is REFUND_PARTIAL', async () => {
    const posterId = await createTestUser(pool, `test-poster-5-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-5-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'REFUND_PARTIAL');
    
    await expect(
      attemptXPAward(workerId, taskId, escrowId)
    ).rejects.toMatchObject({
      code: 'HX101',
    });
  });

  it('MUST ALLOW: XP award when escrow IS RELEASED', async () => {
    const posterId = await createTestUser(pool, `test-poster-6-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-6-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    // This should NOT throw
    await attemptXPAward(workerId, taskId, escrowId);
    
    // Verify it was created
    const result = await pool.query(
      'SELECT * FROM xp_ledger WHERE escrow_id = $1',
      [escrowId]
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].effective_xp).toBe(100);
  });

  it('MUST REJECT: duplicate XP award for same escrow (INV-5)', async () => {
    const posterId = await createTestUser(pool, `test-poster-7-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-7-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    // First award should succeed
    await attemptXPAward(workerId, taskId, escrowId);
    
    // Second award should fail (unique constraint)
    await expect(
      attemptXPAward(workerId, taskId, escrowId)
    ).rejects.toMatchObject({
      code: '23505', // Unique violation
    });
  });

  it('MUST REJECT: deletion of XP ledger entry', async () => {
    const posterId = await createTestUser(pool, `test-poster-8-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-8-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    await attemptXPAward(workerId, taskId, escrowId);
    
    // Attempt to delete should fail
    await expect(
      pool.query('DELETE FROM xp_ledger WHERE escrow_id = $1', [escrowId])
    ).rejects.toMatchObject({
      code: 'HX102',
    });
  });
});
