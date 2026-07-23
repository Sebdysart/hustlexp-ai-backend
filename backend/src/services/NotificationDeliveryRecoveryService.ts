import { db } from '../db.js';
import { logger } from '../logger.js';
import { markNotificationDeliveryFailure } from './NotificationDeliveryState.js';
import { NotificationService, type NotificationChannel } from './NotificationService.js';

type ExternalNotificationChannel = Exclude<NotificationChannel, 'in_app'>;

type RecoveryCandidate = {
  notification_id: string;
  channel: ExternalNotificationChannel;
};

export type NotificationDeliveryRecoveryResult = {
  inspected: number;
  recovered: number;
  failed: number;
  skipped: number;
};

export type NotificationFocusReleaseResult = { released: number };

const log = logger.child({ service: 'NotificationDeliveryRecoveryService' });

export const NotificationDeliveryRecoveryService = {
  async releaseFocusDeferred(limit = 100): Promise<NotificationFocusReleaseResult> {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const result = await db.query<{ released: string | number }>(
      `WITH releasable AS MATERIALIZED (
         SELECT notification.id
         FROM notifications notification
         WHERE notification.delivery_state = 'deferred_focus'
           AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
           AND NOT EXISTS (
             SELECT 1
             FROM tasks task
             WHERE task.worker_id = notification.user_id
               AND task.state = 'ACCEPTED'
               AND task.progress_state IN ('ACCEPTED','TRAVELING','WORKING')
           )
         ORDER BY notification.focus_deferred_at, notification.id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ), released_notifications AS (
         UPDATE notifications notification
         SET delivery_state = 'queued',
             available_at = NOW(),
             focus_released_at = NOW(),
             updated_at = NOW()
         FROM releasable
         WHERE notification.id = releasable.id
         RETURNING notification.id
       ), released_deliveries AS (
         UPDATE notification_deliveries delivery
         SET state = 'queued',
             available_at = NOW(),
             next_retry_at = NULL,
             updated_at = NOW()
         FROM released_notifications notification
         WHERE delivery.notification_id = notification.id
           AND delivery.channel IN ('email','push','sms')
           AND delivery.state = 'deferred_focus'
         RETURNING delivery.notification_id
       ), released_email AS (
         UPDATE email_outbox email
         SET available_at = NOW(), updated_at = NOW()
         FROM released_notifications notification
         WHERE email.notification_id = notification.id
           AND email.status IN ('pending','failed')
         RETURNING email.notification_id
       ), released_sms AS (
         UPDATE sms_outbox sms
         SET available_at = NOW(), updated_at = NOW()
         FROM released_notifications notification
         WHERE sms.notification_id = notification.id
           AND sms.status IN ('pending','failed')
         RETURNING sms.notification_id
       ), released_outbox AS (
         UPDATE outbox_events outbox
         SET available_at = NOW(), updated_at = NOW()
         FROM released_notifications notification
         WHERE outbox.status = 'pending'
           AND (
             outbox.aggregate_id = notification.id
             OR outbox.payload->>'notificationId' = notification.id::TEXT
             OR outbox.payload->'params'->>'notificationId' = notification.id::TEXT
           )
         RETURNING outbox.id
       )
       SELECT COUNT(*)::TEXT AS released FROM released_notifications`,
      [boundedLimit],
    );
    const released = Number(result.rows[0]?.released ?? 0);
    const normalized = Number.isSafeInteger(released) && released >= 0 ? released : 0;
    log.info({ released: normalized }, 'Focus-deferred notification release completed');
    return { released: normalized };
  },

  async recoverDue(limit = 100): Promise<NotificationDeliveryRecoveryResult> {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const candidates = await db.query<RecoveryCandidate>(
      `SELECT delivery.notification_id, delivery.channel
       FROM notification_deliveries delivery
       JOIN notifications notification ON notification.id = delivery.notification_id
       WHERE delivery.state = 'retry_pending'
         AND delivery.channel IN ('email','push','sms')
         AND delivery.next_retry_at <= NOW()
         AND delivery.available_at <= NOW()
         AND notification.superseded_at IS NULL
         AND (
           (delivery.channel = 'email' AND NOT EXISTS (
             SELECT 1 FROM email_outbox email
             WHERE email.notification_id = delivery.notification_id
           ))
           OR (delivery.channel = 'sms' AND NOT EXISTS (
             SELECT 1 FROM sms_outbox sms
             WHERE sms.notification_id = delivery.notification_id
           ))
           OR (delivery.channel = 'push' AND NOT EXISTS (
             SELECT 1 FROM outbox_events outbox
             WHERE outbox.event_type = 'push.send_requested'
               AND outbox.aggregate_id = delivery.notification_id
           ))
         )
       ORDER BY delivery.next_retry_at, delivery.notification_id, delivery.channel
       LIMIT $1`,
      [boundedLimit],
    );

    const result: NotificationDeliveryRecoveryResult = {
      inspected: candidates.rows.length,
      recovered: 0,
      failed: 0,
      skipped: 0,
    };

    for (const candidate of candidates.rows) {
      let retry;
      try {
        retry = await NotificationService.retryDelivery(
          candidate.notification_id,
          candidate.channel,
        );
      } catch (error) {
        retry = {
          success: false as const,
          error: {
            code: 'RECOVERY_ERROR',
            message: error instanceof Error ? error.message : 'Notification recovery failed',
          },
        };
      }

      if (!retry.success) {
        await markNotificationDeliveryFailure(
          candidate.notification_id,
          candidate.channel,
          retry.error.message,
        );
        result.failed += 1;
        log.warn({ ...candidate, code: retry.error.code }, 'Notification delivery recovery attempt failed');
      } else if (retry.data.queued) {
        result.recovered += 1;
      } else {
        result.skipped += 1;
      }
    }

    log.info(result, 'Notification delivery recovery batch completed');
    return result;
  },
};
