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
import type { Job } from 'bullmq';

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
 * Email template renderer (placeholder - should be replaced with proper templating engine)
 * 
 * TODO: Replace with proper templating engine (e.g., Handlebars, Mustache, or template service)
 */
function renderEmailTemplate(
  template: string,
  params: Record<string, unknown>
): { subject: string; html: string; text: string } {
  // Placeholder: Basic template rendering
  // In production, use proper templating engine or template service
  
  const templates: Record<string, (params: Record<string, unknown>) => { subject: string; html: string; text: string }> = {
    'export_ready': (p) => ({
      subject: 'Your data export is ready',
      html: `<h1>Your data export is ready</h1><p>Download your export <a href="${p.downloadUrl}">here</a>. This link expires on ${p.expiresAt}.</p>`,
      text: `Your data export is ready. Download it at ${p.downloadUrl}. This link expires on ${p.expiresAt}.`,
    }),
    'task_status_changed': (p) => ({
      subject: `Task status updated: ${p.taskTitle}`,
      html: `<h1>Task status updated</h1><p>Your task "${p.taskTitle}" status has changed to ${p.status}.</p>`,
      text: `Task "${p.taskTitle}" status has changed to ${p.status}.`,
    }),
    'deletion_confirmed': (p) => ({
      subject: 'Your account deletion has been completed',
      html: `<h1>Account deletion confirmed</h1><p>Your account and all associated data have been permanently deleted.</p>`,
      text: 'Your account and all associated data have been permanently deleted.',
    }),
    'verification_code': (p) => ({
      subject: 'Your verification code',
      html: `<h1>Verification code</h1><p>Your verification code is: <strong>${p.code}</strong></p>`,
      text: `Your verification code is: ${p.code}`,
    }),
    // Add more templates as needed
  };
  
  const templateFn = templates[template];
  if (!templateFn) {
    // Fallback template
    return {
      subject: 'Notification from HustleXP',
      html: `<p>${JSON.stringify(params)}</p>`,
      text: JSON.stringify(params),
    };
  }
  
  return templateFn(params);
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
    console.log(JSON.stringify({
      event: 'email_job_started',
      email_id: emailId,
      job_id: job.id,
      idempotency_key: emailRecord.idempotency_key,
      current_status: emailRecord.status,
      attempt: emailRecord.attempts,
    }));
    
    // Idempotency check: If already sent, skip processing (idempotent replay)
    if (emailRecord.status === 'sent') {
      console.log(JSON.stringify({
        event: 'email_already_sent_replay',
        email_id: emailId,
        job_id: job.id,
        idempotency_key: emailRecord.idempotency_key,
        status: emailRecord.status,
        provider_msg_id: emailRecord.provider_msg_id || null,
      }));
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
      
      console.log(JSON.stringify({
        event: 'email_crash_recovery',
        email_id: emailId,
        job_id: job.id,
        idempotency_key: emailRecord.idempotency_key,
        provider_msg_id: emailRecord.provider_msg_id,
        reason: 'provider_msg_id_exists_but_status_not_sent',
      }));
      
      const outboxKey = emailRecord.idempotency_key || jobIdempotencyKey;
      if (outboxKey) {
        await markOutboxEventProcessed(outboxKey);
      }
      return;
    }
    
    // Check if email is suppressed
    if (emailRecord.status === 'suppressed' || emailRecord.suppressed_reason) {
      console.log(JSON.stringify({
        event: 'email_suppressed_check',
        email_id: emailId,
        job_id: job.id,
        idempotency_key: emailRecord.idempotency_key,
        suppressed_reason: emailRecord.suppressed_reason || 'status_suppressed',
      }));
      throw new Error(`Email is suppressed: ${emailRecord.suppressed_reason || 'suppressed'}`);
    }
    
    // Check if max attempts exceeded (poison message)
    if (emailRecord.attempts >= emailRecord.max_attempts) {
      console.log(JSON.stringify({
        event: 'email_max_attempts_exceeded',
        email_id: emailId,
        job_id: job.id,
        idempotency_key: emailRecord.idempotency_key,
        attempts: emailRecord.attempts,
        max_attempts: emailRecord.max_attempts,
      }));
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
      console.error(JSON.stringify({
        event: 'email_claim_failed',
        email_id: emailId,
        job_id: job.id,
        idempotency_key: emailRecord.idempotency_key,
        reason: 'already_claimed_or_invalid_status',
        current_status: emailRecord.status,
      }));
      return; // Another worker claimed it or status changed - exit gracefully
    }
    
    const claimedEmail = claimResult.rows[0];
    
    // Structured log: claim successful
    console.log(JSON.stringify({
      event: 'email_claimed',
      email_id: emailId,
      job_id: job.id,
      idempotency_key: emailRecord.idempotency_key,
      status_transition: `${emailRecord.status} -> sending`,
      attempt: claimedEmail.attempts,
    }));
    
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
        
        console.log(JSON.stringify({
          event: 'email_suppressed',
          email_id: emailId,
          job_id: job.id,
          idempotency_key: emailRecord.idempotency_key,
          reason: 'user_do_not_email',
          user_id: userId || emailRecord.user_id,
        }));
        
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
    console.log(JSON.stringify({
      event: 'email_sending',
      email_id: emailId,
      job_id: job.id,
      idempotency_key: emailRecord.idempotency_key,
      attempt: claimedEmail.attempts,
      to_email: toEmail || emailRecord.to_email,
      template,
    }));
    
    const [response] = await sgMail.send(msg);
    
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
      console.log(JSON.stringify({
        event: 'email_already_sent',
        email_id: emailId,
        job_id: job.id,
        idempotency_key: emailRecord.idempotency_key,
        reason: 'another_worker_completed',
        provider_msg_id: providerMsgId,
      }));
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
    console.log(JSON.stringify({
      event: 'email_sent',
      email_id: emailId,
      job_id: job.id,
      idempotency_key: emailRecord.idempotency_key,
      outbox_event_id: outboxKey,
      status_transition: 'sending -> sent',
      attempt: claimedEmail.attempts,
      provider_msg_id: finalEmail.provider_msg_id || providerMsgId,
      to_email: toEmail || emailRecord.to_email,
      template,
    }));
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
    console.error(JSON.stringify({
      event: 'email_send_error',
      email_id: emailId,
      job_id: job.id,
      idempotency_key: outboxKey,
      error: errorMessage,
      attempt: currentAttempts,
    }));
    
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
        console.error(JSON.stringify({
          event: 'suppression_user_update_failed',
          user_id: userId,
          error: dbError instanceof Error ? dbError.message : 'Unknown error',
        }));
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
      
      console.log(JSON.stringify({
        event: 'email_suppressed',
        email_id: emailId,
        job_id: job.id,
        idempotency_key: outboxKey,
        suppressed_reason: errorMessage,
        user_id: userId,
      }));
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
        console.log(JSON.stringify({
          event: 'email_poison_message',
          email_id: emailId,
          job_id: job.id,
          idempotency_key: outboxKey,
          attempts: currentAttempts,
          max_attempts: maxAttempts,
          error: errorMessage,
        }));
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
