import { db } from '../db.js';
import type { NotificationChannel } from './NotificationService.js';

type ExternalNotificationChannel = Exclude<NotificationChannel, 'in_app'>;

export type DeliveryAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

const SENDABLE_STATES = new Set([
  'pending', 'deferred_quiet_hours', 'queued', 'retry_pending',
]);

/** Recheck state immediately before a provider call; missing evidence fails closed. */
export async function authorizeNotificationDelivery(
  notificationId: string,
  channel: ExternalNotificationChannel,
  now: Date = new Date(),
): Promise<DeliveryAuthorization> {
  const result = await db.query<{
    superseded_at: Date | string | null;
    available_at: Date | string;
    state: string;
  }>(
    `SELECT notification.superseded_at,
            GREATEST(notification.available_at, delivery.available_at) AS available_at,
            delivery.state
     FROM notifications notification
     JOIN notification_deliveries delivery
       ON delivery.notification_id = notification.id
      AND delivery.channel = $2
     WHERE notification.id = $1`,
    [notificationId, channel],
  );
  const row = result.rows[0];
  if (!row) return { allowed: false, reason: 'delivery_missing' };
  if (row.superseded_at) return { allowed: false, reason: 'superseded' };
  const availableAt = new Date(row.available_at);
  if (!Number.isFinite(availableAt.getTime()) || availableAt.getTime() > now.getTime()) {
    return { allowed: false, reason: 'not_due' };
  }
  if (!SENDABLE_STATES.has(row.state)) return { allowed: false, reason: row.state };
  return { allowed: true };
}

export async function markNotificationProviderAccepted(
  notificationId: string,
  channel: ExternalNotificationChannel,
  providerName: string,
  providerMessageId: string | null,
): Promise<void> {
  await db.query(
    `WITH accepted AS (
       UPDATE notification_deliveries
       SET state = 'provider_accepted',
           provider_name = $3,
           provider_message_id = NULLIF($4, ''),
           provider_accepted_at = NOW(),
           attempt_count = LEAST(attempt_count + 1, max_attempts),
           next_retry_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE notification_id = $1 AND channel = $2
         AND state IN ('pending','deferred_quiet_hours','queued','retry_pending')
       RETURNING notification_id
     )
     UPDATE notifications
     SET delivery_state = CASE
           WHEN delivery_state IN ('delivered','partially_queued','failed_terminal') THEN delivery_state
           ELSE 'provider_accepted'
         END,
         sent_at = COALESCE(sent_at, NOW()),
         updated_at = NOW()
     WHERE id IN (SELECT notification_id FROM accepted)`,
    [notificationId, channel, providerName, providerMessageId],
  );
}

export async function markNotificationDelivered(
  notificationId: string,
  channel: ExternalNotificationChannel,
  providerMessageId?: string | null,
): Promise<void> {
  await db.query(
    `WITH delivered AS (
       UPDATE notification_deliveries
       SET state = 'delivered',
           provider_message_id = COALESCE(NULLIF($3, ''), provider_message_id),
           provider_accepted_at = COALESCE(provider_accepted_at, NOW()),
           delivered_at = NOW(),
           next_retry_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE notification_id = $1 AND channel = $2
       RETURNING notification_id
     )
     UPDATE notifications
     SET delivery_state = CASE
           WHEN delivery_state = 'failed_terminal' THEN delivery_state
           ELSE 'delivered'
         END,
         sent_at = COALESCE(sent_at, NOW()),
         delivered_at = COALESCE(delivered_at, NOW()),
         updated_at = NOW()
     WHERE id IN (SELECT notification_id FROM delivered)`,
    [notificationId, channel, providerMessageId ?? null],
  );
}

export async function markNotificationSuppressed(
  notificationId: string,
  channel: ExternalNotificationChannel,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE notification_deliveries
     SET state = 'suppressed',
         last_error = $3,
         next_retry_at = NULL,
         updated_at = NOW()
     WHERE notification_id = $1 AND channel = $2`,
    [notificationId, channel, reason.slice(0, 500)],
  );
}

export async function markNotificationCancelled(
  notificationId: string,
  channel: ExternalNotificationChannel,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE notification_deliveries
     SET state = 'cancelled_superseded',
         last_error = $3,
         next_retry_at = NULL,
         updated_at = NOW()
     WHERE notification_id = $1 AND channel = $2
       AND state NOT IN ('delivered','provider_accepted')`,
    [notificationId, channel, reason.slice(0, 500)],
  );
}

export async function markNotificationDeliveryFailure(
  notificationId: string,
  channel: ExternalNotificationChannel,
  reason: string,
): Promise<void> {
  await db.query(
    `WITH failed AS (
       UPDATE notification_deliveries
       SET attempt_count = LEAST(attempt_count + 1, max_attempts),
           state = CASE
             WHEN attempt_count + 1 >= max_attempts THEN 'failed_terminal'
             ELSE 'retry_pending'
           END,
           next_retry_at = CASE
             WHEN attempt_count + 1 >= max_attempts THEN NULL
             ELSE NOW() + make_interval(secs => LEAST(3600, 60 * (2 ^ attempt_count)))
           END,
           last_error = $3,
           terminal_failure_at = CASE
             WHEN attempt_count + 1 >= max_attempts THEN NOW()
             ELSE NULL
           END,
           terminal_visibility = 'operator_exception',
           updated_at = NOW()
       WHERE notification_id = $1 AND channel = $2
       RETURNING notification_id, state, terminal_failure_at
     )
     UPDATE notifications notification
     SET delivery_state = CASE
           WHEN notification.delivery_state = 'failed_terminal'
             OR failed.state = 'failed_terminal' THEN 'failed_terminal'
           WHEN notification.delivery_state = 'delivered' THEN 'delivered'
           ELSE 'retry_pending'
         END,
         delivery_attempts = LEAST(notification.delivery_attempts + 1, 5),
         terminal_failure_at = CASE
           WHEN notification.delivery_state = 'failed_terminal'
             OR failed.state = 'failed_terminal'
             THEN COALESCE(notification.terminal_failure_at, failed.terminal_failure_at)
           ELSE NULL
         END,
         terminal_failure_reason = CASE
           WHEN notification.delivery_state = 'failed_terminal'
             OR failed.state = 'failed_terminal'
             THEN COALESCE(notification.terminal_failure_reason, $3)
           ELSE NULL
         END,
         updated_at = NOW()
     FROM failed
     WHERE notification.id = failed.notification_id`,
    [notificationId, channel, reason.slice(0, 500)],
  );
}
