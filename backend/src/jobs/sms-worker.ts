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
import { createOutboundSmsPort } from '../services/OutboundCommunicationService.js';
import { authorizeNotificationDelivery, markNotificationCancelled, markNotificationDeliveryFailure, markNotificationProviderAccepted } from '../services/NotificationDeliveryState.js';

const log = workerLogger.child({ worker: 'sms' });

// ============================================================================
// TYPES
// ============================================================================

interface SMSJobData {
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  payload: {
    smsId: string;
    notificationId?: string;
    userId?: string;
    toPhone: string;
    body: string;
  };
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
  // Extract data from job payload (structured as outbox event)
  const { smsId, notificationId, toPhone, body } = job.data.payload;
  const jobIdempotencyKey = job.id || `sms:${smsId}`;

  try {
    if (notificationId) {
      const authorization = await authorizeNotificationDelivery(notificationId, 'sms');
      if (!authorization.allowed) {
        if (authorization.reason === 'not_due') {
          await markOutboxEventFailed(jobIdempotencyKey, 'notification_not_due');
          return;
        }
        if (authorization.reason === 'superseded' || authorization.reason === 'cancelled_superseded') {
          await markNotificationCancelled(notificationId, 'sms', authorization.reason);
        }
        if (['superseded', 'cancelled_superseded', 'provider_accepted', 'delivered', 'suppressed', 'failed_terminal'].includes(authorization.reason)) {
          await markOutboxEventProcessed(jobIdempotencyKey);
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
      smsRecord: {
        id: string;
        user_id: string | null;
        to_phone: string;
        body: string;
        status: string;
        retry_count: number;
        max_retries: number;
        idempotency_key: string;
        twilio_sid: string | null;
        provider_name: string | null;
        provider_message_id: string | null;
      };
      claimed: boolean;
      shouldReturn: boolean;
      outboxKey?: string;
    };

    const claimResult = await db.transaction(async (txQuery) => {
      // Get SMS record from sms_outbox table with FOR UPDATE lock (prevents concurrent processing)
      const smsResult = await txQuery<{
        id: string;
        user_id: string | null;
        to_phone: string;
        body: string;
        status: string;
        retry_count: number;
        max_retries: number;
        idempotency_key: string;
        twilio_sid: string | null;
        provider_name: string | null;
        provider_message_id: string | null;
      }>(
        `SELECT id, user_id, to_phone, body, status, retry_count, max_retries, idempotency_key,
                twilio_sid, provider_name, provider_message_id
         FROM sms_outbox
         WHERE id = $1
         FOR UPDATE`,
        [smsId]
      );

      if (smsResult.rows.length === 0) {
        throw new Error(`SMS ${smsId} not found in sms_outbox`);
      }

      const smsRecord = smsResult.rows[0];

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
      if ((smsRecord.provider_message_id || smsRecord.twilio_sid) && smsRecord.status !== 'sent') {
        await txQuery(
          `UPDATE sms_outbox
           SET status = 'sent',
               sent_at = COALESCE(sent_at, NOW()),
               updated_at = NOW()
           WHERE id = $1`,
          [smsId]
        );

        log.warn(
          {
            smsId,
            jobId: job.id,
            idempotencyKey: smsRecord.idempotency_key,
            providerKind: smsRecord.provider_name,
            providerMessageId: smsRecord.provider_message_id || smsRecord.twilio_sid,
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
      if (smsRecord.retry_count >= smsRecord.max_retries) {
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
             retry_count = retry_count + 1,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('pending', 'failed')
         RETURNING id, status, retry_count`,
        [smsId]
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
          toPhone: toPhone || smsRecord.to_phone,
        },
        'SMS sending'
      );

      return { smsRecord, claimed: true, shouldReturn: false } satisfies SmsClaimResult;
    });

    // Handle early-return cases from the transaction (already-sent, crash-recovery, claim-lost)
    if (claimResult.shouldReturn) {
      const acceptedMessageId = claimResult.smsRecord.provider_message_id || claimResult.smsRecord.twilio_sid;
      if (notificationId && acceptedMessageId) {
        await markNotificationProviderAccepted(notificationId, 'sms', claimResult.smsRecord.provider_name || deliveryPort.providerKind, acceptedMessageId);
      }
      if (claimResult.outboxKey) {
        await markOutboxEventProcessed(claimResult.outboxKey);
      }
      return;
    }

    // Phase 2: Authorized port call (outside transaction — never hold a DB
    // transaction open while waiting for a provider or synthetic sink).
    const smsBody = body || claimResult.smsRecord.body;
    const smsTo = toPhone || claimResult.smsRecord.to_phone;
    // Alias for use in the rest of the function (mirrors original variable names)
    const smsRecord = claimResult.smsRecord;
    const receipt = await deliveryPort.deliver({
      idempotencyKey: smsRecord.idempotency_key || jobIdempotencyKey,
      to: smsTo,
      body: smsBody,
      smsId,
      notificationId,
    });
    const providerMessageId = receipt.providerMessageId;

    // Keep twilio_sid only as the bounded compatibility projection for Twilio.
    await db.query(
      `UPDATE sms_outbox
       SET provider_name = $1,
           provider_message_id = $2,
           twilio_sid = CASE WHEN $1 = 'twilio' THEN $2 ELSE NULL END,
           updated_at = NOW()
       WHERE id = $3`,
      [receipt.providerKind, providerMessageId, smsId]
    );

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
       RETURNING id, status, provider_name, provider_message_id`,
      [smsId]
    );

    // If update affected 0 rows, another worker already marked this as sent
    if (finalUpdateResult.rowCount === 0) {
      log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, providerMessageId }, 'SMS already sent by another worker');
      return; // Already processed, exit gracefully
    }

    const finalSMS = finalUpdateResult.rows[0];

    if (notificationId) {
      await markNotificationProviderAccepted(notificationId, 'sms', finalSMS.provider_name || receipt.providerKind, finalSMS.provider_message_id || providerMessageId || null);
    }

    // Mark outbox event as processed (if processing from outbox)
    const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
    if (outboxKey) {
      await markOutboxEventProcessed(outboxKey);
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

    // Update sms_outbox with error (for retry)
    // Check current retry_count to determine if we should mark as failed (poison message)
    const shouldMarkFailed = currentRetryCount >= maxRetries;

    await db.query(
      `UPDATE sms_outbox
       SET status = $1,
           error_message = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [shouldMarkFailed ? 'failed' : 'pending', errorMessage, smsId]
    );

    if (notificationId) {
      await markNotificationDeliveryFailure(notificationId, 'sms', errorMessage);
    }

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

    // Mark outbox event as failed (if processing from outbox)
    if (outboxKey) {
      await markOutboxEventFailed(outboxKey, errorMessage);
    }

    // Re-throw error for BullMQ retry logic (unless max retries exceeded - then don't retry)
    if (currentRetryCount >= maxRetries) {
      // Don't throw - let job complete as failed (no more retries)
      return;
    }

    throw error;
  }
}
