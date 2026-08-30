import { db } from '../db.js';
import { logger } from '../logger.js';
import {
  markNotificationDeliveryFailure,
  markNotificationProviderAccepted,
  markNotificationProviderOutcomeUnknown,
} from './NotificationDeliveryState.js';
import { NotificationService, type NotificationChannel } from './NotificationService.js';

type ExternalNotificationChannel = Exclude<NotificationChannel, 'in_app'>;

type RecoveryCandidate = {
  notification_id: string;
  channel: ExternalNotificationChannel;
  recovery_claim_id: string;
};

const RECOVERY_CLAIM_LEASE_SECONDS = 300;

type ProviderReceiptCandidate = {
  channel: 'email' | 'sms';
  channel_outbox_id: string;
  notification_id: string | null;
  provider_name: string;
  provider_message_id: string;
  provider_attempt_id: string;
  idempotency_key: string;
};

export type NotificationDeliveryRecoveryResult = {
  inspected: number;
  recovered: number;
  failed: number;
  skipped: number;
};

export type NotificationFocusReleaseResult = { released: number };

const log = logger.child({ service: 'NotificationDeliveryRecoveryService' });

/**
 * Reconcile a provider receipt that was committed before its notification
 * callback. The receipt is useful only when it is bound to the exact durable
 * notification-provider attempt token; no provider I/O occurs here.
 */
