/**
 * INV-4 Kill Test: Escrow amount is immutable after creation
 * 
 * PURPOSE: Prove that the database enforces INV-4
 *          This test MUST FAIL if INV-4 enforcement is broken
 * 
 * INVARIANT: Escrow amount cannot be modified after creation
 * SPEC: PRODUCT_SPEC §2 (INV-4), §4.2
 * ENFORCEMENT: schema.sql trigger `escrow_amount_immutable`
 * ERROR CODE: HX004
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

// Helper: Attempt to modify escrow amount
async function attemptModifyEscrowAmount(
  escrowId: string,
  newAmount: number
): Promise<void> {
  await pool.query(
    `UPDATE escrows SET amount = $1 WHERE id = $2`,
    [newAmount, escrowId]
  );
}

// =============================================================================
// INV-4 KILL TESTS
// =============================================================================

describe('INV-4: Escrow amount is immutable after creation', () => {
  
  it('MUST REJECT: modify escrow amount when state is PENDING', async () => {
    const posterId = await createTestUser(pool, `test-poster-1-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'OPEN');
    const escrowId = await createTestEscrow(pool, taskId, 'PENDING');
    
    await expect(
      attemptModifyEscrowAmount(escrowId, 5000) // Try to change to $50.00
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });

  it('MUST REJECT: modify escrow amount when state is FUNDED', async () => {
    const posterId = await createTestUser(pool, `test-poster-2-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'ACCEPTED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    await expect(
      attemptModifyEscrowAmount(escrowId, 10000) // Try to change to $100.00
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });

  it('MUST REJECT: modify escrow amount when state is LOCKED_DISPUTE', async () => {
    const posterId = await createTestUser(pool, `test-poster-3-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'DISPUTED');
    const escrowId = await createTestEscrow(pool, taskId, 'LOCKED_DISPUTE');
    
    await expect(
      attemptModifyEscrowAmount(escrowId, 7500) // Try to change to $75.00
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });

  it('MUST REJECT: modify escrow amount when state is RELEASED (terminal)', async () => {
    const posterId = await createTestUser(pool, `test-poster-4-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'RELEASED');
    
    await expect(
      attemptModifyEscrowAmount(escrowId, 20000) // Try to change to $200.00
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });

  it('MUST REJECT: modify escrow amount when state is REFUNDED (terminal)', async () => {
    const posterId = await createTestUser(pool, `test-poster-5-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'CANCELLED');
    const escrowId = await createTestEscrow(pool, taskId, 'REFUNDED');
    
    await expect(
      attemptModifyEscrowAmount(escrowId, 15000) // Try to change to $150.00
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });

  it('MUST REJECT: modify escrow amount when state is REFUND_PARTIAL (terminal)', async () => {
    const posterId = await createTestUser(pool, `test-poster-6-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'CANCELLED');
    const escrowId = await createTestEscrow(pool, taskId, 'REFUND_PARTIAL');
    
    await expect(
      attemptModifyEscrowAmount(escrowId, 12000) // Try to change to $120.00
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });

  it('MUST REJECT: modify escrow amount to zero', async () => {
    const posterId = await createTestUser(pool, `test-poster-7-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'OPEN');
    const escrowId = await createTestEscrow(pool, taskId, 'PENDING');
    
    await expect(
      attemptModifyEscrowAmount(escrowId, 0) // Try to set to $0.00
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });

  it('MUST REJECT: modify escrow amount to negative value', async () => {
    const posterId = await createTestUser(pool, `test-poster-8-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'OPEN');
    const escrowId = await createTestEscrow(pool, taskId, 'PENDING');
    
    await expect(
      attemptModifyEscrowAmount(escrowId, -1000) // Try to set to -$10.00
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });

  // =============================================================================
  // SUCCESS CASES (Verify amount can be set on creation)
  // =============================================================================

  it('MUST SUCCEED: set escrow amount on creation', async () => {
    const posterId = await createTestUser(pool, `test-poster-9-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'OPEN');
    
    // Create escrow with amount (should succeed)
    const result = await pool.query(
      `INSERT INTO escrows (task_id, amount, state)
       VALUES ($1, $2, 'PENDING')
       RETURNING id, amount`,
      [taskId, 3000] // $30.00
    );
    
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].amount).toBe(3000);
  });

  it('MUST SUCCEED: verify amount remains unchanged after state change', async () => {
    const posterId = await createTestUser(pool, `test-poster-10-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'ACCEPTED');
    const escrowId = await createTestEscrow(pool, taskId, 'PENDING');
    
    // Get original amount
    const original = await pool.query(
      'SELECT amount FROM escrows WHERE id = $1',
      [escrowId]
    );
    const originalAmount = original.rows[0].amount;
    
    // Change state to FUNDED (should succeed, amount should remain same)
    await pool.query(
      `UPDATE escrows SET state = 'FUNDED', funded_at = NOW() WHERE id = $1`,
      [escrowId]
    );
    
    // Verify amount unchanged
    const after = await pool.query(
      'SELECT amount FROM escrows WHERE id = $1',
      [escrowId]
    );
    expect(after.rows[0].amount).toBe(originalAmount);
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('INV-4 Edge Cases', () => {
  
  it('MUST REJECT: attempt to set amount via direct UPDATE (bypassing state check)', async () => {
    const posterId = await createTestUser(pool, `test-poster-edge-1-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'OPEN');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Attempt to change amount even when state is valid
    await expect(
      pool.query(
        `UPDATE escrows SET amount = $1, state = 'FUNDED' WHERE id = $2`,
        [5000, escrowId]
      )
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });

  it('MUST REJECT: attempt to modify amount in same UPDATE as state change', async () => {
    const posterId = await createTestUser(pool, `test-poster-edge-2-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'ACCEPTED');
    const escrowId = await createTestEscrow(pool, taskId, 'PENDING');
    
    // Attempt to change both state and amount in one UPDATE
    await expect(
      pool.query(
        `UPDATE escrows SET state = 'FUNDED', amount = $1, funded_at = NOW() WHERE id = $2`,
        [8000, escrowId]
      )
    ).rejects.toMatchObject({
      code: 'HX004',
    });
  });
});
