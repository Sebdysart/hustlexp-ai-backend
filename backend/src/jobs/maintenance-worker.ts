/**
 * Maintenance Worker v1.0.0
 * 
 * SYSTEM GUARANTEES: Recovery and Cleanup Jobs
 * 
 * Handles recovery of stuck processing states and cleanup tasks.
 * 
 * @see ARCHITECTURE.md §2.4 (Recovery patterns)
 */

import { db } from '../db.js';
import type { Job } from 'bullmq';
import { workerLogger } from '../logger.js';
const log = workerLogger.child({ worker: 'maintenance' });

// ============================================================================
// TYPES
// ============================================================================

interface RecoveryStuckStripeEventsPayload {
  timeoutMinutes?: number; // Default: 10 minutes
}

interface DispatchExpiryPayload {
  limit?: number;
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
  // Clamp timeoutMinutes to [1, 1440] — negative or zero values would cause the INTERVAL
  // expression to recover events that haven't actually timed out (or recover all of them),
  // and values above 1440 (24 h) are nonsensical for a maintenance window.
  const timeoutMinutes = Math.max(1, Math.min(1440, Number(job.data?.timeoutMinutes) || 10));
  
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

function boundedJobLimit(job: Job, fallback: number): number {
  const rawLimit = Number((job.data as DispatchExpiryPayload | undefined)?.limit) || fallback;
  return Math.max(1, Math.min(rawLimit, 100));
}

async function expireUnfilledDispatch(job: Job): Promise<void> {
  const { AutomationLifecycleService } = await import('../services/AutomationLifecycleService.js');
  const result = await AutomationLifecycleService.expireDue({ limit: boundedJobLimit(job, 50) });
  if (!result.success) throw new Error(`Dispatch expiry batch failed: ${result.error.code}`);
  log.info(result.data, 'Dispatch expiry batch completed');
}

async function escalateSafetyCheckins(job: Job): Promise<void> {
  const { TaskSafetyCheckinService } = await import('../services/TaskSafetyCheckinService.js');
  const result = await TaskSafetyCheckinService.escalateDue(boundedJobLimit(job, 100));
  log.info(result, 'Overdue safety check-in escalation batch completed');
}

async function expireSafetyLocation(job: Job): Promise<void> {
  const { TaskSafetyLocationService } = await import('../services/TaskSafetyLocationService.js');
  const result = await TaskSafetyLocationService.expireDue(boundedJobLimit(job, 100));
  log.info(result, 'Expired safety location evidence batch completed');
}

async function expireMediaUploads(job: Job): Promise<void> {
  const { expireMediaUploadReceipts } = await import('../services/MediaUploadFinalizationService.js');
  const result = await expireMediaUploadReceipts(boundedJobLimit(job, 100));
  if (result.failed > 0) {
    throw new Error(`Media upload expiry left ${result.failed} object cleanup failure(s).`);
  }
  log.info(result, 'Expired abandoned media uploads');
}

async function generateRecurringDue(job: Job): Promise<void> {
  const { generateDueControlledRecurringOccurrences } = await import('../services/RecurringWorkService.js');
  const result = await generateDueControlledRecurringOccurrences(boundedJobLimit(job, 100));
  log.info(result, 'Controlled recurring generation batch completed');
}

async function advanceRecurringReservations(job: Job): Promise<void> {
  const {
    activateFundedControlledReservationOffers,
    advanceControlledReservationWaves,
  } = await import('../services/RecurringWorkService.js');
  const limit = boundedJobLimit(job, 100);
  const activated = await activateFundedControlledReservationOffers(limit);
  const advanced = await advanceControlledReservationWaves(limit);
  log.info({ ...activated, ...advanced }, 'Controlled recurring reservation batch completed');
}

async function completeUnattendedDue(job: Job): Promise<void> {
  const { UnattendedCompletionSweepService } = await import('../services/UnattendedCompletionSweepService.js');
  const result = await UnattendedCompletionSweepService.completeDue(boundedJobLimit(job, 50));
  log.info(result, 'Unattended completion sweep completed');
}

async function recoverNotificationDelivery(job: Job): Promise<void> {
  const { NotificationDeliveryRecoveryService } = await import('../services/NotificationDeliveryRecoveryService.js');
  const result = await NotificationDeliveryRecoveryService.recoverDue(boundedJobLimit(job, 100));
  log.info(result, 'Notification delivery recovery batch completed');
}

async function releaseFocusDeferredNotifications(job: Job): Promise<void> {
  const { NotificationDeliveryRecoveryService } = await import('../services/NotificationDeliveryRecoveryService.js');
  const result = await NotificationDeliveryRecoveryService.releaseFocusDeferred(boundedJobLimit(job, 100));
  log.info(result, 'Focus-deferred notification release batch completed');
}

async function createBusinessWeeklyDigests(job: Job): Promise<void> {
  const { BusinessNotificationDigestService } = await import('../services/BusinessNotificationDigestService.js');
  const result = await BusinessNotificationDigestService.createPreviousWeekDigests(
    new Date(),
    boundedJobLimit(job, 100),
  );
  log.info(result, 'Business operational digest batch completed');
}

async function processAnnualTaxFiling(job: Job): Promise<void> {
  const { processTaxReportingJob } = await import('./tax-reporting-worker.js');
  await processTaxReportingJob(job);
}

type MaintenanceHandler = (job: Job) => Promise<void>;

const MAINTENANCE_HANDLERS: Record<string, MaintenanceHandler> = {
  recover_stuck_stripe_events: (job) => recoverStuckStripeEvents(job as Job<RecoveryStuckStripeEventsPayload>),
  cleanup_expired_exports: cleanupExpiredExports,
  cleanup_expired_notifications: cleanupExpiredNotifications,
  'dispatch.expire_unfilled': expireUnfilledDispatch,
  'safety.escalate_overdue_checkins': escalateSafetyCheckins,
  'safety.expire_location_evidence': expireSafetyLocation,
  'media.expire_uploads': expireMediaUploads,
  'recurring.generate_due': generateRecurringDue,
  'recurring.advance_reservations': advanceRecurringReservations,
  'completion.complete_due': completeUnattendedDue,
  'notification.recover_due': recoverNotificationDelivery,
  'notification.release_focus_deferred': releaseFocusDeferredNotifications,
  'notification.business_weekly_digest': createBusinessWeeklyDigests,
  'tax.annual_filing_requested': processAnnualTaxFiling,
};

/**
 * Process maintenance job
 */
export async function processMaintenanceJob(job: Job): Promise<void> {
  const handler = MAINTENANCE_HANDLERS[job.name];
  if (!handler) throw new Error(`Unknown maintenance job type: ${job.name}`);
  await handler(job);
}
