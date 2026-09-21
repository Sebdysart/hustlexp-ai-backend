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

import { db, type QueryFn } from '../db.js';
import { sendSMS } from '../services/TwilioSMSService.js';
import { markOutboxEventProcessed, markOutboxEventFailed } from './outbox-worker.js';
import { workerLogger } from '../logger.js';
import type { Job } from 'bullmq';
import {
  authorizeNotificationDelivery,
  markNotificationCancelled,
  markNotificationDeliveryFailure,
  markNotificationProviderAccepted,
} from '../services/NotificationDeliveryState.js';

const log = workerLogger.child({ worker: 'sms' });

interface PremiumSmsRow {
  id: string; user_id: string; provider_os_event_id: string | null; idempotency_key: string;
  status: string; twilio_sid: string | null; retry_count: number; max_retries: number;
  available_at: Date; updated_at: Date;
}

async function finishPremiumSms(query: QueryFn, row: PremiumSmsRow, outcome: string): Promise<void> {
  await query(`UPDATE sms_outbox SET status = $2, error_message = $3, updated_at = NOW() WHERE id = $1`,
    [row.id, outcome === 'sent' ? 'sent' : 'suppressed', outcome === 'sent' ? null : outcome]);
  await query(`UPDATE provider_os_event_recipients SET outcome = $2 WHERE sms_id = $1`, [row.id, outcome]);
  await query(`UPDATE outbox_events SET status = 'processed', processed_at = NOW(), error_message = $2 WHERE idempotency_key = $1`,
    [row.idempotency_key, outcome === 'sent' ? null : outcome]);
}

/** Same SMS worker and Twilio adapter, with a database-backed premium principal.
 * No phone/body/authorization from the queue is trusted for this path. */