export async function reconcileNotificationProviderReceipts(limit = 100): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const candidates = await db.query<ProviderReceiptCandidate>(
    `SELECT * FROM (
       SELECT 'email'::TEXT AS channel,email.id AS channel_outbox_id,
              email.notification_id,COALESCE(email.provider_name,'sendgrid') AS provider_name,
              BTRIM(email.provider_msg_id) AS provider_message_id,
              email.notification_provider_attempt_id AS provider_attempt_id,
              email.idempotency_key
       FROM email_outbox email
       JOIN notification_deliveries delivery
         ON delivery.notification_id = email.notification_id
        AND delivery.channel = 'email'
         AND delivery.provider_attempt_id = email.notification_provider_attempt_id
         AND delivery.state IN ('provider_in_flight','provider_outcome_unknown','provider_accepted','delivered')
       JOIN outbox_events outbox
         ON outbox.idempotency_key=email.idempotency_key
        AND outbox.event_type='email.send_requested'
        AND outbox.aggregate_type='email'
        AND outbox.aggregate_id=email.id
       WHERE NULLIF(BTRIM(email.provider_msg_id),'') IS NOT NULL
          AND email.notification_provider_attempt_id IS NOT NULL
          AND email.idempotency_key IS NOT NULL
          AND (email.status<>'sent' OR outbox.status<>'processed')
       UNION ALL
       SELECT 'email'::TEXT AS channel,email.id AS channel_outbox_id,
              NULL::UUID AS notification_id,COALESCE(email.provider_name,'sendgrid') AS provider_name,
              BTRIM(email.provider_msg_id) AS provider_message_id,
              email.notification_provider_attempt_id AS provider_attempt_id,
              email.idempotency_key
       FROM email_outbox email
       JOIN outbox_events outbox
         ON outbox.idempotency_key=email.idempotency_key
        AND outbox.event_type='email.send_requested'
        AND outbox.event_version=1
        AND outbox.queue_name='user_notifications'
        AND outbox.dispatch_attempt_id IS NOT NULL
        AND NULLIF(BTRIM(outbox.bullmq_job_id),'') IS NOT NULL
        AND outbox.payload=(
          jsonb_build_object(
            'emailId',email.id,
            'toEmail',email.to_email,
            'template',email.template,
            'params',email.params_json
          ) || CASE
            WHEN email.user_id IS NULL THEN '{}'::JSONB
            ELSE jsonb_build_object('userId',email.user_id)
          END
        )
        AND (
          (email.user_id IS NOT NULL AND email.lead_id IS NULL
            AND outbox.aggregate_type='email' AND outbox.aggregate_id=email.id)
          OR (email.user_id IS NULL AND email.lead_id IS NOT NULL
            AND outbox.aggregate_type='lead' AND outbox.aggregate_id=email.lead_id
            AND outbox.payload->>'emailId'=email.id::TEXT)
        )
       WHERE email.notification_id IS NULL
         AND num_nonnulls(email.user_id,email.lead_id)=1
         AND email.status IN ('sending','sent','provider_outcome_unknown')
         AND email.provider_io_started_at IS NOT NULL
         AND NULLIF(BTRIM(email.provider_msg_id),'') IS NOT NULL
         AND email.notification_provider_attempt_id IS NOT NULL
         AND email.idempotency_key IS NOT NULL
         AND (email.status<>'sent' OR outbox.status<>'processed')
       UNION ALL
       SELECT 'sms'::TEXT AS channel,sms.id AS channel_outbox_id,
              sms.notification_id,COALESCE(sms.provider_name,'twilio'),
              COALESCE(
                NULLIF(BTRIM(sms.provider_message_id),''),
                NULLIF(BTRIM(sms.twilio_sid),'')
              ) AS provider_message_id,
              sms.notification_provider_attempt_id AS provider_attempt_id,
              sms.idempotency_key
       FROM sms_outbox sms
       JOIN notification_deliveries delivery
         ON delivery.notification_id = sms.notification_id
        AND delivery.channel = 'sms'
         AND delivery.provider_attempt_id = sms.notification_provider_attempt_id
         AND delivery.state IN ('provider_in_flight','provider_outcome_unknown','provider_accepted','delivered')
       JOIN outbox_events outbox
         ON outbox.idempotency_key=sms.idempotency_key
        AND outbox.event_type='sms.send_requested'
        AND outbox.aggregate_type='sms'
        AND outbox.aggregate_id=sms.id
       WHERE COALESCE(
               NULLIF(BTRIM(sms.provider_message_id),''),
               NULLIF(BTRIM(sms.twilio_sid),'')
             ) IS NOT NULL
          AND sms.notification_provider_attempt_id IS NOT NULL
          AND sms.idempotency_key IS NOT NULL
          AND (sms.status<>'sent' OR outbox.status<>'processed')
       UNION ALL
       SELECT 'sms'::TEXT AS channel,sms.id AS channel_outbox_id,
              NULL::UUID AS notification_id,COALESCE(sms.provider_name,'twilio'),
              COALESCE(
                NULLIF(BTRIM(sms.provider_message_id),''),
                NULLIF(BTRIM(sms.twilio_sid),'')
              ) AS provider_message_id,
              sms.notification_provider_attempt_id AS provider_attempt_id,
              sms.idempotency_key
       FROM sms_outbox sms
       JOIN outbox_events outbox
         ON outbox.idempotency_key=sms.idempotency_key
        AND outbox.event_type='sms.send_requested'
        AND outbox.event_version=1
        AND outbox.queue_name='user_notifications'
        AND outbox.aggregate_type='sms'
        AND outbox.aggregate_id=sms.id
        AND outbox.dispatch_attempt_id IS NOT NULL
        AND NULLIF(BTRIM(outbox.bullmq_job_id),'') IS NOT NULL
        AND outbox.payload=jsonb_strip_nulls(jsonb_build_object(
          'smsId',sms.id,
          'notificationId',sms.notification_id,
          'userId',sms.user_id,
          'toPhone',sms.to_phone,
          'body',sms.body
        ))
       WHERE sms.notification_id IS NULL
         AND sms.user_id IS NOT NULL
         AND sms.status IN ('sending','sent','provider_outcome_unknown')
         AND sms.provider_io_started_at IS NOT NULL
         AND COALESCE(
               NULLIF(BTRIM(sms.provider_message_id),''),
               NULLIF(BTRIM(sms.twilio_sid),'')
             ) IS NOT NULL
         AND sms.notification_provider_attempt_id IS NOT NULL
         AND sms.idempotency_key IS NOT NULL
         AND (sms.status<>'sent' OR outbox.status<>'processed')
      ) receipt
     ORDER BY notification_id NULLS LAST,channel,channel_outbox_id
     LIMIT $1`,
    [boundedLimit],
  );

  let reconciled = 0;
  for (const candidate of candidates.rows) {
    if (!candidate.notification_id) {
      const committed = await db.transaction(async (query) => {
        if (candidate.channel === 'email') {
          const proof = await query<{
            channel_outbox_id: string;
            outbox_id: string;
            outbox_status: string;
          }>(
            `SELECT email.id AS channel_outbox_id,outbox.id AS outbox_id,
                    outbox.status AS outbox_status
             FROM email_outbox email
             JOIN outbox_events outbox
               ON outbox.idempotency_key=email.idempotency_key
              AND outbox.event_type='email.send_requested'
              AND outbox.event_version=1
              AND outbox.queue_name='user_notifications'
              AND outbox.dispatch_attempt_id IS NOT NULL
              AND NULLIF(BTRIM(outbox.bullmq_job_id),'') IS NOT NULL
              AND outbox.payload=(
                jsonb_build_object(
                  'emailId',email.id,
                  'toEmail',email.to_email,
                  'template',email.template,
                  'params',email.params_json
                ) || CASE
                  WHEN email.user_id IS NULL THEN '{}'::JSONB
                  ELSE jsonb_build_object('userId',email.user_id)
                END
              )
              AND (
                (email.user_id IS NOT NULL AND email.lead_id IS NULL
                  AND outbox.aggregate_type='email' AND outbox.aggregate_id=email.id)
                OR (email.user_id IS NULL AND email.lead_id IS NOT NULL
                  AND outbox.aggregate_type='lead' AND outbox.aggregate_id=email.lead_id
                  AND outbox.payload->>'emailId'=email.id::TEXT)
              )
             WHERE email.id=$1
               AND email.notification_id IS NULL
               AND num_nonnulls(email.user_id,email.lead_id)=1
               AND email.status IN ('sending','sent','provider_outcome_unknown')
               AND email.provider_io_started_at IS NOT NULL
               AND email.notification_provider_attempt_id=$2::UUID
               AND NULLIF(BTRIM(email.provider_msg_id),'')=$3
               AND email.idempotency_key=$4
               AND (email.status<>'sent' OR outbox.status<>'processed')
             FOR UPDATE OF email,outbox`,
            [
              candidate.channel_outbox_id,
              candidate.provider_attempt_id,
              candidate.provider_message_id,
              candidate.idempotency_key,
            ],
          );
          const exact = proof.rows[0];
          if (!exact) return false;
          const finalized = await query<{ id: string }>(
            `UPDATE email_outbox
             SET status='sent',sent_at=COALESCE(sent_at,NOW()),updated_at=NOW()
             WHERE id=$1
               AND notification_id IS NULL
               AND num_nonnulls(user_id,lead_id)=1
               AND status IN ('sending','sent','provider_outcome_unknown')
               AND provider_io_started_at IS NOT NULL
               AND notification_provider_attempt_id=$2::UUID
               AND NULLIF(BTRIM(provider_msg_id),'')=$3
               AND idempotency_key=$4
             RETURNING id`,
            [
              candidate.channel_outbox_id,
              candidate.provider_attempt_id,
              candidate.provider_message_id,
              candidate.idempotency_key,
            ],
          );
          if (!finalized.rows[0]) {
            throw new Error('Direct email receipt lost exact channel authority while locked');
          }
          if (exact.outbox_status !== 'processed') {
            const closed = await query<{ id: string }>(
              `UPDATE outbox_events
               SET status='processed',processed_at=COALESCE(processed_at,NOW()),
                   error_message=NULL,dispatch_deadline_at=NULL,
                   pre_provider_claim_deadline_at=NULL,updated_at=NOW()
               WHERE id=$1 AND idempotency_key=$2 AND status<>'processed'
               RETURNING id`,
              [exact.outbox_id, candidate.idempotency_key],
            );
            if (!closed.rows[0]) {
              throw new Error('Direct email receipt lost exact outbox authority while locked');
            }
          }
          return true;
        }

        const proof = await query<{
          channel_outbox_id: string;
          outbox_id: string;
          outbox_status: string;
        }>(
          `SELECT sms.id AS channel_outbox_id,outbox.id AS outbox_id,
                  outbox.status AS outbox_status
           FROM sms_outbox sms
           JOIN outbox_events outbox
             ON outbox.idempotency_key=sms.idempotency_key
            AND outbox.event_type='sms.send_requested'
            AND outbox.event_version=1
            AND outbox.queue_name='user_notifications'
            AND outbox.aggregate_type='sms'
            AND outbox.aggregate_id=sms.id
            AND outbox.dispatch_attempt_id IS NOT NULL
            AND NULLIF(BTRIM(outbox.bullmq_job_id),'') IS NOT NULL
            AND outbox.payload=jsonb_strip_nulls(jsonb_build_object(
              'smsId',sms.id,
              'notificationId',sms.notification_id,
              'userId',sms.user_id,
              'toPhone',sms.to_phone,
              'body',sms.body
            ))
           WHERE sms.id=$1
             AND sms.notification_id IS NULL
             AND sms.user_id IS NOT NULL
             AND sms.status IN ('sending','sent','provider_outcome_unknown')
             AND sms.provider_io_started_at IS NOT NULL
             AND sms.notification_provider_attempt_id=$2::UUID
             AND COALESCE(
               NULLIF(BTRIM(sms.provider_message_id),''),
               NULLIF(BTRIM(sms.twilio_sid),'')
             )=$3
             AND sms.idempotency_key=$4
             AND (sms.status<>'sent' OR outbox.status<>'processed')
           FOR UPDATE OF sms,outbox`,
          [
            candidate.channel_outbox_id,
            candidate.provider_attempt_id,
            candidate.provider_message_id,
            candidate.idempotency_key,
          ],
        );
        const exact = proof.rows[0];
        if (!exact) return false;
        const finalized = await query<{ id: string }>(
          `UPDATE sms_outbox
           SET status='sent',sent_at=COALESCE(sent_at,NOW()),updated_at=NOW()
           WHERE id=$1
             AND notification_id IS NULL
             AND user_id IS NOT NULL
             AND status IN ('sending','sent','provider_outcome_unknown')
             AND provider_io_started_at IS NOT NULL
             AND notification_provider_attempt_id=$2::UUID
             AND COALESCE(
               NULLIF(BTRIM(provider_message_id),''),
               NULLIF(BTRIM(twilio_sid),'')
             )=$3
             AND idempotency_key=$4
           RETURNING id`,
          [
            candidate.channel_outbox_id,
            candidate.provider_attempt_id,
            candidate.provider_message_id,
            candidate.idempotency_key,
          ],
        );
        if (!finalized.rows[0]) {
          throw new Error('Direct SMS receipt lost exact channel authority while locked');
        }
        if (exact.outbox_status !== 'processed') {
          const closed = await query<{ id: string }>(
            `UPDATE outbox_events
             SET status='processed',processed_at=COALESCE(processed_at,NOW()),
                 error_message=NULL,dispatch_deadline_at=NULL,
                 pre_provider_claim_deadline_at=NULL,updated_at=NOW()
             WHERE id=$1 AND idempotency_key=$2 AND status<>'processed'
             RETURNING id`,
            [exact.outbox_id, candidate.idempotency_key],
          );
          if (!closed.rows[0]) {
            throw new Error('Direct SMS receipt lost exact outbox authority while locked');
          }
        }
        return true;
      });
      if (committed) reconciled += 1;
      continue;
    }

    const notificationId = candidate.notification_id;
    const committed = await db.transaction(async (query) => {
      await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
      const proof = candidate.channel === 'email'
        ? await query<{ state: string }>(
            `SELECT delivery.state
             FROM email_outbox email
             JOIN notification_deliveries delivery
               ON delivery.notification_id=email.notification_id
              AND delivery.channel='email'
             WHERE email.id=$1
               AND email.notification_id=$2
               AND email.notification_provider_attempt_id=$3::UUID
               AND NULLIF(BTRIM(email.provider_msg_id),'')=$4
               AND delivery.provider_attempt_id=$3::UUID
               AND delivery.state IN ('provider_in_flight','provider_outcome_unknown','provider_accepted','delivered')
             FOR UPDATE OF email,delivery`,
            [
              candidate.channel_outbox_id,
              notificationId,
              candidate.provider_attempt_id,
              candidate.provider_message_id,
            ],
          )
        : await query<{ state: string }>(
            `SELECT delivery.state
             FROM sms_outbox sms
             JOIN notification_deliveries delivery
               ON delivery.notification_id=sms.notification_id
              AND delivery.channel='sms'
             WHERE sms.id=$1
               AND sms.notification_id=$2
               AND sms.notification_provider_attempt_id=$3::UUID
               AND COALESCE(
                 NULLIF(BTRIM(sms.provider_message_id),''),
                 NULLIF(BTRIM(sms.twilio_sid),'')
               )=$4
               AND delivery.provider_attempt_id=$3::UUID
               AND delivery.state IN ('provider_in_flight','provider_outcome_unknown','provider_accepted','delivered')
             FOR UPDATE OF sms,delivery`,
            [
              candidate.channel_outbox_id,
              notificationId,
              candidate.provider_attempt_id,
              candidate.provider_message_id,
            ],
          );
      const current = proof.rows[0];
      if (!current) return false;
      if (current.state === 'provider_in_flight' || current.state === 'provider_outcome_unknown') {
        await markNotificationProviderAccepted(
          notificationId,
          candidate.channel,
          candidate.provider_name,
          candidate.provider_message_id,
          candidate.provider_attempt_id,
          query,
        );
      }

      const finalized = candidate.channel === 'email'
        ? await query<{ id: string }>(
            `UPDATE email_outbox email
             SET status='sent',sent_at=COALESCE(sent_at,NOW()),updated_at=NOW()
             WHERE email.id=$1
               AND email.notification_provider_attempt_id=$2::UUID
               AND NULLIF(BTRIM(email.provider_msg_id),'')=$3
               AND EXISTS (
                 SELECT 1 FROM notification_deliveries delivery
                 WHERE delivery.notification_id=email.notification_id
                   AND delivery.channel='email'
                   AND delivery.provider_attempt_id=$2::UUID
                   AND delivery.state IN ('provider_accepted','delivered')
               )
             RETURNING email.id`,
            [candidate.channel_outbox_id, candidate.provider_attempt_id, candidate.provider_message_id],
          )
        : await query<{ id: string }>(
            `UPDATE sms_outbox sms
             SET status='sent',sent_at=COALESCE(sent_at,NOW()),updated_at=NOW()
             WHERE sms.id=$1
               AND sms.notification_provider_attempt_id=$2::UUID
               AND COALESCE(
                 NULLIF(BTRIM(sms.provider_message_id),''),
                 NULLIF(BTRIM(sms.twilio_sid),'')
               )=$3
               AND EXISTS (
                 SELECT 1 FROM notification_deliveries delivery
                 WHERE delivery.notification_id=sms.notification_id
                   AND delivery.channel='sms'
                   AND delivery.provider_attempt_id=$2::UUID
                   AND delivery.state IN ('provider_accepted','delivered')
               )
             RETURNING sms.id`,
            [candidate.channel_outbox_id, candidate.provider_attempt_id, candidate.provider_message_id],
          );
      if (!finalized.rows[0]) return false;
      const outbox = await query<{ id: string }>(
        `UPDATE outbox_events
         SET status='processed',processed_at=COALESCE(processed_at,NOW()),
              dispatch_deadline_at=NULL,pre_provider_claim_deadline_at=NULL,updated_at=NOW()
         WHERE idempotency_key=$1
           AND event_type=$2
           AND aggregate_type=$3
           AND aggregate_id=$4
         RETURNING id`,
        [
          candidate.idempotency_key,
          `${candidate.channel}.send_requested`,
          candidate.channel,
          candidate.channel_outbox_id,
        ],
      );
      return Boolean(outbox.rows[0]);
    });
    if (committed) reconciled += 1;
  }
  return reconciled;
}

