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

import { db } from '../db';
import { sendPushNotification } from '../services/PushNotificationService';
import { markOutboxEventProcessed, markOutboxEventFailed } from './outbox-worker';
import { workerLogger } from '../logger';
import type { Job } from 'bullmq';

const log = workerLogger.child({ worker: 'push' });

// ============================================================================
// TYPES
// ============================================================================

interface PushJobData {
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  payload: {
    notificationId: string;
    userId: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  };
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
  const { notificationId, userId, title, body, data } = job.data.payload;
  const idempotencyKey = job.id || `push:${notificationId}`;

  try {
    // Structured log: job started
    log.info({ notificationId, jobId: job.id, idempotencyKey, userId }, 'Push job started');

    // Check if this outbox event was already processed (idempotency)
    const outboxCheck = await db.query<{ status: string }>(
      `SELECT status FROM outbox_events WHERE idempotency_key = $1`,
      [idempotencyKey]
    );

    if (outboxCheck.rows.length > 0 && outboxCheck.rows[0].status === 'processed') {
      log.info({ notificationId, jobId: job.id, idempotencyKey }, 'Push job already processed, skipping');
      return;
    }

    // Send push notification via PushNotificationService
    const result = await sendPushNotification(userId, title, body, data);

    // Structured log: push result
    log.info({ notificationId, jobId: job.id, idempotencyKey, userId, sent: result.sent, failed: result.failed, success: result.success }, 'Push job completed');

    // Mark outbox event as processed
    await markOutboxEventProcessed(idempotencyKey);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Structured log: error occurred
    log.error({ notificationId, jobId: job.id, idempotencyKey, userId, err: errorMessage }, 'Push job error');

    // Mark outbox event as failed
    await markOutboxEventFailed(idempotencyKey, errorMessage);

    // Re-throw for BullMQ retry logic
    throw error;
  }
}
