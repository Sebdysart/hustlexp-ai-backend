/**
 * Push Worker v1.0.0
 *
 * SYSTEM GUARANTEES: Asynchronous Push Notification Delivery with FCM
 *
 * Processes outbox_events with push event types via BullMQ.
 * Sends push notifications via PushNotificationService.
 *
 * Pattern:
 * 1. Job processor receives push job (from outbox_events table)
 * 2. Send push notification via FCM (PushNotificationService)
 * 3. Mark outbox event as processed or failed
 *
 * Hard rule: Push send is never inline on request paths - always async
 *
 * @see ARCHITECTURE.md (Outbox pattern)
 * @see email-worker.ts (sibling worker for email channel)
 */

import { db } from '../db.js';
import { sendPushNotification } from '../services/PushNotificationService.js';
import { markOutboxEventProcessed, markOutboxEventFailed } from './outbox-worker.js';
import { workerLogger } from '../logger.js';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  authorizeNotificationDelivery,
  claimNotificationDelivery,
  markNotificationCancelled,
  markNotificationDeliveryFailure,
  markNotificationProviderOutcomeUnknown,
  markNotificationProviderAccepted,
  markNotificationSuppressed,
} from '../services/NotificationDeliveryState.js';

const log = workerLogger.child({ worker: 'push' });

// ============================================================================
// TYPES
// ============================================================================

interface PushJobData {
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  outbox_idempotency_key?: string;
  outbox_dispatch_attempt_id: string;
  outbox_bullmq_job_id: string;
  payload: {
    notificationId: string;
    userId: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  };
}

type CanonicalPushEvent = {
  id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_version: number;
  idempotency_key: string;
  payload: PushJobData['payload'];
  dispatch_attempt_id: string;
  bullmq_job_id: string;
};

const PRE_PROVIDER_LEASE_SECONDS = 300;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// ============================================================================
// PUSH WORKER
// ============================================================================

/**
 * Process push notification job
 * Should be called by BullMQ worker processor
 *
 * @param job BullMQ job containing push notification data
 */