/**
 * Close immutable queue work after a channel has durable non-retryable truth.
 * This repairs the crash window after a provider callback commits but before
 * the worker marks its outbox event processed, and prevents completed BullMQ
 * job IDs from being re-added forever after an outcome becomes explicit.
 */
export async function reconcileTerminalNotificationOutboxEvents(limit = 100): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const result = await db.transaction(async (query) => query<{ reconciled: string | number }>(
    `WITH candidates AS MATERIALIZED (
       SELECT outbox.id
       FROM outbox_events outbox
       WHERE outbox.status IN ('pending','enqueued','processing','failed')
         AND (
           (
             outbox.event_type='push.send_requested'
             AND outbox.aggregate_type='push'
             AND EXISTS (
               SELECT 1 FROM notification_deliveries delivery
               WHERE delivery.notification_id=outbox.aggregate_id
                 AND delivery.channel='push'
                 AND delivery.state IN (
                   'provider_outcome_unknown','provider_accepted','delivered',
                   'suppressed','failed_terminal','cancelled_superseded'
                 )
             )
           )
           OR (
             outbox.event_type='email.send_requested'
             AND outbox.aggregate_type='email'
             AND EXISTS (
               SELECT 1
               FROM email_outbox email
               JOIN notification_deliveries delivery
                 ON delivery.notification_id=email.notification_id
                AND delivery.channel='email'
               WHERE email.id=outbox.aggregate_id
                 AND delivery.state IN (
                   'provider_outcome_unknown','provider_accepted','delivered',
                   'suppressed','failed_terminal','cancelled_superseded'
                 )
             )
           )
           OR (
             outbox.event_type='sms.send_requested'
             AND outbox.aggregate_type='sms'
             AND EXISTS (
               SELECT 1
               FROM sms_outbox sms
               JOIN notification_deliveries delivery
                 ON delivery.notification_id=sms.notification_id
                AND delivery.channel='sms'
               WHERE sms.id=outbox.aggregate_id
                 AND delivery.state IN (
                   'provider_outcome_unknown','provider_accepted','delivered',
                   'suppressed','failed_terminal','cancelled_superseded'
                 )
             )
           )
         )
       ORDER BY outbox.updated_at,outbox.id
       LIMIT $1
       FOR UPDATE OF outbox SKIP LOCKED
     ), reconciled AS (
       UPDATE outbox_events outbox
       SET status='processed',processed_at=COALESCE(processed_at,NOW()),
           dispatch_deadline_at=NULL,pre_provider_claim_deadline_at=NULL,
           updated_at=NOW()
       FROM candidates
       WHERE outbox.id=candidates.id
       RETURNING outbox.id
     )
     SELECT COUNT(*)::TEXT AS reconciled FROM reconciled`,
    [boundedLimit],
  ));
  const reconciled = Number(result.rows[0]?.reconciled ?? 0);
  return Number.isSafeInteger(reconciled) && reconciled >= 0 ? reconciled : 0;
}

