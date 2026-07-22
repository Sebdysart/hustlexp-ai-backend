import type { Job, Worker } from 'bullmq';
import { db } from '../db.js';
import { workerLogger as log } from '../logger.js';
import { NotificationService } from '../services/NotificationService.js';
import { processBiometricAnalysisJob } from './biometric-analyzer-worker.js';
import { processEmailJob } from './email-worker.js';
import { processExpertiseRecalcJob } from './expertise-recalc-worker.js';
import { processExportJob } from './export-worker.js';
import { createWorker } from './queues.js';
import { processXPTaxReminderJob } from './xp-tax-reminder-worker.js';

type JobHandler = (job: Job) => Promise<void>;

async function notifyEscrow(job: Job, kind: 'funded' | 'refunded'): Promise<void> {
  const { escrowId } = job.data.payload as { escrowId: string };
  const result = await db.query<{ poster_id: string | null; task_id: string }>(
    'SELECT t.poster_id, t.id AS task_id FROM escrows e JOIN tasks t ON t.id = e.task_id WHERE e.id = $1',
    [escrowId]
  );
  const posterId = result.rows[0]?.poster_id;
  if (!posterId) return;
  const funded = kind === 'funded';
  const taskId = result.rows[0].task_id;
  const notification = await NotificationService.createNotification({
    userId: posterId,
    category: funded ? 'escrow_funded' : 'refund_issued',
    title: funded ? 'Payment Captured' : 'Refund Processed',
    body: funded
      ? 'Your payment was captured. The task is now funded and ready to be accepted.'
      : 'Your payment has been refunded. Funds will appear in your account within a few business days.',
    deepLink: `/tasks/${taskId}`,
    taskId,
    objectRef: { type: 'escrow', id: escrowId },
    dedupeKey: `escrow:${escrowId}:${kind}:v${job.data.event_version}`,
    metadata: { escrowId, eventVersion: job.data.event_version },
    channels: ['in_app', 'push'],
    priority: funded ? 'HIGH' : 'MEDIUM',
  });
  if (!notification.success) throw new Error(notification.error.message);
}

async function notifyPaymentFailed(job: Job): Promise<void> {
  const { escrowId, posterId, taskId } = job.data.payload as {
    escrowId: string;
    posterId: string | null;
    taskId: string;
  };
  if (!posterId) return;
  const notification = await NotificationService.createNotification({
    userId: posterId,
    category: 'payment_failed',
    title: 'Payment Failed',
    body: 'Your payment could not be processed. Please update your payment method and try again.',
    deepLink: `/tasks/${taskId}`,
    taskId,
    objectRef: { type: 'escrow', id: escrowId },
    dedupeKey: `escrow:${escrowId}:payment_failed:v${job.data.event_version}`,
    metadata: { escrowId, eventVersion: job.data.event_version },
    channels: ['in_app', 'push'],
    priority: 'HIGH',
  });
  if (!notification.success) throw new Error(notification.error.message);
}

async function notifyTransferFailed(job: Job): Promise<void> {
  const { escrowId, workerId } = job.data.payload as { escrowId: string; workerId: string | null };
  if (!workerId) return;
  const notification = await NotificationService.createNotification({
    userId: workerId,
    category: 'payout_failed',
    title: 'Payment Transfer Failed',
    body: 'Your payment transfer failed. Our team has been alerted and will resolve this urgently. No action required from you.',
    deepLink: '/earnings',
    objectRef: { type: 'escrow', id: escrowId },
    dedupeKey: `escrow:${escrowId}:transfer_failed:v${job.data.event_version}`,
    metadata: { escrowId, eventVersion: job.data.event_version },
    channels: ['in_app', 'push'],
    priority: 'CRITICAL',
  });
  if (!notification.success) throw new Error(notification.error.message);
}

const notificationHandlers: Record<string, JobHandler> = {
  'email.send_requested': processEmailJob,
  'push.send_requested': async (job) => (await import('./push-worker.js')).processPushJob(job),
  'sms.send_requested': async (job) => (await import('./sms-worker.js')).processSMSJob(job),
  'task.instant_available': async (job) => (await import('./instant-notification-worker.js')).processInstantNotificationJob(job),
  'task.progress_updated': async (job) => (await import('./realtime-worker.js')).processRealtimeJob(job),
  'escrow.funded': async (job) => notifyEscrow(job, 'funded'),
  'escrow.refunded': async (job) => notifyEscrow(job, 'refunded'),
  'escrow.payment_failed': notifyPaymentFailed,
  'escrow.transfer_failed': notifyTransferFailed,
};

function inferredNotificationHandler(job: Job): JobHandler | undefined {
  const payload = job.data.payload ?? {};
  if (payload.emailId) return notificationHandlers['email.send_requested'];
  if (payload.smsId) return notificationHandlers['sms.send_requested'];
  if (payload.notificationId) return notificationHandlers['push.send_requested'];
  return undefined;
}

