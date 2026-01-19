/**
 * Trust Engine MVP Invariants - Kill Tests
 * 
 * PURPOSE: Prove that Trust Engine MVP invariants are enforced
 *          These tests MUST FAIL if trust processing correctness is broken
 * 
 * These 5 tests protect against regressions that could cause:
 * - Duplicate trust tier changes on replay
 * - Incorrect tier demotions
 * - Hold application failures
 * - Abuse pattern detection failures
 * - Gating bypass
 * 
 * Trust Engine MVP
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
import { TaskService } from '../../src/services/TaskService';
import type { Job } from 'bullmq';

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
// TRUST INVARIANT 1: Idempotency
// =============================================================================

describe('Trust Invariant 1: Idempotency - Same event processed twice does not demote tier twice', () => {
  
  it('MUST BE IDEMPOTENT: processing same trust event twice does not create duplicate ledger rows or demote tier twice', async () => {
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Set worker to tier 3
    await pool.query(
      'UPDATE users SET trust_tier = 3 WHERE id = $1',
      [workerId]
    );
    
    // Create mock job for trust.dispute_resolved.worker
    const disputeId = 'test-dispute-' + Date.now();
    const idempotencyKey = `trust.dispute_resolved.worker:${disputeId}:1`;
    
    const mockJob = {
      name: 'trust.dispute_resolved.worker',
      id: idempotencyKey,
      data: {
        payload: {
          disputeId,
          taskId,
          escrowId,
          userId: workerId,
          role: 'worker',
          penalty: true,
          outcomeEscrowAction: 'REFUND',
          resolvedBy: 'admin:usr_test',
        },
      },
    } as Job;
    
    // Process trust event first time (dynamic import to avoid DB initialization before test setup)
    const { processTrustJob } = await import('../../src/jobs/trust-worker');
    await processTrustJob(mockJob);
    
    // Verify tier demoted to 2
    const userAfterFirst = await pool.query(
      'SELECT trust_tier FROM users WHERE id = $1',
      [workerId]
    );
    expect(userAfterFirst.rows[0].trust_tier).toBe(2);
    
    // Count ledger entries
    const ledgerAfterFirst = await pool.query(
      'SELECT COUNT(*) as count FROM trust_ledger WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    expect(parseInt(ledgerAfterFirst.rows[0].count, 10)).toBe(1);
    
    // Process trust event second time (idempotent replay)
    await processTrustJob(mockJob); // Already imported above
    
    // Verify tier is still 2 (not demoted again)
    const userAfterSecond = await pool.query(
      'SELECT trust_tier FROM users WHERE id = $1',
      [workerId]
    );
    expect(userAfterSecond.rows[0].trust_tier).toBe(2);
    
    // Verify still only 1 ledger entry (ON CONFLICT DO NOTHING)
    const ledgerAfterSecond = await pool.query(
      'SELECT COUNT(*) as count FROM trust_ledger WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    expect(parseInt(ledgerAfterSecond.rows[0].count, 10)).toBe(1);
  });
});

// =============================================================================
// TRUST INVARIANT 2: Worker penalty demotion
// =============================================================================

describe('Trust Invariant 2: Worker penalty demotes tier by exactly 1, floored at 1', () => {
  
  it('MUST DEMOTE: worker penalty demotes tier by 1, floored at 1', async () => {
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Set worker to tier 2
    await pool.query(
      'UPDATE users SET trust_tier = 2 WHERE id = $1',
      [workerId]
    );
    
    // Create mock job for trust.dispute_resolved.worker with penalty
    const disputeId = 'test-dispute-' + Date.now();
    
    const mockJob = {
      name: 'trust.dispute_resolved.worker',
      id: `trust.dispute_resolved.worker:${disputeId}:1`,
      data: {
        payload: {
          disputeId,
          taskId,
          escrowId,
          userId: workerId,
          role: 'worker',
          penalty: true,
          outcomeEscrowAction: 'RELEASE',
          resolvedBy: 'admin:usr_test',
        },
      },
    } as Job;
    
    // Process trust event (dynamic import)
    const { processTrustJob: processTrustJobWorker } = await import('../../src/jobs/trust-worker');
    await processTrustJobWorker(mockJob);
    
    // Verify tier demoted from 2 to 1
    const userResult = await pool.query(
      'SELECT trust_tier FROM users WHERE id = $1',
      [workerId]
    );
    expect(userResult.rows[0].trust_tier).toBe(1);
    
    // Verify ledger entry reflects correct old/new tiers
    const ledgerResult = await pool.query(
      `SELECT old_tier, new_tier, reason FROM trust_ledger 
       WHERE user_id = $1 AND dispute_id = $2`,
      [workerId, disputeId]
    );
    expect(ledgerResult.rows.length).toBe(1);
    expect(ledgerResult.rows[0].old_tier).toBe(2);
    expect(ledgerResult.rows[0].new_tier).toBe(1);
    expect(ledgerResult.rows[0].reason).toBe('dispute_penalty');
  });
  
  it('MUST FLOOR: worker at tier 1 with penalty stays at tier 1', async () => {
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Set worker to tier 1 (already at floor)
    await pool.query(
      'UPDATE users SET trust_tier = 1 WHERE id = $1',
      [workerId]
    );
    
    // Create mock job for trust.dispute_resolved.worker with penalty
    const disputeId = 'test-dispute-' + Date.now();
    
    const mockJob = {
      name: 'trust.dispute_resolved.worker',
      id: `trust.dispute_resolved.worker:${disputeId}:1`,
      data: {
        payload: {
          disputeId,
          taskId,
          escrowId,
          userId: workerId,
          role: 'worker',
          penalty: true,
          outcomeEscrowAction: 'RELEASE',
          resolvedBy: 'admin:usr_test',
        },
      },
    } as Job;
    
    // Process trust event (dynamic import)
    const { processTrustJob: processTrustJobFloor } = await import('../../src/jobs/trust-worker');
    await processTrustJobFloor(mockJob);
    
    // Verify tier stays at 1 (floor)
    const userResult = await pool.query(
      'SELECT trust_tier FROM users WHERE id = $1',
      [workerId]
    );
    expect(userResult.rows[0].trust_tier).toBe(1);
  });
});

// =============================================================================
// TRUST INVARIANT 3: Worker hold application
// =============================================================================

describe('Trust Invariant 3: Worker demoted to tier 1 with REFUND/SPLIT enters hold', () => {
  
  it('MUST HOLD: worker demoted to tier 1 with REFUND enters hold', async () => {
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Set worker to tier 2
    await pool.query(
      'UPDATE users SET trust_tier = 2 WHERE id = $1',
      [workerId]
    );
    
    // Create mock job for trust.dispute_resolved.worker with penalty and REFUND
    const disputeId = 'test-dispute-' + Date.now();
    
    const mockJob = {
      name: 'trust.dispute_resolved.worker',
      id: `trust.dispute_resolved.worker:${disputeId}:1`,
      data: {
        payload: {
          disputeId,
          taskId,
          escrowId,
          userId: workerId,
          role: 'worker',
          penalty: true,
          outcomeEscrowAction: 'REFUND',
          resolvedBy: 'admin:usr_test',
        },
      },
    } as Job;
    
    // Process trust event (dynamic import)
    const { processTrustJob: processTrustJob3 } = await import('../../src/jobs/trust-worker');
    await processTrustJob3(mockJob);
    
    // Verify tier demoted to 1
    const userResult = await pool.query(
      'SELECT trust_tier, trust_hold, trust_hold_reason, trust_hold_until FROM users WHERE id = $1',
      [workerId]
    );
    expect(userResult.rows[0].trust_tier).toBe(1);
    expect(userResult.rows[0].trust_hold).toBe(true);
    expect(userResult.rows[0].trust_hold_reason).not.toBeNull();
    expect(userResult.rows[0].trust_hold_until).not.toBeNull();
    expect(new Date(userResult.rows[0].trust_hold_until) > new Date()).toBe(true);
  });
  
  it('MUST HOLD: worker demoted to tier 1 with SPLIT enters hold', async () => {
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const taskId = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId = await createTestEscrow(pool, taskId, 'FUNDED');
    
    // Set worker to tier 2
    await pool.query(
      'UPDATE users SET trust_tier = 2 WHERE id = $1',
      [workerId]
    );
    
    // Create mock job for trust.dispute_resolved.worker with penalty and SPLIT
    const disputeId = 'test-dispute-' + Date.now();
    
    const mockJob = {
      name: 'trust.dispute_resolved.worker',
      id: `trust.dispute_resolved.worker:${disputeId}:1`,
      data: {
        payload: {
          disputeId,
          taskId,
          escrowId,
          userId: workerId,
          role: 'worker',
          penalty: true,
          outcomeEscrowAction: 'SPLIT',
          resolvedBy: 'admin:usr_test',
        },
      },
    } as Job;
    
    // Process trust event (dynamic import)
    const { processTrustJob: processTrustJob4 } = await import('../../src/jobs/trust-worker');
    await processTrustJob4(mockJob);
    
    // Verify tier demoted to 1 and hold applied
    const userResult = await pool.query(
      'SELECT trust_tier, trust_hold, trust_hold_reason, trust_hold_until FROM users WHERE id = $1',
      [workerId]
    );
    expect(userResult.rows[0].trust_tier).toBe(1);
    expect(userResult.rows[0].trust_hold).toBe(true);
    expect(userResult.rows[0].trust_hold_reason).not.toBeNull();
    expect(userResult.rows[0].trust_hold_until).not.toBeNull();
  });
});

// =============================================================================
// TRUST INVARIANT 4: Poster abuse hold
// =============================================================================

describe('Trust Invariant 4: Poster receives hold after 2 penalties in 30 days', () => {
  
  it('MUST HOLD: poster with 2 penalties in 30 days enters hold', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId1 = await createTestUser(pool, `test-worker1-${Date.now()}@hustlexp.test`);
    const workerId2 = await createTestUser(pool, `test-worker2-${Date.now()}@hustlexp.test`);
    const taskId1 = await createTestTask(pool, posterId, 'COMPLETED');
    const taskId2 = await createTestTask(pool, posterId, 'COMPLETED');
    const escrowId1 = await createTestEscrow(pool, taskId1, 'FUNDED');
    const escrowId2 = await createTestEscrow(pool, taskId2, 'FUNDED');
    
    // Insert first penalty in trust_ledger (within last 30 days)
    const disputeId1 = 'test-dispute-1-' + Date.now();
    await pool.query(
      `INSERT INTO trust_ledger (
        user_id, old_tier, new_tier, reason, 
        task_id, dispute_id, changed_by,
        idempotency_key, event_source, source_event_id
      ) VALUES ($1, 2, 1, 'dispute_penalty', $2, $3, 'admin:usr_test',
        $4, 'dispute', $3)`,
      [posterId, taskId1, disputeId1, `trust.dispute_resolved.poster:${disputeId1}:1`]
    );
    
    // Create mock job for second penalty
    const disputeId2 = 'test-dispute-2-' + Date.now();
    
    const mockJob = {
      name: 'trust.dispute_resolved.poster',
      id: `trust.dispute_resolved.poster:${disputeId2}:1`,
      data: {
        payload: {
          disputeId: disputeId2,
          taskId: taskId2,
          escrowId: escrowId2,
          userId: posterId,
          role: 'poster',
          penalty: true,
          outcomeEscrowAction: 'REFUND',
          resolvedBy: 'admin:usr_test',
        },
      },
    } as Job;
    
    // Process trust event (second penalty - dynamic import)
    const { processTrustJob: processTrustJob5 } = await import('../../src/jobs/trust-worker');
    await processTrustJob5(mockJob);
    
    // Verify hold applied
    const userResult = await pool.query(
      'SELECT trust_hold, trust_hold_reason, trust_hold_until FROM users WHERE id = $1',
      [posterId]
    );
    expect(userResult.rows[0].trust_hold).toBe(true);
    expect(userResult.rows[0].trust_hold_reason).not.toBeNull();
    expect(userResult.rows[0].trust_hold_until).not.toBeNull();
    
    // Verify hold duration is 14 days (per spec)
    const holdUntil = new Date(userResult.rows[0].trust_hold_until);
    const now = new Date();
    const daysDiff = (holdUntil.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysDiff).toBeGreaterThan(13);
    expect(daysDiff).toBeLessThan(15);
  });
});

// =============================================================================
// TRUST INVARIANT 5: Gating enforcement
// =============================================================================

describe('Trust Invariant 5: Gating enforcement - Hold blocks non-LOW tasks', () => {
  
  it('MUST BLOCK: poster on hold cannot create HIGH risk task', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    
    // Set poster on hold
    const holdUntil = new Date();
    holdUntil.setDate(holdUntil.getDate() + 7); // 7 days from now
    
    await pool.query(
      'UPDATE users SET trust_hold = true, trust_hold_reason = $1, trust_hold_until = $2 WHERE id = $3',
      ['dispute_penalty_abuse_pattern', holdUntil, posterId]
    );
    
    // Attempt to create HIGH risk task (should fail)
    const result = await TaskService.create({
      posterId,
      title: 'Test Task',
      description: 'Test Description',
      price: 5000,
      risk_level: 'HIGH',
    });
    
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.error?.message).toContain('trust hold');
    expect(result.error?.message).toContain('LOW risk');
  });
  
  it('MUST ALLOW: poster on hold can create LOW risk task', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    
    // Set poster on hold
    const holdUntil = new Date();
    holdUntil.setDate(holdUntil.getDate() + 7); // 7 days from now
    
    await pool.query(
      'UPDATE users SET trust_hold = true, trust_hold_reason = $1, trust_hold_until = $2 WHERE id = $3',
      ['dispute_penalty_abuse_pattern', holdUntil, posterId]
    );
    
    // Attempt to create LOW risk task (should succeed)
    const result = await TaskService.create({
      posterId,
      title: 'Test Task',
      description: 'Test Description',
      price: 5000,
      risk_level: 'LOW',
    });
    
    expect(result.success).toBe(true);
  });
  
  it('MUST BLOCK: worker on hold cannot accept IN_HOME risk task', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    
    // Set worker on hold
    const holdUntil = new Date();
    holdUntil.setDate(holdUntil.getDate() + 7); // 7 days from now
    
    await pool.query(
      'UPDATE users SET trust_hold = true, trust_hold_reason = $1, trust_hold_until = $2 WHERE id = $3',
      ['dispute_penalty_tier_1_refund', holdUntil, workerId]
    );
    
    // Create IN_HOME risk task
    const taskResult = await TaskService.create({
      posterId,
      title: 'Test Task',
      description: 'Test Description',
      price: 5000,
      risk_level: 'IN_HOME',
    });
    
    expect(taskResult.success).toBe(true);
    const taskId = taskResult.data.id;
    
    // Attempt to accept task (should fail)
    const acceptResult = await TaskService.accept({
      taskId,
      workerId,
    });
    
    expect(acceptResult.success).toBe(false);
    expect(acceptResult.error?.code).toBe('FORBIDDEN');
    expect(acceptResult.error?.message).toContain('trust hold');
    expect(acceptResult.error?.message).toContain('HIGH or IN_HOME');
  });
  
  it('MUST BLOCK: worker on hold cannot accept HIGH risk task', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    
    // Set worker on hold
    const holdUntil = new Date();
    holdUntil.setDate(holdUntil.getDate() + 7); // 7 days from now
    
    await pool.query(
      'UPDATE users SET trust_hold = true, trust_hold_reason = $1, trust_hold_until = $2 WHERE id = $3',
      ['dispute_penalty_tier_1_refund', holdUntil, workerId]
    );
    
    // Create HIGH risk task
    const taskResult = await TaskService.create({
      posterId,
      title: 'Test Task',
      description: 'Test Description',
      price: 5000,
      risk_level: 'HIGH',
    });
    
    expect(taskResult.success).toBe(true);
    const taskId = taskResult.data.id;
    
    // Attempt to accept task (should fail)
    const acceptResult = await TaskService.accept({
      taskId,
      workerId,
    });
    
    expect(acceptResult.success).toBe(false);
    expect(acceptResult.error?.code).toBe('FORBIDDEN');
    expect(acceptResult.error?.message).toContain('trust hold');
    expect(acceptResult.error?.message).toContain('HIGH or IN_HOME');
  });
  
  it('MUST ALLOW: worker on hold can accept LOW risk task', async () => {
    const posterId = await createTestUser(pool, `test-poster-${Date.now()}@hustlexp.test`);
    const workerId = await createTestUser(pool, `test-worker-${Date.now()}@hustlexp.test`);
    
    // Set worker on hold
    const holdUntil = new Date();
    holdUntil.setDate(holdUntil.getDate() + 7); // 7 days from now
    
    await pool.query(
      'UPDATE users SET trust_hold = true, trust_hold_reason = $1, trust_hold_until = $2 WHERE id = $3',
      ['dispute_penalty_tier_1_refund', holdUntil, workerId]
    );
    
    // Create LOW risk task
    const taskResult = await TaskService.create({
      posterId,
      title: 'Test Task',
      description: 'Test Description',
      price: 5000,
      risk_level: 'LOW',
    });
    
    expect(taskResult.success).toBe(true);
    const taskId = taskResult.data.id;
    
    // Attempt to accept task (should succeed - hold doesn't block LOW)
    const acceptResult = await TaskService.accept({
      taskId,
      workerId,
    });
    
    expect(acceptResult.success).toBe(true);
  });
});
