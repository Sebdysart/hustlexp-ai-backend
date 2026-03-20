/**
 * Worker Runtime v1.0.0
 * 
 * SYSTEM GUARANTEES: Long-Lived Worker Process
 * 
 * Registers all BullMQ workers and starts the outbox poller loop.
 * This process must run continuously to process background jobs.
 * 
 * Pattern:
 * 1. Start outbox poller loop (reads outbox_events → enqueues BullMQ jobs)
 * 2. Register BullMQ workers (process jobs from queues)
 * 3. Handle graceful shutdown (SIGINT, SIGTERM)
 * 
 * Hard rule: Workers are a dedicated long-lived process (not part of API server)
 * 
 * Run with: `node backend/src/jobs/workers.js` or `tsx backend/src/jobs/workers.ts`
 * 
 * @see ARCHITECTURE.md §2.4 (Outbox pattern)
 */

import { fileURLToPath } from 'url';
import { createWorker, getQueue } from './queues.js';
import { startOutboxWorker, type OutboxWorkerHandles } from './outbox-worker.js';
import { processExportJob } from './export-worker.js';
import { processEmailJob } from './email-worker.js';
import { processBiometricAnalysisJob } from './biometric-analyzer-worker.js';
import { processExpertiseRecalcJob } from './expertise-recalc-worker.js';
import { processXPTaxReminderJob } from './xp-tax-reminder-worker.js';
import { workerLogger as log } from '../logger.js';
import { db } from '../db.js';
import { sendPushNotification } from '../services/PushNotificationService.js';
import type { Job, Worker } from 'bullmq';

// Track all registered workers and outbox interval handles for graceful shutdown
const activeWorkers: Worker[] = [];
let outboxHandles: OutboxWorkerHandles | null = null;

// ============================================================================
// WORKER REGISTRATION
// ============================================================================

/**
 * Register all BullMQ workers
 * Each worker processes jobs from its queue
 */
