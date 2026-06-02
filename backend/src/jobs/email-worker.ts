/**
 * Email Worker v1.0.0
 * 
 * SYSTEM GUARANTEES: Asynchronous Email Delivery with SendGrid
 * 
 * Processes email_outbox table from BullMQ.
 * Sends emails via SendGrid with retries, backoff, and suppression handling.
 * 
 * Pattern:
 * 1. Job processor receives email job (from email_outbox table)
 * 2. Send email via SendGrid
 * 3. Update email_outbox table (status=sent, provider_msg_id)
 * 4. Handle suppression (mark do_not_email=true on user profile)
 * 
 * Hard rule: Email send is never inline on request paths - always async
 * 
 * @see ARCHITECTURE.md §2.6 (Email Service)
 */

import { db } from '../db.js';
import { config } from '../config.js';
import sgMail from '@sendgrid/mail';
import { markOutboxEventProcessed, markOutboxEventFailed } from './outbox-worker.js';
import { workerLogger } from '../logger.js';
import type { Job } from 'bullmq';
import { sendgridBreaker } from '../middleware/circuit-breaker.js';
import { notifyAdmins } from '../services/AdminNotificationHelper.js';

const log = workerLogger.child({ worker: 'email' });

// ============================================================================
// SENDGRID SETUP
// ============================================================================

// Initialize SendGrid client
if (config.identity.sendgrid.apiKey) {
  sgMail.setApiKey(config.identity.sendgrid.apiKey);
}

// ============================================================================
// TYPES
// ============================================================================

interface EmailJobData {
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  payload: {
    emailId: string;
    userId?: string;
    toEmail: string;
    template: string;
    params: Record<string, unknown>;
  };
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
    // --- Data Export ---
    'export_ready': () => wrap(
      'Your data export is ready',
      `<h2 style="color:#F5F5F5;">Your data export is ready</h2>
       <p>Download your export using the link below. It will expire on ${p.expiresAt}.</p>
       <a href="${p.downloadUrl}" style="display:inline-block;padding:12px 24px;background:#A855F7;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Download Export</a>`,
      `Your data export is ready. Download it at ${p.downloadUrl}. This link expires on ${p.expiresAt}.`,
    ),

    // --- Task Status Changes ---
    'task_status_changed': () => wrap(
      `Task update: ${p.title || p.taskTitle || 'Your task'}`,
      `<h2 style="color:#F5F5F5;">Task Status Updated</h2>
       <p>Your task <strong>"${p.title || p.taskTitle}"</strong> has changed to <strong>${p.status || p.body}</strong>.</p>`,
      `Task "${p.title || p.taskTitle}" status changed to ${p.status || p.body}.`,
    ),

    // --- Account Deletion ---
    'deletion_confirmed': () => wrap(
      'Account deletion completed',
      `<h2 style="color:#F5F5F5;">Account Deleted</h2>
       <p>Your HustleXP account and all associated personal data have been permanently deleted per your GDPR request. This action cannot be undone.</p>`,
      'Your HustleXP account and all associated data have been permanently deleted.',
    ),

    // --- Verification Code ---
    'verification_code': () => wrap(
      'Your verification code',
      `<h2 style="color:#F5F5F5;">Verification Code</h2>
       <p>Your code is:</p>
       <p style="font-size:32px;font-weight:700;letter-spacing:4px;color:#A855F7;text-align:center;">${p.code}</p>
       <p style="color:#888;">This code expires in 10 minutes.</p>`,
      `Your verification code is: ${p.code}`,
    ),

    // --- Welcome ---
    'welcome': () => wrap(
      'Welcome to HustleXP!',
      `<h2 style="color:#F5F5F5;">Welcome to HustleXP! ⚡</h2>
       <p>You're all set to start earning XP. Whether you're posting tasks or hustling, every task completed earns reputation.</p>
       <p>Open the app to get started.</p>`,
      'Welcome to HustleXP! Open the app to get started.',
    ),

    // --- Security Alerts (fraud, suspension, moderation) ---
    'security_alert': () => wrap(
      `Security Alert: ${p.title || 'Important Update'}`,
      `<h2 style="color:#EF4444;">⚠️ Security Alert</h2>
       <p><strong>${p.title}</strong></p>
       <p>${p.body}</p>`,
      `Security Alert: ${p.title}. ${p.body}`,
    ),

