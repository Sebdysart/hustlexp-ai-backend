/**
 * ProofService v1.0.0
 * 
 * CONSTITUTIONAL: Supports INV-3
 * 
 * INV-3: Task can only be COMPLETED if proof is ACCEPTED
 * 
 * Manages proof lifecycle: submission, review, acceptance/rejection.
 * Photo storage delegated to R2 storage service.
 * 
 * @see schema.sql §1.4 (proofs, proof_photos tables)
 * @see PRODUCT_SPEC.md §3
 */

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';

// ============================================================================
// TYPES
// ============================================================================

import type { Proof, ProofState, ProofPhoto } from '../types';


interface SubmitProofParams {
  taskId: string;
  submitterId: string;
  description?: string;
}

interface AddPhotoParams {
  proofId: string;
  storageKey: string;
  contentType: string;
  fileSizeBytes: number;
  checksumSha256: string;
  captureTime?: Date;
  sequenceNumber?: number;
}

interface ReviewProofParams {
  proofId: string;
  reviewerId: string;
  decision: 'ACCEPTED' | 'REJECTED';
  reason?: string;
}

// ============================================================================
// STATE MACHINE
// ============================================================================

const VALID_TRANSITIONS: Record<ProofState, ProofState[]> = {
  PENDING: ['SUBMITTED'],
  SUBMITTED: ['ACCEPTED', 'REJECTED', 'EXPIRED'],
  ACCEPTED: [],  // TERMINAL
  REJECTED: [],  // TERMINAL
  EXPIRED: [],   // TERMINAL
};

function isValidTransition(from: ProofState, to: ProofState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// SERVICE
// ============================================================================

export const ProofService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get proof by ID
   */
  getById: async (proofId: string): Promise<ServiceResult<Proof>> => {
    try {
      const result = await db.query<Proof>(
        'SELECT * FROM proofs WHERE id = $1',
        [proofId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Proof ${proofId} not found`,
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
   * Get proof by task ID
   */
  getByTaskId: async (taskId: string): Promise<ServiceResult<Proof | null>> => {
    try {
      const result = await db.query<Proof>(
        'SELECT * FROM proofs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
        [taskId]
      );
      
      return { success: true, data: result.rows[0] || null };
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
   * Get photos for a proof
   */
  getPhotos: async (proofId: string): Promise<ServiceResult<ProofPhoto[]>> => {
    try {
      const result = await db.query<ProofPhoto>(
        'SELECT * FROM proof_photos WHERE proof_id = $1 ORDER BY sequence_number',
        [proofId]
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
   * Submit proof for a task
   * Creates proof in PENDING state, then transitions to SUBMITTED
   */
  submit: async (params: SubmitProofParams): Promise<ServiceResult<Proof>> => {
    const { taskId, submitterId, description } = params;
    
    try {
      // Create proof in PENDING state
      const createResult = await db.query<Proof>(
        `INSERT INTO proofs (task_id, submitter_id, state, description)
         VALUES ($1, $2, 'PENDING', $3)
         RETURNING *`,
        [taskId, submitterId, description]
      );
      
      const proof = createResult.rows[0];
      
      // Transition to SUBMITTED
      const submitResult = await db.query<Proof>(
        `UPDATE proofs
         SET state = 'SUBMITTED', submitted_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [proof.id]
      );
      
      return { success: true, data: submitResult.rows[0] };
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
   * Add photo to proof
   */
  addPhoto: async (params: AddPhotoParams): Promise<ServiceResult<ProofPhoto>> => {
    const {
      proofId,
      storageKey,
      contentType,
      fileSizeBytes,
      checksumSha256,
      captureTime,
      sequenceNumber,
    } = params;
    
    try {
      // Get next sequence number if not provided
      let seqNum = sequenceNumber;
      if (seqNum === undefined) {
        const countResult = await db.query<{ count: string }>(
          'SELECT COUNT(*) as count FROM proof_photos WHERE proof_id = $1',
          [proofId]
        );
        seqNum = parseInt(countResult.rows[0].count, 10) + 1;
      }
      
      const result = await db.query<ProofPhoto>(
        `INSERT INTO proof_photos (
          proof_id, storage_key, content_type, file_size_bytes,
          checksum_sha256, capture_time, sequence_number
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *`,
        [proofId, storageKey, contentType, fileSizeBytes, checksumSha256, captureTime, seqNum]
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
   * Review proof (accept/reject/needs_more)
   * 
   * When ACCEPTED, task can transition to COMPLETED (INV-3)
   */
  review: async (params: ReviewProofParams): Promise<ServiceResult<Proof>> => {
    const { proofId, reviewerId, decision, reason } = params;
    
    try {
      // Get current proof state
      const currentResult = await db.query<Proof>(
        'SELECT * FROM proofs WHERE id = $1',
        [proofId]
      );
      
      if (currentResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Proof ${proofId} not found`,
          },
        };
      }
      
      const current = currentResult.rows[0];
      
      // Validate transition (database will also enforce, but we check first for better error messages)
      if (!isValidTransition(current.state, decision)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_TRANSITION,
            message: `Cannot transition proof from ${current.state} to ${decision}`,
          },
        };
      }
      
      // Update proof (database triggers will enforce INV-3 when task tries to complete)
      const result = await db.query<Proof>(
        `UPDATE proofs
         SET state = $1, reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3
         WHERE id = $4
         RETURNING *`,
        [decision, reviewerId, reason, proofId]
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

export default ProofService;