async function processNotificationJob(job: Job): Promise<void> {
  const handler = notificationHandlers[job.name] ?? inferredNotificationHandler(job);
  if (handler) {
    await handler(job);
    return;
  }
  log.info({ eventType: job.name }, 'Notification type not yet implemented');
}

const paymentHandlers: Record<string, JobHandler> = {
  'escrow.release_requested': async (job) => (await import('./escrow-action-worker.js')).processEscrowActionJob(job),
  'escrow.released': async (job) => (await import('./escrow-release-reconciliation-worker.js')).processEscrowReleaseReconciliationJob(job),
  'escrow.refund_requested': async (job) => {
    const action = (job.data.payload as { financial_action?: unknown } | undefined)?.financial_action;
    if (action === 'cancel_pending_payment_intent') {
      await (await import('./dispatch-expiry-payment-cancel-worker.js'))
        .processDispatchExpiryPaymentCancelJob(job as never);
      return;
    }
    await (await import('./escrow-action-worker.js')).processEscrowActionJob(job);
  },
  'escrow.partial_refund_requested': async (job) => (await import('./escrow-action-worker.js')).processEscrowActionJob(job),
  'escrow.completion_release_requested': async (job) => (await import('./completion-release-worker.js')).processCompletionReleaseJob(job),
  'stripe.event_received': async (job) => (await import('./stripe-event-dispatcher.js')).processStripeEventDispatchJob(job),
  'task.instant_matching_started': async (job) => (await import('./instant-matching-worker.js')).processInstantMatchingJob(job),
  'task.instant_surge_evaluate': async (job) => (await import('./instant-surge-worker.js')).processInstantSurgeJob(job),
};

async function processPaymentQueueJob(job: Job): Promise<void> {
  const handler = job.name.startsWith('payment.')
    ? async (target: Job) => (await import('./payment-worker.js')).processPaymentJob(target)
    : paymentHandlers[job.name];
  if (handler) {
    await handler(job);
    return;
  }
  const error = new Error(`Unknown event type in critical_payments queue: ${job.name}`);
  log.error({ eventType: job.name, err: error.message }, 'Unknown payment event type');
  throw error;
}

const trustHandlers: Record<string, JobHandler> = {
  'trust.dispute_resolved.worker': async (job) => (await import('./trust-worker.js')).processTrustJob(job),
  'trust.dispute_resolved.poster': async (job) => (await import('./trust-worker.js')).processTrustJob(job),
  'fraud.scan_requested': async (job) => (await import('./fraud-detection-worker.js')).processFraudDetectionJob(job),
};

async function processTrustQueueJob(job: Job): Promise<void> {
  const handler = trustHandlers[job.name];
  if (handler) {
    await handler(job);
    return;
  }
  const error = new Error(`Unknown event type in critical_trust queue: ${job.name}`);
  log.error({ eventType: job.name, err: error.message }, 'Unknown trust event type');
  throw error;
}

function addWorker(active: Worker[], worker: Worker): void {
  active.push(worker);
}

export function registerWorkers(active: Worker[]): void {
  addWorker(active, createWorker('exports', processExportJob, {
    concurrency: 5, removeOnComplete: { count: 100, age: 3600 }, removeOnFail: { age: 86400 },
  }));
  addWorker(active, createWorker('user_notifications', processNotificationJob, {
    concurrency: 10, removeOnComplete: { count: 1000, age: 3600 }, removeOnFail: { age: 86400 },
  }));
  addWorker(active, createWorker('critical_payments', processPaymentQueueJob, {
    concurrency: 1, removeOnComplete: { count: 1000, age: 86400 }, removeOnFail: { age: 7 * 86400 },
  }));
  addWorker(active, createWorker('critical_trust', processTrustQueueJob, {
    concurrency: 3, removeOnComplete: { count: 500, age: 43200 }, removeOnFail: { age: 3 * 86400 },
  }));
  addWorker(active, createWorker('maintenance', async (job) => (await import('./maintenance-worker.js')).processMaintenanceJob(job), {
    concurrency: 1, removeOnComplete: { count: 100, age: 86400 }, removeOnFail: { age: 7 * 86400 },
  }));
  addWorker(active, createWorker('tax_reporting', async (job) => (await import('./tax-reporting-worker.js')).processTaxReportingJob(job), {
    concurrency: 1, removeOnComplete: { count: 50, age: 7 * 86400 }, removeOnFail: { age: 30 * 86400 },
  }));
  addWorker(active, createWorker('biometric_analysis', processBiometricAnalysisJob, {
    concurrency: 3, removeOnComplete: { count: 500, age: 43200 }, removeOnFail: { age: 3 * 86400 },
  }));
  addWorker(active, createWorker('expertise_recalc', processExpertiseRecalcJob, {
    concurrency: 1, removeOnComplete: { count: 10, age: 86400 }, removeOnFail: { age: 7 * 86400 },
  }));
  addWorker(active, createWorker('xp_tax_reminders', processXPTaxReminderJob, {
    concurrency: 1, removeOnComplete: { count: 10, age: 86400 }, removeOnFail: { age: 7 * 86400 },
  }));
  log.info('All BullMQ workers registered');
}
