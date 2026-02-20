/**
 * Maintenance Worker v1.0.0
 * 
 * SYSTEM GUARANTEES: Recovery and Cleanup Jobs
 * 
 * Handles recovery of stuck processing states and cleanup tasks.
 * 
 * @see ARCHITECTURE.md §2.4 (Recovery patterns)
 */

import { db } from '../db';
import type { Job } from 'bullmq';
import { workerLogger } from '../logger';
const log = workerLogger.child({ worker: 'maintenance' });

// ============================================================================
// TYPES
// ============================================================================

interface RecoveryStuckStripeEventsPayload {
  timeoutMinutes?: number; // Default: 10 minutes
}

// ============================================================================
// MAINTENANCE WORKERS
// ============================================================================

/**
 * Recover stuck stripe events (worker crashed after claiming but before finalizing)
 * 
 * Finds events where:
 * - result = 'processing'
 * - processed_at IS NULL (not finalized)
 * - claimed_at < NOW() - interval (stuck for > timeout)
 * 
 * Resets them to unclaimed state so they can be retried.
 */
export async function recoverStuckStripeEvents(job: Job<RecoveryStuckStripeEventsPayload>): Promise<void> {
  const timeoutMinutes = job.data.payload?.timeoutMinutes || 10;
  
  // Use parameterized query for safety (INTERVAL requires string concatenation, but timeout is validated as number)
  const result = await db.query<{
    stripe_event_id: string;
    claimed_at: Date;
  }>(
    `UPDATE stripe_events
     SET claimed_at = NULL,
         result = NULL,
         error_message = 'Recovered from stuck processing (worker crash)'
     WHERE result = 'processing'
       AND processed_at IS NULL
       AND claimed_at < NOW() - INTERVAL '1 minute' * $1
     RETURNING stripe_event_id, claimed_at`,
    [timeoutMinutes]
  );
  
  if (result.rowCount > 0) {
    log.info({ recoveredCount: result.rowCount, timeoutMinutes }, 'Recovered stuck stripe events');
    result.rows.forEach(row => {
      log.info({ stripeEventId: row.stripe_event_id, stuckSince: row.claimed_at }, 'Recovered stuck stripe event');
    });
  } else {
    log.info({ timeoutMinutes }, 'No stuck stripe events found');
  }
}

/**
 * Clean up expired exports (files older than 30 days)
 *
 * - Deletes export DB records with status='ready' older than 30 days
 * - R2 object lifecycle rules handle the actual file deletion (set via bucket config)
 * - Also cleans up orphaned 'queued'/'generating' exports stuck for > 24 hours
 */
async function cleanupExpiredExports(): Promise<void> {
  // Clean up old completed exports (30+ days)
  const oldExports = await db.query<{ id: string }>(
    `DELETE FROM exports
     WHERE (status = 'ready' AND created_at < NOW() - INTERVAL '30 days')
        OR (status IN ('queued', 'generating') AND created_at < NOW() - INTERVAL '24 hours')
     RETURNING id`,
  );

  if (oldExports.rowCount > 0) {
    log.info({ cleanedCount: oldExports.rowCount }, 'Cleaned up expired/stuck exports');
  } else {
    log.info('No expired exports to clean up');
  }
}

/**
 * Clean up expired notifications (older than 30 days)
 *
 * - Deletes read notifications older than 30 days
 * - Deletes unread notifications that have expired (expires_at < NOW())
 */
async function cleanupExpiredNotifications(): Promise<void> {
  // Delete read notifications older than 30 days
  const readResult = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM notifications
       WHERE read_at IS NOT NULL AND created_at < NOW() - INTERVAL '30 days'
       RETURNING 1
     ) SELECT COUNT(*)::text as count FROM deleted`,
  );

  // Delete expired notifications (unread but past expiry)
  const expiredResult = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM notifications
       WHERE expires_at IS NOT NULL AND expires_at < NOW()
       RETURNING 1
     ) SELECT COUNT(*)::text as count FROM deleted`,
  );

  const readCount = parseInt(readResult.rows[0]?.count || '0', 10);
  const expiredCount = parseInt(expiredResult.rows[0]?.count || '0', 10);

  if (readCount + expiredCount > 0) {
    log.info({ readCount, expiredCount }, 'Cleaned up old read and expired notifications');
  } else {
    log.info('No expired notifications to clean up');
  }
}

/**
 * Process maintenance job
 */
export async function processMaintenanceJob(job: Job): Promise<void> {
  const jobType = job.name;
  
  switch (jobType) {
    case 'recover_stuck_stripe_events':
      await recoverStuckStripeEvents(job as Job<RecoveryStuckStripeEventsPayload>);
      break;
    
    case 'cleanup_expired_exports':
      await cleanupExpiredExports();
      break;

    case 'cleanup_expired_notifications':
      await cleanupExpiredNotifications();
      break;
    
    default:
      throw new Error(`Unknown maintenance job type: ${jobType}`);
  }
}
