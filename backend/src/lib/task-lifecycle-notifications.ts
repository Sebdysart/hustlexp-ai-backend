/**
 * Task lifecycle notifications — beta-gate requirement:
 * "both sides receive the right notifications/status updates end to end."
 *
 * A supplied transaction records durable delivery intent with the domain write.
 * All domain callers use their transaction. The non-transactional fallback
 * remains compatible for existing internal integrations.
 *
 * Delivery rides the existing audited rails:
 * NotificationService.createNotification → notifications row + outbox →
 * push-worker → FCM (device_tokens). No new transport code.
 */

import { NotificationService } from '../services/NotificationService.js';
import type { QueryFn } from '../db.js';
import { enqueueNotificationRequest } from '../services/NotificationRequestService.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'task-lifecycle-notifications' });

async function safeNotify(params: Parameters<typeof NotificationService.createNotification>[0], query?: QueryFn): Promise<void> {
  if (query) return enqueueNotificationRequest(query, params);
  try {
    const result = await NotificationService.createNotification(params);
    if (!result.success) throw new Error(result.error.code);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId: params.userId, category: params.category, taskId: params.taskId },
      'Lifecycle notification failed (non-fatal)'
    );
  }
}

/** Hustler applied → tell the poster. */
export async function notifyApplicationReceived(posterId: string, taskId: string, taskTitle: string, applicationId: string, query?: QueryFn): Promise<void> {
  await safeNotify({
    userId: posterId,
    category: 'new_matching_task',
    title: 'New applicant',
    body: `Someone applied to "${taskTitle}". Review applicants and assign.`,
    deepLink: `/tasks/${taskId}/applicants`,
    taskId,
    dedupeKey: `application-received:${applicationId}:${posterId}`,
    metadata: { applicationId },
    priority: 'MEDIUM',
  }, query);
}

/** Poster assigned a worker → tell the worker. */
export async function notifyWorkerAssigned(workerId: string, taskId: string, taskTitle: string, query?: QueryFn): Promise<void> {
  await safeNotify({
    userId: workerId,
    category: 'task_accepted',
    title: "You're assigned!",
    body: `You got "${taskTitle}". Head over and start when ready.`,
    deepLink: `/tasks/${taskId}`,
    taskId,
    dedupeKey: `worker-assigned:${taskId}:${workerId}`,
    priority: 'HIGH',
  }, query);
}

/** Worker accepted (instant mode direct-accept) → tell the poster. */
export async function notifyTaskAccepted(posterId: string, taskId: string, taskTitle: string, query?: QueryFn): Promise<void> {
  await safeNotify({
    userId: posterId,
    category: 'task_accepted',
    title: 'Your task was accepted',
    body: `A hustler accepted "${taskTitle}" and is on it.`,
    deepLink: `/tasks/${taskId}`,
    taskId,
    dedupeKey: `task-accepted:${taskId}:${posterId}`,
    priority: 'HIGH',
  }, query);
}

/** Worker submitted proof → tell the poster to review. */
export async function notifyProofSubmitted(posterId: string, taskId: string, taskTitle: string, proofId: string, query?: QueryFn): Promise<void> {
  await safeNotify({
    userId: posterId,
    category: 'proof_submitted',
    title: 'Proof submitted — review needed',
    body: `Work on "${taskTitle}" is done. Review the proof to release payment.`,
    deepLink: `/tasks/${taskId}/proof`,
    taskId,
    dedupeKey: `proof-submitted:${proofId}:${posterId}`,
    metadata: { proofId },
    priority: 'HIGH',
  }, query);
}

/** Poster rejected proof → tell the worker to fix and resubmit. */
export async function notifyProofRejected(workerId: string, taskId: string, taskTitle: string, reason: string | undefined, proofId: string, query?: QueryFn): Promise<void> {
  await safeNotify({
    userId: workerId,
    category: 'proof_rejected',
    title: 'Proof needs another pass',
    body: reason ? `"${taskTitle}": ${reason}` : `Your proof for "${taskTitle}" was not approved. Check feedback and resubmit.`,
    deepLink: `/tasks/${taskId}/proof`,
    taskId,
    dedupeKey: `proof-rejected:${proofId}:${workerId}`,
    metadata: { proofId },
    priority: 'HIGH',
  }, query);
}

/** Task completed (poster approved) → tell the worker. */
export async function notifyTaskCompleted(workerId: string, taskId: string, taskTitle: string, query?: QueryFn): Promise<void> {
  await safeNotify({
    userId: workerId,
    category: 'task_completed',
    title: 'Task approved 🎉',
    body: `"${taskTitle}" is complete. Your payout is ready for processing.`,
    deepLink: `/tasks/${taskId}`,
    taskId,
    dedupeKey: `task-completed:${taskId}:${workerId}`,
    priority: 'HIGH',
  }, query);
}

/** Escrow released → report the release without claiming external settlement. */
export async function notifyPaymentReleased(workerId: string, taskId: string, netPayoutCents: number, query?: QueryFn, escrowId?: string, organizationId?: string): Promise<void> {
  if (query && !escrowId) throw new Error('Release notification requires escrow identity');
  const dollars = (netPayoutCents / 100).toFixed(2);
  await safeNotify({
    userId: workerId,
    category: 'payment_released',
    title: 'Payout released',
    body: `$${dollars} was released to your payout account. Check earnings for settlement status.`,
    deepLink: organizationId ? `/business/tasks/${taskId}` : '/earnings',
    taskId: escrowId ? undefined : taskId,
    ...(escrowId ? {
      objectRef: { type: 'escrow', id: escrowId },
      metadata: { escrowId, taskId, organizationId },
      dedupeKey: `payout-released:${escrowId}:${workerId}`,
    } : {}),
    priority: 'CRITICAL',
  }, query);
}
