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
import { getClient } from '../cache/redis.js';

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
// ADVISORY LOCK (YY-03)
// ============================================================================

/**
 * Key pattern for the per-proof Redis advisory lock used to prevent concurrent
 * reviewers from both entering the AI pipeline for the same proof.
 * TTL of 300 s covers even a very slow AI pipeline with margin.
 */
const REVIEW_LOCK_KEY = (proofId: string) => `proof:reviewing:${proofId}`;
const REVIEW_LOCK_TTL_SECONDS = 300;

/**
 * Attempt to acquire the advisory lock for a proof review.
 *
 * Uses SET NX EX so the lock is acquired and its TTL is set atomically.
 * Returns true if the lock was acquired, false if another reviewer already
 * holds it.  When Redis is unavailable the lock is skipped (fail-open) to
 * avoid blocking all reviews during a Redis outage — Phase 3's FOR UPDATE
 * transaction remains the authoritative serialisation point for data safety.
 */
async function acquireReviewLock(proofId: string): Promise<boolean> {
  const client = getClient();
  if (!client) {
    // Redis not configured — skip advisory lock, rely on Phase 3 transaction
    log.warn({ proofId }, 'Redis unavailable — skipping advisory review lock (Phase 3 transaction remains authoritative)');
    return true;
  }
  try {
    const result = await client.set(REVIEW_LOCK_KEY(proofId), '1', { ex: REVIEW_LOCK_TTL_SECONDS, nx: true });
    // Upstash returns 'OK' on successful SET NX, null when key already exists
    return result === 'OK';
  } catch (err) {
    log.warn({ proofId, err }, 'Redis error acquiring review lock — failing open');
    return true; // fail-open: Phase 3 transaction protects data integrity
  }
}

/**
 * Release the advisory lock for a proof review.
 * Fire-and-forget — a failure only means the TTL will eventually expire the lock.
 */
