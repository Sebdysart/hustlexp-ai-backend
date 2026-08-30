import { randomUUID } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { NotificationChannel } from './NotificationService.js';

type ExternalNotificationChannel = Exclude<NotificationChannel, 'in_app'>;

export type DeliveryAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

export type DeliveryClaimAuthorization =
  | { allowed: true; claimToken: string }
  | { allowed: false; reason: string };

const PROVIDER_ATTEMPT_DEADLINE_SECONDS = 300;

// Every state mutation builds a `ranked(notification_id,state)` CTE containing
// the new state for the changed channel plus the committed states of the other
// external channels. This single lattice prevents one channel from hiding a
// stronger provider fact recorded by another channel.
const STRONGEST_RANKED_DELIVERY_STATE_SQL = `CASE
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'delivered')
    THEN 'delivered'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'provider_accepted')
    THEN 'provider_accepted'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'provider_outcome_unknown')
    THEN 'provider_outcome_unknown'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'provider_in_flight')
    THEN 'provider_in_flight'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'failed_terminal')
    THEN 'failed_terminal'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'suppressed')
    THEN 'suppressed'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'retry_pending')
    THEN 'retry_pending'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'queued')
    THEN 'queued'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'deferred_focus')
    THEN 'deferred_focus'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'deferred_quiet_hours')
    THEN 'deferred_quiet_hours'
  WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id = notification.id AND ranked.state = 'pending')
    THEN 'pending'
  ELSE 'cancelled_superseded'
END`;

const SENDABLE_STATES = new Set([
  'pending', 'deferred_quiet_hours', 'queued', 'retry_pending',
]);

const PROVIDER_FACT_STATES = new Set([
  'provider_in_flight', 'provider_outcome_unknown', 'provider_accepted', 'delivered',
]);

type DeliveryAuthorityRow = {
  superseded_at: Date | string | null;
  expires_at: Date | string | null;
  available_at: Date | string;
  decision_time?: Date | string;
  state: string;
};

function deliveryDenial(
  row: DeliveryAuthorityRow,
  decisionTime: Date,
): Extract<DeliveryAuthorization, { allowed: false }> | null {
  // Durable provider truth outranks staleness policy. In particular, a
  // superseded notification with an unresolved provider attempt must remain
  // in-flight/unknown so duplicate workers cannot mark its outbox event done.
  if (PROVIDER_FACT_STATES.has(row.state)) return { allowed: false, reason: row.state };
  if (row.superseded_at) return { allowed: false, reason: 'superseded' };
  if (!SENDABLE_STATES.has(row.state)) return { allowed: false, reason: row.state };
  if (row.expires_at !== null) {
    const expiresAt = new Date(row.expires_at);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= decisionTime.getTime()) {
      return { allowed: false, reason: 'expired' };
    }
  }
  const availableAt = new Date(row.available_at);
  if (!Number.isFinite(availableAt.getTime()) || availableAt.getTime() > decisionTime.getTime()) {
    return { allowed: false, reason: 'not_due' };
  }
  return null;
}

