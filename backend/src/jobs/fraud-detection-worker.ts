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

import { db } from '../db.js';
import { LogisticsAIService } from '../services/LogisticsAIService.js';
import type { Job } from 'bullmq';
import { workerLogger } from '../logger.js';
const log = workerLogger.child({ worker: 'fraud-detection' });

/**
 * Race a promise against a timeout.
 * Rejects with an Error(`Timeout after ${ms}ms`) if the promise does not settle in time.
 */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);

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
export const processFraudDetectionJob = async (_job: Job): Promise<void> => {
  try {
    log.info('Starting fraud scan');

    // Get recent proof submissions with GPS data (last 5 minutes — matches cron interval)
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
       WHERE gps_timestamp > NOW() - INTERVAL '6 minutes'
         AND gps_coordinates IS NOT NULL
       ORDER BY user_id, gps_timestamp ASC`
    );

    if (result.rows.length === 0) {
      log.info('No recent proofs to scan');
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

        let travelResult: Awaited<ReturnType<typeof LogisticsAIService.detectImpossibleTravel>>;
        try {
          travelResult = await withTimeout(
            LogisticsAIService.detectImpossibleTravel(
              userId,
              { ...currentProof.gps_coordinates, timestamp: currentProof.gps_timestamp },
              { ...lastProof.gps_coordinates, timestamp: lastProof.gps_timestamp }
            ),
            10_000
          );
        } catch (aiErr) {
          const isTimeout = aiErr instanceof Error && aiErr.message.startsWith('Timeout after');
          log.warn(
            { userId, err: aiErr, isTimeout },
            isTimeout
              ? 'detectImpossibleTravel timed out — treating as non-fraud, continuing'
              : 'detectImpossibleTravel threw unexpectedly — treating as non-fraud, continuing'
          );
          continue;
        }

        if (travelResult.success && travelResult.data!.flagged) {
          flaggedCount++;
          log.warn({ userId, speedKmh: travelResult.data!.speed_kmh }, 'IMPOSSIBLE TRAVEL detected');

          // Event already created by LogisticsAIService.detectImpossibleTravel()
          // Optionally send admin notification here
        }
      }
    }

    log.info({ scannedCount: result.rows.length, flaggedCount }, 'Fraud scan complete');
  } catch (error) {
    log.error({ err: error }, 'Fraud scan failed');
    throw error; // BullMQ will retry
  }
};

// ============================================================================
// QUEUE CONFIGURATION
// ============================================================================

// W46-4 FIX: fraudDetectionQueueConfig is dead code — 'fraud-detection' is not
// in the QueueName union and is never consumed by createWorker() in queues.ts.
// The fraud scanner runs via setInterval inside outbox-worker.ts startOutboxWorker().
// Exporting this config was misleading and unreachable. Removed to eliminate confusion.
// If fraud detection needs to move to BullMQ, add 'fraud_detection' to QueueName first.
export const _fraudDetectionWorkerProcessor = processFraudDetectionJob;
