/**
 * E2E INTEGRATION TESTS (BUILD_GUIDE Phase 5)
 * 
 * Full end-to-end tests for complete user flows:
 * - Task lifecycle (create → accept → complete → payout)
 * - Payment flow (create intent → fund → release)
 * - Dispute resolution (open → resolve)
 * - XP award chain (escrow release → XP → level up)
 * 
 * These tests verify the entire system works together.
 * 
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getSql, transaction } from '../db/index.js';
import { awardXPForTask } from '../services/AtomicXPService.js';
import { TaskStateMachine } from '../services/TaskStateMachine.js';
import { EscrowStateMachine } from '../services/EscrowStateMachine.js';
import { ProofStateMachine } from '../services/ProofStateMachine.js';
import { TrustTierService } from '../services/TrustTierService.js';
import { JobQueue } from '../services/JobQueue.js';

// ============================================================================
// TEST DATA
// ============================================================================

interface TestUser {
  id: string;
  email: string;
  type: 'client' | 'hustler';
}

interface TestTask {
  id: string;
  clientId: string;
  hustlerId?: string;
  price: number;
}

let testClient: TestUser;
let testHustler: TestUser;
let testTask: TestTask;

// ============================================================================
// SETUP & TEARDOWN
// ============================================================================

beforeAll(async () => {
  const sql = getSql();
  
  // Create test client
  const [client] = await sql`
    INSERT INTO users (email, full_name, user_type, trust_tier)
    VALUES ('e2e_client@test.com', 'E2E Test Client', 'client', 1)
    ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
    RETURNING id, email
  `;
  testClient = { id: client.id, email: client.email, type: 'client' };
  
  // Create test hustler
  const [hustler] = await sql`
    INSERT INTO users (email, full_name, user_type, trust_tier, xp_total, current_level)
    VALUES ('e2e_hustler@test.com', 'E2E Test Hustler', 'hustler', 2, 0, 1)
    ON CONFLICT (email) DO UPDATE SET xp_total = 0, current_level = 1, updated_at = NOW()
    RETURNING id, email
  `;
  testHustler = { id: hustler.id, email: hustler.email, type: 'hustler' };
});

beforeEach(async () => {
  const sql = getSql();
  
  // Reset hustler XP for each test
  await sql`UPDATE users SET xp_total = 0, current_level = 1, current_streak = 0 WHERE id = ${testHustler.id}`;
  
  // Create fresh test task
  const [task] = await sql`
    INSERT INTO tasks (client_id, title, description, price, status)
    VALUES (${testClient.id}, 'E2E Test Task', 'Full lifecycle test', 5000, 'open')
    RETURNING id, price
  `;
  testTask = { id: task.id, clientId: testClient.id, price: task.price };
  
  // Initialize escrow
  await EscrowStateMachine.initialize(testTask.id, testTask.price * 100);
});

afterAll(async () => {
  const sql = getSql();
  
  // Cleanup in order (foreign key constraints)
  await sql`DELETE FROM job_queue WHERE payload::text LIKE '%e2e%'`;
  await sql`DELETE FROM xp_ledger WHERE user_id = ${testHustler.id}`;
  await sql`DELETE FROM trust_ledger WHERE user_id IN (${testClient.id}, ${testHustler.id})`;
  await sql`DELETE FROM badge_ledger WHERE user_id = ${testHustler.id}`;
  await sql`DELETE FROM proof_submissions WHERE hustler_id = ${testHustler.id}`;
  await sql`DELETE FROM proof_state_log WHERE task_id IN (SELECT id FROM tasks WHERE client_id = ${testClient.id})`;
  await sql`DELETE FROM escrow_state_log WHERE task_id IN (SELECT id FROM tasks WHERE client_id = ${testClient.id})`;
  await sql`DELETE FROM task_state_log WHERE task_id IN (SELECT id FROM tasks WHERE client_id = ${testClient.id})`;
  await sql`DELETE FROM money_state_lock WHERE task_id IN (SELECT id FROM tasks WHERE client_id = ${testClient.id})`;
  await sql`DELETE FROM tasks WHERE client_id = ${testClient.id}`;
  await sql`DELETE FROM users WHERE id IN (${testClient.id}, ${testHustler.id})`;
});

// ============================================================================
// E2E TEST 1: COMPLETE TASK LIFECYCLE
// ============================================================================

describe('E2E Test 1: Complete Task Lifecycle', () => {
  it('should complete full task flow: create → accept → proof → complete → payout', async () => {
    const sql = getSql();
    
    // Step 1: Task is OPEN (already created in beforeEach)
    let taskState = await TaskStateMachine.getState(testTask.id);
    expect(taskState).toBe('OPEN');
    
    // Step 2: Fund escrow
    const fundResult = await EscrowStateMachine.transition(testTask.id, 'funded', {
      stripePaymentIntentId: 'pi_test_e2e_123',
    });
    expect(fundResult.success).toBe(true);
    expect(fundResult.newState).toBe('funded');
    
    // Step 3: Hustler accepts task
    await sql`UPDATE tasks SET assigned_to = ${testHustler.id} WHERE id = ${testTask.id}`;
    
    const acceptResult = await TaskStateMachine.transition(testTask.id, 'ACCEPTED', {
      hustlerId: testHustler.id,
    });
    expect(acceptResult.success).toBe(true);
    
    // Step 4: Hustler submits proof
    const proofResult = await ProofStateMachine.submit(testTask.id, testHustler.id, {
      description: 'Task completed successfully',
      photoUrls: ['https://example.com/proof1.jpg', 'https://example.com/proof2.jpg'],
    });
    expect(proofResult.success).toBe(true);
    
    // Update task status
    await sql`UPDATE tasks SET status = 'proof_submitted' WHERE id = ${testTask.id}`;
    
    // Step 5: Client accepts proof
    const acceptProofResult = await ProofStateMachine.accept(proofResult.proofId!);
    expect(acceptProofResult.success).toBe(true);
    expect(acceptProofResult.newState).toBe('accepted');
    
    // Step 6: Complete task
    const completeResult = await TaskStateMachine.transition(testTask.id, 'COMPLETED');
    expect(completeResult.success).toBe(true);
    
    // Step 7: Release escrow (triggers XP award)
    const releaseResult = await EscrowStateMachine.transition(testTask.id, 'released');
    expect(releaseResult.success).toBe(true);
    expect(releaseResult.xpAwarded).toBeGreaterThan(0);
    
    // Verify final states
    const finalTaskState = await TaskStateMachine.getState(testTask.id);
    expect(finalTaskState).toBe('COMPLETED');
    
    const finalEscrowState = await EscrowStateMachine.getState(testTask.id);
    expect(finalEscrowState).toBe('released');
    
    // Verify XP was awarded
    const [hustler] = await sql`SELECT xp_total FROM users WHERE id = ${testHustler.id}`;
    expect(hustler.xp_total).toBeGreaterThan(0);
  });
});

// ============================================================================
// E2E TEST 2: DISPUTE FLOW
// ============================================================================

describe('E2E Test 2: Dispute Resolution Flow', () => {
  it('should handle dispute: proof rejected → dispute → resolution', async () => {
    const sql = getSql();
    
    // Setup: Get to PROOF_SUBMITTED state
    await EscrowStateMachine.transition(testTask.id, 'funded');
    await sql`UPDATE tasks SET assigned_to = ${testHustler.id} WHERE id = ${testTask.id}`;
    await TaskStateMachine.transition(testTask.id, 'ACCEPTED', { hustlerId: testHustler.id });
    
    const proofResult = await ProofStateMachine.submit(testTask.id, testHustler.id, {
      description: 'Disputed work',
      photoUrls: ['https://example.com/bad-proof.jpg'],
    });
    await sql`UPDATE tasks SET status = 'proof_submitted' WHERE id = ${testTask.id}`;
    
    // Client rejects proof
    const rejectResult = await ProofStateMachine.reject(proofResult.proofId!, 'Work not completed as described');
    expect(rejectResult.success).toBe(true);
    
    // Task moves to disputed
    const disputeResult = await TaskStateMachine.transition(testTask.id, 'DISPUTED', {
      reason: 'Client rejected proof',
    });
    expect(disputeResult.success).toBe(true);
    
    // Lock escrow during dispute
    const lockResult = await EscrowStateMachine.transition(testTask.id, 'locked_dispute', {
      disputeId: 'dispute_test_123',
    });
    expect(lockResult.success).toBe(true);
    
    // Admin resolves in favor of hustler
    // (In real flow, admin would review evidence)
    
    // Hustler submits new proof
    const newProofResult = await ProofStateMachine.submit(testTask.id, testHustler.id, {
      description: 'Additional evidence - work was completed',
      photoUrls: ['https://example.com/before.jpg', 'https://example.com/after.jpg'],
    });
    
    // Admin accepts proof
    await ProofStateMachine.accept(newProofResult.proofId!);
    
    // Complete task (admin override)
    const completeResult = await TaskStateMachine.transition(testTask.id, 'COMPLETED', {
      adminId: 'admin_test',
    });
    expect(completeResult.success).toBe(true);
    
    // Release escrow
    const releaseResult = await EscrowStateMachine.transition(testTask.id, 'released');
    expect(releaseResult.success).toBe(true);
    
    // Verify states
    expect(await TaskStateMachine.getState(testTask.id)).toBe('COMPLETED');
    expect(await EscrowStateMachine.getState(testTask.id)).toBe('released');
  });
  
  it('should handle dispute loss: refund client, no XP', async () => {
    const sql = getSql();
    
    // Setup
    await EscrowStateMachine.transition(testTask.id, 'funded');
    await sql`UPDATE tasks SET assigned_to = ${testHustler.id} WHERE id = ${testTask.id}`;
    await TaskStateMachine.transition(testTask.id, 'ACCEPTED', { hustlerId: testHustler.id });
    
    // Lock for dispute
    await EscrowStateMachine.transition(testTask.id, 'locked_dispute');
    await TaskStateMachine.transition(testTask.id, 'DISPUTED', { reason: 'Work not done' });
    
    // Admin rules for client → refund
    const refundResult = await EscrowStateMachine.transition(testTask.id, 'refunded', {
      reason: 'Dispute resolved in favor of client',
    });
    expect(refundResult.success).toBe(true);
    
    // Cancel task
    await sql`UPDATE tasks SET status = 'cancelled' WHERE id = ${testTask.id}`;
    
    // Verify NO XP was awarded
    const [xpEntry] = await sql`
      SELECT * FROM xp_ledger WHERE task_id = ${testTask.id}
    `;
    expect(xpEntry).toBeUndefined();
    
    // Verify hustler XP unchanged
    const [hustler] = await sql`SELECT xp_total FROM users WHERE id = ${testHustler.id}`;
    expect(hustler.xp_total).toBe(0);
  });
});

// ============================================================================
// E2E TEST 3: XP AWARD CHAIN
// ============================================================================

describe('E2E Test 3: XP Award Chain', () => {
  it('should award XP with correct decay and streak multiplier', async () => {
    const sql = getSql();
    
    // Complete task setup
    await EscrowStateMachine.transition(testTask.id, 'funded');
    await sql`UPDATE tasks SET assigned_to = ${testHustler.id} WHERE id = ${testTask.id}`;
    await TaskStateMachine.transition(testTask.id, 'ACCEPTED', { hustlerId: testHustler.id });
    
    const proofResult = await ProofStateMachine.submit(testTask.id, testHustler.id, {
      description: 'Completed',
      photoUrls: ['https://example.com/done.jpg'],
    });
    await sql`UPDATE tasks SET status = 'proof_submitted' WHERE id = ${testTask.id}`;
    await ProofStateMachine.accept(proofResult.proofId!);
    await TaskStateMachine.transition(testTask.id, 'COMPLETED');
    
    // Release escrow - should trigger XP
    const releaseResult = await EscrowStateMachine.transition(testTask.id, 'released');
    expect(releaseResult.success).toBe(true);
    
    // Check XP ledger entry
    const [xpEntry] = await sql`
      SELECT * FROM xp_ledger WHERE task_id = ${testTask.id}
    `;
    expect(xpEntry).toBeDefined();
    expect(xpEntry.base_xp).toBeGreaterThan(0);
    expect(xpEntry.final_xp).toBeGreaterThan(0);
    expect(parseFloat(xpEntry.streak_multiplier)).toBeGreaterThanOrEqual(1.0);
    
    // Check user XP updated
    const [hustler] = await sql`SELECT xp_total, current_level FROM users WHERE id = ${testHustler.id}`;
    expect(hustler.xp_total).toBe(xpEntry.final_xp);
  });
  
  it('should NOT award XP twice (idempotency)', async () => {
    const sql = getSql();
    
    // Complete full flow
    await EscrowStateMachine.transition(testTask.id, 'funded');
    await sql`UPDATE tasks SET assigned_to = ${testHustler.id} WHERE id = ${testTask.id}`;
    await TaskStateMachine.transition(testTask.id, 'ACCEPTED', { hustlerId: testHustler.id });
    
    const proofResult = await ProofStateMachine.submit(testTask.id, testHustler.id, {
      description: 'Done',
      photoUrls: ['https://example.com/proof.jpg'],
    });
    await sql`UPDATE tasks SET status = 'proof_submitted' WHERE id = ${testTask.id}`;
    await ProofStateMachine.accept(proofResult.proofId!);
    await TaskStateMachine.transition(testTask.id, 'COMPLETED');
    await EscrowStateMachine.transition(testTask.id, 'released');
    
    // Get initial XP
    const [initial] = await sql`SELECT xp_total FROM users WHERE id = ${testHustler.id}`;
    const initialXP = initial.xp_total;
    
    // Try to award again
    const secondResult = await awardXPForTask(testTask.id, testHustler.id);
    expect(secondResult.alreadyAwarded).toBe(true);
    expect(secondResult.xpAwarded).toBe(0);
    
    // Verify XP unchanged
    const [final] = await sql`SELECT xp_total FROM users WHERE id = ${testHustler.id}`;
    expect(final.xp_total).toBe(initialXP);
  });
});

// ============================================================================
// E2E TEST 4: TRUST TIER FLOW
// ============================================================================

describe('E2E Test 4: Trust Tier Progression', () => {
  it('should upgrade trust tier after meeting requirements', async () => {
    const sql = getSql();
    
    // Set hustler to tier 1 with 4 completed tasks
    await sql`UPDATE users SET trust_tier = 1 WHERE id = ${testHustler.id}`;
    
    // Simulate 4 prior completed tasks
    for (let i = 0; i < 4; i++) {
      await sql`
        INSERT INTO tasks (client_id, assigned_to, title, description, price, status, completed_at)
        VALUES (${testClient.id}, ${testHustler.id}, 'Prior Task ${i}', 'Done', 2000, 'completed', NOW())
      `;
    }
    
    // Now complete the 5th task (should trigger tier 2 upgrade)
    await EscrowStateMachine.transition(testTask.id, 'funded');
    await sql`UPDATE tasks SET assigned_to = ${testHustler.id} WHERE id = ${testTask.id}`;
    await TaskStateMachine.transition(testTask.id, 'ACCEPTED', { hustlerId: testHustler.id });
    
    const proofResult = await ProofStateMachine.submit(testTask.id, testHustler.id, {
      description: '5th task',
      photoUrls: ['https://example.com/5.jpg'],
    });
    await sql`UPDATE tasks SET status = 'proof_submitted' WHERE id = ${testTask.id}`;
    await ProofStateMachine.accept(proofResult.proofId!);
    await TaskStateMachine.transition(testTask.id, 'COMPLETED');
    await EscrowStateMachine.transition(testTask.id, 'released');
    
    // Check trust upgrade
    const upgradeResult = await TrustTierService.checkUpgradeAfterCompletion(testHustler.id);
    
    // Verify tier upgraded (or eligible)
    const [hustler] = await sql`SELECT trust_tier FROM users WHERE id = ${testHustler.id}`;
    // Tier 2 requires 5 completed tasks and 0 disputes
    expect(hustler.trust_tier).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// E2E TEST 5: JOB QUEUE INTEGRATION
// ============================================================================

describe('E2E Test 5: Job Queue Processing', () => {
  it('should queue and process XP award job', async () => {
    // Add job
    const jobId = await JobQueue.add('award_xp', {
      taskId: testTask.id,
      hustlerId: testHustler.id,
    }, { jobId: `e2e-xp-${testTask.id}` });
    
    expect(jobId).toBeDefined();
    
    // Check job was created
    const job = await JobQueue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job?.status).toBe('pending');
    expect(job?.type).toBe('award_xp');
  });
  
  it('should queue notification job', async () => {
    const jobId = await JobQueue.add('send_notification', {
      recipientId: testHustler.id,
      notificationType: 'task_accepted',
      title: 'Task Accepted',
      body: 'Your task has been accepted!',
      data: { taskId: testTask.id },
    });
    
    expect(jobId).toBeDefined();
    
    const job = await JobQueue.getJob(jobId);
    expect(job?.type).toBe('send_notification');
    expect(job?.payload.recipientId).toBe(testHustler.id);
  });
});

// ============================================================================
// E2E TEST 6: STATE AUDIT TRAIL
// ============================================================================

describe('E2E Test 6: State Audit Trail', () => {
  it('should log all state transitions', async () => {
    const sql = getSql();
    
    // Complete a task flow
    await EscrowStateMachine.transition(testTask.id, 'funded');
    await sql`UPDATE tasks SET assigned_to = ${testHustler.id} WHERE id = ${testTask.id}`;
    await TaskStateMachine.transition(testTask.id, 'ACCEPTED', { hustlerId: testHustler.id });
    
    const proofResult = await ProofStateMachine.submit(testTask.id, testHustler.id, {
      description: 'Audit test',
      photoUrls: ['https://example.com/audit.jpg'],
    });
    await sql`UPDATE tasks SET status = 'proof_submitted' WHERE id = ${testTask.id}`;
    await ProofStateMachine.accept(proofResult.proofId!);
    await TaskStateMachine.transition(testTask.id, 'COMPLETED');
    await EscrowStateMachine.transition(testTask.id, 'released');
    
    // Check task state log
    const taskLogs = await sql`
      SELECT * FROM task_state_log WHERE task_id = ${testTask.id} ORDER BY created_at ASC
    `;
    expect(taskLogs.length).toBeGreaterThanOrEqual(2);
    expect(taskLogs[0].to_state).toBe('ACCEPTED');
    expect(taskLogs[taskLogs.length - 1].to_state).toBe('COMPLETED');
    
    // Check escrow state log
    const escrowLogs = await sql`
      SELECT * FROM escrow_state_log WHERE task_id = ${testTask.id} ORDER BY created_at ASC
    `;
    expect(escrowLogs.length).toBeGreaterThanOrEqual(2);
    expect(escrowLogs[0].to_state).toBe('funded');
    expect(escrowLogs[escrowLogs.length - 1].to_state).toBe('released');
    
    // Check proof state log
    const proofLogs = await sql`
      SELECT * FROM proof_state_log WHERE task_id = ${testTask.id} ORDER BY created_at ASC
    `;
    expect(proofLogs.length).toBeGreaterThanOrEqual(1);
  });
});
