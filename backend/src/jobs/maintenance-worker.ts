import { db } from '../db.js';
import type { Job } from 'bullmq';
import { workerLogger } from '../logger.js';
const log = workerLogger.child({ worker: 'maintenance' });

interface RecoveryStuckStripeEventsPayload {
  timeoutMinutes?: number;
}

export async function recoverStuckStripeEvents(job: Job<RecoveryStuckStripeEventsPayload>): Promise<void> {
  const timeoutMinutes = (job.data as Record<string, unknown>).timeoutMinutes as number || 10;

  const result = await db.query<{ stripe_event_id: string; claimed_at: Date }>(
    `UPDATE stripe_events
     SET claimed_at = NULL, result = NULL,
         error_message = 'Recovered from stuck processing (worker crash)'
     WHERE result = 'processing' AND processed_at IS NULL
       AND claimed_at < NOW() - INTERVAL '1 minute' * $1
     RETURNING stripe_event_id, claimed_at`,
    [timeoutMinutes]
  );

  if (result.rowCount > 0) {
    log.info({ recoveredCount: result.rowCount, timeoutMinutes }, 'Recovered stuck stripe events');
  } else {
    log.info({ timeoutMinutes }, 'No stuck stripe events found');
  }
}

async function cleanupExpiredExports(): Promise<void> {
  const oldExports = await db.query<{ id: string }>(
    `DELETE FROM exports
     WHERE (status = 'ready' AND created_at < NOW() - INTERVAL '30 days')
        OR (status IN ('queued', 'generating') AND created_at < NOW() - INTERVAL '24 hours')
     RETURNING id`,
  );
  if (oldExports.rowCount > 0) {
    log.info({ cleanedCount: oldExports.rowCount }, 'Cleaned up expired/stuck exports');
  }
}

async function cleanupExpiredNotifications(): Promise<void> {
  const readResult = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < NOW() - INTERVAL '30 days' RETURNING 1
     ) SELECT COUNT(*)::text as count FROM deleted`,
  );
  const expiredResult = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM notifications WHERE expires_at IS NOT NULL AND expires_at < NOW() RETURNING 1
     ) SELECT COUNT(*)::text as count FROM deleted`,
  );
  const readCount = parseInt(readResult.rows[0]?.count || '0', 10);
  const expiredCount = parseInt(expiredResult.rows[0]?.count || '0', 10);
  if (readCount + expiredCount > 0) {
    log.info({ readCount, expiredCount }, 'Cleaned up expired notifications');
  }
}

// FIX: Expire stale streaks. The streak_grace_expires_at field is set by
// StreakService when a user completes a task, but no cron job previously
// checked for users who missed their grace window. This caused streaks
// to display as active indefinitely in the UI even when the user hadn't
// completed a task in days/weeks.
async function expireStaleStreaks(): Promise<void> {
  const result = await db.query<{ id: string; current_streak: number }>(
    `UPDATE users
     SET current_streak = 0, updated_at = NOW()
     WHERE current_streak > 0
       AND streak_grace_expires_at IS NOT NULL
       AND streak_grace_expires_at < NOW()
     RETURNING id, current_streak`,
  );
  if (result.rowCount > 0) {
    log.info({ expiredCount: result.rowCount }, 'Expired stale streaks');
    for (const row of result.rows) {
      log.info({ userId: row.id, previousStreak: row.current_streak }, 'Streak expired');
    }
  } else {
    log.info('No stale streaks to expire');
  }
}

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
    case 'expire_stale_streaks':
      await expireStaleStreaks();
      break;
    case 'tax.annual_filing_requested': {
      const { processTaxReportingJob } = await import('./tax-reporting-worker');
      await processTaxReportingJob(job);
      break;
    }
    default:
      throw new Error(`Unknown maintenance job type: ${jobType}`);
  }
}
