/**
 * BiometricVerificationService v1.0.0
 *
 * Handles liveness detection and deepfake scoring for proof submissions
 *
 * External APIs: FaceTec, iProov (configurable via env vars)
 * Scoring: liveness_score (0-1), deepfake_score (0-1)
 * Thresholds: liveness < 0.70 = suspicious, deepfake > 0.85 = suspicious
 *
 * @see schema.sql v1.8.0 (proof_submissions biometric fields)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface BiometricScores {
  liveness_score: number; // 0.0-1.0 (0=pre-recorded, 1=live)
  deepfake_score: number; // 0.0-1.0 (0=real, 1=fake)
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

interface BiometricAnalysisResult {
  scores: BiometricScores;
  flags: string[];
  recommendation: 'approve' | 'manual_review' | 'reject';
  reasoning: string;
}

interface LiDARValidationResult {
  depth_map_valid: boolean;
  depth_consistency_score: number;
  spatial_anomalies: string[];
}

// ============================================================================
// THRESHOLDS
// ============================================================================

const LIVENESS_THRESHOLD_LOW = 0.70; // Below this = suspicious
const DEEPFAKE_THRESHOLD_HIGH = 0.85; // Above this = suspicious

// ============================================================================
// SERVICE
// ============================================================================

export const BiometricVerificationService = {
  /**
   * Analyze face photo for liveness and deepfake detection
   * TODO: Integrate with FaceTec or iProov API
   */
  analyzeFacePhoto: async (photoUrl: string): Promise<ServiceResult<BiometricScores>> => {
    try {
      // TODO: Call external biometric API
      // Example: const result = await faceTecAPI.analyze(photoUrl);

      // Mock implementation for now
      const livenessScore = 0.92; // High confidence = live photo
      const deepfakeScore = 0.12; // Low score = real photo

      const riskLevel = BiometricVerificationService._calculateRiskLevel(livenessScore, deepfakeScore);

      return {
        success: true,
        data: {
          liveness_score: livenessScore,
          deepfake_score: deepfakeScore,
          risk_level: riskLevel
        }
      };
    } catch (error) {
      console.error('[BiometricVerificationService.analyzeFacePhoto] Error:', error);
      return {
        success: false,
        error: {
          code: 'BIOMETRIC_ANALYSIS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to analyze photo'
        }
      };
    }
  },

  /**
   * Detect deepfake probability in photo
   * Returns score 0-1 (0=real, 1=fake)
   */
  detectDeepfake: async (photoUrl: string): Promise<ServiceResult<number>> => {
    try {
      // TODO: Call deepfake detection API (e.g., Sensity, Deepware)

      // Mock implementation
      const deepfakeScore = 0.08; // Low score = likely real

      return { success: true, data: deepfakeScore };
    } catch (error) {
      console.error('[BiometricVerificationService.detectDeepfake] Error:', error);
      return {
        success: false,
        error: {
          code: 'DEEPFAKE_DETECTION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to detect deepfake'
        }
      };
    }
  },

  /**
   * Validate LiDAR depth map consistency with photo
   * Checks 3D spatial data matches 2D image
   */
  validateLiDARDepthMap: async (
    depthMapUrl: string,
    photoUrl: string
  ): Promise<ServiceResult<LiDARValidationResult>> => {
    try {
      // TODO: Implement LiDAR depth map validation
      // Compare depth data with photo edges/surfaces

      // Mock implementation
      const result: LiDARValidationResult = {
        depth_map_valid: true,
        depth_consistency_score: 0.88,
        spatial_anomalies: []
      };

      return { success: true, data: result };
    } catch (error) {
      console.error('[BiometricVerificationService.validateLiDARDepthMap] Error:', error);
      return {
        success: false,
        error: {
          code: 'LIDAR_VALIDATION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to validate LiDAR'
        }
      };
    }
  },

  /**
   * Calculate aggregate biometric risk score
   */
  calculateBiometricRiskScore: (
    livenessScore: number,
    deepfakeScore: number,
    lidarConsistency?: number
  ): number => {
    // Weighted risk calculation
    let risk = 0.0;

    // Liveness (40% weight)
    if (livenessScore < LIVENESS_THRESHOLD_LOW) {
      risk += 0.40 * (1 - livenessScore);
    }

    // Deepfake (40% weight)
    if (deepfakeScore > DEEPFAKE_THRESHOLD_HIGH) {
      risk += 0.40 * deepfakeScore;
    }

    // LiDAR consistency (20% weight) - optional
    if (lidarConsistency !== undefined && lidarConsistency < 0.70) {
      risk += 0.20 * (1 - lidarConsistency);
    }

    return Math.min(risk, 1.0);
  },

  /**
   * Perform complete biometric analysis on proof submission
   */
  analyzeProofSubmission: async (
    proofId: string,
    photoUrl: string,
    lidarDepthMapUrl?: string
  ): Promise<ServiceResult<BiometricAnalysisResult>> => {
    try {
      // Run biometric checks
      const scoresResult = await BiometricVerificationService.analyzeFacePhoto(photoUrl);
      if (!scoresResult.success) {
        throw new Error(scoresResult.error?.message || 'Biometric analysis failed');
      }

      const scores = scoresResult.data!;
      const flags: string[] = [];
      let recommendation: 'approve' | 'manual_review' | 'reject' = 'approve';

      // Check liveness
      if (scores.liveness_score < LIVENESS_THRESHOLD_LOW) {
        flags.push('low_liveness_score');
        if (scores.liveness_score < 0.50) {
          recommendation = 'reject';
        } else {
          recommendation = 'manual_review';
        }
      }

      // Check deepfake
      if (scores.deepfake_score > DEEPFAKE_THRESHOLD_HIGH) {
        flags.push('deepfake_suspected');
        recommendation = 'reject';
      }

      // Validate LiDAR if available
      if (lidarDepthMapUrl) {
        const lidarResult = await BiometricVerificationService.validateLiDARDepthMap(
          lidarDepthMapUrl,
          photoUrl
        );
        if (lidarResult.success && !lidarResult.data?.depth_map_valid) {
          flags.push('lidar_inconsistency');
          recommendation = 'manual_review';
        }
      }

      // Generate reasoning
      let reasoning = '';
      if (recommendation === 'approve') {
        reasoning = `Biometric checks passed. Liveness: ${(scores.liveness_score * 100).toFixed(0)}%, Deepfake risk: ${(scores.deepfake_score * 100).toFixed(0)}%`;
      } else if (recommendation === 'manual_review') {
        reasoning = `Biometric flags require manual review: ${flags.join(', ')}`;
      } else {
        reasoning = `Biometric checks failed: ${flags.join(', ')}. High fraud risk.`;
      }

      // Store scores in database
      await db.query(
        `UPDATE proof_submissions
         SET liveness_score = $1,
             deepfake_score = $2,
             biometric_verified_at = NOW()
         WHERE id = $3`,
        [scores.liveness_score, scores.deepfake_score, proofId]
      );

      return {
        success: true,
        data: {
          scores,
          flags,
          recommendation,
          reasoning
        }
      };
    } catch (error) {
      console.error('[BiometricVerificationService.analyzeProofSubmission] Error:', error);
      return {
        success: false,
        error: {
          code: 'PROOF_ANALYSIS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to analyze proof'
        }
      };
    }
  },

  /**
   * Private: Calculate risk level from scores
   */
  _calculateRiskLevel: (livenessScore: number, deepfakeScore: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' => {
    // CRITICAL: Obvious fraud
    if (deepfakeScore > 0.90 || livenessScore < 0.40) {
      return 'CRITICAL';
    }

    // HIGH: Likely fraud
    if (deepfakeScore > DEEPFAKE_THRESHOLD_HIGH || livenessScore < 0.60) {
      return 'HIGH';
    }

    // MEDIUM: Suspicious
    if (deepfakeScore > 0.70 || livenessScore < LIVENESS_THRESHOLD_LOW) {
      return 'MEDIUM';
    }

    // LOW: Likely legitimate
    return 'LOW';
  }
};
