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

// MONEY-PATH FIX (truth-table row 37): auto-refund escrows that were FUNDED but
// whose task was never accepted. Without this, a poster's captured payment sits
// in FUNDED indefinitely when no Hustler ever accepts. After `staleHours`, return
// the money — EscrowService.refund() now issues a real Stripe refund (fail-closed),
// so a Stripe failure leaves the escrow FUNDED for retry on the next run.
async function cancelStaleEscrows(job: Job): Promise<void> {
  const staleHours = ((job.data as Record<string, unknown>)?.staleHours as number) || 72;

  const stale = await db.query<{ id: string; poster_id: string; task_id: string }>(
    `SELECT e.id, t.poster_id, t.id AS task_id
     FROM escrows e
     JOIN tasks t ON t.id = e.task_id
     WHERE e.state = 'FUNDED'
       AND e.funded_at IS NOT NULL
       AND e.funded_at < NOW() - INTERVAL '1 hour' * $1
       AND t.worker_id IS NULL`,
    [staleHours]
  );

  if (stale.rowCount === 0) {
    log.info({ staleHours }, 'No stale unaccepted FUNDED escrows to refund');
    return;
  }

  const { EscrowService } = await import('../services/EscrowService.js');
  let refunded = 0;
  let failed = 0;

  for (const row of stale.rows) {
    const result = await EscrowService.refund({ escrowId: row.id });
    if (result.success) {
      refunded++;
      log.info({ escrowId: row.id, taskId: row.task_id, posterId: row.poster_id }, 'Auto-refunded stale unaccepted escrow');
      try {
        const { NotificationService } = await import('../services/NotificationService.js');
        await NotificationService.createNotification({
          userId: row.poster_id,
          category: 'refund_issued',
          title: 'Task refunded — no one accepted',
          body: "Your task wasn't accepted in time, so your payment has been fully refunded.",
          taskId: row.task_id,
          deepLink: `app://tasks/${row.task_id}`,
          channels: ['in_app', 'push'],
          priority: 'MEDIUM',
        });
      } catch (notifyErr) {
        log.warn({ err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr), escrowId: row.id }, 'Stale-escrow refund notification failed (refund stands)');
      }
    } else {
      failed++;
      log.error({ escrowId: row.id, err: result.error.message }, 'Stale-escrow auto-refund failed — will retry next run');
    }
  }

  log.info({ refunded, failed, staleHours }, 'Stale-escrow auto-refund pass complete');
}

export async function processMaintenanceJob(job: Job): Promise<void> {
  const jobType = job.name;

  switch (jobType) {
    case 'cancel_stale_escrows':
      await cancelStaleEscrows(job);
      break;
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
