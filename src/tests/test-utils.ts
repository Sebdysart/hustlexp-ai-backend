/**
 * TEST UTILITIES (BUILD_GUIDE Phase 5)
 * 
 * Common utilities for test suites.
 * 
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */

import { getSql } from '../db/index.js';

// ============================================================================
// TEST DATA FACTORIES
// ============================================================================

/**
 * Create a test user
 */
export async function createTestUser(overrides: {
  email?: string;
  type?: 'client' | 'hustler';
  trustTier?: number;
} = {}): Promise<{ id: string; email: string }> {
  const sql = getSql();
  const email = overrides.email || `test_${Date.now()}_${Math.random().toString(36).slice(2)}@test.com`;
  
  const [user] = await sql`
    INSERT INTO users (email, full_name, user_type, trust_tier)
    VALUES (
      ${email},
      'Test User',
      ${overrides.type || 'hustler'},
      ${overrides.trustTier || 1}
    )
    ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
    RETURNING id, email
  `;
  
  return { id: user.id, email: user.email };
}

/**
 * Create a test task with escrow
 */
export async function createTestTask(
  clientId: string,
  overrides: {
    price?: number;
    status?: string;
    hustlerId?: string;
  } = {}
): Promise<{ id: string; price: number }> {
  const sql = getSql();
  const price = overrides.price || 5000;
  
  const [task] = await sql`
    INSERT INTO tasks (
      client_id,
      assigned_to,
      title,
      description,
      price,
      status
    )
    VALUES (
      ${clientId},
      ${overrides.hustlerId || null},
      'Test Task',
      'Test description',
      ${price},
      ${overrides.status || 'open'}
    )
    RETURNING id, price
  `;
  
  // Initialize escrow
  await sql`
    INSERT INTO money_state_lock (task_id, current_state, amount_cents)
    VALUES (${task.id}, 'pending', ${price * 100})
    ON CONFLICT (task_id) DO NOTHING
  `;
  
  return { id: task.id, price: task.price };
}

/**
 * Complete a task flow (for setup)
 */
export async function completeTaskFlow(
  taskId: string,
  hustlerId: string
): Promise<void> {
  const sql = getSql();
  const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');
  const { TaskStateMachine } = await import('../services/TaskStateMachine.js');
  const { ProofStateMachine } = await import('../services/ProofStateMachine.js');
  
  await EscrowStateMachine.transition(taskId, 'funded');
  await sql`UPDATE tasks SET assigned_to = ${hustlerId} WHERE id = ${taskId}`;
  await TaskStateMachine.transition(taskId, 'ACCEPTED', { hustlerId });
  
  const proofResult = await ProofStateMachine.submit(taskId, hustlerId, {
    description: 'Test completion',
    photoUrls: ['https://example.com/proof.jpg'],
  });
  await sql`UPDATE tasks SET status = 'proof_submitted' WHERE id = ${taskId}`;
  await ProofStateMachine.accept(proofResult.proofId!);
  await TaskStateMachine.transition(taskId, 'COMPLETED');
  await EscrowStateMachine.transition(taskId, 'released');
}

// ============================================================================
// CLEANUP UTILITIES
// ============================================================================

/**
 * Clean up all test data for a user
 */
export async function cleanupTestUser(userId: string): Promise<void> {
  const sql = getSql();
  
  // Get task IDs
  const tasks = await sql`SELECT id FROM tasks WHERE client_id = ${userId} OR assigned_to = ${userId}`;
  const taskIds = tasks.map((t: any) => t.id);
  
  if (taskIds.length > 0) {
    await sql`DELETE FROM xp_ledger WHERE task_id = ANY(${taskIds})`;
    await sql`DELETE FROM proof_state_log WHERE task_id = ANY(${taskIds})`;
    await sql`DELETE FROM escrow_state_log WHERE task_id = ANY(${taskIds})`;
    await sql`DELETE FROM task_state_log WHERE task_id = ANY(${taskIds})`;
    await sql`DELETE FROM proof_submissions WHERE task_id = ANY(${taskIds})`;
    await sql`DELETE FROM money_state_lock WHERE task_id = ANY(${taskIds})`;
    await sql`DELETE FROM tasks WHERE id = ANY(${taskIds})`;
  }
  
  await sql`DELETE FROM trust_ledger WHERE user_id = ${userId}`;
  await sql`DELETE FROM badge_ledger WHERE user_id = ${userId}`;
  await sql`DELETE FROM xp_ledger WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/**
 * Assert XP was awarded exactly once
 */
export async function assertXPAwardedOnce(taskId: string): Promise<number> {
  const sql = getSql();
  
  const entries = await sql`SELECT * FROM xp_ledger WHERE task_id = ${taskId}`;
  
  if (entries.length !== 1) {
    throw new Error(`Expected exactly 1 XP entry, got ${entries.length}`);
  }
  
  return entries[0].final_xp;
}

/**
 * Assert state machine is in expected state
 */
export async function assertTaskState(taskId: string, expected: string): Promise<void> {
  const { TaskStateMachine } = await import('../services/TaskStateMachine.js');
  const actual = await TaskStateMachine.getState(taskId);
  
  if (actual !== expected) {
    throw new Error(`Expected task state ${expected}, got ${actual}`);
  }
}

export async function assertEscrowState(taskId: string, expected: string): Promise<void> {
  const { EscrowStateMachine } = await import('../services/EscrowStateMachine.js');
  const actual = await EscrowStateMachine.getState(taskId);
  
  if (actual !== expected) {
    throw new Error(`Expected escrow state ${expected}, got ${actual}`);
  }
}

// ============================================================================
// TIMING UTILITIES
// ============================================================================

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run with timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}
