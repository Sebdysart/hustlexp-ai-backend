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

import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../db';
import type { ServiceResult, Dispute, DisputeState, Escrow } from '../types';
import { ErrorCodes } from '../types';
import { writeToOutbox } from '../jobs/outbox-helpers';
import { TaskService } from './TaskService';
import { EscrowService } from './EscrowService';

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
   * Get disputes for a task
   */
  getByTaskId: async (taskId: string): Promise<ServiceResult<Dispute[]>> => {
    try {
      const result = await db.query<Dispute>(
        'SELECT * FROM disputes WHERE task_id = $1 ORDER BY created_at DESC',
        [taskId]
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
   * Get disputes for a user (as poster or worker)
   */
  getByUserId: async (userId: string): Promise<ServiceResult<Dispute[]>> => {
    try {
      const result = await db.query<Dispute>(
        `SELECT * FROM disputes 
         WHERE poster_id = $1 OR worker_id = $1 OR initiated_by = $1
         ORDER BY created_at DESC`,
        [userId]
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
      
      // Precondition: Get task (check completed_at exists and within 48h)
      const taskResult = await TaskService.getById(taskId);
      if (!taskResult.success) return taskResult;
      const task = taskResult.data;
      
      if (!task.completed_at) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Disputes can only be opened for completed tasks',
          },
        };
      }
      
      const disputeWindowHours = 48;
      const disputeWindowMs = disputeWindowHours * 60 * 60 * 1000;
      const now = new Date();
      const completedAt = new Date(task.completed_at);
      
      if (now.getTime() - completedAt.getTime() > disputeWindowMs) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Disputes must be opened within ${disputeWindowHours} hours of task completion`,
          },
        };
      }
      
      // Precondition: Escrow must be FUNDED
      const escrowResult = await EscrowService.getById(escrowId);
      if (!escrowResult.success) return escrowResult;
      const escrow = escrowResult.data;
      
      if (escrow.state !== 'FUNDED') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Escrow must be FUNDED to open dispute (current: ${escrow.state})`,
          },
        };
      }
      
      // Transaction: Create dispute + lock escrow + outbox event
      const result = await db.transaction(async (query) => {
        // Lock escrow: FUNDED → LOCKED_DISPUTE (versioned)
        const escrowUpdate = await query<Escrow>(
          `UPDATE escrows
           SET state = 'LOCKED_DISPUTE',
               version = version + 1
           WHERE id = $1 AND state = 'FUNDED'
           RETURNING *`,
          [escrowId]
        );
        
        if (escrowUpdate.rowCount === 0) {
          throw new Error('Failed to lock escrow (may have been locked by another process)');
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
   * Request evidence for a dispute
   */
  requestEvidence: async (disputeId: string): Promise<ServiceResult<Dispute>> => {
    try {
      const currentResult = await db.query<Dispute>(
        'SELECT * FROM disputes WHERE id = $1',
        [disputeId]
      );
      
      if (currentResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Dispute ${disputeId} not found`,
          },
        };
      }
      
      const current = currentResult.rows[0];
      
      if (!isValidTransition(current.state, 'EVIDENCE_REQUESTED')) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_TRANSITION,
            message: `Cannot transition dispute from ${current.state} to EVIDENCE_REQUESTED`,
          },
        };
      }
      
      const result = await db.query<Dispute>(
        `UPDATE disputes SET state = 'EVIDENCE_REQUESTED' WHERE id = $1 RETURNING *`,
        [disputeId]
      );
      
      return { success: true, data: result.rows[0] };
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
          if (!refundAmount || !releaseAmount) {
            throw new Error('SPLIT resolution requires refund_amount and release_amount');
          }
          if (refundAmount < 0 || releaseAmount < 0) {
            throw new Error('SPLIT amounts must be non-negative');
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
            refundAmount || null,
            releaseAmount || null,
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
   * Escalate dispute to higher authority
   */
  escalate: async (disputeId: string): Promise<ServiceResult<Dispute>> => {
    try {
      const currentResult = await db.query<Dispute>(
        'SELECT * FROM disputes WHERE id = $1',
        [disputeId]
      );
      
      if (currentResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Dispute ${disputeId} not found`,
          },
        };
      }
      
      const current = currentResult.rows[0];
      
      if (!isValidTransition(current.state, 'ESCALATED')) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_TRANSITION,
            message: `Cannot escalate dispute from ${current.state}`,
          },
        };
      }
      
      const result = await db.query<Dispute>(
        `UPDATE disputes SET state = 'ESCALATED' WHERE id = $1 RETURNING *`,
        [disputeId]
      );
      
      return { success: true, data: result.rows[0] };
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
};

export default DisputeService;