/** Close channel and aggregate truth when durable transport attempts exhaust. */
export async function reconcileExhaustedNotificationDispatches(limit = 100): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const candidates = await db.query<{
    channel: ExternalNotificationChannel;
    notification_id: string | null;
    channel_outbox_id: string | null;
    error_message: string;
  }>(
    `SELECT * FROM (
       SELECT 'push'::TEXT AS channel,outbox.aggregate_id AS notification_id,
              NULL::UUID AS channel_outbox_id,outbox.error_message
       FROM outbox_events outbox
       JOIN notification_deliveries delivery
         ON delivery.notification_id=outbox.aggregate_id AND delivery.channel='push'
       WHERE outbox.status='failed'
         AND outbox.error_message IN (
           'pre_provider_dispatch_attempts_exhausted',
           'retained_terminal_dispatch_attempts_exhausted'
         )
         AND outbox.event_type='push.send_requested'
         AND outbox.aggregate_type='push'
         AND delivery.state IN ('pending','deferred_quiet_hours','deferred_focus','queued','retry_pending')
       UNION ALL
       SELECT 'email'::TEXT,email.notification_id,email.id,outbox.error_message
       FROM outbox_events outbox
       JOIN email_outbox email
         ON email.id::TEXT=COALESCE(outbox.payload->>'emailId',
           CASE WHEN outbox.aggregate_type='email' THEN outbox.aggregate_id::TEXT END)
       LEFT JOIN notification_deliveries delivery
         ON delivery.notification_id=email.notification_id AND delivery.channel='email'
       WHERE outbox.status='failed'
         AND outbox.error_message IN (
           'pre_provider_dispatch_attempts_exhausted',
           'retained_terminal_dispatch_attempts_exhausted'
         )
         AND outbox.event_type='email.send_requested'
         AND (email.status<>'failed' OR delivery.state IN (
           'pending','deferred_quiet_hours','deferred_focus','queued','retry_pending'
         ))
       UNION ALL
       SELECT 'sms'::TEXT,sms.notification_id,sms.id,outbox.error_message
       FROM outbox_events outbox
       JOIN sms_outbox sms
         ON sms.id::TEXT=COALESCE(outbox.payload->>'smsId',
           CASE WHEN outbox.aggregate_type='sms' THEN outbox.aggregate_id::TEXT END)
       LEFT JOIN notification_deliveries delivery
         ON delivery.notification_id=sms.notification_id AND delivery.channel='sms'
       WHERE outbox.status='failed'
         AND outbox.error_message IN (
           'pre_provider_dispatch_attempts_exhausted',
           'retained_terminal_dispatch_attempts_exhausted'
         )
         AND outbox.event_type='sms.send_requested'
         AND (sms.status<>'failed' OR delivery.state IN (
           'pending','deferred_quiet_hours','deferred_focus','queued','retry_pending'
         ))
     ) exhausted
     ORDER BY notification_id NULLS LAST,channel
     LIMIT $1`,
    [boundedLimit],
  );
  let reconciled = 0;
  for (const candidate of candidates.rows) {
    if (candidate.notification_id) {
      await markNotificationDeliveryFailure(
        candidate.notification_id,
        candidate.channel,
        candidate.error_message,
        null,
        undefined,
        null,
        true,
      );
      reconciled += 1;
      continue;
    }
    if (!candidate.channel_outbox_id || candidate.channel === 'push') continue;
    const table = candidate.channel === 'email' ? 'email_outbox' : 'sms_outbox';
    const errorColumn = candidate.channel === 'email' ? 'last_error' : 'error_message';
    const updated = await db.query(
      `UPDATE ${table}
       SET status='failed',${errorColumn}=$2,updated_at=NOW()
       WHERE id=$1 AND status IN ('pending','sending') AND provider_io_started_at IS NULL`,
      [candidate.channel_outbox_id, candidate.error_message],
    );
    if ((updated.rowCount ?? 0) > 0) reconciled += 1;
  }
  return reconciled;
}

/**
 * Recover channel workers that crashed after a durable local claim but before
 * recording provider I/O. Once provider_io_started_at is set, recovery fails
 * closed and the provider-attempt reconciliation path owns the outcome.
 */
