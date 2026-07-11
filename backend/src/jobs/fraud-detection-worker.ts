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

interface ProofLocationRow {
  proof_id: string;
  user_id: string;
  gps_latitude: number;
  gps_longitude: number;
  gps_timestamp: string;
}

async function loadRecentProofLocations(): Promise<ProofLocationRow[]> {
  const result = await db.query<ProofLocationRow>(
    `SELECT id as proof_id, user_id,
            (gps_coordinates->>'latitude')::double precision as gps_latitude,
            (gps_coordinates->>'longitude')::double precision as gps_longitude,
            created_at as gps_timestamp
     FROM proof_submissions
     WHERE created_at > NOW() - INTERVAL '5 minutes'
       AND gps_coordinates IS NOT NULL
       AND gps_coordinates ? 'latitude'
       AND gps_coordinates ? 'longitude'
     ORDER BY user_id, created_at ASC`
  );
  return result.rows;
}

function groupProofsByUser(rows: ProofLocationRow[]): Map<string, ProofLocation[]> {
  const grouped = new Map<string, ProofLocation[]>();
  for (const row of rows) {
    const proofs = grouped.get(row.user_id) ?? [];
    proofs.push({
      proof_id: row.proof_id,
      user_id: row.user_id,
      gps_coordinates: { latitude: row.gps_latitude, longitude: row.gps_longitude },
      gps_timestamp: row.gps_timestamp,
    });
    grouped.set(row.user_id, proofs);
  }
  return grouped;
}

async function scanProofPair(
  userId: string,
  previous: ProofLocation,
  current: ProofLocation,
): Promise<number> {
  try {
    const result = await withTimeout(
      LogisticsAIService.detectImpossibleTravel(
        userId,
        { ...current.gps_coordinates, timestamp: current.gps_timestamp },
        { ...previous.gps_coordinates, timestamp: previous.gps_timestamp },
      ),
      10_000,
    );
    if (!result.success || !result.data?.flagged) return 0;
    log.warn({ userId, speedKmh: result.data.speed_kmh }, 'IMPOSSIBLE TRAVEL detected');
    return 1;
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.startsWith('Timeout after');
    log.warn(
      { userId, err: error, isTimeout },
      isTimeout
        ? 'detectImpossibleTravel timed out — treating as non-fraud, continuing'
        : 'detectImpossibleTravel threw unexpectedly — treating as non-fraud, continuing',
    );
    return 0;
  }
}

async function scanUserProofs(userId: string, proofs: ProofLocation[]): Promise<number> {
  if (proofs.length < 2) return 0;
  let flagged = 0;
  for (let index = 1; index < proofs.length; index += 1) {
    flagged += await scanProofPair(userId, proofs[index - 1], proofs[index]);
  }
  return flagged;
}

async function scanGroupedProofs(grouped: Map<string, ProofLocation[]>): Promise<number> {
  let flagged = 0;
  for (const [userId, proofs] of grouped.entries()) {
    flagged += await scanUserProofs(userId, proofs);
  }
  return flagged;
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
    const rows = await loadRecentProofLocations();
    if (rows.length === 0) {
      log.info('No recent proofs to scan');
      return;
    }
    const flaggedCount = await scanGroupedProofs(groupProofsByUser(rows));
    log.info({ scannedCount: rows.length, flaggedCount }, 'Fraud scan complete');
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
