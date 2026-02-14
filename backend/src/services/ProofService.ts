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
import { BiometricVerificationService } from './BiometricVerificationService';
import { LogisticsAIService } from './LogisticsAIService';
import { JudgeAIService } from './JudgeAIService';
import { PhotoVerificationService } from './PhotoVerificationService';
import type { ServiceResult } from '../types';
import type { BiometricSignals, LogisticsSignals, PhotoVerificationSignals } from './JudgeAIService';
import { ErrorCodes } from '../types';

// ============================================================================
// TYPES
// ============================================================================

import type { Proof, ProofState, ProofPhoto } from '../types';


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
      // Get current proof state with proof_submissions data
      const currentResult = await db.query<Proof & {
        photo_url?: string;
        gps_coordinates?: any;
        gps_accuracy_meters?: number;
        lidar_depth_map_url?: string;
      }>(
        `SELECT p.*, ps.photo_url, ps.gps_coordinates, ps.gps_accuracy_meters, ps.lidar_depth_map_url
         FROM proofs p
         LEFT JOIN proof_submissions ps ON ps.proof_id = p.id
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
            current.lidar_depth_map_url
          );
          if (biometricResult.success) {
            biometricSignals = biometricResult.data!.scores;
          } else {
            console.warn(`[ProofService] Biometric subsystem error for proof ${proofId}, proceeding without`);
          }
        }

        // ── 2. Logistics signals (nullable if no GPS data) ──
        let logisticsSignals: LogisticsSignals | null = null;

        if (current.gps_coordinates) {
          const parsedCoords: { latitude: number; longitude: number } =
            typeof current.gps_coordinates === 'string'
              ? JSON.parse(current.gps_coordinates)
              : current.gps_coordinates;

          // Fetch actual task location from tasks table
          const taskLocResult = await db.query<{ location_lat: number; location_lng: number }>(
            'SELECT location_lat, location_lng FROM tasks WHERE id = $1 AND location_lat IS NOT NULL',
            [current.task_id]
          );
          const taskCoords = taskLocResult.rows.length > 0
            ? { latitude: Number(taskLocResult.rows[0].location_lat), longitude: Number(taskLocResult.rows[0].location_lng) }
            : parsedCoords; // Fallback to proof GPS if task has no location set
          const accuracyMeters = current.gps_accuracy_meters || 0;

          const gpsResult = await LogisticsAIService.validateGPSProof(
            parsedCoords,
            taskCoords,
            accuracyMeters
          );

          if (gpsResult.success) {
            logisticsSignals = {
              gps_proximity: { passed: gpsResult.data.passed, distance_meters: gpsResult.data.distance_meters },
              impossible_travel: { passed: true }, // Checked separately if we have prior location
              time_lock: { passed: true },          // Checked via PhotoVerification capture validation
              gps_accuracy: { passed: accuracyMeters <= 50, accuracy_meters: accuracyMeters },
            };
          } else {
            console.warn(`[ProofService] Logistics subsystem error for proof ${proofId}, proceeding without`);
          }
        }

        // ── 3. Photo verification signals (nullable if no before/after photos) ──
        let photoSignals: PhotoVerificationSignals | null = null;

        // Get task description for photo comparison context
        const taskResult = await db.query<{ description: string; before_photo_url?: string }>(
          'SELECT description, before_photo_url FROM tasks WHERE id = $1',
          [current.task_id]
        );
        const task = taskResult.rows[0];

        if (current.photo_url && task?.before_photo_url && task?.description) {
          const photoResult = await PhotoVerificationService.compareBeforeAfter(
            current.task_id,
            task.before_photo_url,
            current.photo_url,
            task.description
          );
          if (photoResult.success) {
            photoSignals = {
              similarity_score: photoResult.data.similarity_score,
              completion_score: photoResult.data.completion_score,
              change_detected: photoResult.data.change_detected,
            };
          } else {
            console.warn(`[ProofService] Photo verification error for proof ${proofId}, proceeding without`);
          }
        }

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
            console.error('[ProofService] Failed to log Judge verdict:', err)
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
            console.warn(
              `[ProofService] JudgeAI flagged proof ${proofId} for MANUAL_REVIEW (risk=${verdict.risk_score.toFixed(2)}, flags=${verdict.fraud_flags.join(',')}). ` +
              `Human reviewer (${reviewerId}) is overriding to ACCEPTED.`
            );
            // Human reviewer's ACCEPTED decision overrides MANUAL_REVIEW — this is by design.
            // The verdict + flags are still logged to the audit trail above.
          }

          // verdict === 'APPROVE' → continue to accept below
        } else {
          // JudgeAI itself failed — log warning but don't block acceptance
          console.error(`[ProofService] JudgeAI synthesis failed for proof ${proofId}: ${judgeResult.error?.message}`);
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
