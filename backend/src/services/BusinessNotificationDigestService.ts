import { db } from '../db.js';
import { logger } from '../logger.js';
import { NotificationService } from './NotificationService.js';

type DigestRecipientRow = {
  organization_id: string;
  display_name: string;
  user_id: string;
  completed_count: number | string;
  cancelled_count: number | string;
  disputed_count: number | string;
  active_count: number | string;
  upcoming_count: number | string;
};

export type BusinessNotificationDigestResult = {
  inspected: number;
  created: number;
  skipped: number;
  failed: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const log = logger.child({ service: 'BusinessNotificationDigestService' });

function closedUtcWeek(now: Date): { start: Date; end: Date; upcomingEnd: Date } {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid digest run time');
  const currentDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (currentDay.getUTCDay() + 6) % 7;
  const end = new Date(currentDay.getTime() - daysSinceMonday * DAY_MS);
  return {
    start: new Date(end.getTime() - 7 * DAY_MS),
    end,
    upcomingEnd: new Date(end.getTime() + 7 * DAY_MS),
  };
}

function count(value: number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export const BusinessNotificationDigestService = {
  async createPreviousWeekDigests(
    now: Date = new Date(),
    limit = 100,
  ): Promise<BusinessNotificationDigestResult> {
    const window = closedUtcWeek(now);
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const recipients = await db.query<DigestRecipientRow>(
      `WITH metrics AS (
         SELECT task.business_organization_id AS organization_id,
                COUNT(*) FILTER (
                  WHERE task.completed_at >= $1 AND task.completed_at < $2
                )::INTEGER AS completed_count,
                COUNT(*) FILTER (
                  WHERE task.state = 'CANCELLED'
                    AND task.updated_at >= $1 AND task.updated_at < $2
                )::INTEGER AS cancelled_count,
                COUNT(*) FILTER (
                  WHERE task.state = 'DISPUTED'
                    AND task.updated_at >= $1 AND task.updated_at < $2
                )::INTEGER AS disputed_count,
                COUNT(*) FILTER (
                  WHERE task.state NOT IN ('COMPLETED','CANCELLED','EXPIRED')
                )::INTEGER AS active_count,
                COUNT(*) FILTER (
                  WHERE task.state NOT IN ('COMPLETED','CANCELLED','EXPIRED')
                    AND task.deadline >= $2 AND task.deadline < $3
                )::INTEGER AS upcoming_count
         FROM tasks task
         WHERE task.business_organization_id IS NOT NULL
         GROUP BY task.business_organization_id
       )
       SELECT organization.id AS organization_id, organization.display_name,
              membership.user_id, metrics.completed_count, metrics.cancelled_count,
              metrics.disputed_count, metrics.active_count, metrics.upcoming_count
       FROM metrics
       JOIN business_organizations organization ON organization.id = metrics.organization_id
       JOIN business_memberships membership ON membership.organization_id = organization.id
       WHERE organization.status = 'ACTIVE'
         AND membership.status = 'ACTIVE'
         AND business_membership_has_action(organization.id,membership.user_id,'READ_WORKSPACE')
         AND (
           metrics.completed_count + metrics.cancelled_count + metrics.disputed_count
           + metrics.active_count + metrics.upcoming_count
         ) > 0
       ORDER BY organization.id, membership.user_id
       LIMIT $4`,
      [window.start, window.end, window.upcomingEnd, boundedLimit],
    );

    const result: BusinessNotificationDigestResult = {
      inspected: recipients.rows.length,
      created: 0,
      skipped: 0,
      failed: 0,
    };
    const week = window.start.toISOString().slice(0, 10);

    for (const row of recipients.rows) {
      const completedCount = count(row.completed_count);
      const cancelledCount = count(row.cancelled_count);
      const disputedCount = count(row.disputed_count);
      const activeCount = count(row.active_count);
      const upcomingCount = count(row.upcoming_count);
      try {
        const notification = await NotificationService.createNotification({
          userId: row.user_id,
          category: 'business_operational_digest',
          title: `Weekly operations — ${row.display_name}`,
          body: `Last week: ${completedCount} completed, ${cancelledCount} cancelled, ${disputedCount} disputed. Now: ${activeCount} active, ${upcomingCount} upcoming.`,
          deepLink: `/business/${row.organization_id}/operations?week=${week}`,
          channels: ['in_app', 'email'],
          priority: 'LOW',
          objectRef: { type: 'business_week', id: `${row.organization_id}:${week}` },
          dedupeKey: `business-digest:${row.organization_id}:${row.user_id}:${week}`,
          metadata: {
            organizationId: row.organization_id,
            periodStart: window.start.toISOString(),
            periodEnd: window.end.toISOString(),
            completedCount,
            cancelledCount,
            disputedCount,
            activeCount,
            upcomingCount,
          },
        });
        if (notification.success) result.created += 1;
        else if (notification.error.code === 'PREFERENCE_DISABLED') result.skipped += 1;
        else {
          result.failed += 1;
          log.error({ organizationId: row.organization_id, userId: row.user_id,
            code: notification.error.code }, 'Business operational digest creation failed');
        }
      } catch (error) {
        result.failed += 1;
        log.error({ organizationId: row.organization_id, userId: row.user_id, err: error },
          'Business operational digest creation threw');
      }
    }

    log.info({ ...result, periodStart: window.start, periodEnd: window.end },
      'Business operational digest batch completed');
    return result;
  },
};
