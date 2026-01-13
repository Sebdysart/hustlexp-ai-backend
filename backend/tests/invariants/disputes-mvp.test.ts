/**
 * Dispute MVP Invariants - Kill Tests
 * 
 * PURPOSE: Prove that Dispute MVP invariants are enforced
 *          These tests MUST FAIL if dispute processing correctness is broken
 * 
 * These 5 tests protect against regressions that could cause:
 * - Disputes created without locking escrow
 * - Disputes created outside time windows
 * - Resolutions when escrow is not LOCKED_DISPUTE
 * - SPLIT resolutions that don't sum correctly
 * - Terminal dispute transitions
 * 
 * Dispute Resolution MVP
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
  
  const result = await pool.query('SELECT version FROM schema_versions LIMIT 1');
  console.log('Connected to database with schema version:', result.rows[0]?.version);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await cleanupTestData(pool);
});

// =============================================================================
// DISPUTE INVARIANT 1: Dispute creation locks escrow FUNDED→LOCKED_DISPUTE
// =============================================================================

describe('Dispute Invariant 1: Dispute creation locks escrow FUNDED→LOCKED_DISPUTE', () => {
  
  it('MUST LOCK: dispute creation atomically locks escrow to LOCKED_DISPUTE', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Set task completed_at to within 48h window
    const completedAt = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago
    await pool.query(
      `UPDATE tasks SET completed_at = $1 WHERE id = $2`,
      [completedAt, taskId]
    );
    
    // Create dispute using DisputeService (should lock escrow atomically in transaction)
    const { DisputeService } = await import('../../src/services/DisputeService');
    
    const result = await DisputeService.create({
      taskId,
      escrowId,
      initiatedBy: posterId,
      posterId,
      workerId,
      reason: 'test',
      description: 'test',
    });
    
    expect(result.success).toBe(true);
    
    // Transaction should have locked escrow
    const escrowResult = await pool.query(
      'SELECT state FROM escrows WHERE id = $1',
      [escrowId]
    );
    
    expect(escrowResult.rows[0].state).toBe('LOCKED_DISPUTE');
  });
});

// =============================================================================
// DISPUTE INVARIANT 2: Cannot create dispute outside 48h window
// =============================================================================

describe('Dispute Invariant 2: Cannot create dispute if outside 48h window', () => {
  
  it('MUST REJECT: dispute creation outside 48h window', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Set task completed_at to >48h ago
    const completedAt = new Date(Date.now() - 49 * 60 * 60 * 1000); // 49h ago
    await pool.query(
      `UPDATE tasks SET completed_at = $1 WHERE id = $2`,
      [completedAt, taskId]
    );
    
    // Try to create dispute (should fail - application logic check)
    // Note: This is an application-level check, not DB constraint
    // We test that the service rejects it
    const { DisputeService } = await import('../../src/services/DisputeService');
    
    const result = await DisputeService.create({
      taskId,
      escrowId,
      initiatedBy: posterId,
      posterId,
      workerId,
      reason: 'test',
      description: 'test',
    });
    
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('48 hours');
  });
});

// =============================================================================
// DISPUTE INVARIANT 3: Cannot resolve unless escrow is LOCKED_DISPUTE
// =============================================================================

describe('Dispute Invariant 3: Cannot resolve unless escrow is LOCKED_DISPUTE', () => {
  
  it('MUST REJECT: resolve dispute when escrow is not LOCKED_DISPUTE', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const adminId = await createTestUser(pool, `test-admin-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED'); // NOT LOCKED_DISPUTE
    
    // Create admin role with can_resolve_disputes
    await pool.query(
      `INSERT INTO admin_roles (user_id, role, can_resolve_disputes)
       VALUES ($1, 'admin', TRUE)`,
      [adminId]
    );
    
    // Create dispute (should lock escrow)
    const disputeResult = await pool.query(
      `INSERT INTO disputes (
        task_id, escrow_id, initiated_by, poster_id, worker_id,
        reason, description, state, version
      ) VALUES ($1, $2, $3, $4, $5, 'test', 'test', 'OPEN', 1)
      RETURNING id`,
      [taskId, escrowId, posterId, posterId, workerId]
    );
    
    const disputeId = disputeResult.rows[0].id;
    
    // Manually set escrow back to FUNDED (violates invariant)
    await pool.query(
      `UPDATE escrows SET state = 'FUNDED' WHERE id = $1`,
      [escrowId]
    );
    
    // Try to resolve (should fail - escrow must be LOCKED_DISPUTE)
    const { DisputeService } = await import('../../src/services/DisputeService');
    
    const result = await DisputeService.resolve({
      disputeId,
      resolvedBy: adminId,
      resolution: 'test',
      outcomeEscrowAction: 'RELEASE',
    });
    
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('LOCKED_DISPUTE');
  });
});

// =============================================================================
// DISPUTE INVARIANT 4: SPLIT resolution must sum to escrow.amount
// =============================================================================

describe('Dispute Invariant 4: SPLIT resolution must sum to escrow.amount', () => {
  
  it('MUST REJECT: SPLIT resolution with amounts that do not sum to escrow.amount', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const adminId = await createTestUser(pool, `test-admin-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Set escrow amount to 10000 (100.00)
    await pool.query(
      `UPDATE escrows SET amount = 10000 WHERE id = $1`,
      [escrowId]
    );
    
    // Create admin role
    await pool.query(
      `INSERT INTO admin_roles (user_id, role, can_resolve_disputes)
       VALUES ($1, 'admin', TRUE)`,
      [adminId]
    );
    
    // Create dispute (locks escrow)
    const disputeResult = await pool.query(
      `INSERT INTO disputes (
        task_id, escrow_id, initiated_by, poster_id, worker_id,
        reason, description, state, version
      ) VALUES ($1, $2, $3, $4, $5, 'test', 'test', 'OPEN', 1)
      RETURNING id`,
      [taskId, escrowId, posterId, posterId, workerId]
    );
    
    const disputeId = disputeResult.rows[0].id;
    
    // Try to resolve with SPLIT amounts that don't sum (should fail)
    const { DisputeService } = await import('../../src/services/DisputeService');
    
    const result = await DisputeService.resolve({
      disputeId,
      resolvedBy: adminId,
      resolution: 'test',
      outcomeEscrowAction: 'SPLIT',
      refundAmount: 3000, // 30.00
      releaseAmount: 8000, // 80.00 = 110.00 total (should be 100.00)
    });
    
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('sum to escrow amount');
  });
});

// =============================================================================
// DISPUTE INVARIANT 5: Dispute is terminal (RESOLVED cannot transition)
// =============================================================================

describe('Dispute Invariant 5: Dispute is terminal (RESOLVED cannot transition)', () => {
  
  it('MUST REJECT: resolve dispute when already RESOLVED', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const adminId = await createTestUser(pool, `test-admin-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Create admin role
    await pool.query(
      `INSERT INTO admin_roles (user_id, role, can_resolve_disputes)
       VALUES ($1, 'admin', TRUE)`,
      [adminId]
    );
    
    // Create dispute and resolve it
    const disputeResult = await pool.query(
      `INSERT INTO disputes (
        task_id, escrow_id, initiated_by, poster_id, worker_id,
        reason, description, state, version
      ) VALUES ($1, $2, $3, $4, $5, 'test', 'test', 'OPEN', 1)
      RETURNING id`,
      [taskId, escrowId, posterId, posterId, workerId]
    );
    
    const disputeId = disputeResult.rows[0].id;
    
    // Manually set dispute to RESOLVED (simulating already resolved)
    await pool.query(
      `UPDATE disputes SET state = 'RESOLVED', version = 2 WHERE id = $1`,
      [disputeId]
    );
    
    // Try to resolve again (should fail - already RESOLVED)
    const { DisputeService } = await import('../../src/services/DisputeService');
    
    const result = await DisputeService.resolve({
      disputeId,
      resolvedBy: adminId,
      resolution: 'test',
      outcomeEscrowAction: 'RELEASE',
    });
    
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('already resolved');
  });
});