    // --- Payment Released ---
    'payment_released': () => wrap(
      'Payment released for your task',
      `<h2 style="color:#F5F5F5;">💰 Payment Released</h2>
       <p>Payment has been released for task <strong>"${p.title || p.taskTitle}"</strong>.</p>`,
      `Payment released for task "${p.title || p.taskTitle}".`,
    ),

    // --- Generic Notification (catch-all for mapped categories) ---
    'notification': () => wrap(
      `${p.title || 'Notification from HustleXP'}`,
      `<h2 style="color:#F5F5F5;">${p.title || 'Notification'}</h2>
       <p>${p.body || ''}</p>`,
      `${p.title || 'Notification'}: ${p.body || ''}`,
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
  // Extract data from job payload (structured as outbox event)
  const { emailId, toEmail, template, params } = job.data.payload;
  let userId = job.data.payload.userId;
  const idempotencyKey = job.id || `email:${emailId}`;
  
  if (!config.identity.sendgrid.apiKey) {
    throw new Error('SendGrid API key not configured (SENDGRID_API_KEY required)');
  }
  
  try {
    // Phase 1: Atomic claim inside a transaction
    // SELECT FOR UPDATE + all idempotency/crash-recovery checks + CAS UPDATE must be atomic.
    // The row lock is held for the entire transaction, preventing concurrent workers from
    // reading the same 'pending' status and both attempting to claim the same email.
    type EmailClaimResult = {
      emailRecord: { id: string; user_id: string | null; to_email: string; template: string; params_json: Record<string, unknown>; status: string; attempts: number; max_attempts: number; suppressed_reason: string | null; idempotency_key: string; provider_msg_id: string | null };
      claimed: boolean;
      shouldReturn: boolean;
      outboxKey?: string;
    };

    const claimResult = await db.transaction(async (txQuery) => {
      // Get email record from email_outbox table with FOR UPDATE lock (prevents concurrent processing)
      const emailResult = await txQuery<{
        id: string;
        user_id: string | null;
        to_email: string;
        template: string;
        params_json: Record<string, unknown>;
        status: string;
        attempts: number;
        max_attempts: number;
        suppressed_reason: string | null;
        idempotency_key: string;
        provider_msg_id: string | null;
      }>(
        `SELECT id, user_id, to_email, template, params_json, status, attempts, max_attempts, suppressed_reason, idempotency_key, provider_msg_id
         FROM email_outbox
         WHERE id = $1
         FOR UPDATE`, // Lock row for update (prevents concurrent processing)
        [emailId]
      );

      if (emailResult.rows.length === 0) {
        throw new Error(`Email ${emailId} not found in email_outbox`);
      }

      const emailRecord = emailResult.rows[0];

      // Structured log: job started
      log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, currentStatus: emailRecord.status, attempt: emailRecord.attempts }, 'Email job started');

      // Idempotency check: If already sent, skip processing (idempotent replay)
      if (emailRecord.status === 'sent') {
        log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, status: emailRecord.status, providerMsgId: emailRecord.provider_msg_id }, 'Email already sent, replay skipped');
        const outboxKey = emailRecord.idempotency_key || idempotencyKey;
        return { emailRecord, claimed: false, shouldReturn: true, outboxKey } satisfies EmailClaimResult;
      }

      // Crash recovery check: If provider_msg_id exists, email was already sent (SendGrid succeeded but DB update failed)
      if (emailRecord.provider_msg_id && emailRecord.status !== 'sent') {
        await txQuery(
          `UPDATE email_outbox
           SET status = 'sent',
               sent_at = COALESCE(sent_at, NOW()),
               updated_at = NOW()
           WHERE id = $1`,
          [emailId]
        );

        log.warn({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, providerMsgId: emailRecord.provider_msg_id }, 'Email crash recovery: provider_msg_id exists but status not sent');

        const outboxKey = emailRecord.idempotency_key || idempotencyKey;
        return { emailRecord, claimed: false, shouldReturn: true, outboxKey } satisfies EmailClaimResult;
      }

      // Check if email is suppressed
      if (emailRecord.status === 'suppressed' || emailRecord.suppressed_reason) {
        log.warn({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, suppressedReason: emailRecord.suppressed_reason || 'status_suppressed' }, 'Email suppressed, skipping');
        throw new Error(`Email is suppressed: ${emailRecord.suppressed_reason || 'suppressed'}`);
      }