export async function processPushJob(job: Job<PushJobData>): Promise<void> {
  const hintedNotificationId = job.data.payload.notificationId;
  const idempotencyKey = job.data.outbox_idempotency_key
    || (job.id && !job.id.includes(':dispatch:') ? job.id : null);
  if (!idempotencyKey) throw new Error('Push job lacks durable outbox identity');

  const canonicalResult = await db.query<CanonicalPushEvent>(
    `SELECT id,aggregate_id,aggregate_type,event_version,idempotency_key,payload,
            dispatch_attempt_id,bullmq_job_id
     FROM outbox_events
     WHERE idempotency_key=$1
       AND event_type='push.send_requested'
       AND aggregate_type='push'`,
    [idempotencyKey],
  );
  const canonical = canonicalResult.rows[0];
  if (
    !canonical
    || canonical.aggregate_id !== hintedNotificationId
    || job.data.aggregate_id !== canonical.aggregate_id
    || job.data.aggregate_type !== canonical.aggregate_type
    || job.data.event_version !== canonical.event_version
    || job.data.outbox_idempotency_key !== canonical.idempotency_key
    || !canonical.dispatch_attempt_id
    || !canonical.bullmq_job_id
    || job.data.outbox_dispatch_attempt_id !== canonical.dispatch_attempt_id
    || job.data.outbox_bullmq_job_id !== canonical.bullmq_job_id
    || job.id !== canonical.bullmq_job_id
    || stableJson(job.data.payload) !== stableJson(canonical.payload)
  ) {
    throw new Error('Push job does not match canonical outbox authority');
  }

  const { notificationId, userId, title, body, data } = canonical.payload;
  let providerClaimToken: string | null = null;
  const preProviderClaimToken = randomUUID();
  const dispatchAuthority = {
    dispatchAttemptId: canonical.dispatch_attempt_id,
    bullmqJobId: canonical.bullmq_job_id,
  };

  try {
    // Structured log: job started
    log.info({ notificationId, jobId: job.id, idempotencyKey, userId }, 'Push job started');

    const authorization = await authorizeNotificationDelivery(notificationId, 'push');
    if (!authorization.allowed) {
      if (authorization.reason === 'not_due') {
        await markOutboxEventFailed(idempotencyKey, 'notification_not_due', dispatchAuthority);
        return;
      }
      if (authorization.reason === 'superseded' || authorization.reason === 'cancelled_superseded') {
        await markNotificationCancelled(notificationId, 'push', authorization.reason);
      }
      if (
        authorization.reason === 'provider_in_flight'
        || authorization.reason === 'provider_outcome_unknown'
      ) {
        // The original provider claimant still owns (or may have completed)
        // the external call. A duplicate BullMQ job must not assert that the
        // immutable outbox work is processed while that truth is unresolved.
        return;
      }
      if (['superseded', 'cancelled_superseded', 'provider_accepted', 'delivered', 'suppressed', 'failed_terminal'].includes(authorization.reason)) {
        await markOutboxEventProcessed(idempotencyKey, dispatchAuthority);
        return;
      }
      throw new Error(`Push delivery refused: ${authorization.reason}`);
    }

    // W-20 FIX: Atomic claim before FCM call to prevent concurrent workers from
    // both passing the idempotency check and both sending the push notification.
    // The prior SELECT→FCM pattern had a race: two workers could both read status
    // != 'processed', both call FCM, causing double-send.
    // Atomic UPDATE: only the worker that transitions the row wins the race.
    //
    // W-26 FIX: Also reclaim rows stuck in 'processing' for more than 5 minutes.
    // Without this clause, a process crash between claim and FCM leaves the row
    // permanently in 'processing', causing BullMQ retries to exit early (0 rows
    // claimed) and silently drop the notification forever.
    const claimResult = await db.query<{ id: string }>(
      `UPDATE outbox_events
       SET status = 'processing',
           pre_provider_claim_id = $2::UUID,
           pre_provider_claimed_at = NOW(),
           pre_provider_claim_deadline_at = NOW() + make_interval(secs => $3::INTEGER),
           provider_io_started_at = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND dispatch_attempt_id=$4::UUID
         AND bullmq_job_id=$5
         AND (
           status = 'enqueued'
           OR (
             status = 'processing'
             AND provider_io_started_at IS NULL
             AND (
               pre_provider_claim_deadline_at <= NOW()
               OR (pre_provider_claim_deadline_at IS NULL AND updated_at < NOW() - INTERVAL '5 minutes')
             )
           )
         )
       RETURNING id`,
      [
        canonical.id,
        preProviderClaimToken,
        PRE_PROVIDER_LEASE_SECONDS,
        dispatchAuthority.dispatchAttemptId,
        dispatchAuthority.bullmqJobId,
      ]
    );

    if (claimResult.rowCount === 0) {
      // Row is already processing or processed by another worker — skip
      log.info({ notificationId, jobId: job.id, idempotencyKey }, 'Push job already claimed or processed by another worker, skipping');
      return;
    }

    const providerClaim = await db.transaction(async (query) => {
      await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
      const owned = await query<{ id: string }>(
        `UPDATE outbox_events
         SET pre_provider_claim_deadline_at=NOW()+make_interval(secs => $3::INTEGER),updated_at=NOW()
         WHERE id=$1 AND status='processing'
           AND pre_provider_claim_id=$2::UUID
           AND provider_io_started_at IS NULL
           AND pre_provider_claim_deadline_at > NOW()
         RETURNING id`,
        [canonical.id, preProviderClaimToken, PRE_PROVIDER_LEASE_SECONDS],
      );
      if (!owned.rows[0]) return { allowed: false as const, reason: 'pre_provider_claim_lost' };
      const notificationClaim = await claimNotificationDelivery(
        notificationId,
        'push',
        undefined,
        query,
      );
      if (!notificationClaim.allowed) return notificationClaim;
      await query(
        `UPDATE outbox_events
         SET provider_io_started_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND pre_provider_claim_id=$2::UUID`,
        [canonical.id, preProviderClaimToken],
      );
      return notificationClaim;
    });
    if (!providerClaim.allowed) {
      if (providerClaim.reason === 'not_due') {
        await markOutboxEventFailed(idempotencyKey, 'notification_not_due', dispatchAuthority);
        return;
      }
      if (
        providerClaim.reason === 'superseded'
        || providerClaim.reason === 'cancelled_superseded'
      ) {
        await markNotificationCancelled(notificationId, 'push', providerClaim.reason);
      }
      if (
        [
          'superseded',
          'cancelled_superseded',
          'provider_in_flight',
          'provider_outcome_unknown',
          'provider_accepted',
          'delivered',
          'suppressed',
          'failed_terminal',
        ].includes(providerClaim.reason)
      ) {
        // Another exact provider claim may still be running. Its callback owns
        // the immutable outbox transition; this lease loser must not mark it
        // processed or suppressed.
        return;
      }
      if (providerClaim.reason === 'pre_provider_claim_lost' || providerClaim.reason === 'claim_lost') {
        return;
      }
      throw new Error(`Push delivery claim refused: ${providerClaim.reason}`);
    }
    providerClaimToken = providerClaim.claimToken;

    // Send push notification via PushNotificationService
    const result = await sendPushNotification(userId, title, body, data);

    if (result.reason === 'no_active_device') {
      await markNotificationSuppressed(
        notificationId,
        'push',
        'no_active_device',
        providerClaimToken,
      );
    } else if (!result.success) {
      if (result.reason === 'provider_unconfigured') {
        await db.transaction(async (query) => {
          await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
          await markNotificationDeliveryFailure(
            notificationId,
            'push',
            'Push provider unconfigured before I/O',
            providerClaimToken,
            query,
          );
        });
        providerClaimToken = null;
        return;
      }
      throw new Error(`Push provider failed: ${result.reason ?? 'unknown_provider_error'}`);
    } else {
      // FCM multicast acceptance is provider acceptance, not device delivery.
      await markNotificationProviderAccepted(
        notificationId,
        'push',
        'fcm',
        null,
        providerClaimToken,
      );
    }

    // Structured log: push result
    log.info({ notificationId, jobId: job.id, idempotencyKey, userId, sent: result.sent, failed: result.failed, success: result.success }, 'Push job completed');

    // Mark outbox event as processed
    await markOutboxEventProcessed(idempotencyKey, dispatchAuthority);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Structured log: error occurred
    log.error({ notificationId, jobId: job.id, idempotencyKey, userId, err: errorMessage }, 'Push job error');

    if (providerClaimToken) {
      await db.transaction(async (query) => {
        await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
        const changed = await markNotificationProviderOutcomeUnknown(
          notificationId,
          'push',
          errorMessage,
          providerClaimToken!,
          query,
        );
        if (changed) {
          await markOutboxEventProcessed(idempotencyKey, dispatchAuthority, { query });
        }
      });
      return;
    }

    // Failures before a provider claim are known not to have created an
    // external effect and may follow the bounded durable retry path.
    const retryOwned = await db.transaction(async (query) => {
      await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
      const owned = await query<{ id: string }>(
        `SELECT id FROM outbox_events
         WHERE id=$1
           AND dispatch_attempt_id=$2::UUID
           AND bullmq_job_id=$3
           AND provider_io_started_at IS NULL
           AND (
             (status='processing' AND pre_provider_claim_id=$4::UUID)
             OR (status='enqueued' AND pre_provider_claim_id IS NULL)
           )
         FOR UPDATE`,
        [
          canonical.id,
          dispatchAuthority.dispatchAttemptId,
          dispatchAuthority.bullmqJobId,
          preProviderClaimToken,
        ],
      );
      if (!owned.rows[0]) return false;
      await markNotificationDeliveryFailure(
        notificationId,
        'push',
        errorMessage,
        null,
        query,
      );
      return true;
    });
    if (!retryOwned) return;

    // Re-throw for BullMQ retry logic
    throw error;
  }
}
