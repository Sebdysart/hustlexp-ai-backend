/**
 * Biometric Analyzer Worker v1.0.0
 *
 * Asynchronous biometric analysis of proof submissions
 *
 * Processes proof_submissions queue via BullMQ.
 * Analyzes photos for liveness detection and deepfake scoring.
 *
 * Pattern:
 * 1. Job triggered on proof photo upload
 * 2. Call BiometricVerificationService.analyzeFacePhoto()
 * 3. Update proof_submissions table with scores
 * 4. Flag for manual review if HIGH/CRITICAL risk
 *
 * @see BiometricVerificationService.ts
 * @see schema.sql v1.8.0 (proof_submissions biometric fields)
 */

import { db } from '../db.js';
import { BiometricVerificationService } from '../services/BiometricVerificationService.js';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';
import { workerLogger } from '../logger.js';
import type { Job } from 'bullmq';
import { issueSingleSystemMediaAccess } from '../services/PrivateMediaDeliveryService.js';

const log = workerLogger.child({ worker: 'biometric-analyzer' });

// ============================================================================
// TYPES
// ============================================================================

interface BiometricAnalysisJobData {
  proof_id: string;
  // Rolling-upgrade fields are deliberately ignored. Queue payloads are not
  // media authority; the worker resolves a consumed proof receipt below.
  photo_url?: string;
  lidar_depth_map_url?: string;
}

interface BiometricProofMediaContext {
  biometric_analysis: Record<string, unknown> | null;
  task_id: string;
  storage_key: string | null;
}

// ============================================================================
// JOB PROCESSOR
// ============================================================================

/**
 * Process biometric analysis job
 * Analyzes proof photo and updates database
 */
export const processBiometricAnalysisJob = async (job: Job<BiometricAnalysisJobData>): Promise<void> => {
  const { proof_id } = job.data;

  try {
    log.info({ proofId: proof_id }, 'Processing biometric analysis');

    // W-17 FIX: Check if biometric analysis was already completed for this proof
    // before calling Rekognition. On BullMQ retry, without this guard, the worker
    // would make a duplicate (costly and potentially incorrect) Rekognition API call.
    const existingAnalysis = await db.query<BiometricProofMediaContext>(
      `SELECT ps.metadata->>'biometric_analysis' AS biometric_analysis,
              p.task_id::TEXT AS task_id,
              pp.storage_key
       FROM proofs p
       LEFT JOIN LATERAL (
         SELECT metadata
         FROM proof_submissions
         WHERE proof_id = p.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) ps ON TRUE
       LEFT JOIN LATERAL (
         SELECT storage_key
         FROM proof_photos
         WHERE proof_id = p.id
         ORDER BY sequence_number ASC, created_at ASC, id ASC
         LIMIT 1
       ) pp ON TRUE
       WHERE p.id = $1`,
      [proof_id]
    );
    const proofMedia = existingAnalysis.rows[0];
    if (proofMedia?.biometric_analysis) {
      log.info({ proofId: proof_id }, 'Biometric analysis already complete, skipping Rekognition call');
      return;
    }
    if (!proofMedia?.storage_key || !proofMedia.task_id) {
      throw new Error('PROOF_MEDIA_RECEIPT_REQUIRED');
    }
    const privatePhoto = await issueSingleSystemMediaAccess({
      taskId: proofMedia.task_id,
      purpose: 'PROOF',
      accessReason: 'BIOMETRIC_ANALYSIS',
      consumerId: proof_id,
      storageKey: proofMedia.storage_key,
    });
    if (!privatePhoto) throw new Error('PROOF_MEDIA_RECEIPT_REQUIRED');

    // Run biometric analysis
    const result = await BiometricVerificationService.analyzeProofSubmission(
      proof_id,
      privatePhoto.downloadUrl,
      undefined,
    );

    if (!result.success) {
      if (result.error?.code === 'BIOMETRIC_PROVIDER_UNAVAILABLE') {
        log.warn({ proofId: proof_id }, 'Biometric provider unavailable; proof requires human review');
        return;
      }
      throw new Error(result.error?.message || 'Biometric analysis failed');
    }

    const analysis = result.data!;

    // Update proof_submissions table (scores already stored by service)
    // Add analysis recommendation to proof metadata
    const metadataWrite = await db.query(
      `WITH target AS (
         SELECT id FROM proof_submissions
         WHERE proof_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       UPDATE proof_submissions ps
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{biometric_analysis}',
         $1::jsonb
       )
       FROM target
       WHERE ps.id = target.id
       RETURNING ps.id`,
      [
        JSON.stringify({
          recommendation: analysis.recommendation,
          flags: analysis.flags,
          risk_level: analysis.scores.risk_level,
          analyzed_at: new Date().toISOString()
        }),
        proof_id
      ]
    );
    if ((metadataWrite.rowCount ?? 0) === 0) {
      throw new Error('PROOF_SIGNAL_TARGET_NOT_FOUND');
    }

    // If HIGH/CRITICAL risk, flag for manual review
    if (analysis.recommendation === 'reject' || analysis.recommendation === 'manual_review') {
      log.warn({ proofId: proof_id, recommendation: analysis.recommendation, reasoning: analysis.reasoning, riskLevel: analysis.scores.risk_level, flags: analysis.flags }, 'Biometric proof flagged for review');

      // Flag in DB for manual review queue
      const reviewWrite = await db.query(
        `WITH target AS (
           SELECT id FROM proof_submissions
           WHERE proof_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT 1
         )
         UPDATE proof_submissions ps
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{manual_review_required}',
           'true'::jsonb
         )
         FROM target
         WHERE ps.id = target.id
         RETURNING ps.id`,
        [proof_id]
      );
      if ((reviewWrite.rowCount ?? 0) === 0) {
        throw new Error('PROOF_SIGNAL_TARGET_NOT_FOUND');
      }

      // Notify admins of flagged proof
      await notifyAdmins({
        title: `🔬 Biometric Review: ${analysis.recommendation === 'reject' ? 'REJECT' : 'Manual Review'}`,
        body: `Proof ${proof_id} flagged for ${analysis.recommendation}. Risk: ${analysis.scores.risk_level}. Flags: ${analysis.flags.join(', ')}. ${analysis.reasoning}`,
        deepLink: `app://admin/proof-review/${proof_id}`,
        priority: analysis.recommendation === 'reject' ? 'CRITICAL' : 'HIGH',
        metadata: {
          proofId: proof_id,
          recommendation: analysis.recommendation,
          riskLevel: analysis.scores.risk_level,
          flags: analysis.flags,
          reasoning: analysis.reasoning,
        },
      }).catch(err => log.error({ proofId: proof_id, err }, 'Failed to notify admins of biometric flag'));
    }

    log.info({ proofId: proof_id, recommendation: analysis.recommendation }, 'Biometric analysis completed');
  } catch (error) {
    log.error({ proofId: proof_id, err: error }, 'Biometric analysis failed');
    throw error; // BullMQ will retry
  }
};

// ============================================================================
// QUEUE CONFIGURATION
// ============================================================================

export const biometricAnalysisQueueConfig = {
  name: 'biometric-analysis',
  processor: processBiometricAnalysisJob,
  options: {
    attempts: 3, // Retry up to 3 times
    backoff: {
      type: 'exponential' as const,
      delay: 2000 // Start with 2 seconds
    }
  }
};
