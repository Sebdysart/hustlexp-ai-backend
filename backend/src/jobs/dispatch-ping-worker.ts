/**
 * Dispatch Ping Worker
 *
 * Sends FCM push notifications for Smart Dispatch pings (task.dispatch_ping events).
 *
 * This worker handles the `task.dispatch_ping` event type queued by
 * DispatchService.dispatchToHustlers(). It fetches task details, builds the
 * FCM data payload with type:"dispatch_ping", and delivers via sendPushNotification().
 *
 * The iOS PushNotificationManager routes on data.type === "dispatch_ping" to
 * GoModeManager.handleIncomingPing(), which sets activePing → shows LivePingView.
 *
 * FCM data payload (all values must be strings for FCM data messages):
 *   type         "dispatch_ping"
 *   taskId       UUID
 *   taskTitle    string
 *   paymentCents string (integer cents)
 *   waveNumber   "1" | "2" | "3"
 *   location     string | "" (empty string when null)
 */

import { db } from '../db.js';
import { sendPushNotification } from '../services/PushNotificationService.js';
import { workerLogger } from '../logger.js';
import type { Job } from 'bullmq';

const log = workerLogger.child({ worker: 'dispatch-ping' });

interface DispatchPingJobPayload {
  taskId: string;
  hustlerId: string;
  waveNumber: number;
  dispatchScore?: number;
  location?: string | null;
}

interface DispatchPingJobData {
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  payload: DispatchPingJobPayload;
}

/**
 * Core dispatch-ping logic, callable directly (bypassing BullMQ).
 * Used by the outbox worker when BullMQ workers are not consuming.
 */
export async function sendDispatchPing(
  payload: DispatchPingJobPayload,
  jobId?: string
): Promise<void> {
  const startTime = Date.now();
  const { taskId, hustlerId, waveNumber, location } = payload;

  log.info({ jobId, taskId, hustlerId, waveNumber }, 'Dispatch ping job started');

  if (!taskId || !hustlerId) {
    log.error({ jobId, payload }, 'Dispatch ping job missing taskId or hustlerId — dropping');
    return;
  }

  // Fetch task details needed for FCM payload
  const taskResult = await db.query<{
    id: string;
    title: string;
    price: number;
    state: string;
    fulfillment_mode: string;
    dispatch_state: string | null;
  }>(
    `SELECT id, title, price, state, fulfillment_mode,
            COALESCE(dispatch_state, 'pending') AS dispatch_state
       FROM tasks WHERE id = $1`,
    [taskId]
  );

  if (taskResult.rowCount === 0) {
    log.warn({ taskId, hustlerId }, 'Task not found — skipping dispatch ping');
    return;
  }

  const task = taskResult.rows[0];
  log.info(
    { taskId, state: task.state, fulfillmentMode: task.fulfillment_mode, dispatchState: task.dispatch_state },
    'Task state at ping delivery time'
  );

  if (
    task.state === 'ACCEPTED' ||
    task.state === 'COMPLETED' ||
    task.state === 'CANCELLED' ||
    task.dispatch_state === 'fulfilled' ||
    task.dispatch_state === 'expired'
  ) {
    log.info(
      { taskId, hustlerId, state: task.state, dispatchState: task.dispatch_state },
      'Task no longer pingable — skipping FCM send'
    );
    return;
  }

  const hustlerResult = await db.query<{ id: string; trust_hold: boolean; go_mode: boolean }>(
    `SELECT id, trust_hold, COALESCE(go_mode, false) AS go_mode FROM users WHERE id = $1`,
    [hustlerId]
  );

  if (hustlerResult.rowCount === 0) {
    log.warn({ taskId, hustlerId }, 'Hustler not found — skipping dispatch ping');
    return;
  }

  const hustler = hustlerResult.rows[0];

  if (hustler.trust_hold) {
    log.info({ taskId, hustlerId }, 'Hustler on trust hold — skipping dispatch ping');
    return;
  }

  log.info({ taskId, hustlerId, goMode: hustler.go_mode }, 'Hustler eligible — sending FCM dispatch ping');

  const paymentCents = Math.round(Number(task.price));
  const fcmData: Record<string, string> = {
    type: 'dispatch_ping',
    taskId,
    taskTitle: task.title,
    paymentCents: String(paymentCents),
    waveNumber: String(waveNumber),
    location: location ?? '',
  };

  log.info({ taskId, hustlerId, fcmData }, 'Sending FCM push with dispatch_ping payload');

  const pushTitle = `New task — wave ${waveNumber}`;
  const pushBody = `${task.title} — $${(paymentCents / 100).toFixed(2)}${location ? ` • ${location}` : ''}`;

  // urgentWakeup=true → notification banner + content-available:1 + priority 10.
  // iOS shows the banner immediately AND wakes the app in the background so
  // GoModeManager sets activePing before the user taps anything.
  const result = await sendPushNotification(hustlerId, pushTitle, pushBody, fcmData, false, true);

  const latency = Date.now() - startTime;
  log.info(
    {
      taskId,
      hustlerId,
      waveNumber,
      sent: result.sent,
      failed: result.failed,
      success: result.success,
      latency,
    },
    result.sent > 0
      ? 'Dispatch ping FCM delivered'
      : 'Dispatch ping FCM sent but no active tokens found (hustler may not have FCM token registered)'
  );
}

export async function processDispatchPingJob(job: Job<DispatchPingJobData>): Promise<void> {
  await sendDispatchPing(job.data.payload as DispatchPingJobPayload, job.id);
}
