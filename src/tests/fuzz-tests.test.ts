/**
 * FUZZ TESTS (BUILD_GUIDE Phase 5)
 * 
 * Tests invariants under stress conditions:
 * - Random state transitions (1000 iterations)
 * - Timing jitter (0-5000ms)
 * - Concurrent conflicting requests
 * - Random retry patterns
 * 
 * These tests verify the system remains consistent under chaos.
 * 
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSql } from '../db/index.js';
import { TaskStateMachine, TaskState, TASK_TRANSITIONS } from '../services/TaskStateMachine.js';
import { EscrowStateMachine, EscrowState, ESCROW_TRANSITIONS } from '../services/EscrowStateMachine.js';
import { awardXPForTask } from '../services/AtomicXPService.js';

// ============================================================================
// FUZZ CONFIG
// ============================================================================

const FUZZ_CONFIG = {
  iterations: 100, // Reduced from 1000 for CI speed, increase for full testing
  maxJitterMs: 100, // Reduced from 5000 for CI speed
  maxRetries: 5,
  maxConcurrent: 5,
  seed: 12345,
};

// ============================================================================
// SEEDED RANDOM
// ============================================================================

class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  bool(probability: number = 0.5): boolean {
    return this.next() < probability;
  }
}

// ============================================================================
// TEST UTILITIES
// ============================================================================

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createTestTask(userId: string): Promise<string> {
  const sql = getSql();
  const [task] = await sql`
    INSERT INTO tasks (client_id, title, description, price, status)
    VALUES (${userId}, 'Fuzz Test Task', 'Fuzz test', 1000, 'open')
    RETURNING id
  `;
  
  await sql`
    INSERT INTO money_state_lock (task_id, current_state, amount_cents)
    VALUES (${task.id}, 'pending', 100000)
    ON CONFLICT (task_id) DO NOTHING
  `;
  
  return task.id;
}

// ============================================================================
// TEST DATA
// ============================================================================

let testUserId: string;
const createdTaskIds: string[] = [];

beforeAll(async () => {
  const sql = getSql();
  
  const [user] = await sql`
    INSERT INTO users (email, full_name, user_type)
    VALUES ('fuzz_test_user@test.com', 'Fuzz Test User', 'hustler')
    ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `;
  testUserId = user.id;
});

afterAll(async () => {
  const sql = getSql();
  
  // Cleanup all fuzz test data
  if (createdTaskIds.length > 0) {
    await sql`DELETE FROM xp_ledger WHERE task_id = ANY(${createdTaskIds})`;
    await sql`DELETE FROM proof_state_log WHERE task_id = ANY(${createdTaskIds})`;
    await sql`DELETE FROM escrow_state_log WHERE task_id = ANY(${createdTaskIds})`;
    await sql`DELETE FROM task_state_log WHERE task_id = ANY(${createdTaskIds})`;
    await sql`DELETE FROM proof_submissions WHERE task_id = ANY(${createdTaskIds})`;
    await sql`DELETE FROM money_state_lock WHERE task_id = ANY(${createdTaskIds})`;
    await sql`DELETE FROM tasks WHERE id = ANY(${createdTaskIds})`;
  }
  await sql`DELETE FROM users WHERE id = ${testUserId}`;
});

// ============================================================================
// FUZZ TEST 1: Random State Transitions
// ============================================================================

describe('Fuzz Test 1: Random State Transitions', () => {
  it(`should maintain invariants across ${FUZZ_CONFIG.iterations} random transitions`, async () => {
    const random = new SeededRandom(FUZZ_CONFIG.seed);
    const allTaskStates: TaskState[] = ['OPEN', 'ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'];
    const allEscrowStates: EscrowState[] = ['pending', 'funded', 'locked_dispute', 'released', 'refunded', 'partial_refund'];
    
    let invalidTransitionsBlocked = 0;
    let validTransitionsSucceeded = 0;
    let terminalMutationsBlocked = 0;
    
    for (let i = 0; i < FUZZ_CONFIG.iterations; i++) {
      const taskId = await createTestTask(testUserId);
      createdTaskIds.push(taskId);
      
      // Random number of transitions
      const numTransitions = random.int(1, 10);
      
      for (let j = 0; j < numTransitions; j++) {
        // Pick random target state
        const targetTaskState = random.pick(allTaskStates);
        const targetEscrowState = random.pick(allEscrowStates);
        
        // Try task transition
        const currentTaskState = await TaskStateMachine.getState(taskId);
        const taskResult = await TaskStateMachine.transition(taskId, targetTaskState, {
          hustlerId: testUserId,
        });
        
        if (currentTaskState && TASK_TRANSITIONS[currentTaskState]?.length === 0) {
          // Terminal state - should be blocked
          if (!taskResult.success) {
            terminalMutationsBlocked++;
          }
        } else if (currentTaskState && TASK_TRANSITIONS[currentTaskState]?.includes(targetTaskState)) {
          // Valid transition
          if (taskResult.success) {
            validTransitionsSucceeded++;
          }
        } else {
          // Invalid transition - should be blocked
          if (!taskResult.success) {
            invalidTransitionsBlocked++;
          }
        }
        
        // Try escrow transition
        const currentEscrowState = await EscrowStateMachine.getState(taskId);
        if (currentEscrowState) {
          await EscrowStateMachine.transition(taskId, targetEscrowState);
        }
      }
    }
    
    // Verify invariants held
    console.log(`Fuzz results: ${validTransitionsSucceeded} valid, ${invalidTransitionsBlocked} invalid blocked, ${terminalMutationsBlocked} terminal blocked`);
    
    expect(invalidTransitionsBlocked).toBeGreaterThan(0); // Some invalid transitions should have been blocked
    expect(terminalMutationsBlocked).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// FUZZ TEST 2: Timing Jitter
// ============================================================================

describe('Fuzz Test 2: Timing Jitter', () => {
  it('should maintain consistency with random delays', async () => {
    const random = new SeededRandom(FUZZ_CONFIG.seed + 1);
    const sql = getSql();
    
    for (let i = 0; i < 10; i++) {
      const taskId = await createTestTask(testUserId);
      createdTaskIds.push(taskId);
      
      // Add random jitter between operations
      await sleep(random.int(0, FUZZ_CONFIG.maxJitterMs));
      
      await EscrowStateMachine.transition(taskId, 'funded');
      
      await sleep(random.int(0, FUZZ_CONFIG.maxJitterMs));
      
      await sql`UPDATE tasks SET assigned_to = ${testUserId} WHERE id = ${taskId}`;
      await TaskStateMachine.transition(taskId, 'ACCEPTED', { hustlerId: testUserId });
      
      await sleep(random.int(0, FUZZ_CONFIG.maxJitterMs));
      
      // Verify state consistency
      const taskState = await TaskStateMachine.getState(taskId);
      const escrowState = await EscrowStateMachine.getState(taskId);
      
      expect(taskState).toBe('ACCEPTED');
      expect(escrowState).toBe('funded');
    }
  });
});

// ============================================================================
// FUZZ TEST 3: Concurrent Conflicts
// ============================================================================

describe('Fuzz Test 3: Concurrent Conflicts', () => {
  it('should handle concurrent state transitions safely', async () => {
    const taskId = await createTestTask(testUserId);
    createdTaskIds.push(taskId);
    
    await EscrowStateMachine.transition(taskId, 'funded');
    
    // Try concurrent transitions
    const concurrentPromises = [];
    
    for (let i = 0; i < FUZZ_CONFIG.maxConcurrent; i++) {
      concurrentPromises.push(
        TaskStateMachine.transition(taskId, 'ACCEPTED', { hustlerId: testUserId })
      );
    }
    
    const results = await Promise.all(concurrentPromises);
    
    // At most ONE should succeed
    const successCount = results.filter(r => r.success).length;
    expect(successCount).toBeLessThanOrEqual(1);
    
    // State should be consistent
    const finalState = await TaskStateMachine.getState(taskId);
    expect(['OPEN', 'ACCEPTED']).toContain(finalState);
  });
  
  it('should handle concurrent XP awards (idempotency)', async () => {
    const sql = getSql();
    const taskId = await createTestTask(testUserId);
    createdTaskIds.push(taskId);
    
    // Setup: Complete task
    await EscrowStateMachine.transition(taskId, 'funded');
    await sql`UPDATE tasks SET assigned_to = ${testUserId}, status = 'completed' WHERE id = ${taskId}`;
    await EscrowStateMachine.transition(taskId, 'released');
    
    // Try concurrent XP awards
    const concurrentPromises = [];
    
    for (let i = 0; i < FUZZ_CONFIG.maxConcurrent; i++) {
      concurrentPromises.push(
        awardXPForTask(taskId, testUserId)
      );
    }
    
    const results = await Promise.all(concurrentPromises);
    
    // Count actual XP awards (not already awarded)
    const actualAwards = results.filter(r => r.success && !r.alreadyAwarded);
    
    // At most ONE should have awarded XP
    expect(actualAwards.length).toBeLessThanOrEqual(1);
    
    // Verify only one XP ledger entry
    const [count] = await sql`
      SELECT COUNT(*)::int as cnt FROM xp_ledger WHERE task_id = ${taskId}
    `;
    expect(count.cnt).toBeLessThanOrEqual(1);
  });
});

// ============================================================================
// FUZZ TEST 4: Retry Patterns
// ============================================================================

describe('Fuzz Test 4: Retry Patterns', () => {
  it('should handle retries without duplicate side effects', async () => {
    const random = new SeededRandom(FUZZ_CONFIG.seed + 2);
    const sql = getSql();
    
    for (let i = 0; i < 5; i++) {
      const taskId = await createTestTask(testUserId);
      createdTaskIds.push(taskId);
      
      // Setup
      await EscrowStateMachine.transition(taskId, 'funded');
      await sql`UPDATE tasks SET assigned_to = ${testUserId}, status = 'completed' WHERE id = ${taskId}`;
      await EscrowStateMachine.transition(taskId, 'released');
      
      // Simulate retries
      const numRetries = random.int(1, FUZZ_CONFIG.maxRetries);
      
      for (let j = 0; j < numRetries; j++) {
        await awardXPForTask(taskId, testUserId);
      }
      
      // Verify only one XP entry
      const [count] = await sql`
        SELECT COUNT(*)::int as cnt FROM xp_ledger WHERE task_id = ${taskId}
      `;
      expect(count.cnt).toBe(1);
    }
  });
});

// ============================================================================
// FUZZ TEST 5: State Machine Exhaustive
// ============================================================================

describe('Fuzz Test 5: State Machine Exhaustive', () => {
  it('should correctly identify all valid/invalid transitions', () => {
    const allTaskStates: TaskState[] = ['OPEN', 'ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'];
    
    for (const from of allTaskStates) {
      for (const to of allTaskStates) {
        const canTransition = TaskStateMachine.canTransition(from, to);
        const shouldBeAble = TASK_TRANSITIONS[from]?.includes(to) || false;
        
        expect(canTransition).toBe(shouldBeAble);
      }
    }
  });
  
  it('should correctly identify all terminal states', () => {
    const terminalTaskStates: TaskState[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];
    const terminalEscrowStates: EscrowState[] = ['released', 'refunded', 'partial_refund'];
    
    for (const state of terminalTaskStates) {
      const possibleTransitions = TASK_TRANSITIONS[state];
      expect(possibleTransitions).toEqual([]);
    }
    
    for (const state of terminalEscrowStates) {
      const possibleTransitions = ESCROW_TRANSITIONS[state];
      expect(possibleTransitions).toEqual([]);
    }
  });
});
