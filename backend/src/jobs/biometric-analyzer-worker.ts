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

import { db } from '../db';
import { BiometricVerificationService } from '../services/BiometricVerificationService';
import type { Job } from 'bullmq';

// ============================================================================
// TYPES
// ============================================================================

interface BiometricAnalysisJobData {
  proof_id: string;
  photo_url: string;
  lidar_depth_map_url?: string;
}

// ============================================================================
// JOB PROCESSOR
// ============================================================================

/**
 * Process biometric analysis job
 * Analyzes proof photo and updates database
 */
export const processBiometricAnalysisJob = async (job: Job<BiometricAnalysisJobData>): Promise<void> => {
  const { proof_id, photo_url, lidar_depth_map_url } = job.data;

  try {
    console.log(`[BiometricAnalyzerWorker] Processing proof ${proof_id}`);

    // Run biometric analysis
    const result = await BiometricVerificationService.analyzeProofSubmission(
      proof_id,
      photo_url,
      lidar_depth_map_url
    );

    if (!result.success) {
      throw new Error(result.error?.message || 'Biometric analysis failed');
    }

    const analysis = result.data!;

    // Update proof_submissions table (scores already stored by service)
    // Add analysis recommendation to proof metadata
    await db.query(
      `UPDATE proof_submissions
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{biometric_analysis}',
         $1::jsonb
       )
       WHERE id = $2`,
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

    // If HIGH/CRITICAL risk, flag for manual review
    if (analysis.recommendation === 'reject' || analysis.recommendation === 'manual_review') {
      console.warn(
        `[BiometricAnalyzerWorker] FLAGGED proof ${proof_id}: ${analysis.recommendation} - ${analysis.reasoning}`
      );

      // TODO: Notify admin/send to manual review queue
    }

    console.log(`[BiometricAnalyzerWorker] ✓ Completed proof ${proof_id}: ${analysis.recommendation}`);
  } catch (error) {
    console.error(`[BiometricAnalyzerWorker] ✗ Failed proof ${proof_id}:`, error);
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
