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

import { db, isInvariantViolation, getErrorMessage } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { PlanService } from './PlanService.js';
import { ScoperAIService } from './ScoperAIService.js';
import { MIN_INSTANT_TIER, MIN_SENSITIVE_INSTANT_TIER } from './InstantTrustConfig.js';
import { taskLogger } from '../logger.js';

const log = taskLogger.child({ service: 'TaskService' });
import type {
  Task,
  TaskState,
  TaskProgressState,
  ServiceResult
} from '../types.js';
import { TERMINAL_TASK_STATES, VALID_PROGRESS_TRANSITIONS, ErrorCodes } from '../types.js';

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
  estimatedDuration?: string;
  locationCity?: string;
  locationState?: string;
  locationRadiusMiles?: number;
  // Live Mode (PRODUCT_SPEC §3.5)
  mode?: 'STANDARD' | 'LIVE';
  liveBroadcastRadiusMiles?: number;
  // Instant Execution Mode (IEM v1)
  instantMode?: boolean;
  sensitive?: boolean; // Sensitive tasks require higher trust tier (Tier ≥ 3)
  // Template system — set atomically with the INSERT to prevent NULL window on partial failure
  templateSlug?: string;
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
   * Get tasks by poster — cursor-paginated.
   * Cursor = ISO timestamp of the last-seen task's created_at.
   * Returns up to `limit` tasks + a nextCursor to fetch the next page.
   */
  getByPoster: async (
    posterId: string,
    options: { cursor?: string | null; limit?: number } = {}
  ): Promise<ServiceResult<{ tasks: Task[]; nextCursor: string | undefined }>> => {
    const { cursor, limit = 20 } = options;
    // Fetch one extra row to detect if there is a next page
    const fetchLimit = limit + 1;

    try {
      const result = cursor
        ? await db.query<Task>(
            `SELECT * FROM tasks
             WHERE poster_id = $1
               AND created_at < $2::timestamptz
             ORDER BY created_at DESC
             LIMIT $3`,
            [posterId, cursor, fetchLimit]
          )
        : await db.query<Task>(
            `SELECT * FROM tasks
             WHERE poster_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [posterId, fetchLimit]
          );

      const hasMore = result.rows.length > limit;
      const tasks = hasMore ? result.rows.slice(0, limit) : result.rows;
      const nextCursor = hasMore
        ? (tasks[tasks.length - 1] as Task & { created_at: string | Date }).created_at?.toString()
        : undefined;

      return { success: true, data: { tasks, nextCursor } };
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
   * Get tasks by worker — cursor-paginated.
   * Cursor = ISO timestamp of the last-seen task's created_at.
   */
  getByWorker: async (
    workerId: string,
    options: { cursor?: string | null; limit?: number } = {}
  ): Promise<ServiceResult<{ tasks: Task[]; nextCursor: string | undefined }>> => {
    const { cursor, limit = 20 } = options;
    const fetchLimit = limit + 1;

    try {
      const result = cursor
        ? await db.query<Task>(
            `SELECT * FROM tasks
             WHERE worker_id = $1
               AND created_at < $2::timestamptz
             ORDER BY created_at DESC
             LIMIT $3`,
            [workerId, cursor, fetchLimit]
          )
        : await db.query<Task>(
            `SELECT * FROM tasks
             WHERE worker_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [workerId, fetchLimit]
          );

      const hasMore = result.rows.length > limit;
      const tasks = hasMore ? result.rows.slice(0, limit) : result.rows;
      const nextCursor = hasMore
        ? (tasks[tasks.length - 1] as Task & { created_at: string | Date }).created_at?.toString()
        : undefined;

      return { success: true, data: { tasks, nextCursor } };
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
        SELECT id, title, description, price, state, category, location,
               template_slug, trust_tier_required, created_at, expires_at,
               estimated_duration_minutes, is_remote
        FROM tasks
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
   *
   * v1.8.0 Gamification: Scoper AI integration for task pricing/XP proposals
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
      sensitive = false,
      templateSlug,
    } = params;
    let { instantMode = false } = params;

    // v1.8.0: Scoper AI integration (optional, for AI-suggested pricing)
    // If price is not provided or is placeholder (e.g., 0), call Scoper AI for proposal
    let finalPrice = price;
    let xpReward: number | undefined;

    if (!price || price === 0) {
      const scopeResult = await ScoperAIService.analyzeTaskScope({ description, category });
      if (scopeResult.success && scopeResult.data) {
        const proposal = scopeResult.data;
        // Use Scoper AI suggested price
        finalPrice = proposal.suggested_price_cents;
        xpReward = proposal.suggested_xp;

        log.info(
          { priceCents: finalPrice, xp: xpReward, difficulty: proposal.difficulty },
          'Scoper AI proposal accepted'
        );
      } else {
        // Fallback to minimum price if Scoper AI fails
        finalPrice = mode === 'LIVE' ? 1500 : 500;
      }
    }

    // Calculate XP reward if not set by Scoper AI (formula: price / 10)
    if (!xpReward) {
      xpReward = Math.round(finalPrice / 10);
    }

    // Validate price is positive integer (cents)
    if (!Number.isInteger(finalPrice) || finalPrice <= 0) {
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
    if (mode === 'STANDARD' && finalPrice < 500) {
      return {
        success: false,
        error: {
          code: 'PRICE_TOO_LOW',
          message: 'Standard tasks require minimum price of $5.00 (500 cents)',
        },
      };
    }

    if (mode === 'LIVE' && finalPrice < 1500) {
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
        log.info({ posterId, taskTitle: title }, 'Instant Mode disabled by kill switch - falling back to OPEN state');
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
      
      // Build location display string from structured fields
      const locationDisplay = params.locationCity && params.locationState
        ? `${params.locationCity}, ${params.locationState}`
        : location || 'Anywhere';

      const result = await db.query<Task>(
        `INSERT INTO tasks (
          poster_id, title, description, price, xp_reward,
          requirements, location, location_city, location_state, location_radius_miles,
          category, estimated_duration, deadline, requires_proof,
          risk_level, mode, live_broadcast_radius_miles, instant_mode, sensitive, state,
          template_slug
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        RETURNING *`,
        [posterId, title, description, finalPrice, xpReward, requirements,
         locationDisplay, params.locationCity || null, params.locationState || null, params.locationRadiusMiles || null,
         category, params.estimatedDuration || null, deadline, requiresProof,
         riskLevel, mode, liveBroadcastRadiusMiles, instantMode, sensitive, initialState, templateSlug || null]
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
   *
   * TRANSACTION SAFETY: Entire method wrapped in transaction to hold FOR UPDATE
   * lock through the final UPDATE, preventing race conditions under high contention.
   */
  accept: async (params: AcceptTaskParams): Promise<ServiceResult<Task>> => {
    const { taskId, workerId } = params;

    try {
      // Wrap entire method in transaction to hold FOR UPDATE lock through completion
      return await db.transaction(async (query) => {
        // Step 9-C: Check worker plan eligibility for task risk level
        // Trust-Tier Tightening: Check trust tier for Instant tasks
        // RACE CONDITION FIX: Lock task immediately with FOR UPDATE to prevent wasted work
        const taskResult = await query<{
          risk_level: TaskRiskLevel;
          instant_mode: boolean;
          sensitive: boolean | null;
          price: number;
          state: string;
          worker_id: string | null;
          poster_id: string;
        }>(
          `SELECT risk_level, instant_mode, sensitive, price, state, worker_id, poster_id
           FROM tasks WHERE id = $1 FOR UPDATE`,
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

        // FIX 4: Prevent self-dealing — a poster cannot accept their own task
        if (task.poster_id === workerId) {
          return {
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: 'You cannot accept your own task.',
            },
          };
        }

        // Early exit if task is already taken (before expensive eligibility checks)
        if (task.state !== 'OPEN' && task.state !== 'MATCHING') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot accept task: current state is ${task.state}, expected OPEN or MATCHING`,
            },
          };
        }

        if (task.worker_id !== null) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Task already accepted by another worker`,
            },
          };
        }

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
              code: String(eligibilityResult.code),
              message: (eligibilityResult.details?.reason as string) || 'Eligibility check failed',
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

          const workerResult = await query<{ trust_tier: number; trust_hold: boolean }>(
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

        // Fraud risk check on task acceptance
        try {
          const { FraudDetectionService } = await import('./FraudDetectionService');
          const riskResult = await FraudDetectionService.getRiskAssessment('user', workerId);
          if (riskResult.success && riskResult.data && riskResult.data.riskScore > 0.7) {
            log.warn({ workerId, taskId, riskScore: riskResult.data.riskScore }, 'Task acceptance blocked by fraud risk');
            return {
              success: false,
              error: {
                code: 'FRAUD_RISK_HIGH',
                message: 'Task acceptance is under review due to account risk assessment',
              },
            };
          }
        } catch (fraudError) {
          // Don't block task acceptance if fraud check fails
          log.warn({ workerId, taskId, err: fraudError instanceof Error ? fraudError.message : String(fraudError) }, 'Fraud risk check failed, allowing acceptance');
        }

        // Background check gate: high-value tasks (>$500) require clear background check
        if (task.price > 50000) {
          try {
            const BackgroundCheckService = await import('./BackgroundCheckService');
            const hasCheck = await BackgroundCheckService.hasValidBackgroundCheck(workerId);
            if (!hasCheck) {
              log.info({ workerId, taskId, price: task.price }, 'High-value task requires background check');
              return {
                success: false,
                error: {
                  code: 'BACKGROUND_CHECK_REQUIRED',
                  message: 'High-value tasks require a completed background check',
                },
              };
            }
          } catch (bgCheckError) {
            // Don't block if background check service is unavailable
            log.warn({ workerId, taskId, err: bgCheckError instanceof Error ? bgCheckError.message : String(bgCheckError) }, 'Background check lookup failed, allowing acceptance');
          }
        }

        // Instant mode: accept from MATCHING state; Standard: accept from OPEN state
        const result = await query<Task>(
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

        // Transaction commits automatically on successful return
        return { success: true, data: acceptedTask };
      });
    } catch (error) {
      // Transaction automatically rolls back on thrown error
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
   *
   * RACE CONDITION FIX: Wrapped in transaction with SELECT FOR UPDATE so the
   * row-level lock is held from the state read through the UPDATE COMMIT.
   * Without the transaction, two concurrent submitProof() calls could both
   * read state='ACCEPTED' and both write state='PROOF_SUBMITTED', producing
   * duplicate proof-submission events.
   */
  submitProof: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        // Acquire row-level lock before reading state
        const lockResult = await query<{ state: string }>(
          `SELECT state FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }

        const currentState = lockResult.rows[0].state;

        // Idempotent recovery: if the task is already in PROOF_SUBMITTED, the proof INSERT
        // already committed (ProofService.submit ran) but the task UPDATE failed or timed out.
        // Treat this as success — return the current task so the router can respond correctly.
        if (currentState === 'PROOF_SUBMITTED') {
          const existingTask = await query<Task>(
            `SELECT * FROM tasks WHERE id = $1`,
            [taskId]
          );
          return { success: true, data: existingTask.rows[0] };
        }

        if (currentState !== 'ACCEPTED') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot submit proof: current state is ${currentState}, expected ACCEPTED`,
            },
          };
        }

        const result = await query<Task>(
          `UPDATE tasks
           SET state = 'PROOF_SUBMITTED',
               proof_submitted_at = NOW()
           WHERE id = $1
             AND state = 'ACCEPTED'
           RETURNING *`,
          [taskId]
        );

        if (result.rowCount === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot submit proof: state changed unexpectedly`,
            },
          };
        }

        return { success: true, data: result.rows[0] };
      });
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
   *
   * RACE CONDITION FIX: Wrapped in transaction with SELECT FOR UPDATE to prevent
   * a simultaneous proof-rejection racing a completion call, which could otherwise
   * transition the task from PROOF_SUBMITTED to both COMPLETED and ACCEPTED in
   * separate connections. The FOR UPDATE lock serialises these callers.
   */
  complete: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        // Acquire row-level lock before reading state
        const lockResult = await query<{ state: string }>(
          `SELECT state FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }

        const currentState = lockResult.rows[0].state;

        if (isTerminalState(currentState as TaskState)) {
          return {
            success: false,
            error: {
              code: ErrorCodes.TASK_TERMINAL,
              message: `Task ${taskId} is in terminal state ${currentState}`,
            },
          };
        }

        if (currentState !== 'PROOF_SUBMITTED') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot complete task: current state is ${currentState}, expected PROOF_SUBMITTED`,
            },
          };
        }

        const result = await query<Task>(
          `UPDATE tasks
           SET state = 'COMPLETED',
               completed_at = NOW()
           WHERE id = $1
             AND state = 'PROOF_SUBMITTED'
           RETURNING *`,
          [taskId]
        );

        if (result.rowCount === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot complete task: state changed unexpectedly`,
            },
          };
        }

        return { success: true, data: result.rows[0] };
      });
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
   *
   * RACE CONDITION FIX: Wrapped in transaction with SELECT FOR UPDATE so the
   * row-level lock is held from the state read through the UPDATE COMMIT.
   * Without the transaction, a concurrent complete() call could read
   * state='PROOF_SUBMITTED' and race the rejectProof() UPDATE, causing the
   * task to transition to both COMPLETED and ACCEPTED on separate connections.
   */
  rejectProof: async (taskId: string, _reason: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        // Acquire row-level lock before reading state
        const lockResult = await query<{ state: string }>(
          `SELECT state FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }

        const currentState = lockResult.rows[0].state;

        if (currentState !== 'PROOF_SUBMITTED') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot reject proof: current state is ${currentState}, expected PROOF_SUBMITTED`,
            },
          };
        }

        // Note: In a full implementation, we'd update the proof record too
        const result = await query<Task>(
          `UPDATE tasks
           SET state = 'ACCEPTED',
               proof_submitted_at = NULL
           WHERE id = $1
             AND state = 'PROOF_SUBMITTED'
           RETURNING *`,
          [taskId]
        );

        if (result.rowCount === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot reject proof: state changed unexpectedly`,
            },
          };
        }

        return { success: true, data: result.rows[0] };
      });
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
   *
   * RACE CONDITION FIX: Wrapped in transaction with SELECT FOR UPDATE so the
   * row-level lock is held from the state read through the UPDATE COMMIT.
   * Without the transaction, a concurrent complete() or rejectProof() call
   * could read state='PROOF_SUBMITTED' and race the openDispute() UPDATE,
   * producing conflicting terminal states on separate connections.
   */
  openDispute: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        // Acquire row-level lock before reading state
        const lockResult = await query<{ state: string }>(
          `SELECT state FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }

        const currentState = lockResult.rows[0].state;

        if (currentState !== 'PROOF_SUBMITTED') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot open dispute: current state is ${currentState}, expected PROOF_SUBMITTED`,
            },
          };
        }

        const result = await query<Task>(
          `UPDATE tasks
           SET state = 'DISPUTED'
           WHERE id = $1
             AND state = 'PROOF_SUBMITTED'
           RETURNING *`,
          [taskId]
        );

        if (result.rowCount === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot open dispute: state changed unexpectedly`,
            },
          };
        }

        return { success: true, data: result.rows[0] };
      });
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
   *
   * RACE CONDITION FIX: Wrapped in transaction with SELECT FOR UPDATE to prevent
   * simultaneous accept+cancel producing both an ACCEPTED and CANCELLED record.
   * The FOR UPDATE lock is acquired before the state check and held through the
   * final UPDATE, so only one concurrent caller can proceed.
   */
  cancel: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        // Acquire row-level lock before reading state
        const lockResult = await query<{ state: string }>(
          `SELECT state FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }

        const currentState = lockResult.rows[0].state;

        if (isTerminalState(currentState as TaskState)) {
          return {
            success: false,
            error: {
              code: ErrorCodes.TASK_TERMINAL,
              message: `Task ${taskId} is in terminal state ${currentState}`,
            },
          };
        }

        if (!['OPEN', 'ACCEPTED'].includes(currentState)) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot cancel task: current state is ${currentState}`,
            },
          };
        }

        const result = await query<Task>(
          `UPDATE tasks
           SET state = 'CANCELLED',
               cancelled_at = NOW()
           WHERE id = $1
             AND state IN ('OPEN', 'ACCEPTED')
           RETURNING *`,
          [taskId]
        );

        if (result.rowCount === 0) {
          // Should be unreachable given the FOR UPDATE lock above, but guard anyway
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot cancel task: state changed unexpectedly`,
            },
          };
        }

        // FIX (HIGH): Check for a FUNDED escrow and emit an atomic refund outbox
        // event in the same transaction. Without this, cancelling a task with a
        // funded escrow strands the poster's funds — no automatic refund trigger
        // exists and they would need to file a manual support request.
        const escrowResult = await query<{ id: string; state: string }>(
          `SELECT id, state FROM escrows WHERE task_id = $1 AND state = 'FUNDED'`,
          [taskId]
        );
        if (escrowResult.rows.length > 0) {
          const escrowId = escrowResult.rows[0].id;
          await writeToOutbox(
            {
              eventType: 'escrow.refund_requested',
              aggregateType: 'escrow',
              aggregateId: escrowId,
              eventVersion: 1,
              payload: { escrowId, reason: 'task_cancelled', taskId },
              queueName: 'critical_payments',
              idempotencyKey: `escrow.refund_on_cancel:${escrowId}:${taskId}`,
            },
            query
          );
          log.info({ escrowId, taskId }, 'Escrow refund requested on task cancellation');
        }

        return { success: true, data: result.rows[0] };
      });
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
           AND state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'PROOF_SUBMITTED', 'DISPUTED', 'IN_REVIEW', 'ACCEPTED', 'IN_PROGRESS')
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
          occurredAt: result.progressUpdatedAt?.toISOString() ?? new Date().toISOString(),
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
