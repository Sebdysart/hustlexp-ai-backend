/**
 * Email Worker v1.0.0
 *
 * SYSTEM GUARANTEES: Asynchronous, provider-neutral Email Delivery
 *
 * Processes email_outbox table from BullMQ.
 * Sends emails through the authorized outbound port with retries, backoff,
 * suppression handling, and nonproduction sink isolation.
 *
 * Pattern:
 * 1. Job processor receives email job (from email_outbox table)
 * 2. Send email via the explicitly authorized email adapter
 * 3. Update email_outbox table (status=sent, provider_msg_id)
 * 4. Handle suppression (mark do_not_email=true on user profile)
 *
 * Hard rule: Email send is never inline on request paths - always async
 *
 * @see ARCHITECTURE.md §2.6 (Email Service)
 */

import { db } from '../db.js';
import { config } from '../config.js';
import { markOutboxEventProcessed, markOutboxEventFailed } from './outbox-worker.js';
import { workerLogger } from '../logger.js';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';
import { createOutboundEmailPort } from '../services/OutboundCommunicationService.js';
import {
  authorizeNotificationDelivery,
  claimNotificationDelivery,
  markNotificationCancelled,
  markNotificationDeliveryFailure,
  markNotificationProviderOutcomeUnknown,
  markNotificationProviderAccepted,
  markNotificationSuppressed,
} from '../services/NotificationDeliveryState.js';

const log = workerLogger.child({ worker: 'email' });

// ============================================================================
// TYPES
// ============================================================================

interface EmailJobData {
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  outbox_idempotency_key?: string;
  outbox_dispatch_attempt_id: string;
  outbox_bullmq_job_id: string;
  payload: {
    emailId: string;
    userId?: string;
    toEmail: string;
    template: string;
    params: Record<string, unknown>;
  };
}

