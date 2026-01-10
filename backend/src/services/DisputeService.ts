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

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult, Dispute, DisputeState } from '../types';
import { ErrorCodes } from '../types';

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
   */
  create: async (params: CreateDisputeParams): Promise<ServiceResult<Dispute>> => {
    const { taskId, escrowId, initiatedBy, posterId, workerId, reason, description } = params;
    
    try {
      // Lock escrow for dispute
      await db.query(
        `UPDATE escrows SET state = 'LOCKED_DISPUTE' WHERE id = $1`,
        [escrowId]
      );
      
      // Create dispute
      const result = await db.query<Dispute>(
        `INSERT INTO disputes (
          task_id, escrow_id, initiated_by, poster_id, worker_id,
          reason, description, state
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN')
        RETURNING *`,
        [taskId, escrowId, initiatedBy, posterId, workerId, reason, description]
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
   * Resolve a dispute
   * This will update the escrow state based on the outcome
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
      // Get dispute and escrow
      const disputeResult = await db.query<Dispute>(
        'SELECT * FROM disputes WHERE id = $1',
        [disputeId]
      );
      
      if (disputeResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Dispute ${disputeId} not found`,
          },
        };
      }
      
      const dispute = disputeResult.rows[0];
      
      if (!isValidTransition(dispute.state, 'RESOLVED')) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_TRANSITION,
            message: `Cannot resolve dispute in state ${dispute.state}`,
          },
        };
      }
      
      // Use transaction to update dispute and escrow atomically
      const result = await db.transaction(async (query) => {
        // Update dispute
        const disputeUpdate = await query<Dispute>(
          `UPDATE disputes
           SET state = 'RESOLVED',
               resolved_by = $1,
               resolved_at = NOW(),
               resolution = $2,
               resolution_notes = $3,
               outcome_escrow_action = $4,
               outcome_worker_penalty = $5,
               outcome_poster_penalty = $6
           WHERE id = $7
           RETURNING *`,
          [resolvedBy, resolution, resolutionNotes, outcomeEscrowAction, workerPenalty, posterPenalty, disputeId]
        );
        
        // Update escrow based on outcome
        if (outcomeEscrowAction === 'RELEASE') {
          await query(
            `UPDATE escrows SET state = 'RELEASED', released_at = NOW() WHERE id = $1`,
            [dispute.escrow_id]
          );
        } else if (outcomeEscrowAction === 'REFUND') {
          await query(
            `UPDATE escrows SET state = 'REFUNDED', refunded_at = NOW() WHERE id = $1`,
            [dispute.escrow_id]
          );
        } else if (outcomeEscrowAction === 'SPLIT') {
          if (!refundAmount || !releaseAmount) {
            throw new Error('SPLIT resolution requires refund_amount and release_amount');
          }
          await query(
            `UPDATE escrows 
             SET state = 'REFUND_PARTIAL',
                 refund_amount = $1,
                 release_amount = $2,
                 released_at = NOW(),
                 refunded_at = NOW()
             WHERE id = $3`,
            [refundAmount, releaseAmount, dispute.escrow_id]
          );
        }
        
        return disputeUpdate.rows[0];
      });
      
      return { success: true, data: result };
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
