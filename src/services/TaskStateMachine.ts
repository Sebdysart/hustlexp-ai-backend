/**
 * TASK STATE MACHINE (BUILD_GUIDE Phase 2)
 * 
 * Implements the task lifecycle state machine from BUILD_GUIDE.
 * 
 * STATES:
 * - OPEN: Task posted, awaiting hustler
 * - ACCEPTED: Hustler assigned, escrow funded
 * - PROOF_SUBMITTED: Hustler submitted completion proof
 * - DISPUTED: Proof rejected, under review
 * - COMPLETED: Task finished, XP awarded (terminal)
 * - CANCELLED: Task cancelled (terminal)
 * - EXPIRED: Task deadline passed (terminal)
 * 
 * INVARIANTS ENFORCED:
 * - INV-2: COMPLETED requires RELEASED escrow
 * - INV-3: COMPLETED requires ACCEPTED proof
 * - Terminal states immutable
 * 
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */

import { getSql, transaction } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskStateMachine');

// ============================================================================
// TYPES
// ============================================================================

export type TaskState = 
  | 'OPEN'
  | 'ACCEPTED'
  | 'PROOF_SUBMITTED'
  | 'DISPUTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

export const TERMINAL_STATES: TaskState[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

export interface TransitionContext {
  hustlerId?: string;
  proofId?: string;
  proofState?: string;
  escrowState?: string;
  reason?: string;
  adminId?: string;
}

export interface TransitionResult {
  success: boolean;
  previousState: TaskState;
  newState: TaskState;
  error?: string;
}

// ============================================================================
// VALID TRANSITIONS (FROM BUILD_GUIDE)
// ============================================================================

export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  OPEN: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: ['PROOF_SUBMITTED', 'CANCELLED', 'EXPIRED'],
  PROOF_SUBMITTED: ['COMPLETED', 'DISPUTED', 'CANCELLED'],
  DISPUTED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],  // Terminal
  CANCELLED: [],  // Terminal
  EXPIRED: [],    // Terminal
};

// ============================================================================
// TRANSITION GUARDS
// ============================================================================

interface TransitionGuard {
  from: TaskState;
  to: TaskState;
  guard: (taskId: string, context: TransitionContext) => Promise<{ allowed: boolean; reason?: string }>;
}

const GUARDS: TransitionGuard[] = [
  {
    from: 'OPEN',
    to: 'ACCEPTED',
    guard: async (taskId, ctx) => {
      if (!ctx.hustlerId) {
        return { allowed: false, reason: 'Hustler ID required for acceptance' };
      }
      // Check escrow is funded
      const sql = getSql();
      const [escrow] = await sql`
        SELECT current_state FROM money_state_lock WHERE task_id = ${taskId}
      `;
      if (!escrow || escrow.current_state !== 'funded') {
        return { allowed: false, reason: 'Escrow must be funded before acceptance' };
      }
      return { allowed: true };
    },
  },
  {
    from: 'ACCEPTED',
    to: 'PROOF_SUBMITTED',
    guard: async (taskId, ctx) => {
      if (!ctx.proofId) {
        return { allowed: false, reason: 'Proof ID required' };
      }
      return { allowed: true };
    },
  },
  {
    from: 'PROOF_SUBMITTED',
    to: 'COMPLETED',
    guard: async (taskId, ctx) => {
      // INV-3: COMPLETED requires ACCEPTED proof
      const sql = getSql();
      const [proof] = await sql`
        SELECT status FROM proof_submissions 
        WHERE task_id = ${taskId} 
        ORDER BY created_at DESC 
        LIMIT 1
      `;
      if (!proof || proof.status !== 'accepted') {
        return { allowed: false, reason: 'INV-3: Proof must be ACCEPTED before completion' };
      }
      
      // INV-2: Check escrow can be released
      const [escrow] = await sql`
        SELECT current_state FROM money_state_lock WHERE task_id = ${taskId}
      `;
      if (!escrow || escrow.current_state !== 'funded') {
        return { allowed: false, reason: 'INV-2: Escrow must be in FUNDED state' };
      }
      
      return { allowed: true };
    },
  },
  {
    from: 'PROOF_SUBMITTED',
    to: 'DISPUTED',
    guard: async (taskId, ctx) => {
      if (!ctx.reason) {
        return { allowed: false, reason: 'Dispute reason required' };
      }
      return { allowed: true };
    },
  },
  {
    from: 'DISPUTED',
    to: 'COMPLETED',
    guard: async (taskId, ctx) => {
      // Admin resolution required
      if (!ctx.adminId) {
        return { allowed: false, reason: 'Admin resolution required for disputed tasks' };
      }
      return { allowed: true };
    },
  },
];