export async function recoverExpiredNotificationPreProviderClaims(limit = 100): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  return db.transaction(async (query) => {
    // Serialize with every aggregate-state mutation before taking the recovery
    // statement snapshot. This also establishes notification -> channel/outbox
    // lock ordering shared by claims, callbacks, and supersession.
    const lockedNotifications = await query<{ id: string }>(
      `WITH candidate_ids AS MATERIALIZED (
         SELECT aggregate_id AS notification_id FROM (
           SELECT outbox.aggregate_id,outbox.pre_provider_claim_deadline_at,outbox.id
           FROM outbox_events outbox
           LEFT JOIN notification_deliveries delivery
             ON delivery.notification_id=outbox.aggregate_id AND delivery.channel='push'
           WHERE outbox.event_type='push.send_requested'
             AND outbox.aggregate_type='push'
             AND outbox.status='processing'
             AND outbox.provider_io_started_at IS NULL
             AND outbox.pre_provider_claim_deadline_at <= NOW()
             AND (delivery.state IS NULL OR delivery.state NOT IN ('provider_in_flight','provider_outcome_unknown'))
           ORDER BY outbox.pre_provider_claim_deadline_at,outbox.id
           LIMIT $1
         ) push
         UNION
         SELECT notification_id FROM (
           SELECT email.notification_id,email.pre_provider_claim_deadline_at,email.id
           FROM email_outbox email
           LEFT JOIN notification_deliveries delivery
             ON delivery.notification_id=email.notification_id AND delivery.channel='email'
           WHERE email.status='sending'
             AND email.provider_io_started_at IS NULL
             AND email.pre_provider_claim_deadline_at <= NOW()
             AND NULLIF(BTRIM(email.provider_msg_id),'') IS NULL
             AND email.notification_provider_attempt_id IS NULL
             AND (delivery.state IS NULL OR delivery.state NOT IN ('provider_in_flight','provider_outcome_unknown'))
           ORDER BY email.pre_provider_claim_deadline_at,email.id
           LIMIT $1
         ) email
         UNION
         SELECT notification_id FROM (
           SELECT sms.notification_id,sms.pre_provider_claim_deadline_at,sms.id
           FROM sms_outbox sms
           LEFT JOIN notification_deliveries delivery
             ON delivery.notification_id=sms.notification_id AND delivery.channel='sms'
           WHERE sms.status='sending'
             AND sms.provider_io_started_at IS NULL
             AND sms.pre_provider_claim_deadline_at <= NOW()
             AND COALESCE(
               NULLIF(BTRIM(sms.provider_message_id),''),
               NULLIF(BTRIM(sms.twilio_sid),'')
             ) IS NULL
             AND sms.notification_provider_attempt_id IS NULL
             AND (delivery.state IS NULL OR delivery.state NOT IN ('provider_in_flight','provider_outcome_unknown'))
           ORDER BY sms.pre_provider_claim_deadline_at,sms.id
           LIMIT $1
         ) sms
       )
       SELECT notification.id
       FROM notifications notification
       JOIN candidate_ids candidate ON candidate.notification_id=notification.id
       ORDER BY notification.id
       FOR UPDATE`,
      [boundedLimit],
    );
    const lockedNotificationIds = lockedNotifications.rows.map((row) => row.id);
    const result = await query<{ recovered: string | number }>(
     `WITH push_candidates AS MATERIALIZED (
       SELECT outbox.id,outbox.pre_provider_claim_id,delivery.id AS delivery_id,notification.id AS notification_id,
              delivery.state AS delivery_state,
              CASE
                WHEN notification.superseded_at IS NOT NULL THEN 'cancelled_superseded'
                ELSE 'suppressed'
              END AS terminal_delivery_state,
              (
                delivery.state IN ('pending','deferred_quiet_hours','queued','retry_pending')
                AND notification.superseded_at IS NULL
                AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
              ) AS rearmable,
              (
                delivery.state = 'deferred_focus'
                AND notification.superseded_at IS NULL
                AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
              ) AS deferred
       FROM outbox_events outbox
       LEFT JOIN notification_deliveries delivery
         ON delivery.notification_id = outbox.aggregate_id
        AND delivery.channel = 'push'
       LEFT JOIN notifications notification ON notification.id = outbox.aggregate_id
       WHERE outbox.event_type='push.send_requested'
         AND outbox.aggregate_type='push'
         AND outbox.status='processing'
         AND outbox.provider_io_started_at IS NULL
         AND outbox.pre_provider_claim_deadline_at <= NOW()
         AND (delivery.state IS NULL OR delivery.state NOT IN ('provider_in_flight','provider_outcome_unknown'))
         AND (outbox.aggregate_id=ANY($2::UUID[]) OR notification.id IS NULL)
       ORDER BY outbox.pre_provider_claim_deadline_at,outbox.id
       LIMIT $1
       FOR UPDATE OF outbox SKIP LOCKED
     ), recovered_push AS (
       UPDATE outbox_events outbox
       SET status=CASE WHEN candidate.rearmable OR candidate.deferred THEN 'pending' ELSE 'processed' END,
           available_at=CASE WHEN candidate.deferred THEN 'infinity'::TIMESTAMPTZ ELSE NOW() END,
           processed_at=CASE WHEN candidate.rearmable OR candidate.deferred THEN NULL ELSE COALESCE(outbox.processed_at,NOW()) END,
           error_message=CASE
             WHEN candidate.deferred THEN 'pre_provider_claim_deferred_focus'
             WHEN candidate.rearmable THEN 'pre_provider_claim_expired'
             ELSE 'pre_provider_claim_terminal'
           END,
           bullmq_job_id=NULL,dispatch_attempt_id=NULL,dispatch_claimed_at=NULL,dispatch_deadline_at=NULL,
           pre_provider_claim_id=NULL,pre_provider_claimed_at=NULL,pre_provider_claim_deadline_at=NULL,
           updated_at=NOW()
       FROM push_candidates candidate
       WHERE outbox.id=candidate.id AND outbox.status='processing'
         AND outbox.pre_provider_claim_id=candidate.pre_provider_claim_id
         AND outbox.provider_io_started_at IS NULL
       RETURNING outbox.id
     ), email_candidates AS MATERIALIZED (
       SELECT email.id,email.lead_id,email.pre_provider_claim_id,
              delivery.id AS delivery_id,notification.id AS notification_id,
              delivery.state AS delivery_state,
              CASE
                WHEN notification.superseded_at IS NOT NULL THEN 'cancelled_superseded'
                ELSE 'suppressed'
              END AS terminal_delivery_state,
              (
                email.notification_id IS NULL
                OR (
                  delivery.state IN ('pending','deferred_quiet_hours','queued','retry_pending')
                  AND notification.superseded_at IS NULL
                  AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
                )
              ) AS rearmable,
              (
                delivery.state = 'deferred_focus'
                AND notification.superseded_at IS NULL
                AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
              ) AS deferred
       FROM email_outbox email
       LEFT JOIN notification_deliveries delivery
         ON delivery.notification_id=email.notification_id AND delivery.channel='email'
       LEFT JOIN notifications notification ON notification.id=email.notification_id
       WHERE email.status='sending' AND email.provider_io_started_at IS NULL
         AND email.pre_provider_claim_deadline_at <= NOW()
         AND NULLIF(BTRIM(email.provider_msg_id),'') IS NULL
         AND email.notification_provider_attempt_id IS NULL
         AND (delivery.state IS NULL OR delivery.state NOT IN ('provider_in_flight','provider_outcome_unknown'))
         AND (email.notification_id=ANY($2::UUID[]) OR notification.id IS NULL)
       ORDER BY email.pre_provider_claim_deadline_at,email.id
       LIMIT $1
       FOR UPDATE OF email SKIP LOCKED
     ), recovered_email AS (
       UPDATE email_outbox email
       SET status=CASE
             WHEN candidate.rearmable OR candidate.deferred THEN 'pending'
             WHEN candidate.delivery_state IN ('provider_accepted','delivered') THEN 'sent'
             ELSE 'suppressed'
           END,
           attempts=GREATEST(attempts-1,0),
           available_at=CASE WHEN candidate.deferred THEN 'infinity'::TIMESTAMPTZ ELSE NOW() END,
           sent_at=CASE
             WHEN candidate.delivery_state IN ('provider_accepted','delivered') THEN COALESCE(sent_at,NOW())
             ELSE sent_at
           END,
           last_error=CASE
             WHEN candidate.deferred THEN 'pre_provider_claim_deferred_focus'
             WHEN candidate.rearmable THEN 'pre_provider_claim_expired'
             WHEN candidate.delivery_state IN ('provider_accepted','delivered') THEN last_error
             ELSE 'pre_provider_claim_terminal'
           END,
           suppressed_reason=CASE
             WHEN candidate.delivery_state IN ('provider_accepted','delivered') THEN NULL
             WHEN candidate.rearmable OR candidate.deferred THEN suppressed_reason
             ELSE 'notification_not_sendable'
           END,
           suppressed_at=CASE
             WHEN candidate.delivery_state IN ('provider_accepted','delivered') THEN NULL
             WHEN candidate.rearmable OR candidate.deferred THEN suppressed_at
             ELSE COALESCE(suppressed_at,NOW())
           END,
           pre_provider_claim_id=NULL,
           pre_provider_claimed_at=NULL,pre_provider_claim_deadline_at=NULL,updated_at=NOW()
       FROM email_candidates candidate WHERE email.id=candidate.id
         AND email.pre_provider_claim_id=candidate.pre_provider_claim_id
         AND email.provider_io_started_at IS NULL
       RETURNING email.id,email.lead_id,email.idempotency_key,candidate.rearmable,candidate.deferred
     ), email_events AS (
       UPDATE outbox_events outbox
       SET status=CASE WHEN email.rearmable OR email.deferred THEN 'pending' ELSE 'processed' END,
           available_at=CASE WHEN email.deferred THEN 'infinity'::TIMESTAMPTZ ELSE NOW() END,
           processed_at=CASE WHEN email.rearmable OR email.deferred THEN NULL ELSE COALESCE(outbox.processed_at,NOW()) END,
           error_message=CASE
             WHEN email.deferred THEN 'pre_provider_claim_deferred_focus'
             WHEN email.rearmable THEN 'pre_provider_claim_expired'
             ELSE 'pre_provider_claim_terminal'
           END,
           bullmq_job_id=NULL,dispatch_attempt_id=NULL,dispatch_claimed_at=NULL,dispatch_deadline_at=NULL,
           updated_at=NOW()
       FROM recovered_email email
       WHERE outbox.idempotency_key=email.idempotency_key
         AND outbox.event_type='email.send_requested'
         AND (
           (outbox.aggregate_type='email' AND outbox.aggregate_id=email.id)
           OR (
             outbox.aggregate_type='lead'
             AND email.lead_id IS NOT NULL
             AND outbox.aggregate_id=email.lead_id
             AND outbox.payload->>'emailId'=email.id::TEXT
           )
         )
       RETURNING outbox.id
     ), sms_candidates AS MATERIALIZED (
       SELECT sms.id,sms.pre_provider_claim_id,
              delivery.id AS delivery_id,notification.id AS notification_id,
              delivery.state AS delivery_state,
              CASE
                WHEN notification.superseded_at IS NOT NULL THEN 'cancelled_superseded'
                ELSE 'suppressed'
              END AS terminal_delivery_state,
              (
                sms.notification_id IS NULL
                OR (
                  delivery.state IN ('pending','deferred_quiet_hours','queued','retry_pending')
                  AND notification.superseded_at IS NULL
                  AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
                )
              ) AS rearmable,
              (
                delivery.state = 'deferred_focus'
                AND notification.superseded_at IS NULL
                AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
              ) AS deferred
       FROM sms_outbox sms
       LEFT JOIN notification_deliveries delivery
         ON delivery.notification_id=sms.notification_id AND delivery.channel='sms'
       LEFT JOIN notifications notification ON notification.id=sms.notification_id
       WHERE sms.status='sending' AND sms.provider_io_started_at IS NULL
         AND sms.pre_provider_claim_deadline_at <= NOW()
         AND COALESCE(
           NULLIF(BTRIM(sms.provider_message_id),''),
           NULLIF(BTRIM(sms.twilio_sid),'')
         ) IS NULL
         AND sms.notification_provider_attempt_id IS NULL
         AND (delivery.state IS NULL OR delivery.state NOT IN ('provider_in_flight','provider_outcome_unknown'))
         AND (sms.notification_id=ANY($2::UUID[]) OR notification.id IS NULL)
       ORDER BY sms.pre_provider_claim_deadline_at,sms.id
       LIMIT $1
       FOR UPDATE OF sms SKIP LOCKED
     ), recovered_sms AS (
       UPDATE sms_outbox sms
       SET status=CASE
             WHEN candidate.rearmable OR candidate.deferred THEN 'pending'
             WHEN candidate.delivery_state IN ('provider_accepted','delivered') THEN 'sent'
             ELSE 'suppressed'
           END,
           retry_count=GREATEST(retry_count-1,0),
           available_at=CASE WHEN candidate.deferred THEN 'infinity'::TIMESTAMPTZ ELSE NOW() END,
           sent_at=CASE
             WHEN candidate.delivery_state IN ('provider_accepted','delivered') THEN COALESCE(sent_at,NOW())
             ELSE sent_at
           END,
           error_message=CASE
             WHEN candidate.deferred THEN 'pre_provider_claim_deferred_focus'
             WHEN candidate.rearmable THEN 'pre_provider_claim_expired'
             WHEN candidate.delivery_state IN ('provider_accepted','delivered') THEN error_message
             ELSE 'pre_provider_claim_terminal'
           END,
           pre_provider_claim_id=NULL,
           pre_provider_claimed_at=NULL,pre_provider_claim_deadline_at=NULL,updated_at=NOW()
       FROM sms_candidates candidate WHERE sms.id=candidate.id
         AND sms.pre_provider_claim_id=candidate.pre_provider_claim_id
         AND sms.provider_io_started_at IS NULL
       RETURNING sms.id,sms.idempotency_key,candidate.rearmable,candidate.deferred
     ), sms_events AS (
       UPDATE outbox_events outbox
       SET status=CASE WHEN sms.rearmable OR sms.deferred THEN 'pending' ELSE 'processed' END,
           available_at=CASE WHEN sms.deferred THEN 'infinity'::TIMESTAMPTZ ELSE NOW() END,
           processed_at=CASE WHEN sms.rearmable OR sms.deferred THEN NULL ELSE COALESCE(outbox.processed_at,NOW()) END,
           error_message=CASE
             WHEN sms.deferred THEN 'pre_provider_claim_deferred_focus'
             WHEN sms.rearmable THEN 'pre_provider_claim_expired'
             ELSE 'pre_provider_claim_terminal'
           END,
           bullmq_job_id=NULL,dispatch_attempt_id=NULL,dispatch_claimed_at=NULL,dispatch_deadline_at=NULL,
           updated_at=NOW()
       FROM recovered_sms sms
       WHERE outbox.idempotency_key=sms.idempotency_key
         AND outbox.event_type='sms.send_requested'
         AND outbox.aggregate_type='sms'
         AND outbox.aggregate_id=sms.id
       RETURNING outbox.id
     ), terminal_push_delivery AS (
       UPDATE notification_deliveries delivery
       SET state=candidate.terminal_delivery_state,
           next_retry_at=NULL,
           last_error='pre_provider_claim_terminal',
           updated_at=NOW()
       FROM push_candidates candidate
       WHERE delivery.id=candidate.delivery_id
         AND NOT candidate.rearmable
         AND NOT candidate.deferred
         AND delivery.state IN ('pending','deferred_quiet_hours','queued','retry_pending')
       RETURNING delivery.notification_id,delivery.channel,delivery.state
     ), terminal_email_delivery AS (
       UPDATE notification_deliveries delivery
       SET state=candidate.terminal_delivery_state,
           next_retry_at=NULL,
           last_error='pre_provider_claim_terminal',
           updated_at=NOW()
       FROM email_candidates candidate
       WHERE delivery.id=candidate.delivery_id
         AND NOT candidate.rearmable
         AND NOT candidate.deferred
         AND delivery.state IN ('pending','deferred_quiet_hours','queued','retry_pending')
       RETURNING delivery.notification_id,delivery.channel,delivery.state
     ), terminal_sms_delivery AS (
       UPDATE notification_deliveries delivery
       SET state=candidate.terminal_delivery_state,
           next_retry_at=NULL,
           last_error='pre_provider_claim_terminal',
           updated_at=NOW()
       FROM sms_candidates candidate
       WHERE delivery.id=candidate.delivery_id
         AND NOT candidate.rearmable
         AND NOT candidate.deferred
         AND delivery.state IN ('pending','deferred_quiet_hours','queued','retry_pending')
       RETURNING delivery.notification_id,delivery.channel,delivery.state
     ), terminal_states AS MATERIALIZED (
       SELECT notification_id,channel,state FROM terminal_push_delivery
       UNION ALL SELECT notification_id,channel,state FROM terminal_email_delivery
       UNION ALL SELECT notification_id,channel,state FROM terminal_sms_delivery
     ), affected_notifications AS MATERIALIZED (
       SELECT DISTINCT notification_id FROM terminal_states
     ), ranked AS MATERIALIZED (
       SELECT terminal.notification_id,terminal.state FROM terminal_states terminal
       UNION ALL
       SELECT delivery.notification_id,delivery.state
       FROM notification_deliveries delivery
       JOIN affected_notifications affected ON affected.notification_id=delivery.notification_id
       WHERE delivery.channel<>'in_app'
         AND NOT EXISTS (
           SELECT 1 FROM terminal_states terminal
           WHERE terminal.notification_id=delivery.notification_id
             AND terminal.channel=delivery.channel
         )
     ), aggregate_terminal AS (
       UPDATE notifications notification
       SET delivery_state=CASE
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='delivered') THEN 'delivered'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='provider_accepted') THEN 'provider_accepted'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='provider_outcome_unknown') THEN 'provider_outcome_unknown'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='provider_in_flight') THEN 'provider_in_flight'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='failed_terminal') THEN 'failed_terminal'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='suppressed') THEN 'suppressed'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='retry_pending') THEN 'retry_pending'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='queued') THEN 'queued'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='deferred_focus') THEN 'deferred_focus'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='deferred_quiet_hours') THEN 'deferred_quiet_hours'
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='pending') THEN 'pending'
             ELSE 'cancelled_superseded'
           END,
           terminal_failure_at=CASE
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='failed_terminal')
               AND NOT EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state IN ('delivered','provider_accepted','provider_outcome_unknown','provider_in_flight'))
             THEN COALESCE(notification.terminal_failure_at,(
               SELECT MAX(delivery.terminal_failure_at) FROM notification_deliveries delivery
               WHERE delivery.notification_id=notification.id AND delivery.state='failed_terminal'
             )) ELSE NULL END,
           terminal_failure_reason=CASE
             WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state='failed_terminal')
               AND NOT EXISTS (SELECT 1 FROM ranked WHERE ranked.notification_id=notification.id AND ranked.state IN ('delivered','provider_accepted','provider_outcome_unknown','provider_in_flight'))
             THEN COALESCE(notification.terminal_failure_reason,(
               SELECT MAX(delivery.last_error) FROM notification_deliveries delivery
               WHERE delivery.notification_id=notification.id AND delivery.state='failed_terminal'
             )) ELSE NULL END,
           updated_at=NOW()
       FROM affected_notifications affected
       WHERE notification.id=affected.notification_id
       RETURNING notification.id
     )
     SELECT (
       (SELECT COUNT(*) FROM recovered_push)
       +(SELECT COUNT(*) FROM recovered_email)
       +(SELECT COUNT(*) FROM recovered_sms)
     )::TEXT AS recovered`,
     [boundedLimit, lockedNotificationIds],
    );
    const recovered = Number(result.rows[0]?.recovered ?? 0);
    return Number.isSafeInteger(recovered) && recovered >= 0 ? recovered : 0;
  });
}

