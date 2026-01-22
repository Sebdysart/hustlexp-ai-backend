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
import { writeToOutbox } from '../jobs/outbox-helpers';
import { PlanService } from './PlanService';
import { MIN_INSTANT_TIER, MIN_SENSITIVE_INSTANT_TIER } from './InstantTrustConfig';
import type { 
  Task, 
  TaskState,
  TaskProgressState,
  ServiceResult 
} from '../types';
import { TERMINAL_TASK_STATES, VALID_PROGRESS_TRANSITIONS, ErrorCodes } from '../types';

// Risk level type (from database schema - matches tasks.risk_level CHECK constraint)
type TaskRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';

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
  riskLevel?: TaskRiskLevel; // Defaults to 'LOW' in DB
  // Live Mode (PRODUCT_SPEC §3.5)
  mode?: 'STANDARD' | 'LIVE';
  liveBroadcastRadiusMiles?: number;
  // Instant Execution Mode (IEM v1)
  instantMode?: boolean;
  sensitive?: boolean; // Sensitive tasks require higher trust tier (Tier ≥ 3)
}

interface AcceptTaskParams {
  taskId: string;
  workerId: string;
}

interface AdvanceProgressParams {
  taskId: string;
  to: TaskProgressState;
  actor: { type: 'worker' | 'system'; userId?: string };
}

