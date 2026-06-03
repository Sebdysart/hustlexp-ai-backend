/**
 * Instant Notification Worker
 * 
 * Handles delivery of instant task notifications to eligible hustlers.
 * 
 * Notification Urgency Design v1:
 * - CRITICAL priority (bypasses quiet hours)
 * - One-interrupt-at-a-time enforcement
 * - Short TTL (5 minutes)
 * - Metrics instrumentation
 */

import { Job } from 'bullmq';
import { db } from '../db.js';
import { NotificationService } from '../services/NotificationService.js';
import { verifyJobSignature } from './queues.js';
import { workerLogger } from '../logger.js';
const log = workerLogger.child({ worker: 'instant-notification' });

interface InstantNotificationJobData {
  taskId: string;
  hustlerId: string;
  location?: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  sensitive?: boolean;
  surgeLevel?: number;
  urgencyCopy?: string;
}

/**
 * Process instant notification job
 * 
 * Creates a CRITICAL priority notification for the hustler.
 * Enforces one-interrupt-at-a-time by suppressing older instant notifications.
 * 
 * Launch Hardening v1: Error containment, kill switch checks, idempotency
 */
export async function processInstantNotificationJob(
  job: Job<InstantNotificationJobData>
): Promise<void> {
  // HMAC signature verification (Attack 12 — Redis injection defence)
  // task.instant_available jobs dispatched via the outbox MUST carry a _sig field
  // inside job.data.payload. The check is mandatory — jobs without a signature are
  // rejected outright to prevent unsigned payloads injected directly into Redis
  // (bypassing the outbox) from executing with elevated trust.
  const outerPayload = (job.data as unknown as Record<string, unknown>).payload;
  // A50-1 FIX: Fail-closed HMAC guard. Any job that arrives without a valid
  // object payload is rejected immediately — the previous conditional silently
  // skipped the entire HMAC block (including the R49 mandatory-sig throw) when
  // outerPayload was null/undefined/non-object, leaving an unsigned-injection
  // bypass open for malformed jobs.
  if (!outerPayload || typeof outerPayload !== 'object') {
    log.error({ jobId: job.id }, 'Job payload is missing or not an object — rejecting for security');
    throw new Error('Invalid job payload — job rejected for security');
  }
  const p = outerPayload as Record<string, unknown>;
  // A49-3 FIX: Signature is now mandatory. Missing or empty _sig rejects the job.
  if (!('_sig' in p) || !p._sig) {
    log.error({ jobId: job.id }, 'Job is missing required HMAC signature — rejecting for security');
    throw new Error('Missing job signature — job rejected for security');
  }
  const { _sig, ...payloadWithoutSig } = p;
  if (!verifyJobSignature(payloadWithoutSig, _sig as string)) {
    log.error({ jobId: job.id }, 'Job signature verification failed — possible Redis injection attack');
    throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
  }

  const { taskId, hustlerId, location, riskLevel, sensitive, urgencyCopy, surgeLevel } = (job.data as unknown as Record<string, unknown>).payload as InstantNotificationJobData;
  const startTime = Date.now();

  try {
    // Launch Hardening v1: Kill switch check
    const { InstantModeKillSwitch } = await import('../services/InstantModeKillSwitch.js');
    const flags = InstantModeKillSwitch.checkFlags({ taskId, operation: 'notification_delivery' });
    
    if (!flags.interruptsEnabled) {
      log.info({ taskId, hustlerId }, 'Instant notification skipped - kill switch active');
      return; // Safe exit - no state mutation
    }

  // Verify task is still in MATCHING state
  const taskResult = await db.query<{
    id: string;
    state: string;
    title: string;
    price: number;
    instant_mode: boolean;
  }>(
    `SELECT id, state, title, price, instant_mode FROM tasks WHERE id = $1`,
    [taskId]
  );

  if (taskResult.rowCount === 0) {
    throw new Error(`Task ${taskId} not found`);
  }

  const task = taskResult.rows[0];

  if (!task.instant_mode || task.state !== 'MATCHING') {
    // Task already accepted or cancelled - don't send notification
    log.info({ taskId, state: task.state }, 'Task no longer in MATCHING state - skipping notification');
    return;
  }

  // ONE-INTERRUPT-AT-A-TIME: Suppress older instant notifications for this hustler
  // Mark all other pending instant notifications as dismissed (suppressed)
  await db.query(
    `UPDATE notifications
     SET metadata = jsonb_set(
       COALESCE(metadata, '{}'::jsonb),
       '{suppressed_by_instant_task}',
       to_jsonb($1::text)
     )
     WHERE user_id = $2
       AND category = 'instant_task_available'
       AND read_at IS NULL
       AND task_id != $1
       AND created_at < NOW()
       AND (expires_at IS NULL OR expires_at > NOW())`,
    // W46-5 FIX: The expiresAt guard above excludes already-expired notifications
    // from the suppression UPDATE. Without it, expired instant-task notifications
    // received spurious 'suppressed_by_instant_task' metadata writes, polluting
    // audit logs and corrupting notification analytics.
    [taskId, hustlerId]
  );

  // W47-2 FIX: Idempotency guard — BullMQ retries (attempts:3) can fire this job
  // more than once if a timeout occurs after the INSERT succeeds but before the
  // worker returns. Check for an existing notification before inserting to prevent
  // duplicate push notifications reaching the hustler for the same instant task.
  const existingNotif = await db.query(
    `SELECT id FROM notifications WHERE user_id = $1 AND task_id = $2 AND category = 'instant_task_available' LIMIT 1`,
    [hustlerId, taskId]
  );
  if (existingNotif.rows.length > 0) {
    log.info({ hustlerId, taskId }, 'processInstantNotificationJob: notification already exists — idempotent skip');
    return;
  }

  // Create CRITICAL priority notification
  const priceDollars = (task.price / 100).toFixed(2);
  
  // Use surge urgency copy if provided, otherwise default
  const defaultTitle = 'Instant task nearby — first to accept gets it';
  const title = urgencyCopy || defaultTitle;
  const body = `${task.title} — $${priceDollars}${location ? ` • ${location}` : ''}`;

  // Short TTL: 5 minutes (instant tasks expire quickly)
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  const notificationResult = await NotificationService.createNotification({
    userId: hustlerId,
    category: 'instant_task_available',
    title,
    body,
    deepLink: `/tasks/${taskId}/accept`,
    taskId,
    metadata: {
      instantMode: true,
      riskLevel,
      sensitive: sensitive || false,
      location,
      surgeLevel: surgeLevel || 0,
      // Track when notification was created for latency metrics
      notifiedAt: new Date().toISOString(),
    },
    channels: ['push', 'in_app'], // Push + in-app interrupt
    priority: 'CRITICAL', // Highest priority - bypasses quiet hours
    expiresAt,
  });

    if (!notificationResult.success) {
      throw new Error(`Failed to create instant notification: ${notificationResult.error?.message ?? 'unknown error'}`);
    }

    const latency = Date.now() - startTime;
    log.info({ taskId, hustlerId, surgeLevel: surgeLevel || 0, latency, stage: 'notification_delivery' }, 'Instant notification sent');
  } catch (error) {
    // Launch Hardening v1: Error containment - never crash the process
    const latency = Date.now() - startTime;
    log.error({ taskId, hustlerId, err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, latency, stage: 'notification_delivery' }, 'Instant notification failed');
    
    // Re-throw to let BullMQ handle retry (bounded retries configured at queue level)
    throw error;
  }
}
