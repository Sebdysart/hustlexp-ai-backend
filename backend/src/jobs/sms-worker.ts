/**
 * SMS Worker v1.0.0
 *
 * SYSTEM GUARANTEES: Asynchronous, provider-neutral SMS Delivery
 *
 * Processes sms_outbox table from BullMQ.
 * Sends SMS through the authorized outbound port with retries, backoff,
 * error handling, and nonproduction sink isolation.
 *
 * Pattern:
 * 1. Job processor receives SMS job (from sms_outbox table)
 * 2. Send SMS via the explicitly authorized SMS adapter
 * 3. Update sms_outbox table (status=sent, twilio_sid)
 * 4. Handle failures (mark failed with error_message, respect retry_count/max_retries)
 *
 * Hard rule: SMS send is never inline on request paths - always async
 *
 * @see ARCHITECTURE.md §2.6 (Notification Services)
 */

import { db } from '../db.js';
import { markOutboxEventProcessed, markOutboxEventFailed } from './outbox-worker.js';
import { workerLogger } from '../logger.js';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { createOutboundSmsPort } from '../services/OutboundCommunicationService.js';
import { authorizeNotificationDelivery, claimNotificationDelivery, markNotificationCancelled, markNotificationDeliveryFailure, markNotificationProviderAccepted, markNotificationProviderOutcomeUnknown } from '../services/NotificationDeliveryState.js';

const log = workerLogger.child({ worker: 'sms' });

// ============================================================================
// TYPES
// ============================================================================

interface SMSJobData {
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  outbox_idempotency_key?: string;
  outbox_dispatch_attempt_id: string;
  outbox_bullmq_job_id: string;
  payload: {
    smsId: string;
    notificationId?: string;
    userId?: string;
    toPhone: string;
    body: string;
  };
}