async function processPremiumSms(smsId: string): Promise<void> {
  const { loadPremiumEvent, premiumEventEligible, premiumRecipients, recipientSmsPolicy, premiumSmsBody }
    = await import('../services/ProviderOsPremiumEvents.js');
  const claim = await db.transaction(async (query) => {
    const row = (await query<PremiumSmsRow>('SELECT * FROM sms_outbox WHERE id = $1 FOR UPDATE', [smsId])).rows[0];
    if (!row) throw new Error('PREMIUM_SMS_NOT_FOUND');
    if (row.twilio_sid || row.status === 'sent') {
      await finishPremiumSms(query, row, 'sent');
      return null;
    }
    if (['suppressed', 'cancelled'].includes(row.status)) {
      await query(`UPDATE outbox_events SET status = 'processed', processed_at = NOW() WHERE idempotency_key = $1`, [row.idempotency_key]);
      return null;
    }
    if (!row.provider_os_event_id) {
      await finishPremiumSms(query, row, 'legacy_provider_os_provenance');
      return null;
    }
    if (row.status === 'sending') {
      // Another live worker owns the claim. A stale claim without a SID is
      // ambiguous: Twilio might have accepted it before the process crashed.
      if (row.updated_at.getTime() < Date.now() - 10 * 60_000) {
        await finishPremiumSms(query, row, 'delivery_uncertain_requires_review');
      }
      return null;
    }
    const event = await loadPremiumEvent(row.provider_os_event_id, query);
    const ledger = await query(`SELECT 1 FROM provider_os_event_recipients WHERE event_id = $1 AND user_id = $2 AND sms_id = $3`,
      [row.provider_os_event_id, row.user_id, row.id]);
    if (!event || !ledger.rows[0] || row.idempotency_key !== `provider_os:v2:sms:${event.id}:${row.user_id}`
      || !await premiumEventEligible(event, query)) {
      await finishPremiumSms(query, row, 'premium_authority_revoked');
      return null;
    }
    const recipient = (await premiumRecipients(event, query, row.user_id))[0];
    const policy = recipientSmsPolicy(recipient);
    if (policy.reason) {
      await finishPremiumSms(query, row, policy.reason);
      return null;
    }
    const availableAt = new Date(Math.max(row.available_at.getTime(), policy.availableAt!.getTime()));
    if (availableAt.getTime() > Date.now()) {
      await query(`UPDATE sms_outbox SET available_at = $2 WHERE id = $1`, [row.id, availableAt]);
      await query(`UPDATE outbox_events SET status = 'pending', available_at = $2,
        attempts = GREATEST(attempts - 1, 0), error_message = 'quiet_hours_deferred' WHERE idempotency_key = $1`,
      [row.idempotency_key, availableAt]);
      return null;
    }
    if (row.retry_count >= row.max_retries) {
      await finishPremiumSms(query, row, 'delivery_retries_exhausted');
      return null;
    }
    const body = premiumSmsBody(event);
    const phone = recipient.phone!;
    const claimed = await query(`UPDATE sms_outbox SET status = 'sending', retry_count = retry_count + 1,
      to_phone = $2, body = $3, updated_at = NOW() WHERE id = $1 AND status IN ('pending','failed') RETURNING id`, [row.id, phone, body]);
    return claimed.rows[0] ? { row, phone, body } : null;
  });
  if (!claim) return;

  // Network I/O is outside the transaction. Rejections known to be unsent retry;
  // ambiguous network errors never trigger a blind second message.
  let result: Awaited<ReturnType<typeof sendSMS>>;
  try {
    result = await sendSMS(claim.phone, claim.body);
  } catch {
    result = { success: false, error: 'unexpected_sms_transport_failure' };
  }
  if (result.success && result.sid) {
    // Persist SID first; if acknowledgment then fails, replay recovers without sending.
    await db.query(`UPDATE sms_outbox SET twilio_sid = $2, sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND status = 'sending'`, [smsId, result.sid]);
    await db.transaction((query) => finishPremiumSms(query, claim.row, 'sent'));
    return;
  }
  if (!result.definitelyNotSent) {
    await db.transaction((query) => finishPremiumSms(query, claim.row, 'delivery_uncertain_requires_review'));
    log.error({ smsId }, 'Premium SMS delivery uncertain; suppressed automatic resend');
    return;
  }
  await db.transaction(async (query) => {
    const exhausted = claim.row.retry_count + 1 >= claim.row.max_retries;
    await query(`UPDATE sms_outbox SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1 AND status = 'sending'`,
      [smsId, result.error ?? 'sms_rejected']);
    await query(`UPDATE provider_os_event_recipients SET outcome = $2 WHERE sms_id = $1`,
      [smsId, exhausted ? 'delivery_retries_exhausted' : 'retry_pending']);
    await query(`UPDATE outbox_events SET status = $2, available_at = NOW() + INTERVAL '30 seconds', error_message = $3
      WHERE idempotency_key = $1`, [claim.row.idempotency_key, exhausted ? 'failed' : 'pending', result.error ?? 'sms_rejected']);
  });
}

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
    toPhone?: string;
    body?: string;
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
  const { smsId, notificationId } = job.data.payload;
  let { toPhone, body } = job.data.payload;
  const jobIdempotencyKey = job.id || `sms:${smsId}`;
  // Route using persisted provenance, never a client/Redis boolean. Legacy premium
  // rows stay suppressed. The ordinary marketplace SMS path below is unchanged.
  const principal = await db.query<{
    provider_os_event_id: string | null;
    idempotency_key: string;
    recipient_kind: string;
    claim_status: string | null;
    claim_expires_at: Date | null;
    recipient_context_id: string | null;
  }>(
    `SELECT sms.provider_os_event_id, sms.idempotency_key, sms.recipient_kind,
            sms.recipient_context_id,
            claim.status AS claim_status, claim.expires_at AS claim_expires_at
       FROM sms_outbox sms
       LEFT JOIN pending_phone_draft_claims claim
         ON claim.id = sms.recipient_context_id
      WHERE sms.id = $1`, [smsId],
  );
  if (principal.rows[0]?.provider_os_event_id || principal.rows[0]?.idempotency_key?.startsWith('provider_os:')) {
    await processPremiumSms(smsId);
    return;
  }
  if (principal.rows[0]?.recipient_kind === 'pending_phone_claim') {
    const claimValid = principal.rows[0].claim_status === 'OPEN'
      && Boolean(principal.rows[0].claim_expires_at)
      && principal.rows[0].claim_expires_at!.getTime() > Date.now();
    if (!claimValid) {
      await db.query(
        `UPDATE sms_outbox SET status='suppressed', error_message='pending_phone_claim_inactive', updated_at=NOW()
          WHERE id=$1 AND status IN ('pending','failed')`,
        [smsId],
      );
      await markOutboxEventProcessed(principal.rows[0].idempotency_key);
      return;
    }
    // This privileged accountless path trusts only the persisted outbox row.
    toPhone = '';
    body = (await import('../services/CustomerDraftClaimService.js'))
      .pendingPhoneClaimSmsBody(principal.rows[0].recipient_context_id!);
  }


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

    // Phase 1: Atomic claim inside a transaction
    // SELECT FOR UPDATE + all idempotency/crash-recovery checks + CAS UPDATE must be atomic.
    // The row lock is held for the entire transaction, preventing concurrent workers from
    // reading the same 'pending' status and both attempting to claim the same SMS.
    type SmsClaimResult = {
      smsRecord: { id: string; user_id: string | null; to_phone: string; body: string; status: string; retry_count: number; max_retries: number; idempotency_key: string; twilio_sid: string | null };
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

      // Old Provider OS jobs lack organization/entitlement/recipient provenance.
      // Fail closed at delivery as well as enqueue until the notification pass.
      if (smsRecord.idempotency_key?.startsWith('provider_os:')) {
        await txQuery(`UPDATE sms_outbox SET status = 'suppressed',
          error_message = 'Provider OS notification delivery disabled pending organization provenance',
          updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'failed', 'sending')`, [smsId]);
        return { smsRecord, claimed: false, shouldReturn: true,
          outboxKey: smsRecord.idempotency_key } satisfies SmsClaimResult;
      }


      // Structured log: job started
      log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, currentStatus: smsRecord.status, retryCount: smsRecord.retry_count }, 'SMS job started');

      // Idempotency check: If already sent, skip processing (idempotent replay)
      if (smsRecord.status === 'sent') {
        log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, status: smsRecord.status, twilioSid: smsRecord.twilio_sid }, 'SMS already sent, replay skipped');
        const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
        return { smsRecord, claimed: false, shouldReturn: true, outboxKey } satisfies SmsClaimResult;
      }

      // Crash recovery check: If twilio_sid exists, SMS was already sent (Twilio succeeded but DB update failed)
      if (smsRecord.twilio_sid && smsRecord.status !== 'sent') {
        await txQuery(
          `UPDATE sms_outbox
           SET status = 'sent',
               sent_at = COALESCE(sent_at, NOW()),
               updated_at = NOW()
           WHERE id = $1`,
          [smsId]
        );

        log.warn({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, twilioSid: smsRecord.twilio_sid }, 'SMS crash recovery: twilio_sid exists but status not sent');

        const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
        return { smsRecord, claimed: false, shouldReturn: true, outboxKey } satisfies SmsClaimResult;
      }

      // Check if max retries exceeded (poison message)
      if (smsRecord.retry_count >= smsRecord.max_retries) {
        log.warn({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, retryCount: smsRecord.retry_count, maxRetries: smsRecord.max_retries }, 'SMS max retries exceeded');
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
        log.warn({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, currentStatus: smsRecord.status }, 'SMS claim failed: already claimed or invalid status');
        return { smsRecord, claimed: false, shouldReturn: true } satisfies SmsClaimResult;
      }

      const claimedSMS = casResult.rows[0];

      // Structured log: claim successful
      log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, statusTransition: `${smsRecord.status} -> sending`, retryCount: claimedSMS.retry_count }, 'SMS claimed');

      // Structured log: sending attempt
      log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, retryCount: claimedSMS.retry_count, toPhone: toPhone || smsRecord.to_phone }, 'SMS sending');

      return { smsRecord, claimed: true, shouldReturn: false } satisfies SmsClaimResult;
    });

    // Handle early-return cases from the transaction (already-sent, crash-recovery, claim-lost)
    if (claimResult.shouldReturn) {
      if (notificationId && claimResult.smsRecord.twilio_sid) {
        await markNotificationProviderAccepted(
          notificationId, 'sms', 'twilio', claimResult.smsRecord.twilio_sid,
        );
      }
      if (claimResult.outboxKey) {
        await markOutboxEventProcessed(claimResult.outboxKey);
      }
      return;
    }

    // Phase 2: External Twilio call (outside transaction — never hold a DB transaction
    // open while waiting for a network call to an external service)
    const smsBody = body || claimResult.smsRecord.body;
    const smsTo = toPhone || claimResult.smsRecord.to_phone;
    // Alias for use in the rest of the function (mirrors original variable names)
    const smsRecord = claimResult.smsRecord;
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

    if (notificationId) {
      await markNotificationProviderAccepted(
        notificationId,
        'sms',
        'twilio',
        finalSMS.twilio_sid || twilioSid || null,
      );
    }

    // Mark outbox event as processed (if processing from outbox)
    const outboxKey = smsRecord.idempotency_key || jobIdempotencyKey;
    if (outboxKey) {
      await markOutboxEventProcessed(outboxKey);
    }

    // Structured log: SMS sent successfully
    log.info({ smsId, jobId: job.id, idempotencyKey: smsRecord.idempotency_key, outboxEventId: outboxKey, retryCount: smsRecord.retry_count + 1, twilioSid: finalSMS.twilio_sid || twilioSid, toPhone: smsTo }, 'SMS sent successfully');
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

    if (notificationId) {
      await markNotificationDeliveryFailure(notificationId, 'sms', errorMessage);
    }

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