/** Recheck state immediately before a provider call; missing evidence fails closed. */
export async function authorizeNotificationDelivery(
  notificationId: string,
  channel: ExternalNotificationChannel,
  now?: Date,
): Promise<DeliveryAuthorization> {
  const result = await db.query<DeliveryAuthorityRow>(
    `SELECT notification.superseded_at, notification.expires_at,
            NOW() AS decision_time,
            GREATEST(
              notification.available_at,
              delivery.available_at,
              COALESCE(delivery.next_retry_at, delivery.available_at)
            ) AS available_at,
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
  const decisionTime = now ?? new Date(row.decision_time ?? Date.now());
  if (!Number.isFinite(decisionTime.getTime())) {
    return { allowed: false, reason: 'decision_time_invalid' };
  }
  return deliveryDenial(row, decisionTime) ?? { allowed: true };
}

/**
 * Atomically records the last authority decision before provider I/O. Once this
 * claim commits, supersession may still hide the stale notification from the
 * user, but it must preserve the factual in-flight external attempt instead of
 * recording it as cancelled. No database transaction remains open during the
 * provider call.
 */
export async function claimNotificationDelivery(
  notificationId: string,
  channel: ExternalNotificationChannel,
  now?: Date,
  query?: QueryFn,
): Promise<DeliveryClaimAuthorization> {
  if (now && !Number.isFinite(now.getTime())) {
    return { allowed: false, reason: 'decision_time_invalid' };
  }

  const claimToken = randomUUID();
  const execute = async (lockedQuery: QueryFn): Promise<DeliveryClaimAuthorization> => {
    // This must be a statement before the mutation. PostgreSQL retains a
    // statement snapshot while waiting on a row lock, so a lock CTE inside the
    // aggregate mutation can still read stale sibling-channel state.
    await lockedQuery('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
    const result = await lockedQuery<DeliveryAuthorityRow & { claimed: boolean }>(
    `WITH authority AS MATERIALIZED (
       SELECT notification.superseded_at, notification.expires_at,
              COALESCE($3::TIMESTAMPTZ,NOW()) AS decision_time,
              GREATEST(
                notification.available_at,
                delivery.available_at,
                COALESCE(delivery.next_retry_at, delivery.available_at)
              ) AS available_at,
              delivery.state
       FROM notifications notification
       JOIN notification_deliveries delivery
         ON delivery.notification_id = notification.id
        AND delivery.channel = $2
       WHERE notification.id = $1
       FOR UPDATE OF notification, delivery
     ), claimed AS (
       UPDATE notification_deliveries delivery
       SET state = 'provider_in_flight',
           provider_attempt_id = $4::UUID,
           provider_attempt_started_at = NOW(),
           provider_attempt_deadline_at = NOW() + make_interval(secs => $5::INTEGER),
           next_retry_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       FROM authority
       WHERE delivery.notification_id = $1
         AND delivery.channel = $2
         AND authority.superseded_at IS NULL
         AND (
           authority.expires_at IS NULL
           OR authority.expires_at > authority.decision_time
         )
         AND authority.available_at <= authority.decision_time
         AND authority.state IN ('pending','deferred_quiet_hours','queued','retry_pending')
       RETURNING delivery.notification_id, delivery.state
     ), ranked AS MATERIALIZED (
       SELECT claimed.notification_id, claimed.state FROM claimed
       UNION ALL
       SELECT claimed.notification_id, other.state
       FROM claimed
       JOIN notification_deliveries other
         ON other.notification_id = claimed.notification_id
        AND other.channel <> $2
        AND other.channel <> 'in_app'
     ), aggregate_claim AS (
       UPDATE notifications notification
       SET delivery_state = ${STRONGEST_RANKED_DELIVERY_STATE_SQL},
           terminal_failure_at = NULL,
           terminal_failure_reason = NULL,
           updated_at = NOW()
       FROM claimed
       WHERE notification.id = claimed.notification_id
       RETURNING notification.id
     )
     SELECT authority.*,
            (claimed.notification_id IS NOT NULL) AS claimed
     FROM authority
     LEFT JOIN claimed ON TRUE`,
    [
      notificationId,
      channel,
      now ?? null,
      claimToken,
      PROVIDER_ATTEMPT_DEADLINE_SECONDS,
    ],
  );
    const row = result.rows[0];
    if (!row) return { allowed: false, reason: 'delivery_missing' };
    const authorityDecisionTime = new Date(row.decision_time ?? now ?? Date.now());
    if (!Number.isFinite(authorityDecisionTime.getTime())) {
      return { allowed: false, reason: 'decision_time_invalid' };
    }
    const denial = deliveryDenial(row, authorityDecisionTime);
    if (denial) return denial;
    return row.claimed
      ? { allowed: true, claimToken }
      : { allowed: false, reason: 'claim_lost' };
  };
  return query ? execute(query) : db.transaction(execute);
}

export async function markNotificationProviderAccepted(
  notificationId: string,
  channel: ExternalNotificationChannel,
  providerName: string,
  providerMessageId: string | null,
  claimToken?: string | null,
  query?: QueryFn,
): Promise<void> {
  const execute = async (lockedQuery: QueryFn): Promise<void> => {
    await lockedQuery('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
    await lockedQuery(
    `WITH accepted AS (
       UPDATE notification_deliveries delivery
       SET state = 'provider_accepted',
           provider_name = $3,
           provider_message_id = NULLIF(BTRIM($4), ''),
           provider_accepted_at = NOW(),
           provider_attempt_deadline_at = NULL,
           attempt_count = LEAST(attempt_count + 1, max_attempts),
           next_retry_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       FROM notifications notification
       WHERE delivery.notification_id = $1 AND delivery.channel = $2
         AND notification.id = delivery.notification_id
          AND $5::UUID IS NOT NULL
          AND delivery.provider_attempt_id = $5::UUID
          AND delivery.state IN ('provider_in_flight','provider_outcome_unknown')
       RETURNING delivery.notification_id, delivery.state
     ), ranked AS MATERIALIZED (
       SELECT accepted.notification_id, accepted.state FROM accepted
       UNION ALL
       SELECT accepted.notification_id, other.state
       FROM accepted
       JOIN notification_deliveries other
         ON other.notification_id = accepted.notification_id
        AND other.channel <> $2
        AND other.channel <> 'in_app'
     )
      UPDATE notifications notification
      SET delivery_state = ${STRONGEST_RANKED_DELIVERY_STATE_SQL},
          terminal_failure_at = NULL,
          terminal_failure_reason = NULL,
         sent_at = COALESCE(sent_at, NOW()),
         updated_at = NOW()
      FROM accepted
      WHERE notification.id = accepted.notification_id`,
    [notificationId, channel, providerName, providerMessageId, claimToken ?? null],
    );
  };
  if (query) await execute(query);
  else await db.transaction(execute);
}

export async function markNotificationDelivered(
  notificationId: string,
  channel: ExternalNotificationChannel,
  providerMessageId?: string | null,
  claimToken?: string | null,
  query?: QueryFn,
): Promise<void> {
  const execute = async (lockedQuery: QueryFn): Promise<void> => {
    await lockedQuery('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
    await lockedQuery(
    `WITH delivered AS (
       UPDATE notification_deliveries delivery
       SET state = 'delivered',
           provider_message_id = COALESCE(NULLIF(BTRIM($3), ''), provider_message_id),
           provider_accepted_at = COALESCE(provider_accepted_at, NOW()),
           provider_attempt_deadline_at = NULL,
           delivered_at = NOW(),
           next_retry_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       FROM notifications notification
       WHERE delivery.notification_id = $1 AND delivery.channel = $2
         AND notification.id = delivery.notification_id
          AND (
            (
              $4::UUID IS NOT NULL
              AND delivery.provider_attempt_id = $4::UUID
              AND delivery.state IN (
                'provider_in_flight','provider_outcome_unknown','provider_accepted'
              )
            )
            OR (
              $4::UUID IS NULL
              AND delivery.state='provider_accepted'
              AND NULLIF(BTRIM($3),'') IS NOT NULL
              AND delivery.provider_message_id=NULLIF(BTRIM($3),'')
            )
          )
       RETURNING delivery.notification_id, delivery.state
     ), ranked AS MATERIALIZED (
       SELECT delivered.notification_id, delivered.state FROM delivered
       UNION ALL
       SELECT delivered.notification_id, other.state
       FROM delivered
       JOIN notification_deliveries other
         ON other.notification_id = delivered.notification_id
        AND other.channel <> $2
        AND other.channel <> 'in_app'
     )
     UPDATE notifications notification
     SET delivery_state = ${STRONGEST_RANKED_DELIVERY_STATE_SQL},
         terminal_failure_at = NULL,
         terminal_failure_reason = NULL,
         sent_at = COALESCE(sent_at, NOW()),
         delivered_at = COALESCE(delivered_at, NOW()),
         updated_at = NOW()
     FROM delivered
     WHERE notification.id = delivered.notification_id`,
    [notificationId, channel, providerMessageId ?? null, claimToken ?? null],
    );
  };
  if (query) await execute(query);
  else await db.transaction(execute);
}

export async function markNotificationSuppressed(
  notificationId: string,
  channel: ExternalNotificationChannel,
  reason: string,
  claimToken?: string | null,
  query?: QueryFn,
): Promise<void> {
  const execute = async (lockedQuery: QueryFn): Promise<void> => {
    await lockedQuery('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
    await lockedQuery(
    `WITH suppressed AS (
       UPDATE notification_deliveries
       SET state = 'suppressed',
           last_error = $3,
           next_retry_at = NULL,
           provider_attempt_deadline_at = NULL,
           updated_at = NOW()
       WHERE notification_id = $1 AND channel = $2
         AND (
           ($4::UUID IS NULL AND state IN (
             'pending','deferred_quiet_hours','queued','retry_pending'
           ))
           OR (
             $4::UUID IS NOT NULL
             AND provider_attempt_id = $4::UUID
             AND state IN ('provider_in_flight','provider_outcome_unknown')
           )
         )
       RETURNING notification_deliveries.notification_id, notification_deliveries.state
     ), ranked AS MATERIALIZED (
       SELECT suppressed.notification_id, suppressed.state FROM suppressed
       UNION ALL
       SELECT suppressed.notification_id, other.state
       FROM suppressed
       JOIN notification_deliveries other
         ON other.notification_id = suppressed.notification_id
        AND other.channel <> $2
        AND other.channel <> 'in_app'
     )
     UPDATE notifications notification
     SET delivery_state = ${STRONGEST_RANKED_DELIVERY_STATE_SQL},
         terminal_failure_at = CASE
           WHEN (${STRONGEST_RANKED_DELIVERY_STATE_SQL}) = 'failed_terminal'
             THEN COALESCE(
               notification.terminal_failure_at,
               (SELECT MAX(delivery.terminal_failure_at)
                FROM notification_deliveries delivery
                WHERE delivery.notification_id = notification.id
                  AND delivery.state = 'failed_terminal')
             )
           ELSE NULL
         END,
         terminal_failure_reason = CASE
           WHEN (${STRONGEST_RANKED_DELIVERY_STATE_SQL}) = 'failed_terminal'
             THEN COALESCE(
               notification.terminal_failure_reason,
               (SELECT MAX(delivery.last_error)
                FROM notification_deliveries delivery
                WHERE delivery.notification_id = notification.id
                  AND delivery.state = 'failed_terminal')
             )
           ELSE NULL
         END,
         updated_at = NOW()
     FROM suppressed
     WHERE notification.id = suppressed.notification_id`,
    [notificationId, channel, reason.slice(0, 500), claimToken ?? null],
    );
  };
  if (query) await execute(query);
  else await db.transaction(execute);
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
       AND state IN ('pending','deferred_quiet_hours','queued','retry_pending')`,
    [notificationId, channel, reason.slice(0, 500)],
  );
}