function registerWorkers(): void {
  // Export worker - processes export generation jobs
  activeWorkers.push(createWorker(
    'exports',
    async (job: Job) => {
      await processExportJob(job);
    },
    {
      concurrency: 5, // Process up to 5 export jobs concurrently
      removeOnComplete: { count: 100, age: 3600 }, // Keep completed jobs for 1 hour
      removeOnFail: { age: 86400 }, // Keep failed jobs for 24 hours
    }
  ));

  // User notifications worker - processes email and realtime delivery jobs
  activeWorkers.push(createWorker(
    'user_notifications',
    async (job: Job) => {
      const eventType = job.name;
      
      // Route based on event type
      if (eventType === 'email.send_requested' || (job.data.payload && job.data.payload.emailId)) {
        // Email delivery
        await processEmailJob(job);
      } else if (eventType === 'push.send_requested' || (job.data.payload && job.data.payload.notificationId && !job.data.payload.emailId && !job.data.payload.smsId)) {
        // Push notification delivery (FCM)
        const { processPushJob } = await import('./push-worker');
        await processPushJob(job);
      } else if (eventType === 'sms.send_requested' || (job.data.payload && job.data.payload.smsId)) {
        // SMS delivery (Twilio)
        const { processSMSJob } = await import('./sms-worker');
        await processSMSJob(job);
      } else if (eventType === 'task.instant_available') {
        // Route instant availability notifications to InstantNotificationWorker
        // NOTE: Moved from critical_payments to user_notifications to prevent
        // availability notification floods from starving actual payment jobs (W-14 fix)
        const { processInstantNotificationJob } = await import('./instant-notification-worker');
        await processInstantNotificationJob(job);
      } else if (eventType === 'task.progress_updated') {
        // Realtime task progress updates (Step 10 - Pillar A)
        const { processRealtimeJob } = await import('./realtime-worker');
        await processRealtimeJob(job);
      } else if (eventType === 'escrow.funded') {
        // Notify poster that their payment was captured and escrow is now funded
        const { escrowId } = job.data.payload as { escrowId: string };
        const result = await db.query<{ poster_id: string | null }>(
          `SELECT t.poster_id FROM escrows e JOIN tasks t ON t.id = e.task_id WHERE e.id = $1`,
          [escrowId]
        );
        const posterId = result.rows[0]?.poster_id;
        if (posterId) {
          await sendPushNotification(
            posterId,
            'Payment Captured',
            'Your payment was captured. The task is now funded and ready to be accepted.',
            { screen: 'task_detail', escrow_id: escrowId, type: 'escrow_funded' }
          );
        }
      } else if (eventType === 'escrow.refunded') {
        // Notify poster that their refund was processed
        const { escrowId } = job.data.payload as { escrowId: string };
        const result = await db.query<{ poster_id: string | null }>(
          `SELECT t.poster_id FROM escrows e JOIN tasks t ON t.id = e.task_id WHERE e.id = $1`,
          [escrowId]
        );
        const posterId = result.rows[0]?.poster_id;
        if (posterId) {
          await sendPushNotification(
            posterId,
            'Refund Processed',
            'Your payment has been refunded. Funds will appear in your account within a few business days.',
            { screen: 'task_detail', escrow_id: escrowId, type: 'escrow_refunded' }
          );
        }
      } else if (eventType === 'escrow.payment_failed') {
        // Notify poster that their payment failed — payload already carries posterId
        const { escrowId, posterId, taskId } = job.data.payload as { escrowId: string; posterId: string | null; taskId: string };
        if (posterId) {
          await sendPushNotification(
            posterId,
            'Payment Failed',
            'Your payment could not be processed. Please update your payment method and try again.',
            { screen: 'task_detail', task_id: taskId, escrow_id: escrowId, type: 'payment_failed' }
          );
        }
      } else {
        // Unknown notification type - log and skip (don't throw)
        log.info({ eventType }, 'Notification type not yet implemented');
      }
    },
    {
      concurrency: 10, // Process up to 10 notification jobs concurrently
      removeOnComplete: { count: 1000, age: 3600 }, // Keep completed jobs for 1 hour
      removeOnFail: { age: 86400 }, // Keep failed jobs for 24 hours
    }
  ));

  // Critical payments worker - processes Stripe webhooks, escrow state, XP awards, escrow actions
  activeWorkers.push(createWorker(
    'critical_payments',
    async (job: Job) => {
      const eventType = job.name;
      
      // Explicit routing: only known event types are allowed
      if (eventType === 'escrow.release_requested' || eventType === 'escrow.refund_requested' || eventType === 'escrow.partial_refund_requested') {
        // Route escrow action requests to EscrowActionWorker
        const { processEscrowActionJob } = await import('./escrow-action-worker');
        await processEscrowActionJob(job);
      } else if (eventType.startsWith('payment.')) {
        // Route Stripe events (payment.*) to PaymentWorker
        const { processPaymentJob } = await import('./payment-worker');
        await processPaymentJob(job);
      } else if (eventType === 'stripe.event_received') {
        // Route Stripe webhook events to StripeEventWorker (Step 9-D)
        const { processStripeEventJob } = await import('./stripe-event-worker');
        await processStripeEventJob(job);
      } else if (eventType === 'task.instant_matching_started') {
        // Route instant matching to InstantMatchingWorker (IEM v1)
        const { processInstantMatchingJob } = await import('./instant-matching-worker');
        await processInstantMatchingJob(job);
      } else if (eventType === 'task.instant_surge_evaluate') {
        // Route instant surge evaluation to InstantSurgeWorker (Instant Surge Incentives v1)
        const { processInstantSurgeJob } = await import('./instant-surge-worker');
        await processInstantSurgeJob(job);
      } else {
        // Unknown event type: reject to prevent processing invalid jobs
        const error = new Error(`Unknown event type in critical_payments queue: ${eventType}. Expected escrow.*_requested, payment.*, stripe.event_received, task.instant_matching_started, or task.instant_surge_evaluate`);
        log.error({ eventType, err: error.message }, 'Unknown event type in critical_payments queue');
        throw error; // BullMQ will mark job as failed
      }
    },
    {
      concurrency: 1, // Process one payment job at a time (strict ordering)
      removeOnComplete: { count: 1000, age: 86400 }, // Keep completed jobs for 24 hours
      removeOnFail: { age: 7 * 86400 }, // Keep failed jobs for 7 days
    }
  ));

  // Critical trust worker - processes trust tier recalculations, fraud signals
  activeWorkers.push(createWorker(
    'critical_trust',
    async (job: Job) => {
      const eventType = job.name;
      
      // Explicit routing: only known event types are allowed
      if (eventType === 'trust.dispute_resolved.worker' || eventType === 'trust.dispute_resolved.poster') {
        // Route trust events to TrustWorker
        const { processTrustJob } = await import('./trust-worker');
        await processTrustJob(job);
      } else if (eventType === 'fraud.scan_requested') {
        // Route fraud detection scans to FraudDetectionWorker (scheduled every 5 min)
        const { processFraudDetectionJob } = await import('./fraud-detection-worker');
        await processFraudDetectionJob(job);
      } else {
        // Unknown event type: reject to prevent processing invalid jobs
        const error = new Error(`Unknown event type in critical_trust queue: ${eventType}. Expected trust.dispute_resolved.*, fraud.scan_requested`);
        log.error({ eventType, err: error.message }, 'Unknown event type in critical_trust queue');
        throw error; // BullMQ will mark job as failed
      }
    },
    {
      concurrency: 3, // Process up to 3 trust jobs concurrently
      removeOnComplete: { count: 500, age: 43200 }, // Keep completed jobs for 12 hours
      removeOnFail: { age: 3 * 86400 }, // Keep failed jobs for 3 days
    }
  ));

  // Maintenance worker - processes cleanup, TTL expiry, backfills, recovery
  activeWorkers.push(createWorker(
    'maintenance',
    async (job: Job) => {
      const { processMaintenanceJob } = await import('./maintenance-worker');
      await processMaintenanceJob(job);
    },
    {
      concurrency: 1, // Process one maintenance job at a time
      removeOnComplete: { count: 100, age: 86400 }, // Keep completed jobs for 24 hours
      removeOnFail: { age: 7 * 86400 }, // Keep failed jobs for 7 days
    }
  ));

  // Tax reporting worker - processes annual 1099-NEC form generation
  activeWorkers.push(createWorker(
    'tax_reporting',
    async (job: Job) => {
      const { processTaxReportingJob } = await import('./tax-reporting-worker');
      await processTaxReportingJob(job);
    },
    {
      concurrency: 1, // Process one tax job at a time (annual batch)
      removeOnComplete: { count: 50, age: 7 * 86400 }, // Keep completed jobs for 7 days
      removeOnFail: { age: 30 * 86400 }, // Keep failed jobs for 30 days
    }
  ));

  // Biometric analysis worker — analyzes proof photos for liveness/deepfake detection
  activeWorkers.push(createWorker(
    'biometric_analysis',
    async (job: Job) => {
      await processBiometricAnalysisJob(job);
    },
    {
      concurrency: 3,
      removeOnComplete: { count: 500, age: 43200 },
      removeOnFail: { age: 3 * 86400 },
    }
  ));

  // Expertise supply recalculation worker — daily cron, processes recalc jobs
  activeWorkers.push(createWorker(
    'expertise_recalc',
    async (job: Job) => {
      await processExpertiseRecalcJob(job);
    },
    {
      concurrency: 1,
      removeOnComplete: { count: 10, age: 86400 },
      removeOnFail: { age: 7 * 86400 },
    }
  ));

  // XP tax reminder worker — daily cron, sends reminders for unpaid XP taxes
  activeWorkers.push(createWorker(
    'xp_tax_reminders',
    async (job: Job) => {
      await processXPTaxReminderJob(job);
    },
    {
      concurrency: 1,
      removeOnComplete: { count: 10, age: 86400 },
      removeOnFail: { age: 7 * 86400 },
    }
  ));

  log.info('All BullMQ workers registered');
}

