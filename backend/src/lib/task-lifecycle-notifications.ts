/**
 * Task lifecycle notifications — beta-gate requirement:
 * "both sides receive the right notifications/status updates end to end."
 *
 * Every function here is FIRE-AND-FORGET: failures are logged and swallowed.
 * Notification delivery must NEVER block or fail a task/financial mutation.
 * Callers invoke these AFTER the underlying mutation has committed.
 *
 * Delivery rides the existing audited rails:
 * NotificationService.createNotification → notifications row + outbox →
 * push-worker → FCM (device_tokens). No new transport code.
 */

import { NotificationService } from '../services/NotificationService.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'task-lifecycle-notifications' });

async function safeNotify(params: Parameters<typeof NotificationService.createNotification>[0]): Promise<void> {
  try {
    await NotificationService.createNotification(params);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId: params.userId, category: params.category, taskId: params.taskId },
      'Lifecycle notification failed (non-fatal)'
    );
  }
}

/** Hustler applied → tell the poster. */
export async function notifyApplicationReceived(posterId: string, taskId: string, taskTitle: string): Promise<void> {
  await safeNotify({
    userId: posterId,
    category: 'new_matching_task',
    title: 'New applicant',
    body: `Someone applied to "${taskTitle}". Review applicants and assign.`,
    deepLink: `/tasks/${taskId}/applicants`,
    taskId,
    priority: 'MEDIUM',
  });
}

/** Poster assigned a worker → tell the worker. */
export async function notifyWorkerAssigned(workerId: string, taskId: string, taskTitle: string): Promise<void> {
  await safeNotify({
    userId: workerId,
    category: 'task_accepted',
    title: "You're assigned!",
    body: `You got "${taskTitle}". Head over and start when ready.`,
    deepLink: `/tasks/${taskId}`,
    taskId,
    priority: 'HIGH',
  });
}

/** Worker accepted (instant mode direct-accept) → tell the poster. */
export async function notifyTaskAccepted(posterId: string, taskId: string, taskTitle: string): Promise<void> {
  await safeNotify({
    userId: posterId,
    category: 'task_accepted',
    title: 'Your task was accepted',
    body: `A hustler accepted "${taskTitle}" and is on it.`,
    deepLink: `/tasks/${taskId}`,
    taskId,
    priority: 'HIGH',
  });
}

/** Worker submitted proof → tell the poster to review. */
export async function notifyProofSubmitted(posterId: string, taskId: string, taskTitle: string): Promise<void> {
  await safeNotify({
    userId: posterId,
    category: 'proof_submitted',
    title: 'Proof submitted — review needed',
    body: `Work on "${taskTitle}" is done. Review the proof to release payment.`,
    deepLink: `/tasks/${taskId}/proof`,
    taskId,
    priority: 'HIGH',
  });
}

/** Poster rejected proof → tell the worker to fix and resubmit. */
export async function notifyProofRejected(workerId: string, taskId: string, taskTitle: string, reason?: string): Promise<void> {
  await safeNotify({
    userId: workerId,
    category: 'proof_rejected',
    title: 'Proof needs another pass',
    body: reason ? `"${taskTitle}": ${reason}` : `Your proof for "${taskTitle}" was not approved. Check feedback and resubmit.`,
    deepLink: `/tasks/${taskId}/proof`,
    taskId,
    priority: 'HIGH',
  });
}

/** Task completed (poster approved) → tell the worker. */
export async function notifyTaskCompleted(workerId: string, taskId: string, taskTitle: string): Promise<void> {
  await safeNotify({
    userId: workerId,
    category: 'task_completed',
    title: 'Task approved 🎉',
    body: `"${taskTitle}" is complete. Your payout is on the way.`,
    deepLink: `/tasks/${taskId}`,
    taskId,
    priority: 'HIGH',
  });
}

/** Escrow released → tell the worker they got paid. */
export async function notifyPaymentReleased(workerId: string, taskId: string, netPayoutCents: number): Promise<void> {
  const dollars = (netPayoutCents / 100).toFixed(2);
  await safeNotify({
    userId: workerId,
    category: 'payment_released',
    title: 'You got paid 💸',
    body: `$${dollars} is on its way to your account.`,
    deepLink: `/earnings`,
    taskId,
    priority: 'CRITICAL',
  });
}