export async function markNotificationDeliveryFailure(
  notificationId: string,
  channel: ExternalNotificationChannel,
  reason: string,
  claimToken?: string | null,
  query?: QueryFn,
  recoveryClaimToken?: string | null,
  forceTerminal = false,
): Promise<void> {
  const execute = async (lockedQuery: QueryFn): Promise<void> => {
    await lockedQuery('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
    await lockedQuery(
    `WITH failed AS (
       UPDATE notification_deliveries delivery
       SET attempt_count = LEAST(attempt_count + 1, max_attempts),
           state = CASE
             WHEN notification.superseded_at IS NOT NULL THEN 'cancelled_superseded'
             WHEN $6::BOOLEAN OR attempt_count + 1 >= max_attempts THEN 'failed_terminal'
             ELSE 'retry_pending'
           END,
           next_retry_at = CASE
             WHEN notification.superseded_at IS NOT NULL THEN NULL
             WHEN $6::BOOLEAN OR attempt_count + 1 >= max_attempts THEN NULL
             ELSE NOW() + make_interval(secs => LEAST(3600, 60 * (2 ^ attempt_count)))
           END,
           last_error = $3,
           terminal_failure_at = CASE
             WHEN notification.superseded_at IS NULL
               AND ($6::BOOLEAN OR attempt_count + 1 >= max_attempts) THEN NOW()
             ELSE NULL
           END,
           terminal_visibility = 'operator_exception',
           provider_attempt_deadline_at = NULL,
           provider_attempt_id = NULL,
           provider_attempt_started_at = NULL,
           recovery_claim_id = NULL,
           recovery_claimed_at = NULL,
           recovery_claim_deadline_at = NULL,
           updated_at = NOW()
       FROM notifications notification
       WHERE delivery.notification_id = $1 AND delivery.channel = $2
         AND notification.id = delivery.notification_id
         AND (
           ($4::UUID IS NULL AND $5::UUID IS NULL AND delivery.state IN (
             'pending','deferred_quiet_hours','queued','retry_pending'
           ))
           OR (
             $5::UUID IS NOT NULL
             AND delivery.recovery_claim_id=$5::UUID
             AND delivery.recovery_claim_deadline_at > NOW()
             AND delivery.state='retry_pending'
           )
           OR (
             $4::UUID IS NOT NULL
             AND delivery.provider_attempt_id = $4::UUID
             AND delivery.state = 'provider_in_flight'
           )
         )
       RETURNING delivery.notification_id, delivery.state, delivery.terminal_failure_at,
                 delivery.next_retry_at
     ), ranked AS MATERIALIZED (
       SELECT failed.notification_id, failed.state FROM failed
       UNION ALL
       SELECT failed.notification_id, other.state
       FROM failed
       JOIN notification_deliveries other
         ON other.notification_id = failed.notification_id
        AND other.channel <> $2
        AND other.channel <> 'in_app'
     ), rearmed_email AS (
       UPDATE email_outbox email
       SET status = CASE WHEN failed.state='failed_terminal' THEN 'failed' ELSE 'pending' END,
           available_at = COALESCE(failed.next_retry_at, email.available_at),
           last_error = $3,
           pre_provider_claim_id = NULL,
           pre_provider_claimed_at = NULL,
           pre_provider_claim_deadline_at = NULL,
           provider_io_started_at = NULL,
           notification_provider_attempt_id = NULL,
           updated_at = NOW()
       FROM failed
       WHERE email.notification_id = failed.notification_id
         AND $2::TEXT = 'email'
         AND failed.state IN ('retry_pending','failed_terminal')
         AND email.status IN ('pending','failed','sending')
       RETURNING email.id
     ), rearmed_sms AS (
       UPDATE sms_outbox sms
       SET status = CASE WHEN failed.state='failed_terminal' THEN 'failed' ELSE 'pending' END,
           available_at = COALESCE(failed.next_retry_at, sms.available_at),
           error_message = $3,
           pre_provider_claim_id = NULL,
           pre_provider_claimed_at = NULL,
           pre_provider_claim_deadline_at = NULL,
           provider_io_started_at = NULL,
           notification_provider_attempt_id = NULL,
           updated_at = NOW()
       FROM failed
       WHERE sms.notification_id = failed.notification_id
         AND $2::TEXT = 'sms'
         AND failed.state IN ('retry_pending','failed_terminal')
         AND sms.status IN ('pending','failed','sending')
       RETURNING sms.id
     ), rearmed_outbox AS (
       UPDATE outbox_events outbox
       SET status = CASE WHEN failed.state='failed_terminal' THEN 'failed' ELSE 'pending' END,
           available_at = COALESCE(failed.next_retry_at, outbox.available_at),
           error_message = $3,
           processed_at = NULL,
           bullmq_job_id = NULL,
           dispatch_attempt_id = NULL,
           dispatch_claimed_at = NULL,
           dispatch_deadline_at = NULL,
           pre_provider_claim_id = NULL,
           pre_provider_claimed_at = NULL,
           pre_provider_claim_deadline_at = NULL,
           provider_io_started_at = NULL,
           updated_at = NOW()
       FROM failed
       WHERE failed.state IN ('retry_pending','failed_terminal')
         AND outbox.status IN ('pending','enqueued','processing','failed')
         AND (failed.state='failed_terminal' OR outbox.attempts < 5)
         AND (
            ($2::TEXT = 'push'
              AND outbox.event_type = 'push.send_requested'
              AND outbox.aggregate_type = 'push'
               AND outbox.aggregate_id = failed.notification_id)
            OR ($2::TEXT = 'email' AND EXISTS (
               SELECT 1 FROM email_outbox email
               WHERE email.id = outbox.aggregate_id
                 AND email.notification_id = failed.notification_id
                 AND outbox.event_type = 'email.send_requested'
                 AND outbox.aggregate_type = 'email'
            ))
            OR ($2::TEXT = 'sms' AND EXISTS (
               SELECT 1 FROM sms_outbox sms
               WHERE sms.id = outbox.aggregate_id
                 AND sms.notification_id = failed.notification_id
                 AND outbox.event_type = 'sms.send_requested'
                 AND outbox.aggregate_type = 'sms'
            ))
         )
       RETURNING outbox.id
     ), aggregate_failure AS (
       UPDATE notifications notification
     SET delivery_state = ${STRONGEST_RANKED_DELIVERY_STATE_SQL},
         delivery_attempts = LEAST(notification.delivery_attempts + 1, 5),
         terminal_failure_at = CASE
            WHEN (${STRONGEST_RANKED_DELIVERY_STATE_SQL}) = 'failed_terminal'
              THEN COALESCE(
                notification.terminal_failure_at,
                failed.terminal_failure_at,
                (SELECT MAX(delivery.terminal_failure_at)
                 FROM notification_deliveries delivery
                 WHERE delivery.notification_id=notification.id
                   AND delivery.state='failed_terminal')
              )
           ELSE NULL
         END,
         terminal_failure_reason = CASE
            WHEN (${STRONGEST_RANKED_DELIVERY_STATE_SQL}) = 'failed_terminal'
              THEN COALESCE(
                notification.terminal_failure_reason,
                CASE WHEN failed.state='failed_terminal' THEN $3 ELSE NULL END,
                (SELECT MAX(delivery.last_error)
                 FROM notification_deliveries delivery
                 WHERE delivery.notification_id=notification.id
                   AND delivery.state='failed_terminal')
              )
           ELSE NULL
         END,
         updated_at = NOW()
     FROM failed
     WHERE notification.id = failed.notification_id
     RETURNING notification.id
     )
     SELECT COUNT(*)::INTEGER AS updated FROM aggregate_failure`,
    [
      notificationId,
      channel,
      reason.slice(0, 500),
      claimToken ?? null,
      recoveryClaimToken ?? null,
      forceTerminal,
    ],
    );
  };
  if (query) await execute(query);
  else await db.transaction(execute);
}

/**
 * A provider call started but no authoritative acceptance/rejection receipt was
 * obtained. This state is intentionally non-retryable: retrying could duplicate
 * an external send. Reconciliation or an operator must resolve it.
 */
export async function markNotificationProviderOutcomeUnknown(
  notificationId: string,
  channel: ExternalNotificationChannel,
  reason: string,
  claimToken: string,
  query?: QueryFn,
): Promise<boolean> {
  const execute = async (lockedQuery: QueryFn): Promise<boolean> => {
    await lockedQuery('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
    const result = await lockedQuery<{ id: string }>(
    `WITH unknown AS (
       UPDATE notification_deliveries delivery
       SET state = 'provider_outcome_unknown',
           next_retry_at = NULL,
           last_error = $3,
           terminal_visibility = 'operator_exception',
           updated_at = NOW()
       WHERE delivery.notification_id = $1
         AND delivery.channel = $2
         AND delivery.provider_attempt_id = $4::UUID
         AND delivery.state = 'provider_in_flight'
       RETURNING delivery.notification_id, delivery.state
     ), ranked AS MATERIALIZED (
       SELECT unknown.notification_id, unknown.state FROM unknown
       UNION ALL
       SELECT unknown.notification_id, other.state
       FROM unknown
       JOIN notification_deliveries other
         ON other.notification_id = unknown.notification_id
        AND other.channel <> $2
        AND other.channel <> 'in_app'
     )
     UPDATE notifications notification
     SET delivery_state = ${STRONGEST_RANKED_DELIVERY_STATE_SQL},
         terminal_failure_at = CASE
           WHEN notification.delivery_state IN ('delivered','provider_accepted')
             THEN notification.terminal_failure_at
           ELSE NULL
         END,
         terminal_failure_reason = CASE
           WHEN notification.delivery_state IN ('delivered','provider_accepted')
             THEN notification.terminal_failure_reason
           ELSE NULL
         END,
         updated_at = NOW()
      FROM unknown
      WHERE notification.id = unknown.notification_id
      RETURNING notification.id`,
    [notificationId, channel, reason.slice(0, 500), claimToken],
    );
    return Boolean(result.rows[0]);
  };
  return query ? execute(query) : db.transaction(execute);
}
