/**
 * TaskService v1.0.0
 * 
 * CONSTITUTIONAL: Enforces INV-3
 * 
 * INV-3: Task can only be COMPLETED if proof is ACCEPTED
 * 
 * This service does NOT pre-check invariants — it relies on
 * database triggers to enforce them.
 * 
 * @see schema.sql §1.2 (tasks table)
 * @see PRODUCT_SPEC.md §3
 */

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { 
  Task, 
  TaskState, 
  ServiceResult 
} from '../types';
import { TERMINAL_TASK_STATES, ErrorCodes } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface CreateTaskParams {
  posterId: string;
  title: string;
  description: string;
  price: number; // USD cents
  requirements?: string;
  location?: string;
  category?: string;
  deadline?: Date;
  requiresProof?: boolean;
}

interface AcceptTaskParams {
  taskId: string;
  workerId: string;
}

// ============================================================================
// STATE MACHINE
// ============================================================================

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  OPEN: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: ['PROOF_SUBMITTED', 'CANCELLED', 'EXPIRED'],
  PROOF_SUBMITTED: ['COMPLETED', 'DISPUTED', 'ACCEPTED'], // ACCEPTED = proof rejected
  DISPUTED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],   // TERMINAL
  CANCELLED: [],   // TERMINAL
  EXPIRED: [],     // TERMINAL
};

function isTerminalState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

