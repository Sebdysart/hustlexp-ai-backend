/**
 * Capability Recompute Worker (Phase N2.4)
 * 
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * 
 * Processes 'recompute_capability' jobs from job_queue.
 * Calls CapabilityRecomputeService.recomputeCapabilityProfile()
 * 
 * ============================================================================
 * USAGE
 * ============================================================================
 * 
 * This worker should be called periodically (e.g., via cron or queue processor)
 * to process pending recompute jobs.
 * 
 * Example:
 * ```ts
 * await processCapabilityRecomputeJobs(limit: 10);
 * ```
 * 
 * Reference: Phase N2.4 — Verification Resolution (LOCKED)
 */

import { db } from '@/backend/database/client';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService';

interface JobRow {
  id: string;
  type: string;
  payload: any; // JSONB
  status: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Process pending capability recompute jobs
 * 
 * @param limit - Maximum number of jobs to process in this batch
 * @returns Number of jobs processed
 */
export async function processCapabilityRecomputeJobs(limit: number = 10): Promise<number> {
  // Fetch pending recompute jobs
  const jobsResult = await db.query<JobRow>(
    `
    SELECT id, type, payload, status, attempts, max_attempts
    FROM job_queue
    WHERE type = 'recompute_capability'
      AND status = 'pending'
    ORDER BY scheduled_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
    `,
    [limit]
  );

  if (jobsResult.rows.length === 0) {
    return 0;
  }

  let processed = 0;

  for (const job of jobsResult.rows) {
    try {
      // Mark as processing
      await db.query(
        `
        UPDATE job_queue
        SET status = 'processing', started_at = NOW(), attempts = attempts + 1
        WHERE id = $1
        `,
        [job.id]
      );

      // Parse payload
      const payload = typeof job.payload === 'string' 
        ? JSON.parse(job.payload) 
        : job.payload;

      const { userId, reason, sourceVerificationId } = payload;

      if (!userId) {
        throw new Error('Missing userId in job payload');
      }

      // Execute recompute
      await recomputeCapabilityProfile(userId, {
        reason: reason || 'VERIFICATION_RESOLVED',
        sourceVerificationId,
      });

      // Mark as completed
      await db.query(
        `
        UPDATE job_queue
        SET status = 'completed', completed_at = NOW()
        WHERE id = $1
        `,
        [job.id]
      );

      processed++;
      console.log('[Capability Recompute Worker] Processed job:', job.id);

    } catch (error: any) {
      // Mark as failed or dead
      const newStatus = job.attempts + 1 >= job.max_attempts ? 'dead' : 'failed';
      
      await db.query(
        `
        UPDATE job_queue
        SET status = $1, last_error = $2
        WHERE id = $3
        `,
        [newStatus, error.message, job.id]
      );

      console.error('[Capability Recompute Worker] Job failed:', {
        jobId: job.id,
        error: error.message,
        attempts: job.attempts + 1,
      });
    }
  }

  return processed;
}