/**
 * Bound the indeterminate crash window without risking a duplicate send. An
 * expired provider claim becomes explicit operator/reconciliation work; it is
 * never converted back to retry_pending automatically.
 */
export async function promoteExpiredNotificationProviderClaims(
  limit = 100,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const candidates = await db.query<{
    notification_id: string;
    channel: ExternalNotificationChannel;
    provider_attempt_id: string;
  }>(
    `SELECT delivery.notification_id,delivery.channel,delivery.provider_attempt_id
     FROM notification_deliveries delivery
     WHERE delivery.state='provider_in_flight'
       AND delivery.channel IN ('email','push','sms')
       AND delivery.provider_attempt_deadline_at <= NOW()
       AND delivery.provider_attempt_id IS NOT NULL
     ORDER BY delivery.provider_attempt_deadline_at,delivery.notification_id,delivery.channel
     LIMIT $1`,
    [boundedLimit],
  );
  let promoted = 0;
  for (const candidate of candidates.rows) {
    const changed = await markNotificationProviderOutcomeUnknown(
      candidate.notification_id,
      candidate.channel,
      'provider_attempt_deadline_exceeded',
      candidate.provider_attempt_id,
    );
    if (changed) promoted += 1;
  }
  return promoted;
}

/**
 * Direct/lead messages do not have a notification_deliveries row, but they do
 * cross the same external provider boundary.  The durable channel token and
 * deadline therefore become the reconciliation authority after a worker crash.
 * Expiry is never an automatic retry: a provider may have accepted the send.
 */