type CanonicalSmsAuthority = {
  id: string;
  user_id: string | null;
  to_phone: string;
  body: string;
  status: string;
  retry_count: number;
  max_retries: number;
  idempotency_key: string;
  notification_id: string | null;
  twilio_sid: string | null;
  provider_name: string | null;
  provider_message_id: string | null;
  notification_provider_attempt_id: string | null;
  pre_provider_claim_id: string | null;
  outbox_id: string;
  outbox_event_version: number;
  outbox_payload: SMSJobData['payload'];
  outbox_dispatch_attempt_id: string;
  outbox_bullmq_job_id: string;
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

function firstNonEmptyProviderMessageId(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return null;
}

// ============================================================================
// SMS WORKER
// ============================================================================

/**
 * Process SMS job
 * Should be called by BullMQ worker processor
 *
 * @param job BullMQ job containing SMS data
 */
export async function processSMSJob(job: Job<SMSJobData>): Promise<void> {
  const hintedSmsId = job.data.payload.smsId;
  const hintedOutboxKey = job.data.outbox_idempotency_key
    || (job.id && !job.id.includes(':dispatch:') ? job.id : null);
  if (!hintedOutboxKey) throw new Error('SMS job lacks durable outbox identity');
  const authorityResult = await db.query<CanonicalSmsAuthority>(
    `SELECT sms.id,sms.user_id,sms.to_phone,sms.body,sms.status,sms.retry_count,
            sms.max_retries,sms.idempotency_key,sms.notification_id,sms.twilio_sid,
            sms.provider_name,sms.provider_message_id,
            sms.notification_provider_attempt_id,sms.pre_provider_claim_id,
            outbox.id AS outbox_id,outbox.event_version AS outbox_event_version,
            outbox.payload AS outbox_payload,
            outbox.dispatch_attempt_id AS outbox_dispatch_attempt_id,
            outbox.bullmq_job_id AS outbox_bullmq_job_id
     FROM sms_outbox sms
     JOIN outbox_events outbox
       ON outbox.aggregate_id=sms.id
      AND outbox.idempotency_key=sms.idempotency_key
      AND outbox.event_type='sms.send_requested'
      AND outbox.aggregate_type='sms'
     WHERE sms.id=$1 AND outbox.idempotency_key=$2`,
    [hintedSmsId, hintedOutboxKey],
  );
  const authority = authorityResult.rows[0];
  const expectedPayload: SMSJobData['payload'] | null = authority
    ? {
        smsId: authority.id,
        ...(authority.notification_id ? { notificationId: authority.notification_id } : {}),
        ...(authority.user_id ? { userId: authority.user_id } : {}),
        toPhone: authority.to_phone,
        body: authority.body,
      }
    : null;
  if (
    !authority
    || job.data.aggregate_type !== 'sms'
    || job.data.aggregate_id !== authority.id
    || job.data.event_version !== authority.outbox_event_version
    || job.data.outbox_idempotency_key !== authority.idempotency_key
    || !authority.outbox_dispatch_attempt_id
    || !authority.outbox_bullmq_job_id
    || job.data.outbox_dispatch_attempt_id !== authority.outbox_dispatch_attempt_id
    || job.data.outbox_bullmq_job_id !== authority.outbox_bullmq_job_id
    || job.id !== authority.outbox_bullmq_job_id
    || stableJson(authority.outbox_payload) !== stableJson(expectedPayload)
    || stableJson(job.data.payload) !== stableJson(authority.outbox_payload)
  ) {
    throw new Error('SMS job does not match canonical outbox authority');
  }

  const smsId = authority.id;
  const notificationId = authority.notification_id;
  const jobIdempotencyKey = authority.idempotency_key;
  let providerClaimToken: string | null = null;
  const preProviderClaimToken = randomUUID();
  const directProviderAttemptToken = randomUUID();
  const dispatchAuthority = {
    dispatchAttemptId: authority.outbox_dispatch_attempt_id,
    bullmqJobId: authority.outbox_bullmq_job_id,
  };

  const reconcilePersistedReceipt = async (
    record: CanonicalSmsAuthority,
  ): Promise<boolean> => {
    const providerMessageId = firstNonEmptyProviderMessageId(
      record.provider_message_id,
      record.twilio_sid,
    );
    if (!providerMessageId) return false;
    if (record.notification_id) {
      if (!record.notification_provider_attempt_id) return false;
      await markNotificationProviderAccepted(
        record.notification_id,
        'sms',
        record.provider_name || 'unknown',
        providerMessageId,
        record.notification_provider_attempt_id,
      );
    }
    const finalized = await db.query<{ id: string }>(
      `UPDATE sms_outbox sms
       SET status='sent',sent_at=COALESCE(sent_at,NOW()),updated_at=NOW()
       WHERE sms.id=$1
         AND COALESCE(
           NULLIF(BTRIM(sms.provider_message_id),''),
           NULLIF(BTRIM(sms.twilio_sid),'')
         )=$2
         AND sms.notification_provider_attempt_id IS NOT DISTINCT FROM $3::UUID
         AND (
           $4::UUID IS NULL
           OR EXISTS (
             SELECT 1 FROM notification_deliveries delivery
             WHERE delivery.notification_id=$4::UUID
               AND delivery.channel='sms'
               AND delivery.provider_attempt_id=$3::UUID
               AND delivery.state IN ('provider_accepted','delivered')
           )
         )
       RETURNING sms.id`,
      [
        record.id,
        providerMessageId,
        record.notification_provider_attempt_id,
        record.notification_id,
      ],
    );
    return Boolean(finalized.rows[0]);
  };

  try {
    const persistedProviderMessageId = firstNonEmptyProviderMessageId(
      authority.provider_message_id,
      authority.twilio_sid,
    );
    if (persistedProviderMessageId) {
      if (await reconcilePersistedReceipt(authority)) {
        await markOutboxEventProcessed(jobIdempotencyKey, dispatchAuthority);
      }
      return;
    }

    if (notificationId) {
      const authorization = await authorizeNotificationDelivery(notificationId, 'sms');
      if (!authorization.allowed) {
        if (authorization.reason === 'not_due') {
          await markOutboxEventFailed(jobIdempotencyKey, 'notification_not_due', dispatchAuthority);
          return;
        }
        if (authorization.reason === 'superseded' || authorization.reason === 'cancelled_superseded') {
          await markNotificationCancelled(notificationId, 'sms', authorization.reason);
        }
        if (
          authorization.reason === 'provider_in_flight'
          || authorization.reason === 'provider_outcome_unknown'
        ) {
          return;
        }
        if (['superseded', 'cancelled_superseded', 'provider_accepted', 'delivered', 'suppressed', 'failed_terminal'].includes(authorization.reason)) {
          await markOutboxEventProcessed(jobIdempotencyKey, dispatchAuthority);
          return;
        }
        throw new Error(`SMS delivery refused: ${authorization.reason}`);
      }
    }

    // Resolve authority before claiming the durable row. Existing Twilio
    // credentials alone cannot authorize a production message.
    const deliveryPort = createOutboundSmsPort();

    // Phase 1: Atomic claim inside a transaction
    // SELECT FOR UPDATE + all idempotency/crash-recovery checks + CAS UPDATE must be atomic.
    // The row lock is held for the entire transaction, preventing concurrent workers from
    // reading the same 'pending' status and both attempting to claim the same SMS.
    type SmsClaimResult = {
      smsRecord: CanonicalSmsAuthority;
      claimed: boolean;
      shouldReturn: boolean;
      outboxKey?: string;
    };

    const claimResult = await db.transaction(async (txQuery) => {
      // Get SMS record from sms_outbox table with FOR UPDATE lock (prevents concurrent processing)
      const smsResult = await txQuery<CanonicalSmsAuthority>(
        `SELECT sms.id,sms.user_id,sms.to_phone,sms.body,sms.status,sms.retry_count,
                sms.max_retries,sms.idempotency_key,sms.notification_id,sms.twilio_sid,
                sms.provider_name,sms.provider_message_id,sms.notification_provider_attempt_id,
                sms.pre_provider_claim_id,outbox.id::TEXT AS outbox_id,
                outbox.event_version AS outbox_event_version,outbox.payload AS outbox_payload,
                outbox.dispatch_attempt_id::TEXT AS outbox_dispatch_attempt_id,
                outbox.bullmq_job_id AS outbox_bullmq_job_id
         FROM sms_outbox sms
         JOIN outbox_events outbox
           ON outbox.idempotency_key=sms.idempotency_key
          AND outbox.event_type='sms.send_requested'
          AND outbox.aggregate_type='sms'
          AND outbox.aggregate_id=sms.id
         WHERE sms.id = $1
           AND outbox.idempotency_key=$2
           AND outbox.dispatch_attempt_id=$3::UUID
           AND outbox.bullmq_job_id=$4
         FOR UPDATE OF sms,outbox`,
        [
          smsId,
          jobIdempotencyKey,
          dispatchAuthority.dispatchAttemptId,
          dispatchAuthority.bullmqJobId,
        ]
      );

      if (smsResult.rows.length === 0) {
        throw new Error(`SMS ${smsId} not found in sms_outbox`);
      }

      const smsRecord = smsResult.rows[0];
      const lockedExpectedPayload: SMSJobData['payload'] = {
        smsId: smsRecord.id,
        ...(smsRecord.notification_id ? { notificationId: smsRecord.notification_id } : {}),
        ...(smsRecord.user_id ? { userId: smsRecord.user_id } : {}),
        toPhone: smsRecord.to_phone,
        body: smsRecord.body,
      };
      if (
        stableJson(smsRecord.outbox_payload) !== stableJson(lockedExpectedPayload)
        || stableJson(job.data.payload) !== stableJson(smsRecord.outbox_payload)
      ) {
        throw new Error('SMS claim no longer matches canonical outbox authority');
      }

      // Structured log: job started
      log.info(
        {
          smsId,
          jobId: job.id,
          idempotencyKey: smsRecord.idempotency_key,
          currentStatus: smsRecord.status,
          retryCount: smsRecord.retry_count,
        },
        'SMS job started'
      );

      // Idempotency check: If already sent, skip processing (idempotent replay)
      if (smsRecord.status === 'sent') {
        log.info(
          {
            smsId,
            jobId: job.id,
            idempotencyKey: smsRecord.idempotency_key,
            status: smsRecord.status,
            twilioSid: smsRecord.twilio_sid,
          },
          'SMS already sent, replay skipped'
        );
        const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
        return {
          smsRecord,
          claimed: false,
          shouldReturn: true,
          outboxKey,
        } satisfies SmsClaimResult;
      }

      // Crash recovery accepts both the provider-neutral receipt and the
      // legacy Twilio projection created before this contract.
      const persistedRecordMessageId = firstNonEmptyProviderMessageId(
        smsRecord.provider_message_id,
        smsRecord.twilio_sid,
      );
      if (persistedRecordMessageId && smsRecord.status !== 'sent') {
        log.warn(
          {
            smsId,
            jobId: job.id,
            idempotencyKey: smsRecord.idempotency_key,
            providerKind: smsRecord.provider_name,
            providerMessageId: persistedRecordMessageId,
          },
          'SMS crash recovery: provider receipt exists but status not sent'
        );

        const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
        return {
          smsRecord,
          claimed: false,
          shouldReturn: true,
          outboxKey,
        } satisfies SmsClaimResult;
      }

      // Check if max retries exceeded (poison message)
      if (
        smsRecord.retry_count >= smsRecord.max_retries
        && smsRecord.status !== 'sending'
      ) {
        log.warn(
          {
            smsId,
            jobId: job.id,
            idempotencyKey: smsRecord.idempotency_key,
            retryCount: smsRecord.retry_count,
            maxRetries: smsRecord.max_retries,
          },
          'SMS max retries exceeded'
        );
        throw new Error(`Max retries (${smsRecord.max_retries}) exceeded for SMS ${smsId}`);
      }

      // ATOMIC CLAIM: Update status to sending only if still in claimable state
      // CRITICAL: This is the atomic claim - only one worker can transition pending/failed -> sending
      const casResult = await txQuery<{
        id: string;
        status: string;
        retry_count: number;
      }>(
        `UPDATE sms_outbox
         SET status = 'sending',
             retry_count = CASE WHEN status='sending' THEN retry_count ELSE retry_count + 1 END,
             pre_provider_claim_id = $2::UUID,
             pre_provider_claimed_at = NOW(),
             pre_provider_claim_deadline_at = NOW() + make_interval(secs => $3::INTEGER),
             provider_io_started_at = NULL,
             notification_provider_attempt_id = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND (
             status IN ('pending','failed')
             OR (
               status='sending'
               AND provider_io_started_at IS NULL
               AND provider_message_id IS NULL
               AND twilio_sid IS NULL
               AND (
                 pre_provider_claim_deadline_at <= NOW()
                 OR (pre_provider_claim_deadline_at IS NULL AND updated_at < NOW() - INTERVAL '5 minutes')
               )
             )
           )
           AND EXISTS (
             SELECT 1 FROM outbox_events outbox
             WHERE outbox.idempotency_key=$4
               AND outbox.dispatch_attempt_id=$5::UUID
               AND outbox.bullmq_job_id=$6
               AND outbox.status IN ('enqueued','processing')
           )
         RETURNING id, status, retry_count`,
        [
          smsId,
          preProviderClaimToken,
          PRE_PROVIDER_LEASE_SECONDS,
          jobIdempotencyKey,
          dispatchAuthority.dispatchAttemptId,
          dispatchAuthority.bullmqJobId,
        ]
      );

      // If no row returned, another worker already claimed this SMS (or status changed)
      if (casResult.rowCount === 0) {
        log.warn(
          {
            smsId,
            jobId: job.id,
            idempotencyKey: smsRecord.idempotency_key,
            currentStatus: smsRecord.status,
          },
          'SMS claim failed: already claimed or invalid status'
        );
        return { smsRecord, claimed: false, shouldReturn: true } satisfies SmsClaimResult;
      }

      const claimedSMS = casResult.rows[0];

      // Structured log: claim successful
      log.info(
        {
          smsId,
          jobId: job.id,
          idempotencyKey: smsRecord.idempotency_key,
          statusTransition: `${smsRecord.status} -> sending`,
          retryCount: claimedSMS.retry_count,
        },
        'SMS claimed'
      );

      // Structured log: sending attempt
      log.info(
        {
          smsId,
          jobId: job.id,
          idempotencyKey: smsRecord.idempotency_key,
          retryCount: claimedSMS.retry_count,
          toPhone: smsRecord.to_phone,
        },
        'SMS sending'
      );

      return { smsRecord, claimed: true, shouldReturn: false } satisfies SmsClaimResult;
    });

    // Handle early-return cases from the transaction (already-sent, crash-recovery, claim-lost)
    if (claimResult.shouldReturn) {
      const acceptedMessageId = firstNonEmptyProviderMessageId(
        claimResult.smsRecord.provider_message_id,
        claimResult.smsRecord.twilio_sid,
      );
      const finalized = acceptedMessageId
        ? await reconcilePersistedReceipt(claimResult.smsRecord)
        : claimResult.smsRecord.status === 'sent';
      if (finalized && claimResult.outboxKey) {
        await markOutboxEventProcessed(claimResult.outboxKey, dispatchAuthority);
      }
      return;
    }

    // Phase 2: Authorized port call (outside transaction — never hold a DB
    // transaction open while waiting for a provider or synthetic sink).
    const smsBody = claimResult.smsRecord.body;
    const smsTo = claimResult.smsRecord.to_phone;
    // Alias for use in the rest of the function (mirrors original variable names)
    const smsRecord = claimResult.smsRecord;
    const providerBoundary = await db.transaction(async (query) => {
      if (notificationId) {
        await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
      }
      const owned = await query<{ id: string }>(
        `UPDATE sms_outbox
         SET pre_provider_claim_deadline_at=NOW()+make_interval(secs => $3::INTEGER),
             updated_at=NOW()
         WHERE id=$1 AND status='sending'
           AND pre_provider_claim_id=$2::UUID
           AND provider_io_started_at IS NULL
           AND pre_provider_claim_deadline_at > NOW()
         RETURNING id`,
        [smsId, preProviderClaimToken, PRE_PROVIDER_LEASE_SECONDS],
      );
      if (!owned.rows[0]) {
        return { allowed: false as const, reason: 'pre_provider_claim_lost' as const };
      }
      const notificationClaim = notificationId
        ? await claimNotificationDelivery(notificationId, 'sms', undefined, query)
        : { allowed: true as const, claimToken: directProviderAttemptToken };
      if (!notificationClaim.allowed) return notificationClaim;
      const started = await query<{ id: string }>(
        `UPDATE sms_outbox
         SET provider_io_started_at=NOW(),
             notification_provider_attempt_id=$3::UUID,
             updated_at=NOW()
         WHERE id=$1 AND status='sending'
           AND pre_provider_claim_id=$2::UUID
           AND provider_io_started_at IS NULL
         RETURNING id`,
        [smsId, preProviderClaimToken, notificationClaim.claimToken],
      );
      return started.rows[0]
        ? notificationClaim
        : { allowed: false as const, reason: 'pre_provider_claim_lost' as const };
    });
    if (!providerBoundary.allowed) {
      const reason = providerBoundary.reason;
      if (
        reason === 'provider_in_flight'
        || reason === 'provider_outcome_unknown'
        || reason === 'claim_lost'
        || reason === 'pre_provider_claim_lost'
      ) {
        return;
      }
      if (reason === 'not_due') {
        await db.query(
          `UPDATE sms_outbox
           SET status='pending',retry_count=GREATEST(retry_count-1,0),
               pre_provider_claim_id=NULL,pre_provider_claimed_at=NULL,
               pre_provider_claim_deadline_at=NULL,updated_at=NOW()
           WHERE id=$1 AND pre_provider_claim_id=$2::UUID
             AND provider_io_started_at IS NULL`,
          [smsId, preProviderClaimToken],
        );
        await markOutboxEventFailed(jobIdempotencyKey, 'notification_not_due', dispatchAuthority);
        return;
      }
      if (reason === 'superseded' || reason === 'cancelled_superseded') {
        await markNotificationCancelled(notificationId!, 'sms', reason);
      }
      if (['superseded', 'cancelled_superseded', 'provider_accepted', 'delivered', 'suppressed', 'failed_terminal'].includes(reason)) {
        await db.query(
          `UPDATE sms_outbox
           SET status=CASE WHEN $3 IN ('provider_accepted','delivered') THEN 'sent' ELSE 'suppressed' END,
               error_message=CASE WHEN $3 IN ('provider_accepted','delivered') THEN error_message ELSE $3 END,
               pre_provider_claim_id=NULL,pre_provider_claimed_at=NULL,
               pre_provider_claim_deadline_at=NULL,updated_at=NOW()
           WHERE id=$1 AND pre_provider_claim_id=$2::UUID
             AND provider_io_started_at IS NULL`,
          [smsId, preProviderClaimToken, reason],
        );
        await markOutboxEventProcessed(jobIdempotencyKey, dispatchAuthority);
        return;
      }
      throw new Error(`SMS delivery claim refused: ${reason}`);
    }
    providerClaimToken = providerBoundary.claimToken;

    const receipt = await deliveryPort.deliver({
      idempotencyKey: smsRecord.idempotency_key || jobIdempotencyKey,
      to: smsTo,
      body: smsBody,
      smsId,
      notificationId: notificationId ?? undefined,
    });
    const providerMessageId = firstNonEmptyProviderMessageId(receipt.providerMessageId);
    if (!providerMessageId) throw new Error('SMS provider returned no message receipt ID');

    // Keep twilio_sid only as the bounded compatibility projection for Twilio.
    const receiptPersistResult = await db.query<{ id: string }>(
      `UPDATE sms_outbox
       SET provider_name = $1,
           provider_message_id = $2,
           twilio_sid = CASE WHEN $1 = 'twilio' THEN $2 ELSE NULL END,
           notification_provider_attempt_id = $4::UUID,
           updated_at = NOW()
       WHERE id = $3
         AND status='sending'
         AND pre_provider_claim_id=$5::UUID
         AND provider_io_started_at IS NOT NULL
         AND notification_provider_attempt_id IS NOT DISTINCT FROM $4::UUID
       RETURNING id`,
      [receipt.providerKind, providerMessageId, smsId, providerClaimToken, preProviderClaimToken]
    );
    if (!receiptPersistResult.rows[0]) {
      throw new Error('SMS provider receipt could not be bound to the active claim');
    }

    // Update sms_outbox table (status=sent)
    // CRITICAL: Update only if still in 'sending' state (prevents overwriting if another worker completed)
    const finalUpdateResult = await db.query<{
      id: string;
      status: string;
      provider_name: string;
      provider_message_id: string;
    }>(
      `UPDATE sms_outbox
       SET status = 'sent',
           sent_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'sending'
         AND pre_provider_claim_id=$2::UUID
         AND notification_provider_attempt_id IS NOT DISTINCT FROM $3::UUID
       RETURNING id, status, provider_name, provider_message_id`,
      [smsId, preProviderClaimToken, providerClaimToken]
    );

    // If update affected 0 rows, another worker already marked this as sent
    if (finalUpdateResult.rowCount === 0) {
      log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, providerMessageId }, 'SMS already sent by another worker');
      return; // Already processed, exit gracefully
    }

    const finalSMS = finalUpdateResult.rows[0];

    if (notificationId) {
      await markNotificationProviderAccepted(
        notificationId,
        'sms',
        finalSMS.provider_name || receipt.providerKind,
        finalSMS.provider_message_id || providerMessageId || null,
        providerClaimToken,
      );
    }

    // Mark outbox event as processed (if processing from outbox)
    const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
    if (outboxKey) {
      await markOutboxEventProcessed(outboxKey, dispatchAuthority);
    }

    // Structured log: SMS sent successfully
    log.info(
      {
        smsId,
        jobId: job.id,
        idempotencyKey: smsRecord.idempotency_key,
        outboxEventId: outboxKey,
        retryCount: smsRecord.retry_count + 1,
        providerKind: finalSMS.provider_name || receipt.providerKind,
        providerMessageId: finalSMS.provider_message_id || providerMessageId,
        toPhone: smsTo,
      },
      'SMS sent successfully'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Get SMS record idempotency key for logging (may be null if error before SELECT)
    let outboxKey = jobIdempotencyKey;
    let currentRetryCount = 0;
    let maxRetries = 3;

    try {
      // Try to get current state for logging
      const currentState = await db.query<{
        idempotency_key: string;
        retry_count: number;
        max_retries: number;
        status: string;
      }>(`SELECT idempotency_key, retry_count, max_retries, status FROM sms_outbox WHERE id = $1`, [smsId]);

      if (currentState.rows.length > 0) {
        outboxKey = currentState.rows[0].idempotency_key || jobIdempotencyKey;
        currentRetryCount = currentState.rows[0].retry_count;
        maxRetries = currentState.rows[0].max_retries;
      }
    } catch {
      // Ignore errors fetching current state
    }

    // Structured log: error occurred
    log.error(
      {
        smsId,
        jobId: job.id,
        idempotencyKey: outboxKey,
        err: errorMessage,
        retryCount: currentRetryCount,
      },
      'SMS send error'
    );

    if (providerClaimToken) {
      await db.transaction(async (query) => {
        if (notificationId) {
          await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
        }
        const outcomeUnknown = await query<{ id: string }>(
          `UPDATE sms_outbox
           SET status = 'provider_outcome_unknown',
               error_message = $1,
               updated_at = NOW()
           WHERE id = $2 AND status = 'sending'
             AND notification_provider_attempt_id=$3::UUID
             AND provider_io_started_at IS NOT NULL
           RETURNING id`,
          [errorMessage, smsId, providerClaimToken],
        );
        if (!outcomeUnknown.rows[0]) return;
        if (notificationId) {
          await markNotificationProviderOutcomeUnknown(
            notificationId,
            'sms',
            errorMessage,
            providerClaimToken!,
            query,
          );
        }
        await markOutboxEventProcessed(outboxKey, dispatchAuthority, { query });
      });
      return;
    }

    // Update sms_outbox with error (for retry)
    // Check current retry_count to determine if we should mark as failed (poison message)
    const shouldMarkFailed = currentRetryCount >= maxRetries;

    const retryOwned = await db.transaction(async (query) => {
      if (notificationId) {
        await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
      }
      const owned = await query<{ id: string }>(
        `UPDATE sms_outbox
         SET status = $1,
             error_message = $2,
             pre_provider_claim_id = NULL,
             pre_provider_claimed_at = NULL,
             pre_provider_claim_deadline_at = NULL,
             updated_at = NOW()
         WHERE id = $3
           AND pre_provider_claim_id=$4::UUID
           AND provider_io_started_at IS NULL
         RETURNING id`,
        [shouldMarkFailed ? 'failed' : 'pending', errorMessage, smsId, preProviderClaimToken],
      );
      if (!owned.rows[0]) return false;
      if (notificationId) {
        await markNotificationDeliveryFailure(
          notificationId,
          'sms',
          errorMessage,
          null,
          query,
          null,
          shouldMarkFailed,
        );
      } else {
        await markOutboxEventFailed(outboxKey, errorMessage, dispatchAuthority, {
          terminal: shouldMarkFailed,
          query,
        });
      }
      return true;
    });
    if (!retryOwned) return;

    if (shouldMarkFailed) {
      log.error(
        {
          smsId,
          jobId: job.id,
          idempotencyKey: outboxKey,
          retryCount: currentRetryCount,
          maxRetries,
          err: errorMessage,
        },
        'SMS poison message: max retries exceeded'
      );
    }

    // Re-throw error for BullMQ retry logic (unless max retries exceeded - then don't retry)
    if (currentRetryCount >= maxRetries) {
      // Don't throw - let job complete as failed (no more retries)
      return;
    }

    throw error;
  }
}
