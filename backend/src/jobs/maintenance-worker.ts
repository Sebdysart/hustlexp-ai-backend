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
    console.log(`✅ Recovered ${result.rowCount} stuck stripe events (timeout: ${timeoutMinutes} minutes)`);
    result.rows.forEach(row => {
      console.log(`   - Recovered: ${row.stripe_event_id} (was stuck since ${row.claimed_at})`);
    });
  } else {
    console.log(`ℹ️  No stuck stripe events found (timeout: ${timeoutMinutes} minutes)`);
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
      // TODO: Implement cleanup_expired_exports
      console.warn(`Maintenance job 'cleanup_expired_exports' not yet implemented`);
      throw new Error('Maintenance job not yet implemented: cleanup_expired_exports');
    
    default:
      throw new Error(`Unknown maintenance job type: ${jobType}`);
  }
}