function isValidTransition(from: TaskState, to: TaskState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// SERVICE
// ============================================================================

export const TaskService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get task by ID
   */
  getById: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      const result = await db.query<Task>(
        'SELECT * FROM tasks WHERE id = $1',
        [taskId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${taskId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get tasks by poster
   */
  getByPoster: async (posterId: string): Promise<ServiceResult<Task[]>> => {
    try {
      const result = await db.query<Task>(
        'SELECT * FROM tasks WHERE poster_id = $1 ORDER BY created_at DESC',
        [posterId]
      );
      
      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get tasks by worker
   */
  getByWorker: async (workerId: string): Promise<ServiceResult<Task[]>> => {
    try {
      const result = await db.query<Task>(
        'SELECT * FROM tasks WHERE worker_id = $1 ORDER BY created_at DESC',
        [workerId]
      );
      
      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * List open tasks (for task feed)
   */
  listOpen: async (options: {
    limit?: number;
    offset?: number;
    category?: string;
  } = {}): Promise<ServiceResult<Task[]>> => {
    const { limit = 50, offset = 0, category } = options;
    
    try {
      let sql = `
        SELECT * FROM tasks 
        WHERE state = 'OPEN'
      `;
      const params: unknown[] = [];
      
      if (category) {
        params.push(category);
        sql += ` AND category = $${params.length}`;
      }
      
      params.push(limit, offset);
      sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      
      const result = await db.query<Task>(sql, params);
      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // STATE TRANSITIONS
  // --------------------------------------------------------------------------

  /**
   * Create task in OPEN state
   */
  create: async (params: CreateTaskParams): Promise<ServiceResult<Task>> => {
    const {
      posterId,
      title,
      description,
      price,
      requirements,
      location,
      category,
      deadline,
      requiresProof = true,
    } = params;
    
    // Validate price is positive integer (cents)
    if (!Number.isInteger(price) || price <= 0) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'Price must be a positive integer (cents)',
        },
      };
    }
    
    try {
      const result = await db.query<Task>(
        `INSERT INTO tasks (
          poster_id, title, description, price, 
          requirements, location, category, deadline, requires_proof, state
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')
        RETURNING *`,
        [posterId, title, description, price, requirements, location, category, deadline, requiresProof]
      );
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Accept task: OPEN → ACCEPTED
   */
  accept: async (params: AcceptTaskParams): Promise<ServiceResult<Task>> => {
    const { taskId, workerId } = params;
    
    try {
      const result = await db.query<Task>(
        `UPDATE tasks 
         SET state = 'ACCEPTED',
             worker_id = $2,
             accepted_at = NOW()
         WHERE id = $1 
           AND state = 'OPEN'
         RETURNING *`,
        [taskId, workerId]
      );
      
      if (result.rowCount === 0) {
        const existing = await TaskService.getById(taskId);
        if (!existing.success) {
          return existing;
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot accept task: current state is ${existing.data.state}, expected OPEN`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Submit proof: ACCEPTED → PROOF_SUBMITTED
   */
  submitProof: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      const result = await db.query<Task>(
        `UPDATE tasks 
         SET state = 'PROOF_SUBMITTED',
             proof_submitted_at = NOW()
         WHERE id = $1 
           AND state = 'ACCEPTED'
         RETURNING *`,
        [taskId]
      );
      
      if (result.rowCount === 0) {
        const existing = await TaskService.getById(taskId);
        if (!existing.success) {
          return existing;
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot submit proof: current state is ${existing.data.state}, expected ACCEPTED`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Complete task: PROOF_SUBMITTED → COMPLETED
   * 
   * INV-3: COMPLETED requires ACCEPTED proof
   * The database trigger enforces this — we catch the error.
   */
  complete: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      const result = await db.query<Task>(
        `UPDATE tasks 
         SET state = 'COMPLETED',
             completed_at = NOW()
         WHERE id = $1 
           AND state = 'PROOF_SUBMITTED'
         RETURNING *`,
        [taskId]
      );
      
      if (result.rowCount === 0) {
        const existing = await TaskService.getById(taskId);
        if (!existing.success) {
          return existing;
        }
        
        if (isTerminalState(existing.data.state)) {
          return {
            success: false,
            error: {
              code: ErrorCodes.TASK_TERMINAL,
              message: `Task ${taskId} is in terminal state ${existing.data.state}`,
            },
          };
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot complete task: current state is ${existing.data.state}, expected PROOF_SUBMITTED`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      // Check for INV-3 violation from trigger
      if (isInvariantViolation(error)) {
        const dbError = error as { code: string };
        if (dbError.code === 'HX301') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INV_3_VIOLATION,
              message: getErrorMessage('HX301'),
              details: { taskId },
            },
          };
        }
      }
      
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Reject proof: PROOF_SUBMITTED → ACCEPTED
   */
  rejectProof: async (taskId: string, reason: string): Promise<ServiceResult<Task>> => {
    try {
      // Note: In a full implementation, we'd update the proof record too
      const result = await db.query<Task>(
        `UPDATE tasks 
         SET state = 'ACCEPTED',
             proof_submitted_at = NULL
         WHERE id = $1 
           AND state = 'PROOF_SUBMITTED'
         RETURNING *`,
        [taskId]
      );
      
      if (result.rowCount === 0) {
        const existing = await TaskService.getById(taskId);
        if (!existing.success) {
          return existing;
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot reject proof: current state is ${existing.data.state}, expected PROOF_SUBMITTED`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Open dispute: PROOF_SUBMITTED → DISPUTED
   */
  openDispute: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      const result = await db.query<Task>(
        `UPDATE tasks 
         SET state = 'DISPUTED'
         WHERE id = $1 
           AND state = 'PROOF_SUBMITTED'
         RETURNING *`,
        [taskId]
      );
      
      if (result.rowCount === 0) {
        const existing = await TaskService.getById(taskId);
        if (!existing.success) {
          return existing;
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot open dispute: current state is ${existing.data.state}, expected PROOF_SUBMITTED`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Cancel task: OPEN/ACCEPTED → CANCELLED
   */
  cancel: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      const result = await db.query<Task>(
        `UPDATE tasks 
         SET state = 'CANCELLED',
             cancelled_at = NOW()
         WHERE id = $1 
           AND state IN ('OPEN', 'ACCEPTED')
         RETURNING *`,
        [taskId]
      );
      
      if (result.rowCount === 0) {
        const existing = await TaskService.getById(taskId);
        if (!existing.success) {
          return existing;
        }
        
        if (isTerminalState(existing.data.state)) {
          return {
            success: false,
            error: {
              code: ErrorCodes.TASK_TERMINAL,
              message: `Task ${taskId} is in terminal state ${existing.data.state}`,
            },
          };
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot cancel task: current state is ${existing.data.state}`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Expire task: * → EXPIRED (called by cron job)
   */
  expire: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      const result = await db.query<Task>(
        `UPDATE tasks 
         SET state = 'EXPIRED',
             expired_at = NOW()
         WHERE id = $1 
           AND state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
           AND deadline < NOW()
         RETURNING *`,
        [taskId]
      );
      
      if (result.rowCount === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Task cannot be expired (already terminal or deadline not passed)',
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------

  isTerminalState,
  isValidTransition,
  getValidTransitions: (state: TaskState) => VALID_TRANSITIONS[state] ?? [],
};

export default TaskService;