// ============================================================================
// SCHEDULED JOBS
// ============================================================================

/**
 * Register repeatable BullMQ jobs for periodic tasks.
 * These were previously defined but never activated.
 *
 * Jobs are idempotent — BullMQ deduplicates by repeat key.
 * Safe to call on every worker restart.
 */
async function registerScheduledJobs(): Promise<void> {
  const maintenanceQueue = getQueue('maintenance');
  const criticalTrustQueue = getQueue('critical_trust');

  // Recover stuck stripe events — every 10 minutes
  // W-19 FIX: jobId removed — BullMQ repeatable jobs use their own internal repeat key
  // for deduplication. Adding a custom jobId conflicts with BullMQ's repeat key format.
  await maintenanceQueue.add(
    'recover_stuck_stripe_events',
    { timeoutMinutes: 10 },
    {
      repeat: { pattern: '*/10 * * * *' },
    }
  );

  // Cleanup expired exports — every 6 hours
  await maintenanceQueue.add(
    'cleanup_expired_exports',
    {},
    {
      repeat: { pattern: '0 */6 * * *' },
    }
  );

  // Cleanup expired notifications — every 6 hours (offset by 30 min)
  await maintenanceQueue.add(
    'cleanup_expired_notifications',
    {},
    {
      repeat: { pattern: '30 */6 * * *' },
    }
  );

  // Fraud detection scan — every 5 minutes
  await criticalTrustQueue.add(
    'fraud.scan_requested',
    {},
    {
      repeat: { pattern: '*/5 * * * *' },
    }
  );

  // Expertise supply recalculation — daily at 3:00 AM (off-peak)
  const expertiseRecalcQueue = getQueue('expertise_recalc');
  await expertiseRecalcQueue.add(
    'expertise.recalculate_all',
    {},
    {
      repeat: { pattern: '0 3 * * *' },
    }
  );

  // XP tax reminders — daily at 10:00 AM
  const xpTaxRemindersQueue = getQueue('xp_tax_reminders');
  await xpTaxRemindersQueue.add(
    'xp_tax.send_reminders',
    {},
    {
      repeat: { pattern: '0 10 * * *' },
    }
  );

  log.info('Scheduled repeatable jobs registered');
}