type CanonicalEmailAuthority = {
  id: string;
  user_id: string | null;
  lead_id: string | null;
  to_email: string;
  template: string;
  params_json: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  suppressed_reason: string | null;
  idempotency_key: string;
  notification_id: string | null;
  provider_msg_id: string | null;
  provider_name: string | null;
  notification_provider_attempt_id: string | null;
  pre_provider_claim_id: string | null;
  outbox_id: string;
  outbox_event_version: number;
  outbox_payload: EmailJobData['payload'];
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

function nonEmptyProviderMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

// ============================================================================
// EMAIL TEMPLATES
// ============================================================================

/**
 * Email template renderer
 *
 * Uses a simple inline template system. Each template produces subject, html, and
 * plain text versions. Unknown templates fall back to a generic notification layout.
 *
 * Upgrade path: swap this for Handlebars/Mustache/React Email when design polish is needed.
 */
function renderEmailTemplate(
  template: string,
  params: Record<string, unknown>
): { subject: string; html: string; text: string } {
  const p = params; // alias for brevity
  const escapeHtml = (value: unknown) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  // Shared header/footer for branded emails
  const header = `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#0D0D0D;color:#F5F5F5;">
    <div style="text-align:center;margin-bottom:24px;">
      <span style="font-size:24px;font-weight:700;color:#A855F7;">⚡ HustleXP</span>
    </div>`;
  const footer = `<hr style="border:none;border-top:1px solid #2A2A2A;margin:24px 0;"/>
    <p style="font-size:12px;color:#888;">This email was sent by HustleXP. If you didn't expect this, please contact support.</p>
  </div>`;

  const wrap = (subject: string, body: string, text: string) => ({
    subject,
    html: `${header}${body}${footer}`,
    text,
  });

  const templates: Record<string, () => { subject: string; html: string; text: string }> = {
    // --- Anonymous Universal V1 lead confirmation ---
    lead_confirmation: () => {
      const firstName = escapeHtml(p.firstName || 'there');
      const leadType = String(p.leadType ?? 'poster');
      const copy = leadType === 'hustler'
        ? {
            subject: 'Your HustleXP provider interest is recorded',
            body: 'We will verify service categories, location, availability, and required credentials before presenting an eligible next step.',
          }
        : leadType === 'business'
          ? {
              subject: 'Your HustleXP business request is recorded',
              body: 'We will review the requested service bundle, operating locations, schedule, and credential requirements before presenting a supported next step.',
            }
          : leadType === 'founder'
            ? {
                subject: 'Your HustleXP builder application is recorded',
                body: 'The team will review the application against currently authorized work and contact you only when a scoped next step exists.',
              }
            : {
                subject: 'Your HustleXP work request is recorded',
                body: 'We are screening the scope, safety, location, and available supply. The next result may be fulfillment review, an estimate, manual sourcing, referral, waitlist, or decline.',
              };
      return wrap(
        copy.subject,
        `<h2 style="color:#F5F5F5;">Request received</h2><p>Hi ${firstName},</p><p>${copy.body}</p><p>No provider assignment or payment has been created.</p>`,
        `Hi ${String(p.firstName || 'there')},\n\n${copy.body}\n\nNo provider assignment or payment has been created.`
      );
    },
    // --- Data Export ---
    export_ready: () =>
      wrap(
        'Your data export is ready',
        `<h2 style="color:#F5F5F5;">Your data export is ready</h2>
       <p>Download your export using the link below. It will expire on ${p.expiresAt}.</p>
       <a href="${p.downloadUrl}" style="display:inline-block;padding:12px 24px;background:#A855F7;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Download Export</a>`,
        `Your data export is ready. Download it at ${p.downloadUrl}. This link expires on ${p.expiresAt}.`
      ),

    // --- Task Status Changes ---
    task_status_changed: () =>
      wrap(
        `Task update: ${p.title || p.taskTitle || 'Your task'}`,
        `<h2 style="color:#F5F5F5;">Task Status Updated</h2>
       <p>Your task <strong>"${p.title || p.taskTitle}"</strong> has changed to <strong>${p.status || p.body}</strong>.</p>`,
        `Task "${p.title || p.taskTitle}" status changed to ${p.status || p.body}.`
      ),

    // --- Account Deletion ---
    deletion_confirmed: () =>
      wrap(
        'Account deletion completed',
        `<h2 style="color:#F5F5F5;">Account Deleted</h2>
       <p>Your HustleXP account and all associated personal data have been permanently deleted per your GDPR request. This action cannot be undone.</p>`,
        'Your HustleXP account and all associated data have been permanently deleted.'
      ),

    // --- Verification Code ---
    verification_code: () =>
      wrap(
        'Your verification code',
        `<h2 style="color:#F5F5F5;">Verification Code</h2>
       <p>Your code is:</p>
       <p style="font-size:32px;font-weight:700;letter-spacing:4px;color:#A855F7;text-align:center;">${p.code}</p>
       <p style="color:#888;">This code expires in 10 minutes.</p>`,
        `Your verification code is: ${p.code}`
      ),

    // --- Welcome ---
    welcome: () =>
      wrap(
        'Welcome to HustleXP!',
        `<h2 style="color:#F5F5F5;">Welcome to HustleXP! ⚡</h2>
       <p>You're all set to start earning XP. Whether you're posting tasks or hustling, every task completed earns reputation.</p>
       <p>Open the app to get started.</p>`,
        'Welcome to HustleXP! Open the app to get started.'
      ),

    // --- Security Alerts (fraud, suspension, moderation) ---
    security_alert: () =>
      wrap(
        `Security Alert: ${p.title || 'Important Update'}`,
        `<h2 style="color:#EF4444;">⚠️ Security Alert</h2>
       <p><strong>${p.title}</strong></p>
       <p>${p.body}</p>`,
        `Security Alert: ${p.title}. ${p.body}`
      ),

    // --- Payment Released ---
    payment_released: () =>
      wrap(
        'Payment released for your task',
        `<h2 style="color:#F5F5F5;">💰 Payment Released</h2>
       <p>Payment has been released for task <strong>"${p.title || p.taskTitle}"</strong>.</p>`,
        `Payment released for task "${p.title || p.taskTitle}".`
      ),

    // --- Generic Notification (catch-all for mapped categories) ---
    notification: () =>
      wrap(
        `${p.title || 'Notification from HustleXP'}`,
        `<h2 style="color:#F5F5F5;">${p.title || 'Notification'}</h2>
       <p>${p.body || ''}</p>`,
        `${p.title || 'Notification'}: ${p.body || ''}`
      ),
  };

  const templateFn = templates[template];
  if (!templateFn) {
    // Fallback: use 'notification' template with params
    return templates['notification']();
  }

  return templateFn();
}

// ============================================================================
// EMAIL WORKER
// ============================================================================

/**
 * Process email job
 * Should be called by BullMQ worker processor
 *
 * @param job BullMQ job containing email data
 */
export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  // Redis is transport only. Resolve and validate the immutable PostgreSQL
  // envelope before any delivery-state or outbox mutation, then use only the
  // canonical row for recipient and content.
  const hintedEmailId = job.data.payload.emailId;
  const hintedOutboxKey = job.data.outbox_idempotency_key
    || (job.id && !job.id.includes(':dispatch:') ? job.id : null);
  if (!hintedOutboxKey) throw new Error('Email job lacks durable outbox identity');
  const authorityResult = await db.query<CanonicalEmailAuthority>(
    `SELECT email.id,email.user_id,email.lead_id,email.to_email,email.template,email.params_json,
            email.status,email.attempts,email.max_attempts,email.suppressed_reason,
            email.idempotency_key,email.notification_id,email.provider_msg_id,
            email.provider_name,email.notification_provider_attempt_id,
            email.pre_provider_claim_id,outbox.id AS outbox_id,
            outbox.event_version AS outbox_event_version,outbox.payload AS outbox_payload,
            outbox.dispatch_attempt_id AS outbox_dispatch_attempt_id,
            outbox.bullmq_job_id AS outbox_bullmq_job_id
     FROM email_outbox email
     JOIN outbox_events outbox
       ON outbox.idempotency_key=email.idempotency_key
      AND outbox.event_type='email.send_requested'
      AND (
        (
          outbox.aggregate_type='email'
          AND outbox.aggregate_id=email.id
          AND email.user_id IS NOT NULL
          AND email.lead_id IS NULL
        )
        OR (
          outbox.aggregate_type='lead'
          AND outbox.aggregate_id=email.lead_id
          AND email.user_id IS NULL
          AND email.lead_id IS NOT NULL
          AND outbox.payload->>'emailId'=email.id::TEXT
        )
      )
     WHERE email.id=$1 AND outbox.idempotency_key=$2`,
    [hintedEmailId, hintedOutboxKey],
  );
  const authority = authorityResult.rows[0];
  const expectedPayload: EmailJobData['payload'] | null = authority
    ? {
        emailId: authority.id,
        ...(authority.user_id ? { userId: authority.user_id } : {}),
        toEmail: authority.to_email,
        template: authority.template,
        params: authority.params_json,
      }
    : null;
  const expectedAggregateType = authority?.lead_id ? 'lead' : 'email';
  const expectedAggregateId = authority?.lead_id ?? authority?.id;
  if (
    !authority
    || job.data.aggregate_type !== expectedAggregateType
    || job.data.aggregate_id !== expectedAggregateId
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
    throw new Error('Email job does not match canonical outbox authority');
  }

  const emailId = authority.id;
  const idempotencyKey = authority.idempotency_key;
  const notificationId = authority.notification_id;
  let userId = authority.user_id ?? undefined;
  let providerClaimToken: string | null = null;
  const preProviderClaimToken = randomUUID();
  const directProviderAttemptToken = randomUUID();
  const dispatchAuthority = {
    dispatchAttemptId: authority.outbox_dispatch_attempt_id,
    bullmqJobId: authority.outbox_bullmq_job_id,
  };

  const reconcilePersistedReceipt = async (
    record: CanonicalEmailAuthority,
  ): Promise<boolean> => {
    const providerMessageId = nonEmptyProviderMessageId(record.provider_msg_id);
    if (!providerMessageId) return false;
    if (record.notification_id) {
      if (!record.notification_provider_attempt_id) return false;
      await markNotificationProviderAccepted(
        record.notification_id,
        'email',
        record.provider_name || 'unknown',
        providerMessageId,
        record.notification_provider_attempt_id,
      );
    }
    const finalized = await db.query<{ id: string }>(
      `UPDATE email_outbox email
       SET status='sent',sent_at=COALESCE(sent_at,NOW()),updated_at=NOW()
       WHERE email.id=$1
         AND NULLIF(BTRIM(email.provider_msg_id),'')=$2
         AND email.notification_provider_attempt_id IS NOT DISTINCT FROM $3::UUID
         AND (
           $4::UUID IS NULL
           OR EXISTS (
             SELECT 1 FROM notification_deliveries delivery
             WHERE delivery.notification_id=$4::UUID
               AND delivery.channel='email'
               AND delivery.provider_attempt_id=$3::UUID
               AND delivery.state IN ('provider_accepted','delivered')
           )
         )
       RETURNING email.id`,
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
    // A provider receipt written with the exact notification claim token is
    // authoritative crash evidence. Reconcile it before generic in-flight or
    // outcome-unknown authorization can short-circuit the retry.
    const persistedProviderMessageId = nonEmptyProviderMessageId(authority.provider_msg_id);
    if (persistedProviderMessageId) {
      if (await reconcilePersistedReceipt(authority)) {
        await markOutboxEventProcessed(idempotencyKey, dispatchAuthority);
      }
      return;
    }

    if (notificationId) {
      const authorization = await authorizeNotificationDelivery(notificationId, 'email');
      if (!authorization.allowed) {
        if (authorization.reason === 'not_due') {
          await markOutboxEventFailed(idempotencyKey, 'notification_not_due', dispatchAuthority);
          return;
        }
        if (
          authorization.reason === 'superseded' ||
          authorization.reason === 'cancelled_superseded'
        ) {
          await markNotificationCancelled(notificationId, 'email', authorization.reason);
        }
        if (
          authorization.reason === 'provider_in_flight'
          || authorization.reason === 'provider_outcome_unknown'
        ) {
          return;
        }
        if (['superseded', 'cancelled_superseded', 'provider_accepted', 'delivered', 'suppressed', 'failed_terminal'].includes(authorization.reason)) {
          await markOutboxEventProcessed(idempotencyKey, dispatchAuthority);
          return;
        }
        throw new Error(`Email delivery refused: ${authorization.reason}`);
      }
    }

    // Resolve authority before claiming the durable row. Credentials by
    // themselves never authorize a live provider, and sink mode needs none.
    const deliveryPort = createOutboundEmailPort();

    // Phase 1: Atomic claim inside a transaction
    // SELECT FOR UPDATE + all idempotency/crash-recovery checks + CAS UPDATE must be atomic.
    // The row lock is held for the entire transaction, preventing concurrent workers from
    // reading the same 'pending' status and both attempting to claim the same email.
    type EmailClaimResult = {
      emailRecord: CanonicalEmailAuthority;
      claimed: boolean;
      shouldReturn: boolean;
      outboxKey?: string;
    };

    const claimResult = await db.transaction(async (txQuery) => {
      // Get email record from email_outbox table with FOR UPDATE lock (prevents concurrent processing)
      const emailResult = await txQuery<CanonicalEmailAuthority>(
        `SELECT email.id,email.user_id,email.lead_id,email.to_email,email.template,email.params_json,
                email.status,email.attempts,email.max_attempts,email.suppressed_reason,
                email.idempotency_key,email.notification_id,email.provider_msg_id,
                email.provider_name,email.notification_provider_attempt_id,email.pre_provider_claim_id,
                outbox.id::TEXT AS outbox_id,outbox.event_version AS outbox_event_version,
                outbox.payload AS outbox_payload,
                outbox.dispatch_attempt_id::TEXT AS outbox_dispatch_attempt_id,
                outbox.bullmq_job_id AS outbox_bullmq_job_id
         FROM email_outbox email
         JOIN outbox_events outbox
           ON outbox.idempotency_key=email.idempotency_key
          AND outbox.event_type='email.send_requested'
          AND (
            (outbox.aggregate_type='email' AND outbox.aggregate_id=email.id
              AND email.user_id IS NOT NULL AND email.lead_id IS NULL)
            OR (outbox.aggregate_type='lead' AND outbox.aggregate_id=email.lead_id
              AND email.user_id IS NULL AND email.lead_id IS NOT NULL
              AND outbox.payload->>'emailId'=email.id::TEXT)
          )
         WHERE email.id = $1
           AND outbox.idempotency_key=$2
           AND outbox.dispatch_attempt_id=$3::UUID
           AND outbox.bullmq_job_id=$4
         FOR UPDATE OF email,outbox`,
        [
          emailId,
          idempotencyKey,
          dispatchAuthority.dispatchAttemptId,
          dispatchAuthority.bullmqJobId,
        ]
      );

      if (emailResult.rows.length === 0) {
        throw new Error(`Email ${emailId} not found in email_outbox`);
      }

      const emailRecord = emailResult.rows[0];
      const lockedExpectedPayload: EmailJobData['payload'] = {
        emailId: emailRecord.id,
        ...(emailRecord.user_id ? { userId: emailRecord.user_id } : {}),
        toEmail: emailRecord.to_email,
        template: emailRecord.template,
        params: emailRecord.params_json,
      };
      if (
        stableJson(emailRecord.outbox_payload) !== stableJson(lockedExpectedPayload)
        || stableJson(job.data.payload) !== stableJson(emailRecord.outbox_payload)
      ) {
        throw new Error('Email claim no longer matches canonical outbox authority');
      }

      // Structured log: job started
      log.info(
        {
          emailId,
          jobId: job.id,
          idempotencyKey: emailRecord.idempotency_key,
          currentStatus: emailRecord.status,
          attempt: emailRecord.attempts,
        },
        'Email job started'
      );

      // Idempotency check: If already sent, skip processing (idempotent replay)
      if (emailRecord.status === 'sent') {
        log.info(
          {
            emailId,
            jobId: job.id,
            idempotencyKey: emailRecord.idempotency_key,
            status: emailRecord.status,
            providerMsgId: emailRecord.provider_msg_id,
          },
          'Email already sent, replay skipped'
        );
        const outboxKey = emailRecord.idempotency_key || idempotencyKey;
        return {
          emailRecord,
          claimed: false,
          shouldReturn: true,
          outboxKey,
        } satisfies EmailClaimResult;
      }

      // Crash recovery check: If provider_msg_id exists, email was already sent (SendGrid succeeded but DB update failed)
      const persistedRecordMessageId = nonEmptyProviderMessageId(emailRecord.provider_msg_id);
      if (persistedRecordMessageId && emailRecord.status !== 'sent') {
        log.warn(
          {
            emailId,
            jobId: job.id,
            idempotencyKey: emailRecord.idempotency_key,
            providerMsgId: persistedRecordMessageId,
          },
          'Email crash recovery: provider_msg_id exists but status not sent'
        );

        const outboxKey = emailRecord.idempotency_key || idempotencyKey;
        return {
          emailRecord,
          claimed: false,
          shouldReturn: true,
          outboxKey,
        } satisfies EmailClaimResult;
      }

      // Check if email is suppressed
      if (emailRecord.status === 'suppressed' || emailRecord.suppressed_reason) {
        log.warn(
          {
            emailId,
            jobId: job.id,
            idempotencyKey: emailRecord.idempotency_key,
            suppressedReason: emailRecord.suppressed_reason || 'status_suppressed',
          },
          'Email suppressed, skipping'
        );
        throw new Error(`Email is suppressed: ${emailRecord.suppressed_reason || 'suppressed'}`);
      }

      // Check if max attempts exceeded (poison message)
      if (
        emailRecord.attempts >= emailRecord.max_attempts
        && emailRecord.status !== 'sending'
      ) {
        log.warn(
          {
            emailId,
            jobId: job.id,
            idempotencyKey: emailRecord.idempotency_key,
            attempts: emailRecord.attempts,
            maxAttempts: emailRecord.max_attempts,
          },
          'Email max attempts exceeded'
        );
        throw new Error(`Max attempts (${emailRecord.max_attempts}) exceeded for email ${emailId}`);
      }

      // ATOMIC CLAIM: Update status to sending only if still in claimable state.
      // CRITICAL: This is the atomic claim - only one worker can transition pending/failed -> sending.
      // Using UPDATE ... RETURNING ensures we only proceed if we successfully claimed the row.
      //
      // BUG 7 FIX: Add a staleness recovery clause for rows stuck in 'sending'.
      // If the process crashes after the claim commit but before the suppression UPDATE,
      // the row is permanently stuck in 'sending' and can never be re-claimed.
      // The additional OR clause recovers rows that have been in 'sending' for more than
      // 5 minutes (indicating a crashed worker), making them re-claimable on the next retry.
      const casResult = await txQuery<{
        id: string;
        status: string;
        attempts: number;
      }>(
        `UPDATE email_outbox
         SET status = 'sending',
             attempts = CASE WHEN status = 'sending' THEN attempts ELSE attempts + 1 END,
             pre_provider_claim_id = $2::UUID,
             pre_provider_claimed_at = NOW(),
             pre_provider_claim_deadline_at = NOW() + make_interval(secs => $3::INTEGER),
             provider_io_started_at = NULL,
             notification_provider_attempt_id = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND (
             status IN ('pending', 'failed')
             OR (
               status = 'sending'
               AND provider_io_started_at IS NULL
               AND provider_msg_id IS NULL
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
         RETURNING id, status, attempts`,
        [
          emailId,
          preProviderClaimToken,
          PRE_PROVIDER_LEASE_SECONDS,
          idempotencyKey,
          dispatchAuthority.dispatchAttemptId,
          dispatchAuthority.bullmqJobId,
        ]
      );

      // If no row returned, another worker already claimed this email (or status changed)
      if (casResult.rowCount === 0) {
        // Structured log for verification
        log.warn(
          {
            emailId,
            jobId: job.id,
            idempotencyKey: emailRecord.idempotency_key,
            currentStatus: emailRecord.status,
          },
          'Email claim failed: already claimed or invalid status'
        );
        return {
          emailRecord,
          claimed: false,
          shouldReturn: true,
        } satisfies EmailClaimResult;
      }

      const claimedEmail = casResult.rows[0];

      // Structured log: claim successful
      log.info(
        {
          emailId,
          jobId: job.id,
          idempotencyKey: emailRecord.idempotency_key,
          statusTransition: `${emailRecord.status} -> sending`,
          attempt: claimedEmail.attempts,
        },
        'Email claimed'
      );

      return { emailRecord, claimed: true, shouldReturn: false } satisfies EmailClaimResult;
    });

    // Handle early-return cases from the transaction (already-sent, crash-recovery, claim-lost)
    if (claimResult.shouldReturn) {
      const persistedReceipt = nonEmptyProviderMessageId(claimResult.emailRecord.provider_msg_id);
      const finalized = persistedReceipt
        ? await reconcilePersistedReceipt(claimResult.emailRecord)
        : claimResult.emailRecord.status === 'sent';
      if (finalized && claimResult.outboxKey) {
        await markOutboxEventProcessed(claimResult.outboxKey, dispatchAuthority);
      }
      return;
    }

    // Phase 2: Authorized port call (outside transaction — never hold a DB
    // transaction open while waiting for a provider or synthetic sink).
    const emailRecord = claimResult.emailRecord;

    // Check if user is suppressed BEFORE sending (additional safety check)
    if (userId || emailRecord.user_id) {
      const userCheck = await db.query<{ do_not_email: boolean }>(
        `SELECT do_not_email FROM users WHERE id = $1`,
        [userId || emailRecord.user_id]
      );

      if (userCheck.rows.length > 0 && userCheck.rows[0].do_not_email === true) {
        // User is suppressed. Only the worker that still owns the bounded
        // pre-provider lease may close the immutable event or notification
        // state. A paused claimant can otherwise resume after recovery handed
        // the row to a new worker and suppress that worker's active delivery.
        const suppressed = await db.query<{ id: string }>(
          `UPDATE email_outbox
           SET status = 'suppressed',
               suppressed_reason = 'user_do_not_email',
               suppressed_at = NOW(),
               pre_provider_claim_id = NULL,
               pre_provider_claimed_at = NULL,
               pre_provider_claim_deadline_at = NULL,
               updated_at = NOW()
           WHERE id = $1
             AND status='sending'
             AND pre_provider_claim_id=$2::UUID
             AND provider_io_started_at IS NULL
           RETURNING id`,
          [emailId, preProviderClaimToken]
        );
        if (!suppressed.rows[0]) return;

        log.info(
          {
            emailId,
            jobId: job.id,
            idempotencyKey: emailRecord.idempotency_key,
            userId: userId || emailRecord.user_id,
          },
          'Email suppressed: user do_not_email flag'
        );

        // Mark the outbox event processed so the row does not remain stuck as
        // 'enqueued' and the poller never re-enqueues this suppressed email.
        const suppressionOutboxKey = emailRecord.idempotency_key || idempotencyKey;
        if (suppressionOutboxKey) {
          await markOutboxEventProcessed(suppressionOutboxKey, dispatchAuthority);
        }

        if (notificationId) {
          await markNotificationSuppressed(notificationId, 'email', 'user_do_not_email');
        }

        return; // Exit without sending
      }
    }

    // Render email template
    const emailContent = renderEmailTemplate(emailRecord.template, emailRecord.params_json);

    const outboundMessage = {
      idempotencyKey: emailRecord.idempotency_key || idempotencyKey,
      to: emailRecord.to_email,
      from: config.identity.sendgrid.fromEmail,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
      emailId,
      userId: emailRecord.user_id || undefined,
    };

    // Structured log: sending attempt
    log.info(
      {
        emailId,
        jobId: job.id,
        idempotencyKey: emailRecord.idempotency_key,
        attempt: emailRecord.attempts + 1,
        toEmail: emailRecord.to_email,
        template: emailRecord.template,
      },
      'Email sending'
    );

    const providerBoundary = await db.transaction(async (query) => {
      if (notificationId) {
        await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
      }
      const owned = await query<{ id: string }>(
        `UPDATE email_outbox
         SET pre_provider_claim_deadline_at=NOW()+make_interval(secs => $3::INTEGER),
             updated_at=NOW()
         WHERE id=$1 AND status='sending'
           AND pre_provider_claim_id=$2::UUID
           AND provider_io_started_at IS NULL
           AND pre_provider_claim_deadline_at > NOW()
         RETURNING id`,
        [emailId, preProviderClaimToken, PRE_PROVIDER_LEASE_SECONDS],
      );
      if (!owned.rows[0]) {
        return { allowed: false as const, reason: 'pre_provider_claim_lost' as const };
      }

      const notificationClaim = notificationId
        ? await claimNotificationDelivery(notificationId, 'email', undefined, query)
        : { allowed: true as const, claimToken: directProviderAttemptToken };
      if (!notificationClaim.allowed) return notificationClaim;

      const started = await query<{ id: string }>(
        `UPDATE email_outbox
         SET provider_io_started_at=NOW(),
             notification_provider_attempt_id=$3::UUID,
             updated_at=NOW()
         WHERE id=$1 AND status='sending'
           AND pre_provider_claim_id=$2::UUID
           AND provider_io_started_at IS NULL
         RETURNING id`,
        [emailId, preProviderClaimToken, notificationClaim.claimToken],
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
          `UPDATE email_outbox
           SET status='pending',attempts=GREATEST(attempts-1,0),
               pre_provider_claim_id=NULL,pre_provider_claimed_at=NULL,
               pre_provider_claim_deadline_at=NULL,updated_at=NOW()
           WHERE id=$1 AND pre_provider_claim_id=$2::UUID
             AND provider_io_started_at IS NULL`,
          [emailId, preProviderClaimToken],
        );
        await markOutboxEventFailed(idempotencyKey, 'notification_not_due', dispatchAuthority);
        return;
      }
      if (reason === 'superseded' || reason === 'cancelled_superseded') {
        await markNotificationCancelled(notificationId!, 'email', reason);
      }
      if (['superseded', 'cancelled_superseded', 'provider_accepted', 'delivered', 'suppressed', 'failed_terminal'].includes(reason)) {
        await db.query(
          `UPDATE email_outbox
           SET status=CASE WHEN $3 IN ('provider_accepted','delivered') THEN 'sent' ELSE 'suppressed' END,
               suppressed_reason=CASE WHEN $3 IN ('provider_accepted','delivered') THEN suppressed_reason ELSE $3 END,
               suppressed_at=CASE WHEN $3 IN ('provider_accepted','delivered') THEN suppressed_at ELSE NOW() END,
               pre_provider_claim_id=NULL,pre_provider_claimed_at=NULL,
               pre_provider_claim_deadline_at=NULL,updated_at=NOW()
           WHERE id=$1 AND pre_provider_claim_id=$2::UUID
             AND provider_io_started_at IS NULL`,
          [emailId, preProviderClaimToken, reason],
        );
        await markOutboxEventProcessed(idempotencyKey, dispatchAuthority);
        return;
      }
      throw new Error(`Email delivery claim refused: ${reason}`);
    }
    providerClaimToken = providerBoundary.claimToken;

    const receipt = await deliveryPort.deliver(outboundMessage);
    const providerMsgId = nonEmptyProviderMessageId(receipt.providerMessageId);
    if (!providerMsgId) throw new Error('Email provider returned no message receipt ID');

    // Store provider_msg_id IMMEDIATELY after SendGrid success (for crash recovery)
    // This allows us to detect "already sent" even if DB update fails
    const receiptPersistResult = await db.query<{ id: string }>(
      `UPDATE email_outbox
       SET provider_msg_id = $1,
           provider_name = $2,
           notification_provider_attempt_id = $4::UUID,
           updated_at = NOW()
       WHERE id = $3
         AND status='sending'
         AND pre_provider_claim_id=$5::UUID
         AND provider_io_started_at IS NOT NULL
         AND notification_provider_attempt_id IS NOT DISTINCT FROM $4::UUID
       RETURNING id`,
      [providerMsgId, receipt.providerKind, emailId, providerClaimToken, preProviderClaimToken]
    );
    if (!receiptPersistResult.rows[0]) {
      throw new Error('Email provider receipt could not be bound to the active claim');
    }

    // Update email_outbox table (status=sent)
    // CRITICAL: Update only if still in 'sending' state (prevents overwriting if another worker completed)
    // Note: provider_msg_id already stored above for crash recovery
    const finalUpdateResult = await db.query<{
      id: string;
      status: string;
      provider_msg_id: string;
    }>(
      `UPDATE email_outbox
       SET status = 'sent',
           sent_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'sending'
         AND pre_provider_claim_id=$2::UUID
         AND notification_provider_attempt_id IS NOT DISTINCT FROM $3::UUID
       RETURNING id, status, provider_msg_id`,
      [emailId, preProviderClaimToken, providerClaimToken]
    );

    // If update affected 0 rows, another worker already marked this as sent
    if (finalUpdateResult.rowCount === 0) {
      log.info(
        { emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, providerMsgId },
        'Email already sent by another worker'
      );
      return; // Already processed, exit gracefully
    }

    const finalEmail = finalUpdateResult.rows[0];

    if (notificationId) {
      await markNotificationProviderAccepted(
        notificationId,
        'email',
        receipt.providerKind,
        finalEmail.provider_msg_id || providerMsgId || null,
        providerClaimToken,
      );
    }

    // Mark outbox event as processed (if processing from outbox)
    // Use idempotency_key from email_outbox record (deterministic)
    const outboxKey = emailRecord.idempotency_key || idempotencyKey;
    if (outboxKey) {
      await markOutboxEventProcessed(outboxKey, dispatchAuthority);
    }

    // Structured log: email sent successfully
    log.info(
      {
        emailId,
        jobId: job.id,
        idempotencyKey: emailRecord.idempotency_key,
        outboxEventId: outboxKey,
        attempt: emailRecord.attempts + 1,
        providerMsgId: finalEmail.provider_msg_id || providerMsgId,
        toEmail: emailRecord.to_email,
        template: emailRecord.template,
      },
      'Email sent successfully'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Get email record idempotency key for logging (may be null if error before SELECT)
    // Do NOT fall back to job.id — that is a BullMQ job ID, not the DB idempotency_key.
    // markOutboxEventFailed/Processed keyed on job.id silently finds no row.
    let outboxKey: string | null = null;
    let currentAttempts = 0;
    let maxAttempts = 3;

    try {
      // Try to get current state for logging
      const currentState = await db.query<{
        idempotency_key: string;
        attempts: number;
        max_attempts: number;
        status: string;
        user_id: string | null;
      }>(
        `SELECT idempotency_key, attempts, max_attempts, status, user_id FROM email_outbox WHERE id = $1`,
        [emailId]
      );

      if (currentState.rows.length > 0) {
        outboxKey = currentState.rows[0].idempotency_key || null;
        currentAttempts = currentState.rows[0].attempts;
        maxAttempts = currentState.rows[0].max_attempts;
        userId = userId || currentState.rows[0].user_id || undefined;
      }
    } catch {
      // Ignore errors fetching current state
    }

    // Structured log: error occurred
    log.error(
      {
        emailId,
        jobId: job.id,
        idempotencyKey: outboxKey,
        err: errorMessage,
        attempt: currentAttempts,
      },
      'Email send error'
    );

    // Suppression early-exit: the email_outbox row already has status='suppressed' (or a
    // suppressed_reason set). The throw inside the transaction is intentional — it exits
    // cleanly and signals "do not send". Without this guard, the error would fall through
    // to the retry path below and reset status to 'pending'/'failed', causing an infinite
    // BullMQ retry loop until max_attempts is exhausted.
    if (errorMessage.includes('Email is suppressed')) {
      log.info(
        { emailId, jobId: job.id, idempotencyKey: outboxKey, error: errorMessage },
        'Email suppressed, skipping retry'
      );
      // The durable row was already terminal before this claimant acquired a
      // lease. Reconcile only this exact dispatch; do not apply user or
      // notification side effects without local/provider ownership.
      if (outboxKey) {
        await markOutboxEventProcessed(outboxKey, dispatchAuthority);
      }
      return;
    }

    // Handle SendGrid suppression errors (bounces, complaints, unsubscribes)
    // Only treat as a hard suppression when SendGrid returns a structured delivery-failure
    // status code. Raw string matching on errorMessage risks permanently silencing a user
    // on a transient error whose message coincidentally contains "bounce" or "suppressed".
    //
    // SendGrid permanent-failure codes:
    //   550  — Mailbox does not exist / hard bounce
    //   551  — User not local / forwarding failed
    //   552  — Mailbox full (treated as hard bounce by SG)
    //   553  — Mailbox name not allowed
    //   554  — Transaction failed / permanent rejection
    //   421  — (transient) — NOT a suppression signal
    //
    // The @sendgrid/mail client wraps HTTP errors as objects with a `code` field and
    // a nested `response.body.errors[].message`. We inspect the structured code first,
    // then fall back to checking the top-level error code property.
    const sgError = error as Record<string, unknown>;
    const sgCode = typeof sgError.code === 'number' ? sgError.code : NaN;
    // HTTP 400 from SendGrid on known suppression list membership
    const sgBody = sgError.response as Record<string, unknown> | undefined;
    const sgResponseBody = sgBody?.body as Record<string, unknown> | undefined;
    const sgErrors: Array<{ message?: string }> = Array.isArray(sgResponseBody?.errors)
      ? (sgResponseBody!.errors as Array<{ message?: string }>)
      : [];

    // Structured suppression: HTTP 4xx hard-bounce codes or explicit suppression list hit
    const HARD_BOUNCE_HTTP_CODES = new Set([550, 551, 552, 553, 554]);
    const isSgHardBounce = HARD_BOUNCE_HTTP_CODES.has(sgCode);
    // SendGrid returns HTTP 400 with error messages referencing suppression lists
    const SUPPRESSION_ERROR_MESSAGES = [
      'The from address does not match a verified Sender Identity',
    ] as const;
    // Only match exact known SendGrid suppression list error messages — not substring
    const isSgSuppressionListError =
      sgCode === 400 &&
      sgErrors.some(
        (e) =>
          typeof e.message === 'string' &&
          SUPPRESSION_ERROR_MESSAGES.some((known) => e.message === known)
      );

    const isSuppressionError = isSgHardBounce || isSgSuppressionListError;

    // Truncate suppressed_reason to 500 chars before storing — prevent oversized DB writes
    const suppressedReason = errorMessage.substring(0, 500);

    if (providerClaimToken && !isSuppressionError) {
      await db.transaction(async (query) => {
        if (notificationId) {
          await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
        }
        const outcomeUnknown = await query<{ id: string }>(
          `UPDATE email_outbox
           SET status = 'provider_outcome_unknown',
               last_error = $1,
               updated_at = NOW()
           WHERE id = $2 AND status = 'sending'
             AND notification_provider_attempt_id=$3::UUID
             AND provider_io_started_at IS NOT NULL
           RETURNING id`,
          [errorMessage, emailId, providerClaimToken],
        );
        if (!outcomeUnknown.rows[0]) return;
        if (notificationId) {
          await markNotificationProviderOutcomeUnknown(
            notificationId,
            'email',
            errorMessage,
            providerClaimToken!,
            query,
          );
        }
        if (outboxKey) {
          await markOutboxEventProcessed(outboxKey, dispatchAuthority, { query });
        }
      });
      return;
    }

    if (isSuppressionError) {
      const suppressionCommitted = await db.transaction(async (query) => {
        if (notificationId) {
          await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
        }
        const suppressed = await query<{ id: string }>(
          `UPDATE email_outbox
           SET status = 'suppressed',
               suppressed_reason = $1,
               suppressed_at = NOW(),
               updated_at = NOW()
           WHERE id = $2
             AND (
               ($3::UUID IS NOT NULL AND notification_provider_attempt_id=$3::UUID
                 AND provider_io_started_at IS NOT NULL)
               OR ($3::UUID IS NULL AND pre_provider_claim_id=$4::UUID
                 AND provider_io_started_at IS NULL)
             )
           RETURNING id`,
          [suppressedReason, emailId, providerClaimToken, preProviderClaimToken],
        );
        if (!suppressed.rows[0]) return false;
        if (userId) {
          await query(
            `UPDATE users SET do_not_email=true,updated_at=NOW() WHERE id=$1`,
            [userId],
          );
        }
        if (notificationId) {
          await markNotificationSuppressed(
            notificationId,
            'email',
            suppressedReason,
            providerClaimToken,
            query,
          );
        }
        if (outboxKey) {
          await markOutboxEventProcessed(outboxKey, dispatchAuthority, { query });
        }
        return true;
      });
      if (!suppressionCommitted) return;

      log.info(
        { emailId, jobId: job.id, idempotencyKey: outboxKey, suppressedReason, userId, sgCode },
        'Email suppressed due to hard bounce/complaint'
      );
      return;
    } else {
      // Update email_outbox with error (for retry)
      // Check current attempts to determine if we should mark as failed (poison message)
      const shouldMarkFailed = currentAttempts >= maxAttempts;

      const retryOwned = await db.transaction(async (query) => {
        if (notificationId) {
          await query('SELECT id FROM notifications WHERE id=$1 FOR UPDATE', [notificationId]);
        }
        const owned = await query<{ id: string }>(
          `UPDATE email_outbox
           SET status = $1,
               last_error = $2,
               pre_provider_claim_id = NULL,
               pre_provider_claimed_at = NULL,
               pre_provider_claim_deadline_at = NULL,
               updated_at = NOW()
           WHERE id = $3
             AND pre_provider_claim_id=$4::UUID
             AND provider_io_started_at IS NULL
           RETURNING id`,
          [shouldMarkFailed ? 'failed' : 'pending', errorMessage, emailId, preProviderClaimToken],
        );
        if (!owned.rows[0]) return false;
        if (notificationId) {
          await markNotificationDeliveryFailure(
            notificationId,
            'email',
            errorMessage,
            null,
            query,
            null,
            shouldMarkFailed,
          );
        } else if (outboxKey) {
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
            emailId,
            jobId: job.id,
            idempotencyKey: outboxKey,
            attempts: currentAttempts,
            maxAttempts,
            err: errorMessage,
          },
          'Email poison message: max attempts exceeded'
        );

        // BUG FIX: Dead-lettered emails were silently dropped with no admin
        // visibility. Send a non-fatal admin alert so the failure is surfaced
        // for manual review. Errors here must not interfere with the normal
        // error-handling / retry path below.
        const emailType = job.data?.payload?.template ?? 'unknown';
        try {
          await notifyAdmins({
            title: 'Email delivery permanently failed',
            body: `emailId ${emailId} (type: ${emailType}) exhausted all retries. Manual review required.`,
            deepLink: 'app://admin/email-outbox',
            priority: 'HIGH',
            metadata: {
              emailId,
              emailType,
              attempts: currentAttempts,
              maxAttempts,
              lastError: errorMessage,
            },
          });
        } catch (alertErr) {
          log.error({ alertErr }, 'Failed to send dead-letter admin alert');
        }
      }
    }

    // Re-throw error for BullMQ retry logic (unless max attempts exceeded - then don't retry)
    if (currentAttempts >= maxAttempts) {
      // Don't throw - let job complete as failed (no more retries)
      return;
    }

    throw error;
  }
}