      // Check if max attempts exceeded (poison message)
      if (emailRecord.attempts >= emailRecord.max_attempts) {
        log.warn({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, attempts: emailRecord.attempts, maxAttempts: emailRecord.max_attempts }, 'Email max attempts exceeded');
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
             updated_at = NOW()
         WHERE id = $1
           AND (
             status IN ('pending', 'failed')
             OR (status = 'sending' AND updated_at < NOW() - INTERVAL '5 minutes')
           )
         RETURNING id, status, attempts`,
        [emailId]
      );

      // If no row returned, another worker already claimed this email (or status changed)
      if (casResult.rowCount === 0) {
        // Structured log for verification
        log.warn({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, currentStatus: emailRecord.status }, 'Email claim failed: already claimed or invalid status');
        const outboxKey = emailRecord.idempotency_key || idempotencyKey;
        return { emailRecord, claimed: false, shouldReturn: true, outboxKey } satisfies EmailClaimResult;
      }

      const claimedEmail = casResult.rows[0];

      // Structured log: claim successful
      log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, statusTransition: `${emailRecord.status} -> sending`, attempt: claimedEmail.attempts }, 'Email claimed');

      return { emailRecord, claimed: true, shouldReturn: false } satisfies EmailClaimResult;
    });

    // Handle early-return cases from the transaction (already-sent, crash-recovery, claim-lost)
    if (claimResult.shouldReturn) {
      if (claimResult.outboxKey) {
        await markOutboxEventProcessed(claimResult.outboxKey);
      }
      return;
    }

    // Phase 2: External SendGrid call (outside transaction — never hold a DB transaction
    // open while waiting for a network call to an external service)
    const emailRecord = claimResult.emailRecord;

    // Check if user is suppressed BEFORE sending (additional safety check)
    if (userId || emailRecord.user_id) {
      const userCheck = await db.query<{ do_not_email: boolean }>(
        `SELECT do_not_email FROM users WHERE id = $1`,
        [userId || emailRecord.user_id]
      );
      
      if (userCheck.rows.length > 0 && userCheck.rows[0].do_not_email === true) {
        // User is suppressed - mark as suppressed and exit
        await db.query(
          `UPDATE email_outbox
           SET status = 'suppressed',
               suppressed_reason = 'user_do_not_email',
               suppressed_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [emailId]
        );
        