// ============================================================================
// MAIN WORKER PROCESS
// ============================================================================

/**
 * Start worker process
 * This is the entry point for the dedicated worker process
 */
async function startWorkers(): Promise<void> {
  log.info('Starting HustleXP Worker Runtime...');

  try {
    // Register all BullMQ workers
    registerWorkers();

    // Register repeatable scheduled jobs (maintenance, fraud detection)
    await registerScheduledJobs();

    // Start outbox poller loop (continuously reads outbox_events → enqueues BullMQ jobs)
    outboxHandles = startOutboxWorker(5000); // Poll every 5 seconds

    log.info('Worker runtime started successfully — processing jobs');

    // Keep process alive
    // Workers run in background, outbox poller runs on interval
  } catch (error) {
    log.fatal({ err: error }, 'Failed to start worker runtime');
    process.exit(1);
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let shutdownInProgress = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) {
    log.warn('Shutdown already in progress, forcing exit');
    process.exit(1);
  }

  shutdownInProgress = true;
  log.info({ signal }, 'Received signal, shutting down gracefully...');

  // Clear all outbox interval timers to prevent accumulation on hot-reload
  if (outboxHandles) {
    clearInterval(outboxHandles.outboxInterval);
    clearInterval(outboxHandles.surgeInterval);
    clearInterval(outboxHandles.trustTierInterval);
    outboxHandles = null;
  }

  // Close all BullMQ workers — each .close() waits for the current job to finish
  const closePromises = activeWorkers.map(async (worker, index) => {
    try {
      log.info({ workerName: worker.name, index: index + 1, total: activeWorkers.length }, 'Closing worker...');
      await worker.close();
      log.info({ workerName: worker.name }, 'Worker closed');
    } catch (err) {
      log.error({ workerName: worker.name, err }, 'Error closing worker');
    }
  });

  // Wait for all workers to finish (with 30s timeout)
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      log.warn('Shutdown timeout reached (30s), forcing exit');
      resolve();
    }, 30000);
  });

  await Promise.race([
    Promise.allSettled(closePromises),
    timeout,
  ]);

  log.info('Worker runtime shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ============================================================================
// START WORKERS
// ============================================================================

// Start workers if this file is run directly (ESM-compatible entry point guard)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  startWorkers().catch(error => {
    log.fatal({ err: error }, 'Fatal error starting workers');
    process.exit(1);
  });
}

export { startWorkers, registerWorkers };