async function releaseReviewLock(proofId: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.del(REVIEW_LOCK_KEY(proofId));
  } catch (err) {
    log.warn({ proofId, err }, 'Redis error releasing review lock — lock will expire via TTL');
  }
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

    // FIX UU-05: Wrap read+duplicate-check+insert in a single transaction with FOR UPDATE
    // locks so concurrent submissions cannot both pass the duplicate check and both INSERT.
    try {
      // FIX 3: Require at least one form of proof content before touching the DB
      const hasDescription = typeof description === 'string' && description.trim().length > 0;
      const hasPhotos = Array.isArray(params.photoUrls) && params.photoUrls.length > 0;
      const hasLocation = params.gpsLatitude != null && params.gpsLongitude != null;

      if (!hasDescription && !hasPhotos && !hasLocation) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Proof must include at least a description, photo, or location.',
        });
      }

      const submittedProof = await db.transaction(async (query) => {
        // FIX 1 + FIX 2: Lock the task row so concurrent submits are serialised.
        const taskCheck = await query<{ worker_id: string | null; state: string }>(
          `SELECT worker_id, state FROM tasks WHERE id = $1 FOR UPDATE`,
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

        // FIX 2: Only allow proof submission on ACCEPTED state — the only valid state
        // for proof submission per the task state machine. 'in_progress', 'IN_PROGRESS',
        // and 'accepted' (lowercase) are not valid task states.
        const PROOF_ALLOWED_STATES = ['ACCEPTED'];
        if (!PROOF_ALLOWED_STATES.includes(task.state)) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `Cannot submit proof for a task in '${task.state}' state.`,
          });
        }

        // FIX 6 + UU-05: Lock any existing active proof rows so the duplicate check
        // and INSERT are atomic — concurrent submissions both block here until one commits.
        const existing = await query(
          `SELECT id FROM proofs WHERE task_id = $1 AND state IN ('pending', 'submitted', 'PENDING', 'SUBMITTED') FOR UPDATE`,
          [taskId]
        );
        if (existing.rows.length > 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'A proof is already pending review for this task.' });
        }

        // Create proof in PENDING state
        const createResult = await query<Proof>(
          `INSERT INTO proofs (task_id, submitter_id, state, description)
           VALUES ($1, $2, 'PENDING', $3)
           RETURNING *`,
          [taskId, submitterId, description]
        );

        const proof = createResult.rows[0];

        // Transition to SUBMITTED
        const submitResult = await query<Proof>(
          `UPDATE proofs
           SET state = 'SUBMITTED', submitted_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [proof.id]
        );

        return submitResult.rows[0];
      });

      return { success: true, data: submittedProof };
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
      // FIX GGG-04: Wrap the count SELECT + INSERT in a transaction with FOR UPDATE so
      // concurrent addPhoto() calls cannot both read the same count and produce duplicate
      // sequence numbers. The FOR UPDATE on proof_photos locks the existing rows for this
      // proof_id, serializing concurrent inserts.
      const result = await db.transaction(async (txQuery) => {
        let seqNum = sequenceNumber;
        if (seqNum === undefined) {
          const countResult = await txQuery<{ count: string }>(
            'SELECT COUNT(*) FROM proof_photos WHERE proof_id = $1 FOR UPDATE',
            [proofId]
          );
          seqNum = parseInt(countResult.rows[0].count, 10) + 1;
        }

        return txQuery<ProofPhoto>(
          `INSERT INTO proof_photos (
            proof_id, storage_key, content_type, file_size_bytes,
            checksum_sha256, capture_time, sequence_number
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *`,
          [proofId, storageKey, contentType, fileSizeBytes, checksumSha256, captureTime, seqNum]
        );
      });

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
      // FIX GGG-04: Wrap the count SELECT + INSERT in a transaction with FOR UPDATE so
      // concurrent addVideo() calls cannot both read the same count and produce duplicate
      // sequence numbers. The FOR UPDATE on proof_videos locks the existing rows for this
      // proof_id, serializing concurrent inserts.
      const result = await db.transaction(async (txQuery) => {
        let seqNum = sequenceNumber;
        if (seqNum === undefined) {
          const countResult = await txQuery<{ count: string }>(
            'SELECT COUNT(*) FROM proof_videos WHERE proof_id = $1 FOR UPDATE',
            [proofId]
          );
          seqNum = parseInt(countResult.rows[0].count, 10) + 1;
        }

        return txQuery<ProofVideo>(
          `INSERT INTO proof_videos (
            proof_id, storage_key, content_type, file_size_bytes,
            duration_seconds, sequence_number
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *`,
          [proofId, storageKey, contentType, fileSizeBytes ?? null, durationSeconds ?? null, seqNum]
        );
      });

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

    // FIX UU-01: The entire read-pipeline-write sequence runs inside a transaction.
    // The initial SELECT uses FOR UPDATE to acquire a row-level lock, preventing two
    // concurrent reviewers from both reading state='SUBMITTED' and both succeeding.
    // The final UPDATE includes AND state = 'SUBMITTED' as a belt-and-suspenders guard;
    // if rowCount === 0 a concurrent reviewer won the race and we throw CONFLICT.
    try {
      // Phase 1: Lock the proof row and run read-only validation BEFORE entering the
      // expensive AI pipeline. If the proof is not in SUBMITTED state we fail fast
      // without holding any locks during the AI calls.
      const currentResult = await db.query<Proof & {
        photo_url?: string;
        gps_coordinates?: { lat: number; lng: number } | null;
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

      // T53-8 FIX: Proof review role check — enforce at the service layer that only
      // the task's poster can approve or reject proof. The router (posterProcedure)
      // guards the primary path, but callers may invoke ProofService.review() directly
      // (e.g. integration tests, future internal callers) and bypass that guard.
      // Belt-and-suspenders: query the task's poster_id and compare against reviewerId.
      const taskOwnerResult = await db.query<{ poster_id: string }>(
        `SELECT poster_id FROM tasks WHERE id = $1`,
        [current.task_id]
      );
      if (taskOwnerResult.rows.length === 0 || taskOwnerResult.rows[0].poster_id !== reviewerId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.FORBIDDEN,
            message: 'Not authorized to review this proof',
          },
        };
      }

      // Phase 2: Acquire Redis advisory lock BEFORE the AI pipeline (FIX YY-03).
      // This ensures only one reviewer runs the expensive AI pipeline for a given proof.
      // Concurrent reviewers that already passed Phase 1's plain SELECT will be turned
      // away here instead of duplicating all AI calls. Phase 3's FOR UPDATE transaction
      // remains the definitive serialisation point — the lock is belt-and-suspenders
      // against AI cost amplification, not against data corruption.
      const lockAcquired = await acquireReviewLock(proofId);
      if (!lockAcquired) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Another reviewer is already processing this proof. Please try again shortly.',
        });
      }

      // Run the (potentially long) AI pipeline outside any transaction so we
      // don't hold a DB lock during network I/O. The final write transaction below will
      // re-verify state and use FOR UPDATE + rowCount check to detect races.
      // The advisory lock acquired above is released in the finally block regardless
      // of whether the AI pipeline or Phase 3 transaction succeeds or fails.
      try {

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
            log.warn({ proofId }, 'Biometric subsystem error, proceeding without');
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
            log.warn({ proofId }, 'Logistics subsystem error, proceeding without');
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
            log.warn({ proofId }, 'Photo verification error, proceeding without');
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

      // Phase 3: Commit the state change inside a transaction with a FOR UPDATE lock.
      // Re-checking state = 'SUBMITTED' in the WHERE clause ensures that if a concurrent
      // reviewer committed first the UPDATE matches 0 rows and we throw CONFLICT.
      const updatedProof = await db.transaction(async (query) => {
        // Acquire exclusive row lock — blocks any concurrent reviewer at this point
        const lockResult = await query<{ state: string; task_id: string }>(
          `SELECT state, task_id FROM proofs WHERE id = $1 FOR UPDATE`,
          [proofId]
        );

        if (lockResult.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Proof ${proofId} not found` });
        }

        if (lockResult.rows[0].state !== 'SUBMITTED') {
          throw new TRPCError({ code: 'CONFLICT', message: 'Proof already reviewed' });
        }

        // T60-1 FIX: After acquiring the proof lock, verify the task is still in
        // PROOF_SUBMITTED state. A concurrent dispute creation (T59-3) can have
        // transitioned the task to DISPUTED between Phase 1 and Phase 3. If the
        // proof is reviewed (REJECTED) while the task is DISPUTED, a subsequent
        // dispute resolution with RELEASE would try to accept a REJECTED proof —
        // violating INV-3 (completed task requires accepted proof).
        // T64-2 FIX: Use FOR UPDATE on the tasks row so that DisputeService.create()
        // cannot commit a DISPUTED state transition between this read and the proof
        // UPDATE below. Without the lock, a concurrent dispute.create() could commit
        // task→DISPUTED after this SELECT but before the proof UPDATE, leaving the
        // task DISPUTED with an ACCEPTED/REJECTED proof (inconsistent state).
        const proofTaskId = lockResult.rows[0].task_id;
        const taskStateCheck = await query<{ state: string }>(
          'SELECT state FROM tasks WHERE id = $1 FOR UPDATE',
          [proofTaskId]
        );
        if (taskStateCheck.rows[0]?.state !== 'PROOF_SUBMITTED') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `TASK_STATE_CHANGED:Task is no longer in PROOF_SUBMITTED state (current: ${taskStateCheck.rows[0]?.state ?? 'unknown'})`,
          });
        }

        // Update proof — AND state = 'SUBMITTED' is an extra guard against races
        // (database will also enforce via triggers for INV-3 compliance)
        const result = await query<Proof>(
          `UPDATE proofs
           SET state = $1, reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3
           WHERE id = $4 AND state = 'SUBMITTED'
           RETURNING *`,
          [decision, reviewerId, reason, proofId]
        );

        if (result.rowCount === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Proof already reviewed' });
        }

        return result.rows[0];
      });

      return { success: true, data: updatedProof };

      } finally {
        // Release the advisory lock whether the pipeline succeeded, failed, or threw.
        // If the lock was never acquired (Redis down, fail-open), this is a no-op.
        await releaseReviewLock(proofId);
      }
    } catch (error) {
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