        log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, userId: userId || emailRecord.user_id }, 'Email suppressed: user do_not_email flag');

        // Mark the outbox event processed so the row does not remain stuck as
        // 'enqueued' and the poller never re-enqueues this suppressed email.
        const suppressionOutboxKey = emailRecord.idempotency_key || idempotencyKey;
        if (suppressionOutboxKey) {
          await markOutboxEventProcessed(suppressionOutboxKey);
        }

        return; // Exit without sending
      }
    }
    
    // Render email template
    const emailContent = renderEmailTemplate(template, params || emailRecord.params_json);
    
    // Send email via SendGrid
    const msg = {
      to: toEmail || emailRecord.to_email,
      from: config.identity.sendgrid.fromEmail,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
      // SendGrid tracking options
      trackingSettings: {
        clickTracking: { enable: true },
        openTracking: { enable: true },
      },
      // Custom args for webhook events (optional)
      customArgs: {
        emailId,
        userId: userId || emailRecord.user_id || '',
      },
    };
    
    // Structured log: sending attempt
    log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, attempt: emailRecord.attempts + 1, toEmail: toEmail || emailRecord.to_email, template }, 'Email sending');
    
    const [response] = await sendgridBreaker.execute(() => sgMail.send(msg));
    
    // Extract SendGrid message ID from response
    const providerMsgId = response.headers['x-message-id'] || '';
    
    // Store provider_msg_id IMMEDIATELY after SendGrid success (for crash recovery)
    // This allows us to detect "already sent" even if DB update fails
    await db.query(
      `UPDATE email_outbox
       SET provider_msg_id = $1,
           provider_name = 'sendgrid',
           updated_at = NOW()
       WHERE id = $2`,
      [providerMsgId, emailId]
    );
    
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
         AND status = 'sending'  -- Only update if still sending (prevents race condition)
       RETURNING id, status, provider_msg_id`,
      [emailId]
    );
    
    // If update affected 0 rows, another worker already marked this as sent
    if (finalUpdateResult.rowCount === 0) {
      log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, providerMsgId }, 'Email already sent by another worker');
      return; // Already processed, exit gracefully
    }
    
    const finalEmail = finalUpdateResult.rows[0];
    
    // Mark outbox event as processed (if processing from outbox)
    // Use idempotency_key from email_outbox record (deterministic)
    const outboxKey = emailRecord.idempotency_key || idempotencyKey;
    if (outboxKey) {
      await markOutboxEventProcessed(outboxKey);
    }
    
    // Structured log: email sent successfully
    log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, outboxEventId: outboxKey, attempt: emailRecord.attempts + 1, providerMsgId: finalEmail.provider_msg_id || providerMsgId, toEmail: toEmail || emailRecord.to_email, template }, 'Email sent successfully');
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
    log.error({ emailId, jobId: job.id, idempotencyKey: outboxKey, err: errorMessage, attempt: currentAttempts }, 'Email send error');

    // Suppression early-exit: the email_outbox row already has status='suppressed' (or a
    // suppressed_reason set). The throw inside the transaction is intentional — it exits
    // cleanly and signals "do not send". Without this guard, the error would fall through
    // to the retry path below and reset status to 'pending'/'failed', causing an infinite
    // BullMQ retry loop until max_attempts is exhausted.
    if (errorMessage.includes('Email is suppressed')) {
      log.info({ emailId, jobId: job.id, idempotencyKey: outboxKey, error: errorMessage }, 'Email suppressed, skipping retry');
      // Mark the outbox row as suppressed so the poller never re-enqueues it
      try {
        await db.query(
          `UPDATE email_outbox
              SET status = 'suppressed',
                  suppressed_at = NOW(),
                  suppressed_reason = COALESCE(suppressed_reason, 'detected_on_send')
            WHERE id = $1
              AND status != 'suppressed'`,
          [emailId]
        );
      } catch (dbErr) {
        log.error({ emailId, err: dbErr }, 'Failed to mark email as suppressed');
      }
      // BUG FIX: mark the outbox_events row done so the poller never re-enqueues
      // this email. Without this call the row stays 'enqueued' indefinitely,
      // causing an infinite re-enqueue storm.
      if (outboxKey) {
        await markOutboxEventFailed(outboxKey, errorMessage);
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
    const isSgSuppressionListError = sgCode === 400 && sgErrors.some(e =>
      typeof e.message === 'string' && SUPPRESSION_ERROR_MESSAGES.some(known => e.message === known)
    );

    const isSuppressionError = isSgHardBounce || isSgSuppressionListError;

    // Truncate suppressed_reason to 500 chars before storing — prevent oversized DB writes
    const suppressedReason = errorMessage.substring(0, 500);

    if (isSuppressionError) {
      // Always update email_outbox status to suppressed regardless of whether we have a userId
      await db.query(
        `UPDATE email_outbox
         SET status = 'suppressed',
             suppressed_reason = $1,
             suppressed_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [suppressedReason, emailId]
      );

      // Only set do_not_email flag if we can resolve a user ID.
      // Note: userId was already updated above in the currentState fetch block
      // (userId = userId || currentState.rows[0].user_id || undefined), so it
      // already incorporates any user_id resolved from the email_outbox record.
      if (userId) {
        await db.query(
          `UPDATE users
           SET do_not_email = true,
               updated_at = NOW()
           WHERE id = $1`,
          [userId]
        ).catch(dbError => {
          log.error({ userId, err: dbError instanceof Error ? dbError.message : 'Unknown error' }, 'Suppression user update failed');
        });
      }

      log.info({ emailId, jobId: job.id, idempotencyKey: outboxKey, suppressedReason, userId, sgCode }, 'Email suppressed due to hard bounce/complaint');
    } else {
      // Update email_outbox with error (for retry)
      // Check current attempts to determine if we should mark as failed (poison message)
      const shouldMarkFailed = currentAttempts >= maxAttempts;
      
      await db.query(
        `UPDATE email_outbox
         SET status = $1,
             last_error = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [shouldMarkFailed ? 'failed' : 'pending', errorMessage, emailId]
      );
      
      if (shouldMarkFailed) {
        log.error({ emailId, jobId: job.id, idempotencyKey: outboxKey, attempts: currentAttempts, maxAttempts, err: errorMessage }, 'Email poison message: max attempts exceeded');

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
            metadata: { emailId, emailType, attempts: currentAttempts, maxAttempts, lastError: errorMessage },
          });
        } catch (alertErr) {
          log.error({ alertErr }, 'Failed to send dead-letter admin alert');
        }
      }
    }
    
    // Mark outbox event as failed (if processing from outbox)
    if (outboxKey) {
      await markOutboxEventFailed(outboxKey, errorMessage);
    }
    
    // Re-throw error for BullMQ retry logic (unless max attempts exceeded - then don't retry)
    if (currentAttempts >= maxAttempts) {
      // Don't throw - let job complete as failed (no more retries)
      return;
    }
    
    throw error;
  }
}
