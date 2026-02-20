/**
 * SMS Worker v1.0.0
 *
 * SYSTEM GUARANTEES: Asynchronous SMS Delivery with Twilio
 *
 * Processes sms_outbox table from BullMQ.
 * Sends SMS via TwilioSMSService with retries, backoff, and error handling.
 *
 * Pattern:
 * 1. Job processor receives SMS job (from sms_outbox table)
 * 2. Send SMS via TwilioSMSService
 * 3. Update sms_outbox table (status=sent, twilio_sid)
 * 4. Handle failures (mark failed with error_message, respect retry_count/max_retries)
 *
 * Hard rule: SMS send is never inline on request paths - always async
 *
 * @see ARCHITECTURE.md §2.6 (Notification Services)
 */

import { db } from '../db';
import { sendSMS } from '../services/TwilioSMSService';
import { markOutboxEventProcessed, markOutboxEventFailed } from './outbox-worker';
import { workerLogger } from '../logger';
import type { Job } from 'bullmq';

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
  const { smsId, userId, toPhone, body } = job.data.payload;
  const jobIdempotencyKey = job.id || `sms:${smsId}`;

  try {
    // Get SMS record from sms_outbox table with FOR UPDATE lock (prevents concurrent processing)
    const smsResult = await db.query<{
      id: string;
      user_id: string | null;
      to_phone: string;
      body: string;
      status: string;
      retry_count: number;
      max_retries: number;
      idempotency_key: string;
      twilio_sid: string | null;
    }>(
      `SELECT id, user_id, to_phone, body, status, retry_count, max_retries, idempotency_key, twilio_sid
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
    log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, currentStatus: smsRecord.status, retryCount: smsRecord.retry_count }, 'SMS job started');

    // Idempotency check: If already sent, skip processing (idempotent replay)
    if (smsRecord.status === 'sent') {
      log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, status: smsRecord.status, twilioSid: smsRecord.twilio_sid }, 'SMS already sent, replay skipped');
      // Mark outbox event as processed (if processing from outbox)
      const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
      if (outboxKey) {
        await markOutboxEventProcessed(outboxKey);
      }
      return;
    }

    // Crash recovery check: If twilio_sid exists, SMS was already sent (Twilio succeeded but DB update failed)
    if (smsRecord.twilio_sid && smsRecord.status !== 'sent') {
      // SMS was already sent - mark as sent and exit
      await db.query(
        `UPDATE sms_outbox
         SET status = 'sent',
             sent_at = COALESCE(sent_at, NOW()),
             updated_at = NOW()
         WHERE id = $1`,
        [smsId]
      );

      log.warn({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, twilioSid: smsRecord.twilio_sid }, 'SMS crash recovery: twilio_sid exists but status not sent');

      const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
      if (outboxKey) {
        await markOutboxEventProcessed(outboxKey);
      }
      return;
    }

    // Check if max retries exceeded (poison message)
    if (smsRecord.retry_count >= smsRecord.max_retries) {
      log.warn({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, retryCount: smsRecord.retry_count, maxRetries: smsRecord.max_retries }, 'SMS max retries exceeded');
      throw new Error(`Max retries (${smsRecord.max_retries}) exceeded for SMS ${smsId}`);
    }

    // ATOMIC CLAIM: Update status to sending only if still in claimable state
    // CRITICAL: This is the atomic claim - only one worker can transition pending/failed -> sending
    const claimResult = await db.query<{
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
    if (claimResult.rowCount === 0) {
      log.warn({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, currentStatus: smsRecord.status }, 'SMS claim failed: already claimed or invalid status');
      return; // Another worker claimed it or status changed - exit gracefully
    }

    const claimedSMS = claimResult.rows[0];

    // Structured log: claim successful
    log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, statusTransition: `${smsRecord.status} -> sending`, retryCount: claimedSMS.retry_count }, 'SMS claimed');

    // Structured log: sending attempt
    log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, retryCount: claimedSMS.retry_count, toPhone: toPhone || smsRecord.to_phone }, 'SMS sending');

    // Send SMS via TwilioSMSService
    const smsBody = body || smsRecord.body;
    const smsTo = toPhone || smsRecord.to_phone;
    const result = await sendSMS(smsTo, smsBody);

    if (!result.success) {
      throw new Error(result.error || 'SMS send failed');
    }

    const twilioSid = result.sid || '';

    // Store twilio_sid IMMEDIATELY after Twilio success (for crash recovery)
    await db.query(
      `UPDATE sms_outbox
       SET twilio_sid = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [twilioSid, smsId]
    );

    // Update sms_outbox table (status=sent)
    // CRITICAL: Update only if still in 'sending' state (prevents overwriting if another worker completed)
    const finalUpdateResult = await db.query<{
      id: string;
      status: string;
      twilio_sid: string;
    }>(
      `UPDATE sms_outbox
       SET status = 'sent',
           sent_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'sending'
       RETURNING id, status, twilio_sid`,
      [smsId]
    );

    // If update affected 0 rows, another worker already marked this as sent
    if (finalUpdateResult.rowCount === 0) {
      log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, twilioSid }, 'SMS already sent by another worker');
      return; // Already processed, exit gracefully
    }

    const finalSMS = finalUpdateResult.rows[0];

    // Mark outbox event as processed (if processing from outbox)
    const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
    if (outboxKey) {
      await markOutboxEventProcessed(outboxKey);
    }

    // Structured log: SMS sent successfully
    log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, outboxEventId: outboxKey, retryCount: claimedSMS.retry_count, twilioSid: finalSMS.twilio_sid || twilioSid, toPhone: smsTo }, 'SMS sent successfully');
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
      }>(
        `SELECT idempotency_key, retry_count, max_retries, status FROM sms_outbox WHERE id = $1`,
        [smsId]
      );

      if (currentState.rows.length > 0) {
        outboxKey = currentState.rows[0].idempotency_key || jobIdempotencyKey;
        currentRetryCount = currentState.rows[0].retry_count;
        maxRetries = currentState.rows[0].max_retries;
      }
    } catch {
      // Ignore errors fetching current state
    }

    // Structured log: error occurred
    log.error({ smsId, jobId: job.id, idempotencyKey: outboxKey, err: errorMessage, retryCount: currentRetryCount }, 'SMS send error');

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

    if (shouldMarkFailed) {
      log.error({ smsId, jobId: job.id, idempotencyKey: outboxKey, retryCount: currentRetryCount, maxRetries, err: errorMessage }, 'SMS poison message: max retries exceeded');
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
