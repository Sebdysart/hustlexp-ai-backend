/**
 * XP Tax Reminder Worker v1.0.0
 *
 * Daily reminders for unpaid XP taxes
 *
 * Runs daily at 10:00 AM via BullMQ cron schedule.
 * Sends notifications to users with unpaid offline taxes.
 *
 * Pattern:
 * 1. Query user_xp_tax_status for unpaid balances
 * 2. Send email/push notification via NotificationService
 * 3. Track last reminder sent to avoid spam
 *
 * @see XPTaxService.ts
 * @see schema.sql v1.8.0 (user_xp_tax_status)
 */

import { db } from '../db';
import { NotificationService } from '../services/NotificationService';
import { workerLogger } from '../logger';
import type { Job } from 'bullmq';

const log = workerLogger.child({ worker: 'xp-tax-reminder' });

// ============================================================================
// TYPES
// ============================================================================

interface UserWithUnpaidTax {
  user_id: string;
  total_unpaid_tax_cents: number;
  total_xp_held_back: number;
  last_updated_at: string;
}

// ============================================================================
// JOB PROCESSOR
// ============================================================================

/**
 * Send reminders for unpaid XP taxes
 */
export const processXPTaxReminderJob = async (job: Job): Promise<void> => {
  try {
    log.info('Starting daily XP tax reminder run');

    // Get users with unpaid taxes (>$1)
    const result = await db.query<UserWithUnpaidTax>(
      `SELECT user_id, total_unpaid_tax_cents, total_xp_held_back, last_updated_at
       FROM user_xp_tax_status
       WHERE total_unpaid_tax_cents >= 100
       ORDER BY total_unpaid_tax_cents DESC`
    );

    if (result.rows.length === 0) {
      log.info('No users with unpaid taxes');
      return;
    }

    let sentCount = 0;

    for (const user of result.rows) {
      // Check if we've sent a reminder recently (within 7 days)
      const lastReminderResult = await db.query<{ sent_at: string }>(
        `SELECT sent_at FROM notification_log
         WHERE user_id = $1
           AND notification_type = 'xp_tax_reminder'
           AND sent_at > NOW() - INTERVAL '7 days'
         ORDER BY sent_at DESC
         LIMIT 1`,
        [user.user_id]
      );

      if (lastReminderResult.rows.length > 0) {
        // Already sent reminder within 7 days, skip
        continue;
      }

      // Send notification
      try {
        const taxAmount = (user.total_unpaid_tax_cents / 100).toFixed(2);
        await NotificationService.createNotification({
          userId: user.user_id,
          category: 'payment_due',
          title: 'XP Tax Payment Due',
          body: `You have $${taxAmount} in unpaid XP taxes. ${user.total_xp_held_back} XP is being held back until payment. Pay now to unlock your XP!`,
          deepLink: 'app://settings/xp-tax',
          channels: ['in_app', 'push', 'email'],
          priority: 'MEDIUM',
          metadata: {
            unpaidTaxCents: user.total_unpaid_tax_cents,
            xpHeldBack: user.total_xp_held_back,
          },
        });

        // Log notification for dedup (7-day window check above)
        await db.query(
          `INSERT INTO notification_log (user_id, notification_type, sent_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT DO NOTHING`,
          [user.user_id, 'xp_tax_reminder']
        );

        sentCount++;

        log.info({ userId: user.user_id, taxAmount: (user.total_unpaid_tax_cents / 100).toFixed(2) }, 'XP tax reminder sent');
      } catch (error) {
        log.error({ userId: user.user_id, err: error }, 'Failed to send XP tax reminder');
        // Continue with other users
      }
    }

    log.info({ sentCount, totalUsersWithUnpaidTax: result.rows.length }, 'XP tax reminder run complete');
  } catch (error) {
    log.error({ err: error }, 'XP tax reminder job failed');
    throw error; // BullMQ will retry
  }
};

// ============================================================================
// QUEUE CONFIGURATION
// ============================================================================

export const xpTaxReminderQueueConfig = {
  name: 'xp-tax-reminders',
  processor: processXPTaxReminderJob,
  options: {
    repeat: {
      pattern: '0 10 * * *' // Daily at 10:00 AM
    },
    attempts: 2,
    backoff: {
      type: 'fixed' as const,
      delay: 60000 // 1 minute
    }
  }
};