export async function promoteExpiredDirectProviderClaims(limit = 100): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const result = await db.transaction(async (query) => query<{ promoted: string | number }>(
    `WITH email_candidates AS MATERIALIZED (
       SELECT email.id,email.idempotency_key,email.notification_provider_attempt_id
       FROM email_outbox email
       WHERE email.notification_id IS NULL
         AND email.status='sending'
         AND email.provider_io_started_at IS NOT NULL
         AND email.notification_provider_attempt_id IS NOT NULL
         AND email.pre_provider_claim_deadline_at <= NOW()
         AND NULLIF(BTRIM(email.provider_msg_id),'') IS NULL
       ORDER BY email.pre_provider_claim_deadline_at,email.id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ), unknown_email AS (
       UPDATE email_outbox email
       SET status='provider_outcome_unknown',
           last_error='provider_attempt_deadline_exceeded',
           updated_at=NOW()
       FROM email_candidates candidate
       WHERE email.id=candidate.id
         AND email.status='sending'
         AND email.notification_provider_attempt_id=candidate.notification_provider_attempt_id
         AND email.provider_io_started_at IS NOT NULL
       RETURNING email.id,email.idempotency_key
     ), closed_email_events AS (
       UPDATE outbox_events outbox
       SET status='processed',processed_at=COALESCE(processed_at,NOW()),
           error_message='provider_outcome_unknown',updated_at=NOW()
       FROM unknown_email email
       WHERE outbox.idempotency_key=email.idempotency_key
         AND outbox.event_type='email.send_requested'
         AND outbox.status IN ('enqueued','processing')
       RETURNING outbox.id
     ), sms_candidates AS MATERIALIZED (
       SELECT sms.id,sms.idempotency_key,sms.notification_provider_attempt_id
       FROM sms_outbox sms
       WHERE sms.notification_id IS NULL
         AND sms.status='sending'
         AND sms.provider_io_started_at IS NOT NULL
         AND sms.notification_provider_attempt_id IS NOT NULL
         AND sms.pre_provider_claim_deadline_at <= NOW()
         AND COALESCE(NULLIF(BTRIM(sms.provider_message_id),''),NULLIF(BTRIM(sms.twilio_sid),'')) IS NULL
       ORDER BY sms.pre_provider_claim_deadline_at,sms.id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ), unknown_sms AS (
       UPDATE sms_outbox sms
       SET status='provider_outcome_unknown',
           error_message='provider_attempt_deadline_exceeded',
           updated_at=NOW()
       FROM sms_candidates candidate
       WHERE sms.id=candidate.id
         AND sms.status='sending'
         AND sms.notification_provider_attempt_id=candidate.notification_provider_attempt_id
         AND sms.provider_io_started_at IS NOT NULL
       RETURNING sms.id,sms.idempotency_key
     ), closed_sms_events AS (
       UPDATE outbox_events outbox
       SET status='processed',processed_at=COALESCE(processed_at,NOW()),
           error_message='provider_outcome_unknown',updated_at=NOW()
       FROM unknown_sms sms
       WHERE outbox.idempotency_key=sms.idempotency_key
         AND outbox.event_type='sms.send_requested'
         AND outbox.aggregate_type='sms'
         AND outbox.aggregate_id=sms.id
         AND outbox.status IN ('enqueued','processing')
       RETURNING outbox.id
     )
     SELECT ((SELECT COUNT(*) FROM unknown_email)+(SELECT COUNT(*) FROM unknown_sms))::TEXT AS promoted`,
    [boundedLimit],
  ));
  const promoted = Number(result.rows[0]?.promoted ?? 0);
  return Number.isSafeInteger(promoted) && promoted >= 0 ? promoted : 0;
}

