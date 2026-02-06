/**
 * Fraud Detection Worker v1.0.0
 *
 * Periodic fraud pattern scanning
 *
 * Runs every 5 minutes via BullMQ cron schedule.
 * Scans recent proof submissions for impossible travel patterns.
 *
 * Pattern:
 * 1. Query proof_submissions from last 10 minutes
 * 2. For each user, check for impossible travel
 * 3. Create fraud_detection_events for violations
 * 4. Flag HIGH/CRITICAL events for admin review
 *
 * @see LogisticsAIService.ts
 * @see schema.sql v1.8.0 (fraud_detection_events)
 */

import { db } from '../db';
import { LogisticsAIService } from '../services/LogisticsAIService';
import type { Job } from 'bullmq';

// ============================================================================
// TYPES
// ============================================================================

interface ProofLocation {
  proof_id: string;
  user_id: string;
  gps_coordinates: { latitude: number; longitude: number };
  gps_timestamp: string;
}

// ============================================================================
// JOB PROCESSOR
// ============================================================================

/**
 * Scan recent proofs for fraud patterns
 */
export const processFraudDetectionJob = async (job: Job): Promise<void> => {
  try {
    console.log('[FraudDetectionWorker] Starting fraud scan...');

    // Get recent proof submissions with GPS data (last 10 minutes)
    const result = await db.query<{
      proof_id: string;
      user_id: string;
      gps_latitude: number;
      gps_longitude: number;
      gps_timestamp: string;
    }>(
      `SELECT id as proof_id, user_id,
              ST_Y(gps_coordinates::geometry) as gps_latitude,
              ST_X(gps_coordinates::geometry) as gps_longitude,
              gps_timestamp
       FROM proof_submissions
       WHERE gps_timestamp > NOW() - INTERVAL '10 minutes'
         AND gps_coordinates IS NOT NULL
       ORDER BY user_id, gps_timestamp ASC`
    );

    if (result.rows.length === 0) {
      console.log('[FraudDetectionWorker] No recent proofs to scan');
      return;
    }

    // Group by user
    const userProofs = new Map<string, ProofLocation[]>();
    for (const row of result.rows) {
      const userId = row.user_id;
      if (!userProofs.has(userId)) {
        userProofs.set(userId, []);
      }
      userProofs.get(userId)!.push({
        proof_id: row.proof_id,
        user_id: row.user_id,
        gps_coordinates: {
          latitude: row.gps_latitude,
          longitude: row.gps_longitude
        },
        gps_timestamp: row.gps_timestamp
      });
    }

    let flaggedCount = 0;

    // Check each user for impossible travel
    for (const [userId, proofs] of userProofs.entries()) {
      if (proofs.length < 2) continue; // Need at least 2 proofs to detect travel

      // Check consecutive proof pairs
      for (let i = 1; i < proofs.length; i++) {
        const lastProof = proofs[i - 1];
        const currentProof = proofs[i];

        const travelResult = await LogisticsAIService.detectImpossibleTravel(
          userId,
          { ...currentProof.gps_coordinates, timestamp: currentProof.gps_timestamp },
          { ...lastProof.gps_coordinates, timestamp: lastProof.gps_timestamp }
        );

        if (travelResult.success && travelResult.data!.flagged) {
          flaggedCount++;
          console.warn(
            `[FraudDetectionWorker] ⚠️  IMPOSSIBLE TRAVEL: user=${userId}, speed=${travelResult.data!.speed_kmh.toFixed(0)} km/h`
          );

          // Event already created by LogisticsAIService.detectImpossibleTravel()
          // Optionally send admin notification here
        }
      }
    }

    console.log(
      `[FraudDetectionWorker] ✓ Scan complete. Scanned ${result.rows.length} proofs, flagged ${flaggedCount} violations`
    );
  } catch (error) {
    console.error('[FraudDetectionWorker] ✗ Scan failed:', error);
    throw error; // BullMQ will retry
  }
};

// ============================================================================
// QUEUE CONFIGURATION
// ============================================================================

export const fraudDetectionQueueConfig = {
  name: 'fraud-detection',
  processor: processFraudDetectionJob,
  options: {
    repeat: {
      pattern: '*/5 * * * *' // Every 5 minutes
    },
    attempts: 2,
    backoff: {
      type: 'fixed' as const,
      delay: 30000 // 30 seconds
    }
  }
};
