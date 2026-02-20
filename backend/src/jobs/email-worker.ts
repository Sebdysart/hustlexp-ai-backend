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

import { db } from '../db';
import { config } from '../config';
import sgMail from '@sendgrid/mail';
import { markOutboxEventProcessed, markOutboxEventFailed } from './outbox-worker';
import { workerLogger } from '../logger';
import type { Job } from 'bullmq';
import { sendgridBreaker } from '../middleware/circuit-breaker';

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
  const { emailId, userId, toEmail, template, params } = job.data.payload;
  const idempotencyKey = job.id || `email:${emailId}`;
  
  if (!config.identity.sendgrid.apiKey) {
    throw new Error('SendGrid API key not configured (SENDGRID_API_KEY required)');
  }
  
  try {
    // Get email record from email_outbox table with FOR UPDATE lock (prevents concurrent processing)
    const emailResult = await db.query<{
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
      // Mark outbox event as processed (if processing from outbox)
      const outboxKey = emailRecord.idempotency_key || jobIdempotencyKey;
      if (outboxKey) {
        await markOutboxEventProcessed(outboxKey);
      }
      return;
    }
    
    // Crash recovery check: If provider_msg_id exists, email was already sent (SendGrid succeeded but DB update failed)
    if (emailRecord.provider_msg_id && emailRecord.status !== 'sent') {
      // Email was already sent - mark as sent and exit
      await db.query(
        `UPDATE email_outbox
         SET status = 'sent',
             sent_at = COALESCE(sent_at, NOW()),
             updated_at = NOW()
         WHERE id = $1`,
        [emailId]
      );
      
      log.warn({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, providerMsgId: emailRecord.provider_msg_id }, 'Email crash recovery: provider_msg_id exists but status not sent');
      
      const outboxKey = emailRecord.idempotency_key || jobIdempotencyKey;
      if (outboxKey) {
        await markOutboxEventProcessed(outboxKey);
      }
      return;
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
    
    // ATOMIC CLAIM: Update status to sending only if still in claimable state
    // CRITICAL: This is the atomic claim - only one worker can transition pending/failed -> sending
    // Using UPDATE ... RETURNING ensures we only proceed if we successfully claimed the row
    const claimResult = await db.query<{
      id: string;
      status: string;
      attempts: number;
    }>(
      `UPDATE email_outbox
       SET status = 'sending',
           attempts = attempts + 1,
           updated_at = NOW()
       WHERE id = $1
         AND status IN ('pending', 'failed')
       RETURNING id, status, attempts`,
      [emailId]
    );
    
    // If no row returned, another worker already claimed this email (or status changed)
    if (claimResult.rowCount === 0) {
      // Structured log for verification
      log.warn({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, currentStatus: emailRecord.status }, 'Email claim failed: already claimed or invalid status');
      return; // Another worker claimed it or status changed - exit gracefully
    }
    
    const claimedEmail = claimResult.rows[0];
    
    // Structured log: claim successful
    log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, statusTransition: `${emailRecord.status} -> sending`, attempt: claimedEmail.attempts }, 'Email claimed');
    
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
    log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, attempt: claimedEmail.attempts, toEmail: toEmail || emailRecord.to_email, template }, 'Email sending');
    
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
    const outboxKey = emailRecord.idempotency_key || jobIdempotencyKey;
    if (outboxKey) {
      await markOutboxEventProcessed(outboxKey);
    }
    
    // Structured log: email sent successfully
    log.info({ emailId, jobId: job.id, idempotencyKey: emailRecord.idempotency_key, outboxEventId: outboxKey, attempt: claimedEmail.attempts, providerMsgId: finalEmail.provider_msg_id || providerMsgId, toEmail: toEmail || emailRecord.to_email, template }, 'Email sent successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    // Get email record idempotency key for logging (may be null if error before SELECT)
    // Use jobIdempotencyKey as fallback
    let outboxKey = jobIdempotencyKey;
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
        outboxKey = currentState.rows[0].idempotency_key || jobIdempotencyKey;
        currentAttempts = currentState.rows[0].attempts;
        maxAttempts = currentState.rows[0].max_attempts;
        userId = userId || currentState.rows[0].user_id || undefined;
      }
    } catch {
      // Ignore errors fetching current state
    }
    
    // Structured log: error occurred
    log.error({ emailId, jobId: job.id, idempotencyKey: outboxKey, err: errorMessage, attempt: currentAttempts }, 'Email send error');
    
    // Handle SendGrid suppression errors (bounces, complaints, unsubscribes)
    const isSuppressionError = errorMessage.includes('suppressed') ||
                               errorMessage.includes('bounce') ||
                               errorMessage.includes('complaint') ||
                               errorMessage.includes('unsubscribe');
    
    if (isSuppressionError && userId) {
      // Mark user as do_not_email
      await db.query(
        `UPDATE users
         SET do_not_email = true,
             updated_at = NOW()
         WHERE id = $1`,
        [userId]
      ).catch(dbError => {
        log.error({ userId, err: dbError instanceof Error ? dbError.message : 'Unknown error' }, 'Suppression user update failed');
      });
      
      // Update email_outbox with suppression reason
      await db.query(
        `UPDATE email_outbox
         SET status = 'suppressed',
             suppressed_reason = $1,
             suppressed_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [errorMessage, emailId]
      );
      
      log.info({ emailId, jobId: job.id, idempotencyKey: outboxKey, suppressedReason: errorMessage, userId }, 'Email suppressed due to bounce/complaint');
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