/**
 * Atomically lease due recovery rows. Existing channel/outbox work is
 * deliberately eligible: provider failures durably re-arm that work for the
 * same due time, and retryDelivery converges on its deterministic keys. A
 * claimed retry has a null retry time and a fresh update time, so overlapping
 * invocations skip it. An abandoned claim becomes eligible after the bounded
 * stale-claim interval.
 */
export async function claimDueNotificationDeliveries(
  limit = 100,
): Promise<RecoveryCandidate[]> {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const candidates = await db.query<RecoveryCandidate>(
    `WITH candidates AS MATERIALIZED (
       SELECT delivery.id
       FROM notification_deliveries delivery
       JOIN notifications notification ON notification.id = delivery.notification_id
       WHERE delivery.state = 'retry_pending'
         AND delivery.channel IN ('email','push','sms')
         AND (
           delivery.next_retry_at <= NOW()
           OR (
             delivery.next_retry_at IS NULL
             AND (
               delivery.recovery_claim_deadline_at <= NOW()
               OR (
                 delivery.recovery_claim_id IS NULL
                 AND delivery.updated_at <= NOW() - make_interval(secs => $2::INTEGER)
               )
             )
           )
         )
         AND delivery.available_at <= NOW()
         AND notification.superseded_at IS NULL
         AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
       ORDER BY delivery.next_retry_at, delivery.notification_id, delivery.channel
       LIMIT $1
       FOR UPDATE OF delivery SKIP LOCKED
     ), claimed AS (
       UPDATE notification_deliveries delivery
       SET next_retry_at = NULL,
           recovery_claim_id = gen_random_uuid(),
           recovery_claimed_at = NOW(),
           recovery_claim_deadline_at = NOW() + make_interval(secs => $2::INTEGER),
           updated_at = NOW()
       FROM candidates
       WHERE delivery.id = candidates.id
         AND delivery.state = 'retry_pending'
         AND (
           delivery.next_retry_at <= NOW()
           OR (
             delivery.next_retry_at IS NULL
             AND (
               delivery.recovery_claim_deadline_at <= NOW()
               OR (
                 delivery.recovery_claim_id IS NULL
                 AND delivery.updated_at <= NOW() - make_interval(secs => $2::INTEGER)
               )
             )
           )
         )
       RETURNING delivery.notification_id, delivery.channel, delivery.recovery_claim_id
     )
     SELECT notification_id, channel, recovery_claim_id FROM claimed
     ORDER BY notification_id, channel`,
    [boundedLimit, RECOVERY_CLAIM_LEASE_SECONDS],
  );
  return candidates.rows;
}

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
    const reconciledReceipts = await reconcileNotificationProviderReceipts(limit);
    if (reconciledReceipts > 0) {
      log.info({ reconciledReceipts }, 'Notification provider receipts reconciled');
    }
    const preProviderRecovered = await recoverExpiredNotificationPreProviderClaims(limit);
    if (preProviderRecovered > 0) {
      log.warn({ preProviderRecovered }, 'Expired pre-provider claims rearmed');
    }
    const exhaustedDispatches = await reconcileExhaustedNotificationDispatches(limit);
    if (exhaustedDispatches > 0) {
      log.error({ exhaustedDispatches }, 'Exhausted notification dispatches terminalized');
    }
    const outcomeUnknown = await promoteExpiredNotificationProviderClaims(limit);
    if (outcomeUnknown > 0) {
      log.warn({ outcomeUnknown }, 'Expired provider claims require reconciliation');
    }
    const directOutcomeUnknown = await promoteExpiredDirectProviderClaims(limit);
    if (directOutcomeUnknown > 0) {
      log.warn({ directOutcomeUnknown }, 'Expired direct provider claims require reconciliation');
    }
    const terminalOutboxReconciled = await reconcileTerminalNotificationOutboxEvents(limit);
    if (terminalOutboxReconciled > 0) {
      log.info({ terminalOutboxReconciled }, 'Terminal notification outbox work reconciled');
    }
    const candidates = await claimDueNotificationDeliveries(limit);

    const result: NotificationDeliveryRecoveryResult = {
      inspected: candidates.length,
      recovered: 0,
      failed: 0,
      skipped: 0,
    };

    for (const candidate of candidates) {
      let retry;
      try {
        retry = await NotificationService.retryDelivery(
          candidate.notification_id,
          candidate.channel,
          candidate.recovery_claim_id,
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
          null,
          undefined,
          candidate.recovery_claim_id,
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
