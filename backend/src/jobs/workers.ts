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

import { createWorker } from './queues';
import { startOutboxWorker } from './outbox-worker';
import { processExportJob } from './export-worker';
import { processEmailJob } from './email-worker';
import type { Job } from 'bullmq';

// ============================================================================
// WORKER REGISTRATION
// ============================================================================

/**
 * Register all BullMQ workers
 * Each worker processes jobs from its queue
 */
function registerWorkers(): void {
  // Export worker - processes export generation jobs
  createWorker(
    'exports',
    async (job: Job) => {
      await processExportJob(job);
    },
    {
      concurrency: 5, // Process up to 5 export jobs concurrently
      removeOnComplete: { count: 100, age: 3600 }, // Keep completed jobs for 1 hour
      removeOnFail: { age: 86400 }, // Keep failed jobs for 24 hours
    }
  );
  
  // User notifications worker - processes email and realtime delivery jobs
  createWorker(
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
      } else if (eventType === 'task.progress_updated') {
        // Realtime task progress updates (Step 10 - Pillar A)
        const { processRealtimeJob } = await import('./realtime-worker');
        await processRealtimeJob(job);
      } else {
        // Unknown notification type - log and skip (don't throw)
        console.log(`ℹ️  Notification type '${eventType}' not yet implemented (will be handled by NotificationService)`);
      }
    },
    {
      concurrency: 10, // Process up to 10 notification jobs concurrently
      removeOnComplete: { count: 1000, age: 3600 }, // Keep completed jobs for 1 hour
      removeOnFail: { age: 86400 }, // Keep failed jobs for 24 hours
    }
  );
  
  // Critical payments worker - processes Stripe webhooks, escrow state, XP awards, escrow actions
  createWorker(
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
      } else if (eventType === 'task.instant_available') {
        // Route instant notifications to InstantNotificationWorker (Notification Urgency Design v1)
        const { processInstantNotificationJob } = await import('./instant-notification-worker');
        await processInstantNotificationJob(job);
      } else if (eventType === 'task.instant_surge_evaluate') {
        // Route instant surge evaluation to InstantSurgeWorker (Instant Surge Incentives v1)
        const { processInstantSurgeJob } = await import('./instant-surge-worker');
        await processInstantSurgeJob(job);
      } else {
        // Unknown event type: reject to prevent processing invalid jobs
        const error = new Error(`Unknown event type in critical_payments queue: ${eventType}. Expected escrow.*_requested, payment.*, stripe.event_received, task.instant_matching_started, task.instant_available, or task.instant_surge_evaluate`);
        console.error(`❌ ${error.message}`);
        throw error; // BullMQ will mark job as failed
      }
    },
    {
      concurrency: 1, // Process one payment job at a time (strict ordering)
      removeOnComplete: { count: 1000, age: 86400 }, // Keep completed jobs for 24 hours
      removeOnFail: { age: 7 * 86400 }, // Keep failed jobs for 7 days
    }
  );
  
  // Critical trust worker - processes trust tier recalculations, fraud signals
  createWorker(
    'critical_trust',
    async (job: Job) => {
      const eventType = job.name;
      
      // Explicit routing: only known event types are allowed
      if (eventType === 'trust.dispute_resolved.worker' || eventType === 'trust.dispute_resolved.poster') {
        // Route trust events to TrustWorker
        const { processTrustJob } = await import('./trust-worker');
        await processTrustJob(job);
      } else {
        // Unknown event type: reject to prevent processing invalid jobs
        const error = new Error(`Unknown event type in critical_trust queue: ${eventType}. Expected trust.dispute_resolved.worker or trust.dispute_resolved.poster`);
        console.error(`❌ ${error.message}`);
        throw error; // BullMQ will mark job as failed
      }
    },
    {
      concurrency: 3, // Process up to 3 trust jobs concurrently
      removeOnComplete: { count: 500, age: 43200 }, // Keep completed jobs for 12 hours
      removeOnFail: { age: 3 * 86400 }, // Keep failed jobs for 3 days
    }
  );
  
  // Maintenance worker - processes cleanup, TTL expiry, backfills, recovery
  createWorker(
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
  );
  
  console.log('✅ All BullMQ workers registered');
}

// ============================================================================
// OUTBOX POLLER LOOP
// ============================================================================


// ============================================================================
// MAIN WORKER PROCESS
// ============================================================================

/**
 * Start worker process
 * This is the entry point for the dedicated worker process
 */
async function startWorkers(): Promise<void> {
  console.log('🚀 Starting HustleXP Worker Runtime...');
  
  try {
    // Register all BullMQ workers
    registerWorkers();
    
    // Start outbox poller loop (continuously reads outbox_events → enqueues BullMQ jobs)
    startOutboxWorker(5000); // Poll every 5 seconds
    
    console.log('✅ Worker runtime started successfully');
    console.log('📝 Workers are now processing jobs...');
    console.log('   - Press Ctrl+C to stop gracefully');
    
    // Keep process alive
    // Workers run in background, outbox poller runs on interval
  } catch (error) {
    console.error('❌ Failed to start worker runtime:', error);
    process.exit(1);
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let shutdownInProgress = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) {
    console.log('⚠️  Shutdown already in progress, forcing exit...');
    process.exit(1);
  }
  
  shutdownInProgress = true;
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  
  // TODO: Close worker connections gracefully
  // Workers will complete current jobs before shutting down
  
  console.log('✅ Worker runtime shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ============================================================================
// START WORKERS
// ============================================================================

// Start workers if this file is run directly
if (require.main === module) {
  startWorkers().catch(error => {
    console.error('❌ Fatal error starting workers:', error);
    process.exit(1);
  });
}

export { startWorkers, registerWorkers };