// ============================================================================
// STATE MACHINE CLASS
// ============================================================================

class TaskStateMachineClass {
  
  /**
   * Check if a transition is valid
   */
  canTransition(from: TaskState, to: TaskState): boolean {
    const validTargets = TASK_TRANSITIONS[from] || [];
    return validTargets.includes(to);
  }
  
  /**
   * Execute a state transition
   */
  async transition(
    taskId: string,
    targetState: TaskState,
    context: TransitionContext = {}
  ): Promise<TransitionResult> {
    const sql = getSql();
    
    try {
      // Get current state
      const [task] = await sql`
        SELECT id, status FROM tasks WHERE id = ${taskId}
      `;
      
      if (!task) {
        return {
          success: false,
          previousState: 'OPEN',
          newState: 'OPEN',
          error: 'Task not found',
        };
      }
      
      const currentState = (task.status?.toUpperCase() || 'OPEN') as TaskState;
      
      // Check if terminal
      if (TERMINAL_STATES.includes(currentState)) {
        return {
          success: false,
          previousState: currentState,
          newState: currentState,
          error: `Cannot modify task in terminal state: ${currentState}`,
        };
      }
      
      // Check if transition is valid
      if (!this.canTransition(currentState, targetState)) {
        return {
          success: false,
          previousState: currentState,
          newState: currentState,
          error: `Invalid transition: ${currentState} → ${targetState}`,
        };
      }
      
      // Run guards
      const guard = GUARDS.find(g => g.from === currentState && g.to === targetState);
      if (guard) {
        const guardResult = await guard.guard(taskId, context);
        if (!guardResult.allowed) {
          return {
            success: false,
            previousState: currentState,
            newState: currentState,
            error: guardResult.reason,
          };
        }
      }
      
      // Execute transition
      await sql`
        UPDATE tasks 
        SET 
          status = ${targetState.toLowerCase()},
          ${targetState === 'ACCEPTED' ? sql`accepted_at = NOW(),` : sql``}
          ${targetState === 'COMPLETED' ? sql`completed_at = NOW(),` : sql``}
          updated_at = NOW()
        WHERE id = ${taskId}
      `;
      
      // Log transition
      await sql`
        INSERT INTO task_state_log (task_id, from_state, to_state, context, created_at)
        VALUES (${taskId}, ${currentState}, ${targetState}, ${JSON.stringify(context)}, NOW())
      `;
      
      logger.info({
        taskId,
        from: currentState,
        to: targetState,
        context,
      }, 'Task state transition successful');
      
      return {
        success: true,
        previousState: currentState,
        newState: targetState,
      };
      
    } catch (error: any) {
      logger.error({ error, taskId, targetState }, 'Task state transition failed');
      return {
        success: false,
        previousState: 'OPEN',
        newState: 'OPEN',
        error: error.message,
      };
    }
  }
  
  /**
   * Get current task state
   */
  async getState(taskId: string): Promise<TaskState | null> {
    const sql = getSql();
    const [task] = await sql`
      SELECT status FROM tasks WHERE id = ${taskId}
    `;
    return task ? (task.status?.toUpperCase() as TaskState) : null;
  }
  
  /**
   * Get state history for a task
   */
  async getHistory(taskId: string): Promise<Array<{
    fromState: TaskState;
    toState: TaskState;
    context: TransitionContext;
    createdAt: Date;
  }>> {
    const sql = getSql();
    const rows = await sql`
      SELECT from_state, to_state, context, created_at
      FROM task_state_log
      WHERE task_id = ${taskId}
      ORDER BY created_at ASC
    `;
    
    return rows.map((row: any) => ({
      fromState: row.from_state as TaskState,
      toState: row.to_state as TaskState,
      context: row.context || {},
      createdAt: new Date(row.created_at),
    }));
  }
}

export const TaskStateMachine = new TaskStateMachineClass();
