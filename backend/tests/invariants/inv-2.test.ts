/**
 * INV-2 Kill Test: RELEASED escrow requires COMPLETED task
 * 
 * PURPOSE: Prove that the database enforces INV-2
 *          This test MUST FAIL if INV-2 enforcement is broken
 * 
 * INVARIANT: Escrow can only transition to RELEASED if task is COMPLETED
 * SPEC: PRODUCT_SPEC §2 (INV-2)
 * ENFORCEMENT: schema.sql trigger `escrow_released_requires_completed_task`
 * ERROR CODE: HX201
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { 
  createTestPool, 
  cleanupTestData, 
  createTestUser, 
  createTestTask, 
  createTestEscrow,
  setEscrowState
} from '../setup';

let pool: pg.Pool;

beforeAll(async () => {
  pool = createTestPool();
  
  const result = await pool.query('SELECT version FROM schema_versions LIMIT 1');
  console.log('Connected to database with schema version:', result.rows[0]?.version);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await cleanupTestData(pool);
});

// Helper: Attempt to release escrow
async function attemptReleaseEscrow(escrowId: string): Promise<void> {
  await pool.query(
    `UPDATE escrows SET state = 'RELEASED', released_at = NOW() WHERE id = $1`,
    [escrowId]
  );
}

// =============================================================================
// INV-2 KILL TESTS
// =============================================================================

describe('INV-2: RELEASED escrow requires COMPLETED task', () => {
  
  it('MUST REJECT: release escrow when task is OPEN', async () => {
    const posterId = await createTestUser(pool, `test-poster-1-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'OPEN');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    await expect(
      attemptReleaseEscrow(escrowId)
    ).rejects.toMatchObject({
      code: 'HX201',
    });
  });

  it('MUST REJECT: release escrow when task is ACCEPTED', async () => {
    const posterId = await createTestUser(pool, `test-poster-2-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'ACCEPTED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    await expect(
      attemptReleaseEscrow(escrowId)
    ).rejects.toMatchObject({
      code: 'HX201',
    });
  });

  it('MUST REJECT: release escrow when task is PROOF_SUBMITTED', async () => {
    const posterId = await createTestUser(pool, `test-poster-3-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'PROOF_SUBMITTED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    await expect(
      attemptReleaseEscrow(escrowId)
    ).rejects.toMatchObject({
      code: 'HX201',
    });
  });

  it('MUST REJECT: release escrow when task is DISPUTED', async () => {
    const posterId = await createTestUser(pool, `test-poster-4-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'DISPUTED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    await expect(
      attemptReleaseEscrow(escrowId)
    ).rejects.toMatchObject({
      code: 'HX201',
    });
  });

  it('MUST REJECT: release escrow when task is CANCELLED', async () => {
    const posterId = await createTestUser(pool, `test-poster-5-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'CANCELLED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    await expect(
      attemptReleaseEscrow(escrowId)
    ).rejects.toMatchObject({
      code: 'HX201',
    });
  });

  it('MUST REJECT: release escrow when task is EXPIRED', async () => {
    const posterId = await createTestUser(pool, `test-poster-6-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'EXPIRED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    await expect(
      attemptReleaseEscrow(escrowId)
    ).rejects.toMatchObject({
      code: 'HX201',
    });
  });

  it('MUST ALLOW: release escrow when task IS COMPLETED', async () => {
    const posterId = await createTestUser(pool, `test-poster-7-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // This should NOT throw
    await attemptReleaseEscrow(escrowId);
    
    // Verify state changed
    const result = await pool.query(
      'SELECT state FROM escrows WHERE id = $1',
      [escrowId]
    );
    expect(result.rows[0].state).toBe('RELEASED');
  });

  it('MUST REJECT: state change on already RELEASED escrow (terminal state)', async () => {
    const posterId = await createTestUser(pool, `test-poster-8-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    // Attempt to change state on terminal escrow should fail
    await expect(
      pool.query(`UPDATE escrows SET state = 'REFUNDED' WHERE id = $1`, [escrowId])
    ).rejects.toMatchObject({
      code: 'HX002',
    });
  });
});

// =============================================================================
// INV-3 KILL TESTS (COMPLETED requires ACCEPTED proof)
// =============================================================================

describe('INV-3: COMPLETED task requires ACCEPTED proof', () => {
  
  it('MUST REJECT: complete task when no proof exists', async () => {
    const posterId = await createTestUser(pool, `test-poster-inv3-1-${Date.now()}@hustlexp.test`);
    // requiresProof = true to trigger INV-3 enforcement
    const taskId = await createTestTask(pool, posterId, 'PROOF_SUBMITTED', true);
    
    await expect(
      pool.query(`UPDATE tasks SET state = 'COMPLETED' WHERE id = $1`, [taskId])
    ).rejects.toMatchObject({
      code: 'HX301',
    });
  });

  it('MUST REJECT: complete task when proof is PENDING', async () => {
    const posterId = await createTestUser(pool, `test-poster-inv3-2-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-inv3-2-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'PROOF_SUBMITTED', true);
    
    // Create proof in PENDING state
    await pool.query(
      `INSERT INTO proofs (task_id, submitter_id, state, description)
       VALUES ($1, $2, 'PENDING', 'Test description')`,
      [taskId, workerId]
    );
    
    await expect(
      pool.query(`UPDATE tasks SET state = 'COMPLETED' WHERE id = $1`, [taskId])
    ).rejects.toMatchObject({
      code: 'HX301',
    });
  });

  it('MUST REJECT: complete task when proof is REJECTED', async () => {
    const posterId = await createTestUser(pool, `test-poster-inv3-3-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-inv3-3-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'PROOF_SUBMITTED', true);
    
    await pool.query(
      `INSERT INTO proofs (task_id, submitter_id, state, description)
       VALUES ($1, $2, 'REJECTED', 'Test description')`,
      [taskId, workerId]
    );
    
    await expect(
      pool.query(`UPDATE tasks SET state = 'COMPLETED' WHERE id = $1`, [taskId])
    ).rejects.toMatchObject({
      code: 'HX301',
    });
  });

  it('MUST ALLOW: complete task when proof IS ACCEPTED', async () => {
    const posterId = await createTestUser(pool, `test-poster-inv3-4-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-inv3-4-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'PROOF_SUBMITTED', true);
    
    // Create ACCEPTED proof
    await pool.query(
      `INSERT INTO proofs (task_id, submitter_id, state, description)
       VALUES ($1, $2, 'ACCEPTED', 'Test description')`,
      [taskId, workerId]
    );
    
    // This should NOT throw
    await pool.query(`UPDATE tasks SET state = 'COMPLETED' WHERE id = $1`, [taskId]);
    
    const result = await pool.query('SELECT state FROM tasks WHERE id = $1', [taskId]);
    expect(result.rows[0].state).toBe('COMPLETED');
  });
});

// =============================================================================
// TERMINAL STATE TESTS
// =============================================================================

describe('Terminal State Protection', () => {
  
  it('MUST REJECT: modification of COMPLETED task', async () => {
    const posterId = await createTestUser(pool, `test-poster-term-1-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    
    await expect(
      pool.query(`UPDATE tasks SET title = 'Hacked' WHERE id = $1`, [taskId])
    ).rejects.toMatchObject({
      code: 'HX001', // Task terminal state violation
    });
  });

  it('MUST REJECT: modification of CANCELLED task', async () => {
    const posterId = await createTestUser(pool, `test-poster-term-2-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'CANCELLED');
    
    await expect(
      pool.query(`UPDATE tasks SET title = 'Hacked' WHERE id = $1`, [taskId])
    ).rejects.toMatchObject({
      code: 'HX001', // Task terminal state violation
    });
  });

  it('MUST REJECT: modification of RELEASED escrow', async () => {
    const posterId = await createTestUser(pool, `test-poster-term-3-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    // Changing state triggers terminal guard (HX002)
    await expect(
      pool.query(`UPDATE escrows SET state = 'FUNDED' WHERE id = $1`, [escrowId])
    ).rejects.toMatchObject({
      code: 'HX002', // Escrow terminal state violation
    });
  });

  it('MUST REJECT: modification of REFUNDED escrow', async () => {
    const posterId = await createTestUser(pool, `test-poster-term-4-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'CANCELLED');
    const escrowId = await createTestEscrow(pool, taskId, 'REFUNDED');
    
    // Changing state triggers terminal guard (HX002)
    await expect(
      pool.query(`UPDATE escrows SET state = 'FUNDED' WHERE id = $1`, [escrowId])
    ).rejects.toMatchObject({
      code: 'HX002', // Escrow terminal state violation
    });
  });
});
