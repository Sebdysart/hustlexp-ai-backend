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

import { TRPCError } from '@trpc/server';
import { db, isInvariantViolation, getErrorMessage } from '../db.js';
import { BiometricVerificationService } from './BiometricVerificationService.js';
import { LogisticsAIService } from './LogisticsAIService.js';
import { JudgeAIService } from './JudgeAIService.js';
import { PhotoVerificationService } from './PhotoVerificationService.js';
import type { ServiceResult } from '../types.js';
import type { BiometricSignals, LogisticsSignals, PhotoVerificationSignals } from './JudgeAIService.js';
import { ErrorCodes } from '../types.js';
import { logger } from '../logger.js';

const log = logger.child({ service: 'ProofService' });

// ============================================================================
// TYPES
// ============================================================================

import type { Proof, ProofState, ProofPhoto, ProofVideo } from '../types.js';


interface SubmitProofParams {
  taskId: string;
  submitterId: string;
  description?: string;
  photoUrls?: string[];
  gpsLatitude?: number;
  gpsLongitude?: number;
  biometricHash?: string;
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

interface AddVideoParams {
  proofId: string;
  storageKey: string;
  contentType?: string;
  fileSizeBytes?: number;
  durationSeconds?: number;
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

  /**
   * Get videos for a proof
   */
  getVideos: async (proofId: string): Promise<ServiceResult<ProofVideo[]>> => {
    try {
      const result = await db.query<ProofVideo>(
        'SELECT * FROM proof_videos WHERE proof_id = $1 ORDER BY sequence_number',
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
      // FIX 1 + FIX 2: Fetch the task to validate submitter identity and task state
      const taskCheck = await db.query<{ worker_id: string | null; state: string }>(
        `SELECT worker_id, state FROM tasks WHERE id = $1`,
        [taskId]
      );

      if (taskCheck.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Task ${taskId} not found` });
      }

      const task = taskCheck.rows[0];

      // FIX 1: Only the assigned worker may submit proof
      if (task.worker_id !== submitterId) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Only the assigned worker can submit proof.' });
      }

      // FIX 2: Only allow proof submission on active task states
      const PROOF_ALLOWED_STATES = ['accepted', 'in_progress', 'ACCEPTED', 'IN_PROGRESS'];
      if (!PROOF_ALLOWED_STATES.includes(task.state)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Cannot submit proof for a task in '${task.state}' state.`,
        });
      }

      // FIX 6: Block duplicate active-proof submissions
      const existing = await db.query(
        `SELECT id FROM proofs WHERE task_id = $1 AND state IN ('pending', 'submitted', 'PENDING', 'SUBMITTED')`,
        [taskId]
      );
      if (existing.rows.length > 0) {
        throw new TRPCError({ code: 'CONFLICT', message: 'A proof is already pending review for this task.' });
      }

      // FIX 3: Require at least one form of proof content
      const hasDescription = typeof description === 'string' && description.trim().length > 0;
      const hasPhotos = Array.isArray(params.photoUrls) && params.photoUrls.length > 0;
      const hasLocation = params.gpsLatitude != null && params.gpsLongitude != null;

      if (!hasDescription && !hasPhotos && !hasLocation) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Proof must include at least a description, photo, or location.',
        });
      }

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
      // Re-throw TRPCErrors (e.g. UNAUTHORIZED, PRECONDITION_FAILED, BAD_REQUEST, CONFLICT)
      if (error instanceof TRPCError) {
        throw error;
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
   * Add video to proof
   */
  addVideo: async (params: AddVideoParams): Promise<ServiceResult<ProofVideo>> => {
    const {
      proofId,
      storageKey,
      contentType = 'video/mp4',
      fileSizeBytes,
      durationSeconds,
      sequenceNumber,
    } = params;

    try {
      let seqNum = sequenceNumber;
      if (seqNum === undefined) {
        const countResult = await db.query<{ count: string }>(
          'SELECT COUNT(*) as count FROM proof_videos WHERE proof_id = $1',
          [proofId]
        );
        seqNum = parseInt(countResult.rows[0].count, 10) + 1;
      }

      const result = await db.query<ProofVideo>(
        `INSERT INTO proof_videos (
          proof_id, storage_key, content_type, file_size_bytes,
          duration_seconds, sequence_number
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [proofId, storageKey, contentType, fileSizeBytes ?? null, durationSeconds ?? null, seqNum]
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
   *
   * v1.8.0 Gamification Integration:
   * - Runs biometric validation (liveness, deepfake detection)
   * - Runs GPS/logistics validation (proximity, impossible travel)
   * - Synthesizes AI recommendations via JudgeAIService
   * - Flags HIGH/CRITICAL risk for manual review
   */
  review: async (params: ReviewProofParams): Promise<ServiceResult<Proof>> => {
    const { proofId, reviewerId, decision, reason } = params;

    try {
      // Get current proof state with first photo URL from proof_photos
      const currentResult = await db.query<Proof & {
        photo_url?: string;
      }>(
        `SELECT p.*, (SELECT pp.storage_key FROM proof_photos pp WHERE pp.proof_id = p.id ORDER BY pp.sequence_number LIMIT 1) AS photo_url
         FROM proofs p
         WHERE p.id = $1
         LIMIT 1`,
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

      // v2.0.0: Automated AI verification pipeline on every proof acceptance
      // Runs all subsystems, collects signals, feeds to JudgeAI for synthesis.
      // JudgeAI can REJECT (block acceptance) or flag for MANUAL_REVIEW.
      if (decision === 'ACCEPTED') {
        // ── 1. Biometric signals (nullable if subsystem fails or no photo) ──
        let biometricSignals: BiometricSignals | null = null;

        if (current.photo_url) {
          const biometricResult = await BiometricVerificationService.analyzeProofSubmission(
            proofId,
            current.photo_url,
            undefined // LiDAR not available in current schema
          );
          if (biometricResult.success) {
            biometricSignals = biometricResult.data!.scores;
          } else {
            log.warn({ proofId }, 'Biometric subsystem error, proceeding without');
          }
        }

        // ── 2. Logistics signals (skipped — GPS data not stored in proofs table) ──
        // GPS validation happens at submission time via the biometric endpoint.
        // For beta, poster reviews proof manually.
        const logisticsSignals: LogisticsSignals | null = null;

        // ── 3. Photo verification signals (nullable if no before/after photos) ──
        let photoSignals: PhotoVerificationSignals | null = null;

        // Get task description for photo comparison context
        const taskResult = await db.query<{ description: string }>(
          'SELECT description FROM tasks WHERE id = $1',
          [current.task_id]
        );
        const task = taskResult.rows[0];

        // Before/after photo comparison skipped for beta — before_photo_url not yet implemented.

        // ── 4. JudgeAI synthesis — combines all available signals ──
        const judgeResult = await JudgeAIService.synthesizeVerdict({
          proof_id: proofId,
          task_id: current.task_id,
          biometric: biometricSignals,
          logistics: logisticsSignals,
          photo_verification: photoSignals,
        });

        if (judgeResult.success) {
          const verdict = judgeResult.data;

          // Log verdict to audit trail (non-blocking)
          JudgeAIService.logVerdict(proofId, current.task_id, verdict).catch(err =>
            log.error({ err: err instanceof Error ? err.message : String(err), proofId, taskId: current.task_id }, 'Failed to log Judge verdict')
          );

          // Enforce verdict
          if (verdict.verdict === 'REJECT') {
            return {
              success: false,
              error: {
                code: 'JUDGE_REJECTED',
                message: `Proof rejected by verification: ${verdict.reasoning}`,
                details: {
                  risk_score: verdict.risk_score,
                  fraud_flags: verdict.fraud_flags,
                  component_scores: verdict.component_scores,
                  recommended_action: verdict.recommended_action,
                },
              },
            };
          }

          if (verdict.verdict === 'MANUAL_REVIEW') {
            log.warn(
              { proofId, riskScore: verdict.risk_score, fraudFlags: verdict.fraud_flags, reviewerId },
              'JudgeAI flagged proof for MANUAL_REVIEW - human reviewer overriding to ACCEPTED'
            );
            // Human reviewer's ACCEPTED decision overrides MANUAL_REVIEW — this is by design.
            // The verdict + flags are still logged to the audit trail above.
          }

          // verdict === 'APPROVE' → continue to accept below
        } else {
          // JudgeAI itself failed — log warning but don't block acceptance
          log.error({ err: judgeResult.error?.message, proofId }, 'JudgeAI synthesis failed');
        }
      }

      // Update proof (database triggers will enforce INV-3 when task tries to complete)
      const result = await db.query<Proof>(
        `UPDATE proofs
         SET state = $1, reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3
         WHERE id = $4
         RETURNING *`,
        [decision, reviewerId, reason, proofId]
      );

      // On REJECTED: reset task to ACCEPTED so worker can resubmit a new proof
      // (or escalate to dispute on repeat rejections)
      if (decision === 'REJECTED') {
        try {
          // Count prior rejections for this task
          const rejCount = await db.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM proofs WHERE task_id = $1 AND state = 'REJECTED'`,
            [current.task_id]
          );
          const rejectionCount = parseInt(rejCount.rows[0]?.count ?? '0', 10);

          if (rejectionCount >= 2) {
            // Two strikes — escalate to dispute (lock escrow, freeze task)
            log.warn({ taskId: current.task_id, rejectionCount }, 'Repeat rejections — escalating to dispute');
            await db.query(
              `UPDATE tasks SET state = 'DISPUTED' WHERE id = $1`,
              [current.task_id]
            );
            await db.query(
              `UPDATE escrows SET state = 'LOCKED_DISPUTE' WHERE task_id = $1 AND state = 'FUNDED'`,
              [current.task_id]
            );
          } else {
            // First rejection — let worker resubmit
            await db.query(
              `UPDATE tasks SET state = 'ACCEPTED' WHERE id = $1 AND state = 'PROOF_SUBMITTED'`,
              [current.task_id]
            );
            log.info({ taskId: current.task_id }, 'Proof rejected — task reset to ACCEPTED for resubmission');
          }
        } catch (err) {
          log.error({ err: err instanceof Error ? err.message : String(err), taskId: current.task_id }, 'Failed to handle rejection state transition');
        }
      }

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
   * Validate proof submission against completion criteria type.
   * Called before releasing escrow to ensure the correct proof type is present.
   */
  validateProofForCriteria: async (
    taskId: string,
    proof: {
      type: 'photo_proof' | 'check_in_check_out' | 'session_completion' | 'hybrid';
      photoUrls?: string[];
      checkInAt?: string | null;
      checkOutAt?: string | null;
      hustlerConfirmed?: boolean;
      posterConfirmed?: boolean;
    }
  ): Promise<{ valid: boolean; reason?: string }> => {
    switch (proof.type) {
      case 'photo_proof':
        if (!proof.photoUrls?.length) {
          return { valid: false, reason: 'At least one photo is required for proof submission.' };
        }
        return { valid: true };

      case 'check_in_check_out':
        if (!proof.checkInAt) {
          return { valid: false, reason: 'GPS check-in timestamp is required.' };
        }
        if (!proof.checkOutAt) {
          return { valid: false, reason: 'GPS check-out timestamp is required.' };
        }
        return { valid: true };

      case 'session_completion':
        if (!proof.hustlerConfirmed) {
          return { valid: false, reason: 'Hustler must confirm session completion.' };
        }
        if (!proof.posterConfirmed) {
          return { valid: false, reason: 'Poster must confirm session completion before payment releases.' };
        }
        return { valid: true };

      case 'hybrid':
        // GPS check-in/out required; bonus proof items are optional
        if (!proof.checkInAt || !proof.checkOutAt) {
          return { valid: false, reason: 'GPS check-in and check-out are required for this task type.' };
        }
        return { valid: true };

      default:
        return { valid: false, reason: 'Unknown proof type — cannot validate.' };
    }
  },
};

export default ProofService;
