/**
 * DisputeService v1.0.0
 * 
 * CONSTITUTIONAL: Manages dispute lifecycle
 * 
 * Disputes link to AI proposals (A2 authority) for resolution recommendations.
 * Final decisions are made by deterministic validators or admins.
 * 
 * @see schema.sql §5 (disputes table)
 * @see PRODUCT_SPEC.md §7
 * @see AI_INFRASTRUCTURE.md §7.3
 */

import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../db.js';
import type { ServiceResult, Dispute, DisputeState, Escrow } from '../types.js';
import { ErrorCodes } from '../types.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { EscrowService } from './EscrowService.js';
import { logger } from '../logger.js';

const disputeServiceLog = logger.child({ service: 'DisputeService' });

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Check if a user has admin permission to resolve disputes
 */
async function canResolveDisputes(userId: string): Promise<boolean> {
  const result = await db.query<{ can_resolve_disputes: boolean }>(
    `SELECT can_resolve_disputes FROM admin_roles WHERE user_id = $1 AND can_resolve_disputes = true LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0;
}

// ============================================================================
// TYPES
// ============================================================================

interface CreateDisputeParams {
  taskId: string;
  escrowId: string;
  initiatedBy: string;
  posterId: string;
  workerId: string;
  reason: string;
  description: string;
}

interface ResolveDisputeParams {
  disputeId: string;
  resolvedBy: string;
  resolution: string;
  resolutionNotes?: string;
  outcomeEscrowAction: 'RELEASE' | 'REFUND' | 'SPLIT';
  workerPenalty?: boolean;
  posterPenalty?: boolean;
  // For SPLIT resolution
  refundAmount?: number;
  releaseAmount?: number;
}

// ============================================================================
// STATE MACHINE
// ============================================================================

const VALID_TRANSITIONS: Record<DisputeState, DisputeState[]> = {
  OPEN: ['EVIDENCE_REQUESTED', 'RESOLVED', 'ESCALATED'],
  EVIDENCE_REQUESTED: ['OPEN', 'RESOLVED', 'ESCALATED'],
  RESOLVED: [],  // TERMINAL
  ESCALATED: ['RESOLVED'],
};

function isValidTransition(from: DisputeState, to: DisputeState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// SERVICE
// ============================================================================

export const DisputeService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get dispute by ID
   */
  getById: async (disputeId: string): Promise<ServiceResult<Dispute>> => {
    try {
      const result = await db.query<Dispute>(
        'SELECT * FROM disputes WHERE id = $1',
        [disputeId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Dispute ${disputeId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      disputeServiceLog.error({ err: error instanceof Error ? error.message : String(error) }, 'DisputeService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
  
  /**
   * Get disputes for a task
   */
  getByTaskId: async (taskId: string): Promise<ServiceResult<Dispute[]>> => {
    try {
      // R-12: LIMIT 50 prevents DoS via accumulated resolved disputes.
      // Any reasonable UI use case fits within this bound.
      const result = await db.query<Dispute>(
        'SELECT * FROM disputes WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50',
        [taskId]
      );
      
      return { success: true, data: result.rows };
    } catch (error) {
      disputeServiceLog.error({ err: error instanceof Error ? error.message : String(error) }, 'DisputeService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
  
  /**
   * Get disputes for a user (as poster or worker)
   */
  getByUserId: async (userId: string, limit = 50, offset = 0): Promise<ServiceResult<Dispute[]>> => {
    try {
      // SECURITY FIX (MEDIUM): Removed `OR initiated_by = $1` clause.
      // An admin who initiates a dispute on behalf of a task they are not party to
      // would previously see that dispute — and the other user's task details — in
      // their own consumer feed. The initiator for normal disputes is always the
      // poster or worker (enforced at creation), so the clause was redundant in the
      // non-admin case and a leakage vector in the admin-override case.
      const result = await db.query<Dispute>(
        `SELECT * FROM disputes
         WHERE poster_id = $1 OR worker_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return { success: true, data: result.rows };
    } catch (error) {
      disputeServiceLog.error({ err: error instanceof Error ? error.message : String(error) }, 'DisputeService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Create a new dispute
   * MVP: Preconditions + transaction + outbox event
   */
  create: async (params: CreateDisputeParams): Promise<ServiceResult<Dispute>> => {
    const { taskId, escrowId, initiatedBy, posterId, workerId, reason, description } = params;
    
    try {
      // Precondition: Check authorization
      if (initiatedBy !== posterId && initiatedBy !== workerId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.FORBIDDEN,
            message: 'Only poster or worker can initiate disputes',
          },
        };
      }
      
      // Transaction: Create dispute + lock task + lock escrow + outbox event
      // Task fetch and 48h window check are performed INSIDE the transaction under
      // a FOR UPDATE lock to eliminate the TOCTOU race where a concurrent
      // completed_at update between the pre-check and the lock could allow
      // disputes outside the intended window.
      const result = await db.transaction(async (query) => {
        // Lock task row first to prevent concurrent completed_at changes
        const taskSelect = await query(
          `SELECT * FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (taskSelect.rows.length === 0) {
          throw Object.assign(new Error(`Task ${taskId} not found`), { code: ErrorCodes.NOT_FOUND });
        }

        const task = taskSelect.rows[0];

        // BUG R-3 FIX: Accept both COMPLETED and PROOF_SUBMITTED tasks for dispute creation.
        // PROOF_SUBMITTED tasks do not have completed_at set — the 48-hour window only
        // applies to COMPLETED tasks (post-completion dispute period). For PROOF_SUBMITTED
        // tasks the window check is skipped; the poster disputes the proof itself, not the
        // completed work.
        const validDisputeTaskStates = ['COMPLETED', 'PROOF_SUBMITTED'];
        if (!validDisputeTaskStates.includes(task.state)) {
          throw Object.assign(
            new Error('Disputes can only be opened for completed tasks or tasks with submitted proof'),
            { code: ErrorCodes.INVALID_STATE }
          );
        }

        if (task.state === 'COMPLETED') {
          if (!task.completed_at) {
            throw Object.assign(
              new Error('Completed task is missing completed_at timestamp'),
              { code: ErrorCodes.INVALID_STATE }
            );
          }

          const disputeWindowHours = 48;
          const disputeWindowMs = disputeWindowHours * 60 * 60 * 1000;
          const completedAt = new Date(task.completed_at);

          if (Date.now() - completedAt.getTime() > disputeWindowMs) {
            throw Object.assign(
              new Error(`Disputes must be opened within ${disputeWindowHours} hours of task completion`),
              { code: ErrorCodes.INVALID_STATE }
            );
          }
        }

        // Lock escrow row to prevent concurrent state changes
        const escrowSelect = await query<Escrow>(
          `SELECT * FROM escrows WHERE id = $1 FOR UPDATE`,
          [escrowId]
        );

        if (escrowSelect.rows.length === 0) {
          throw Object.assign(new Error(`Escrow ${escrowId} not found`), { code: ErrorCodes.NOT_FOUND });
        }

        const escrow = escrowSelect.rows[0];

        // BUG FIX (HIGH): Accept both FUNDED and RELEASED escrow states.
        // A task marked COMPLETED typically has its escrow auto-released (RELEASED)
        // via the payment worker before a user can file a dispute. Requiring only
        // FUNDED made it impossible to dispute a completed task — the two conditions
        // (completed_at IS NOT NULL AND escrow.state = 'FUNDED') were mutually
        // exclusive in the normal payment flow.
        if (!['FUNDED', 'RELEASED'].includes(escrow.state)) {
          throw Object.assign(new Error(`Dispute can only be filed when escrow is FUNDED or RELEASED (current: ${escrow.state})`), { code: ErrorCodes.INVALID_STATE });
        }

        // Lock escrow: FUNDED or RELEASED → LOCKED_DISPUTE (versioned)
        // BUG FIX (HIGH - Part A): When the escrow is RELEASED a Stripe transfer has
        // already been sent to the worker. We clear stripe_transfer_id so that the
        // escrow-action-worker's handleReleaseRequest idempotency guard (which checks
        // for a non-null stripe_transfer_id) does NOT fire and skip payment if the
        // dispute is later resolved in the worker's favour. The original transfer ID
        // is preserved in an escrow_events row below so the refund path can reverse it
        // if the poster wins.
        const escrowUpdate = await query<Escrow>(
          `UPDATE escrows
           SET state = 'LOCKED_DISPUTE',
               stripe_transfer_id = NULL,
               version = version + 1
           WHERE id = $1 AND state IN ('FUNDED', 'RELEASED')
           RETURNING *`,
          [escrowId]
        );

        if (escrowUpdate.rowCount === 0) {
          throw new Error('Failed to lock escrow (may have been locked by another process)');
        }

        // BUG FIX (HIGH - Part B): If the escrow was RELEASED, persist the original
        // transfer ID into escrow_events so handleRefundRequest can reverse it if the
        // poster wins the dispute. We use escrow_events (which has a JSONB metadata
        // column) because the disputes table has no metadata column.
        if (escrow.stripe_transfer_id) {
          await query(
            `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
             VALUES ($1, 'RELEASED', 'LOCKED_DISPUTE', NULL, 'system', $2)`,
            [escrowId, JSON.stringify({
              event_type: 'dispute_locked_after_release',
              original_transfer_id: escrow.stripe_transfer_id,
            })]
          );
        }

        // Create dispute (version=1)
        const disputeResult = await query<Dispute>(
          `INSERT INTO disputes (
            task_id, escrow_id, initiated_by, poster_id, worker_id,
            reason, description, state, version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', 1)
          RETURNING *`,
          [taskId, escrowId, initiatedBy, posterId, workerId, reason, description]
        );
        
        const dispute = disputeResult.rows[0];
        
        // Write outbox event: dispute.created
        await writeToOutbox({
          eventType: 'dispute.created',
          aggregateType: 'dispute',
          aggregateId: dispute.id,
          eventVersion: 1,
          payload: {
            dispute_id: dispute.id,
            escrow_id: escrowId,
            task_id: taskId,
            actor_id: initiatedBy,
            state: 'OPEN',
            version: 1,
          },
          queueName: 'critical_trust',
        });
        
        return dispute;
      });
      
      return { success: true, data: result };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'A dispute already exists for this escrow',
          },
        };
      }
      if (isInvariantViolation(error)) {
        return {
          success: false,
          error: {
            code: error.code || 'INVARIANT_VIOLATION',
            message: getErrorMessage(error.code || ''),
          },
        };
      }
      // Surface typed errors thrown inside the transaction (NOT_FOUND, INVALID_STATE)
      const errCode = (error as { code?: string }).code;
      if (errCode === ErrorCodes.NOT_FOUND || errCode === ErrorCodes.INVALID_STATE) {
        return {
          success: false,
          error: {
            code: errCode,
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        };
      }
      disputeServiceLog.error({ err: error instanceof Error ? error.message : String(error) }, 'DisputeService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },

  /**
   * Request evidence for a dispute
   */
  requestEvidence: async (disputeId: string): Promise<ServiceResult<Dispute>> => {
    try {
      const updated = await db.transaction(async (query) => {
        // Lock the row to prevent concurrent state transitions
        const currentResult = await query<Dispute>(
          'SELECT * FROM disputes WHERE id = $1 FOR UPDATE',
          [disputeId]
        );

        if (currentResult.rows.length === 0) {
          throw Object.assign(new Error(`Dispute ${disputeId} not found`), { code: ErrorCodes.NOT_FOUND });
        }

        const current = currentResult.rows[0];

        if (!isValidTransition(current.state, 'EVIDENCE_REQUESTED')) {
          throw Object.assign(
            new Error(`Cannot transition dispute from ${current.state} to EVIDENCE_REQUESTED`),
            { code: ErrorCodes.INVALID_TRANSITION }
          );
        }

        // CAS update: only succeeds if state hasn't changed since the FOR UPDATE select
        const result = await query<Dispute>(
          `UPDATE disputes SET state = 'EVIDENCE_REQUESTED' WHERE id = $1 AND state = $2 RETURNING *`,
          [disputeId, current.state]
        );

        if (result.rowCount === 0) {
          throw Object.assign(new Error('Dispute state changed concurrently — please retry'), { code: ErrorCodes.INVALID_STATE });
        }

        return result.rows[0];
      });

      return { success: true, data: updated };
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
      const errCode = (error as { code?: string }).code;
      if (errCode === ErrorCodes.NOT_FOUND || errCode === ErrorCodes.INVALID_TRANSITION || errCode === ErrorCodes.INVALID_STATE) {
        return {
          success: false,
          error: {
            code: errCode,
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        };
      }
      disputeServiceLog.error({ err: error instanceof Error ? error.message : String(error) }, 'DisputeService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },

  /**
   * Resolve dispute
   * MVP: Admin check + preconditions + versioned update + outbox events
   * NOTE: Does NOT touch escrow state - that's done by EscrowActionWorker
   */
  resolve: async (params: ResolveDisputeParams): Promise<ServiceResult<Dispute>> => {
    const {
      disputeId,
      resolvedBy,
      resolution,
      resolutionNotes,
      outcomeEscrowAction,
      workerPenalty = false,
      posterPenalty = false,
      refundAmount,
      releaseAmount,
    } = params;
    
    try {
      // Precondition: Check admin permission
      const hasPermission = await canResolveDisputes(resolvedBy);
      if (!hasPermission) {
        return {
          success: false,
          error: {
            code: ErrorCodes.FORBIDDEN,
            message: 'Only admins with can_resolve_disputes permission can resolve disputes',
          },
        };
      }
      
      // Transaction: Resolve dispute + emit outbox events
      const result = await db.transaction(async (query) => {
        // Lock dispute and escrow FOR UPDATE
        const disputeResult = await query<Dispute>(
          'SELECT * FROM disputes WHERE id = $1 FOR UPDATE',
          [disputeId]
        );
        
        if (disputeResult.rows.length === 0) {
          throw new Error(`Dispute ${disputeId} not found`);
        }
        
        const dispute = disputeResult.rows[0];
        
        // Precondition: Not already RESOLVED
        if (dispute.state === 'RESOLVED') {
          throw new Error('Dispute is already resolved');
        }
        
        if (!isValidTransition(dispute.state, 'RESOLVED')) {
          throw new Error(`Cannot resolve dispute from ${dispute.state}`);
        }
        
        // Lock escrow FOR UPDATE
        const escrowResult = await query<Escrow>(
          'SELECT * FROM escrows WHERE id = $1 FOR UPDATE',
          [dispute.escrow_id]
        );
        
        if (escrowResult.rows.length === 0) {
          throw new Error(`Escrow ${dispute.escrow_id} not found`);
        }
        
        const escrow = escrowResult.rows[0];
        
        // Precondition: Escrow must be LOCKED_DISPUTE
        if (escrow.state !== 'LOCKED_DISPUTE') {
          throw new Error(`Escrow must be LOCKED_DISPUTE to resolve dispute (current: ${escrow.state})`);
        }
        
        // Precondition: Validate SPLIT amounts
        if (outcomeEscrowAction === 'SPLIT') {
          if (refundAmount === undefined || refundAmount === null || releaseAmount === undefined || releaseAmount === null) {
            throw new Error('SPLIT resolution requires refund_amount and release_amount');
          }
          if (refundAmount < 0 || releaseAmount < 0) {
            throw new Error('SPLIT amounts must be non-negative');
          }
          if (refundAmount === 0 || releaseAmount === 0) {
            throw Object.assign(
              new Error('SPLIT requires both amounts to be positive. Use RELEASE or REFUND for full payouts.'),
              { code: 'BAD_REQUEST' }
            );
          }
          // BUG 4 FIX: Validate integer-ness BEFORE the sum check. Math.round() allows
          // float values like 4999.4 + 500.6 = 5000 to pass while storing non-integer
          // cents. Reject non-integers explicitly first.
          if (!Number.isInteger(refundAmount) || !Number.isInteger(releaseAmount)) {
            throw Object.assign(
              new Error('Split amounts must be whole cents'),
              { code: 'INVALID_INPUT' }
            );
          }
          if (refundAmount + releaseAmount !== escrow.amount) {
            throw new Error(`SPLIT amounts (${refundAmount} + ${releaseAmount} = ${refundAmount + releaseAmount}) must sum to escrow amount (${escrow.amount})`);
          }
        }
        
        // Update dispute with version check
        const newVersion = dispute.version + 1;
        const disputeUpdate = await query<Dispute>(
          `UPDATE disputes
           SET state = 'RESOLVED',
               resolved_by = $1,
               resolved_at = NOW(),
               resolution = $2,
               resolution_notes = $3,
               outcome_escrow_action = $4,
               outcome_worker_penalty = $5,
               outcome_poster_penalty = $6,
               outcome_refund_amount = $7,
               outcome_release_amount = $8,
               version = $9
           WHERE id = $10 AND version = $11
           RETURNING *`,
          [
            resolvedBy,
            resolution,
            resolutionNotes || null,
            outcomeEscrowAction,
            workerPenalty,
            posterPenalty,
            refundAmount ?? null,
            releaseAmount ?? null,
            newVersion,
            disputeId,
            dispute.version,
          ]
        );
        
        if (disputeUpdate.rowCount === 0) {
          throw new Error('Version conflict: dispute was modified by another process');
        }
        
        const resolvedDispute = disputeUpdate.rows[0];
        
        // Write outbox event: dispute.resolved
        await writeToOutbox({
          eventType: 'dispute.resolved',
          aggregateType: 'dispute',
          aggregateId: dispute.id,
          eventVersion: newVersion,
          payload: {
            dispute_id: dispute.id,
            escrow_id: dispute.escrow_id,
            task_id: dispute.task_id,
            actor_id: resolvedBy,
            state: 'RESOLVED',
            version: newVersion,
          },
          queueName: 'critical_trust',
        });
        
        // Write trust events: trust.dispute_resolved.worker and trust.dispute_resolved.poster
        // Generate deterministic idempotency keys
        const workerTrustIdempotencyKey = `trust.dispute_resolved.worker:${dispute.id}:1`;
        const posterTrustIdempotencyKey = `trust.dispute_resolved.poster:${dispute.id}:1`;
        
        // Format resolvedBy: 'admin:usr_xxx' or 'system'
        const resolvedByFormatted = resolvedBy.startsWith('usr_') ? `admin:${resolvedBy}` : resolvedBy;
        
        // Worker trust event
        await writeToOutbox({
          eventType: 'trust.dispute_resolved.worker',
          aggregateType: 'user',
          aggregateId: dispute.worker_id,
          eventVersion: 1,
          payload: {
            disputeId: dispute.id,
            taskId: dispute.task_id,
            escrowId: dispute.escrow_id,
            userId: dispute.worker_id,
            role: 'worker',
            penalty: workerPenalty,
            outcomeEscrowAction: outcomeEscrowAction,
            resolvedBy: resolvedByFormatted,
          },
          queueName: 'critical_trust',
          idempotencyKey: workerTrustIdempotencyKey,
        });
        
        // Poster trust event
        await writeToOutbox({
          eventType: 'trust.dispute_resolved.poster',
          aggregateType: 'user',
          aggregateId: dispute.poster_id,
          eventVersion: 1,
          payload: {
            disputeId: dispute.id,
            taskId: dispute.task_id,
            escrowId: dispute.escrow_id,
            userId: dispute.poster_id,
            role: 'poster',
            penalty: posterPenalty,
            outcomeEscrowAction: outcomeEscrowAction,
            resolvedBy: resolvedByFormatted,
          },
          queueName: 'critical_trust',
          idempotencyKey: posterTrustIdempotencyKey,
        });
        
        // Write escrow action request outbox event (exactly one)
        const escrowEventType = outcomeEscrowAction === 'RELEASE'
          ? 'escrow.release_requested'
          : outcomeEscrowAction === 'REFUND'
          ? 'escrow.refund_requested'
          : 'escrow.partial_refund_requested';
        
        await writeToOutbox({
          eventType: escrowEventType,
          aggregateType: 'escrow',
          aggregateId: escrow.id,
          payload: {
            escrow_id: escrow.id,
            task_id: dispute.task_id,
            dispute_id: dispute.id,
            reason: 'dispute_resolution',
            outcome_escrow_action: outcomeEscrowAction,
            refund_amount: refundAmount,
            release_amount: releaseAmount,
          },
          queueName: 'critical_payments',
        });
        
        return resolvedDispute;
      });
      
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: error.message,
            },
          };
        }
        if (error.message.includes('permission') || error.message.includes('FORBIDDEN')) {
          return {
            success: false,
            error: {
              code: ErrorCodes.FORBIDDEN,
              message: error.message,
            },
          };
        }
        if (error.message.includes('Cannot resolve') || error.message.includes('must be') || error.message.includes('Version conflict') || error.message.includes('already resolved') || error.message.includes('SPLIT')) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: error.message,
            },
          };
        }
      }
      const errCode = (error as { code?: string }).code;
      if (errCode === 'BAD_REQUEST') {
        return {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        };
      }
      if (isInvariantViolation(error)) {
        return {
          success: false,
          error: {
            code: error.code || 'INVARIANT_VIOLATION',
            message: getErrorMessage(error.code || ''),
          },
        };
      }
      disputeServiceLog.error({ err: error instanceof Error ? error.message : String(error) }, 'DisputeService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },

  /**
   * Escalate dispute to higher authority
   */
  escalate: async (disputeId: string): Promise<ServiceResult<Dispute>> => {
    try {
      const updated = await db.transaction(async (query) => {
        // Lock the row to prevent concurrent state transitions
        const currentResult = await query<Dispute>(
          'SELECT * FROM disputes WHERE id = $1 FOR UPDATE',
          [disputeId]
        );

        if (currentResult.rows.length === 0) {
          throw Object.assign(new Error(`Dispute ${disputeId} not found`), { code: ErrorCodes.NOT_FOUND });
        }

        const current = currentResult.rows[0];

        if (!isValidTransition(current.state, 'ESCALATED')) {
          throw Object.assign(
            new Error(`Cannot escalate dispute from ${current.state}`),
            { code: ErrorCodes.INVALID_TRANSITION }
          );
        }

        // CAS update: only succeeds if state hasn't changed since the FOR UPDATE select
        const result = await query<Dispute>(
          `UPDATE disputes SET state = 'ESCALATED' WHERE id = $1 AND state = $2 RETURNING *`,
          [disputeId, current.state]
        );

        if (result.rowCount === 0) {
          throw Object.assign(new Error('Dispute state changed concurrently — please retry'), { code: ErrorCodes.INVALID_STATE });
        }

        return result.rows[0];
      });

      return { success: true, data: updated };
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
      const errCode = (error as { code?: string }).code;
      if (errCode === ErrorCodes.NOT_FOUND || errCode === ErrorCodes.INVALID_TRANSITION || errCode === ErrorCodes.INVALID_STATE) {
        return {
          success: false,
          error: {
            code: errCode,
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        };
      }
      disputeServiceLog.error({ err: error instanceof Error ? error.message : String(error) }, 'DisputeService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
};

export default DisputeService;