// ============================================================================
// STATE MACHINE
// ============================================================================

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  OPEN: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  MATCHING: ['ACCEPTED', 'CANCELLED', 'EXPIRED'], // Instant mode: first accept wins
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
      mode = 'STANDARD',
      liveBroadcastRadiusMiles,
      instantMode = false,
      sensitive = false,
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

    // SPEC ALIGNMENT (PRODUCT_SPEC §3.5): Minimum price enforcement
    // | Mode     | Minimum Price |
    // |----------|---------------|
    // | STANDARD | $5.00 (500)   |
    // | LIVE     | $15.00 (1500) |
    if (mode === 'STANDARD' && price < 500) {
      return {
        success: false,
        error: {
          code: 'PRICE_TOO_LOW',
          message: 'Standard tasks require minimum price of $5.00 (500 cents)',
        },
      };
    }

    if (mode === 'LIVE' && price < 1500) {
      return {
        success: false,
        error: {
          code: ErrorCodes.LIVE_2_VIOLATION,
          message: 'Live tasks require minimum price of $15.00 (1500 cents)',
        },
      };
    }

    // Step 9-C: Plan gating for risk levels (Monetization Hooks)
    const riskLevel = params.riskLevel || 'LOW';
    const planCheck = await PlanService.canCreateTaskWithRisk(posterId, riskLevel);
    if (!planCheck.allowed) {
      return {
        success: false,
        error: {
          code: 'PLAN_REQUIRED',
          message: planCheck.reason || 'Premium plan required for this risk level',
          details: {
            requiredPlan: planCheck.requiredPlan,
            riskLevel,
          },
        },
      };
    }

    // Launch Hardening v1: Kill switch check
    if (instantMode) {
      const { InstantModeKillSwitch } = await import('./InstantModeKillSwitch');
      const flags = InstantModeKillSwitch.checkFlags({ taskId: undefined, operation: 'create' });
      
      if (!flags.instantModeEnabled) {
        console.log(`🚫 Instant Mode disabled by kill switch - falling back to OPEN state`, {
          posterId,
          taskTitle: title,
        });
        // Safe fallback: create as non-instant task
        instantMode = false;
      }
    }

    // Launch Hardening v1: Rate limiting for Instant posts
    if (instantMode) {
      const { InstantRateLimiter } = await import('./InstantRateLimiter');
      const rateLimitCheck = await InstantRateLimiter.checkPostLimit(posterId);
      
      if (!rateLimitCheck.allowed) {
        return {
          success: false,
          error: {
            code: ErrorCodes.RATE_LIMIT_EXCEEDED,
            message: rateLimitCheck.reason || 'Rate limit exceeded for Instant posts',
            details: {
              retryAfter: rateLimitCheck.retryAfter,
            },
          },
        };
      }
    }

    // IEM v1: AI Task Completeness Gate (Option B)
    // Enforce gate server-side - even if UI allows Instant Mode, backend validates
    if (instantMode) {
      const { InstantTaskGate } = await import('./InstantTaskGate');
      const gateResult = await InstantTaskGate.check({
        title,
        description,
        location,
        requirements,
        deadline,
        category,
      });

      if (!gateResult.instantEligible) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INSTANT_TASK_INCOMPLETE,
            message: 'Instant Mode requires a few more details',
            details: {
              blockReason: gateResult.blockReason,
              questions: gateResult.questions,
            },
          },
        };
      }
    }
    
    try {
      // Instant mode: start in MATCHING state, not OPEN
      const initialState = instantMode ? 'MATCHING' : 'OPEN';
      
      const result = await db.query<Task>(
        `INSERT INTO tasks (
          poster_id, title, description, price, 
          requirements, location, category, deadline, requires_proof, 
          risk_level, mode, live_broadcast_radius_miles, instant_mode, sensitive, state
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [posterId, title, description, price, requirements, location, category, deadline, requiresProof, riskLevel, mode, liveBroadcastRadiusMiles, instantMode, sensitive, initialState]
      );
      
      let createdTask = result.rows[0];
      
      // If instant mode, trigger matching broadcast (async, non-blocking)
      if (instantMode) {
        // Set matched_at timestamp immediately (authority: DB NOW())
        await db.query(
          `UPDATE tasks SET matched_at = NOW() WHERE id = $1`,
          [createdTask.id]
        );
        
        // Reload task to get matched_at
        const reloaded = await db.query<Task>(
          `SELECT * FROM tasks WHERE id = $1`,
          [createdTask.id]
        );
        createdTask = reloaded.rows[0];
        
        // Enqueue matching broadcast job (non-blocking)
        await writeToOutbox({
          eventType: 'task.instant_matching_started',
          aggregateType: 'task',
          aggregateId: createdTask.id,
          eventVersion: 1,
          idempotencyKey: `task.instant_matching_started:${createdTask.id}`,
          payload: { taskId: createdTask.id, location, riskLevel },
          queueName: 'critical_payments', // Use critical queue for instant tasks
        });
      }
      
      return { success: true, data: createdTask };
    } catch (error) {
      if (isInvariantViolation(error)) {
        return {
          success: false,
          error: {
            code: error.code || 'INVARIANT_VIOLATION',
            message: getErrorMessage(error.code || ''),
          },
        };
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
   * Accept task: OPEN → ACCEPTED
   */
  accept: async (params: AcceptTaskParams): Promise<ServiceResult<Task>> => {
    const { taskId, workerId } = params;
    
    try {
      // Step 9-C: Check worker plan eligibility for task risk level
      // Trust-Tier Tightening: Check trust tier for Instant tasks
      const taskResult = await db.query<{ 
        risk_level: TaskRiskLevel;
        instant_mode: boolean;
        sensitive: boolean | null;
      }>(
        `SELECT risk_level, instant_mode, sensitive FROM tasks WHERE id = $1`,
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${taskId} not found`,
          },
        };
      }

      const task = taskResult.rows[0];

      // Pre-Alpha Prerequisite: Eligibility Guard (centralized enforcement)
      const { EligibilityGuard } = await import('./EligibilityGuard');
      const eligibilityResult = await EligibilityGuard.assertEligibility({
        userId: workerId,
        taskId,
        isInstant: task.instant_mode || false,
      });

      if (!eligibilityResult.allowed) {
        return {
          success: false,
          error: {
            code: eligibilityResult.code as any,
            message: eligibilityResult.details?.reason || 'Eligibility check failed',
            details: eligibilityResult.details,
          },
        };
      }

      // Trust-Tier Tightening: Enforce minimum trust tier for Instant tasks
      if (task.instant_mode) {
        // Launch Hardening v1: Kill switch check
        const { InstantModeKillSwitch } = await import('./InstantModeKillSwitch');
        const flags = InstantModeKillSwitch.checkFlags({ taskId, operation: 'accept' });
        
        if (!flags.instantModeEnabled) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: 'Instant Mode is currently disabled',
            },
          };
        }

        // Launch Hardening v1: Rate limiting for Instant accepts
        const { InstantRateLimiter } = await import('./InstantRateLimiter');
        const rateLimitCheck = await InstantRateLimiter.checkAcceptLimit(workerId);
        
        if (!rateLimitCheck.allowed) {
          return {
            success: false,
            error: {
              code: ErrorCodes.RATE_LIMIT_EXCEEDED,
              message: rateLimitCheck.reason || 'Rate limit exceeded for Instant accepts',
              details: {
                retryAfter: rateLimitCheck.retryAfter,
              },
            },
          };
        }

        const workerResult = await db.query<{ trust_tier: number; trust_hold: boolean }>(
          `SELECT trust_tier, trust_hold FROM users WHERE id = $1`,
          [workerId]
        );

        if (workerResult.rowCount === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Worker ${workerId} not found`,
            },
          };
        }

        const worker = workerResult.rows[0];

        // Check trust hold first
        if (worker.trust_hold) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INSTANT_TASK_TRUST_INSUFFICIENT,
              message: 'Your account is currently on hold',
            },
          };
        }

        // Determine minimum trust tier (sensitive tasks require higher tier)
        const minTrustTier = task.sensitive ? MIN_SENSITIVE_INSTANT_TIER : MIN_INSTANT_TIER;

        // Enforce trust tier requirement
        if (worker.trust_tier < minTrustTier) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INSTANT_TASK_TRUST_INSUFFICIENT,
              message: 'This task requires a higher trust tier',
            },
          };
        }
      }

      const planCheck = await PlanService.canAcceptTaskWithRisk(workerId, task.risk_level);
      if (!planCheck.allowed) {
        return {
          success: false,
          error: {
            code: 'PLAN_REQUIRED',
            message: planCheck.reason || 'Pro plan required for high-risk tasks',
            details: {
              requiredPlan: planCheck.requiredPlan,
              riskLevel: task.risk_level,
            },
          },
        };
      }

      // Instant mode: accept from MATCHING state; Standard: accept from OPEN state
      const result = await db.query<Task>(
        `UPDATE tasks 
         SET state = 'ACCEPTED',
             worker_id = $2,
             accepted_at = NOW()
         WHERE id = $1 
           AND state IN ('OPEN', 'MATCHING')
           AND worker_id IS NULL
         RETURNING *`,
        [taskId, workerId]
      );
      
      if (result.rowCount === 0) {
        const existing = await TaskService.getById(taskId);
        if (!existing.success) {
          return existing;
        }
        
        // Launch Hardening v1: Observability - log accept race condition
        if (task.instant_mode && existing.data.state === 'ACCEPTED') {
          const { InstantObservability } = await import('./InstantObservability');
          InstantObservability.logAcceptRace(taskId, workerId, 'Task already accepted by another hustler');
        }
        
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot accept task: current state is ${existing.data.state}, expected ${task.instant_mode ? 'MATCHING' : 'OPEN'}`,
          },
        };
      }
      
      const acceptedTask = result.rows[0];
      
      // Step 4: Hook ACCEPTED transition (Pillar A - Realtime Tracking)
      // System-driven transition: POSTED → ACCEPTED
      await TaskService.advanceProgress({
        taskId,
        to: 'ACCEPTED',
        actor: { type: 'system' },
      });
      
      return { success: true, data: acceptedTask };
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
  // PROGRESS TRACKING (Pillar A - Realtime Tracking)
  // --------------------------------------------------------------------------

  /**
   * Advance task progress state (Pillar A - Realtime Tracking)
   * 
   * Enforces:
   * - Valid transition (VALID_PROGRESS_TRANSITIONS)
   * - Authorization (worker must own task for worker transitions)
   * - Dispute freeze (no progress during active disputes)
   * - Escrow terminal freeze (no progress after escrow terminal)
   * - Idempotency (from === to is a no-op)
   */
  advanceProgress: async (params: AdvanceProgressParams): Promise<ServiceResult<Task>> => {
    const { taskId, to, actor } = params;

    try {
      // Transaction: load task + check guards + update
      const result = await db.transaction(async (query) => {
        // 1. Load task FOR UPDATE (lock for concurrent safety)
        const taskResult = await query<{
          id: string;
          poster_id: string;
          worker_id: string | null;
          progress_state: string;
          state: string;
        }>(
          `SELECT id, poster_id, worker_id, progress_state, state
           FROM tasks
           WHERE id = $1
           FOR UPDATE`,
          [taskId]
        );

        if (taskResult.rows.length === 0) {
          throw new Error(`Task ${taskId} not found`);
        }

        const task = taskResult.rows[0];
        const from = task.progress_state as TaskProgressState;

        // 2. Idempotency check: if from === to, no-op
        if (from === to) {
          // Return current task (no update needed)
          const currentTaskResult = await query<Task>(
            `SELECT * FROM tasks WHERE id = $1`,
            [taskId]
          );
          return { task: currentTaskResult.rows[0], from };
        }

        // 3. Validate transition legality
        const validTransitions = VALID_PROGRESS_TRANSITIONS[from];
        if (!validTransitions.includes(to)) {
          throw new Error(
            `Invalid progress transition: ${from} → ${to}. Valid transitions: ${validTransitions.join(', ')}`
          );
        }

        // 4. Authorization check
        // Worker-only transitions: ACCEPTED → TRAVELING, TRAVELING → WORKING, WORKING → COMPLETED
        const workerTransitions: TaskProgressState[] = ['TRAVELING', 'WORKING', 'COMPLETED'];
        if (workerTransitions.includes(to)) {
          if (actor.type !== 'worker' || !actor.userId) {
            throw new Error(`Transition to ${to} requires worker actor`);
          }
          if (task.worker_id !== actor.userId) {
            throw new Error(`Worker ${actor.userId} does not own task ${taskId}`);
          }
        }

        // System-only transitions: POSTED → ACCEPTED, COMPLETED → CLOSED
        const systemTransitions: TaskProgressState[] = ['ACCEPTED', 'CLOSED'];
        if (systemTransitions.includes(to)) {
          if (actor.type !== 'system') {
            throw new Error(`Transition to ${to} requires system actor`);
          }
        }

        // 5. Dispute freeze: check if active dispute exists
        const disputeResult = await query<{ state: string }>(
          `SELECT state
           FROM disputes
           WHERE task_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [taskId]
        );

        if (disputeResult.rows.length > 0) {
          const disputeState = disputeResult.rows[0].state;
          if (disputeState !== 'RESOLVED') {
            throw new Error(
              `Cannot advance progress: task ${taskId} has active dispute (state: ${disputeState})`
            );
          }
        }

        // 6. Escrow terminal freeze: check if escrow is terminal
        const escrowResult = await query<{ state: string }>(
          `SELECT state
           FROM escrows
           WHERE task_id = $1`,
          [taskId]
        );

        if (escrowResult.rows.length > 0) {
          const escrowState = escrowResult.rows[0].state;
          const terminalEscrowStates = ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'];
          if (terminalEscrowStates.includes(escrowState)) {
            throw new Error(
              `Cannot advance progress: escrow is in terminal state ${escrowState}`
            );
          }
        }

        // 7. Update task progress_state
        const updateResult = await query<Task & { progress_updated_at: Date; progress_by: string | null }>(
          `UPDATE tasks
           SET progress_state = $1,
               progress_updated_at = NOW(),
               progress_by = $2,
               updated_at = NOW()
           WHERE id = $3
           RETURNING *`,
          [to, actor.userId || null, taskId]
        );

        if (updateResult.rows.length === 0) {
          throw new Error(`Failed to update task ${taskId}`);
        }

        const updatedTask = updateResult.rows[0];
        return { task: updatedTask, from, progressUpdatedAt: updatedTask.progress_updated_at };
      });

      // Step 5: Emit outbox event (Pillar A - Realtime Tracking)
      // Emit canonical task.progress_updated event for realtime delivery, notifications, UI animations
      // Idempotency key ensures same transition emits exactly once
      await writeToOutbox({
        eventType: 'task.progress_updated',
        aggregateType: 'task',
        aggregateId: taskId,
        eventVersion: 1,
        idempotencyKey: `task.progress_updated:${taskId}:${to}`,
        payload: {
          taskId,
          from: result.from,
          to,
          actor: {
            type: actor.type,
            userId: actor.userId || null,
          },
          occurredAt: result.progressUpdatedAt.toISOString(),
        },
        // NOTE: user_notifications currently serves as the realtime delivery channel.
        // This may be split into a dedicated realtime queue in the future.
        queueName: 'user_notifications',
      });

      return {
        success: true,
        data: result.task,
      };
    } catch (error) {
      // Check for specific error types
      if (error instanceof Error) {
        if (error.message.includes('Invalid progress transition')) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_TRANSITION,
              message: error.message,
            },
          };
        }
        if (error.message.includes('does not own task') || error.message.includes('requires')) {
          return {
            success: false,
            error: {
              code: ErrorCodes.FORBIDDEN,
              message: error.message,
            },
          };
        }
        if (error.message.includes('not found')) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: error.message,
            },
          };
        }
        if (error.message.includes('active dispute') || error.message.includes('terminal state')) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: error.message,
            },
          };
        }
      }

      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
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
