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
import { startOutboxWorker, type OutboxWorkerHandles } from './outbox-worker.js';
import { workerLogger as log } from '../logger.js';
import { validateConfig } from '../config.js';
import type { Worker } from 'bullmq';
import { registerWorkers as registerWorkerSet } from './worker-registration.js';
import { registerScheduledJobs } from './worker-schedules.js';

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
  registerWorkerSet(activeWorkers);
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

/**
 * Worker process entry point.
 *
 * Runs fail-fast config validation BEFORE starting any workers. In production
 * validateConfig() calls process.exit(1) on missing/invalid required vars
 * (DATABASE_URL, Redis TCP for BullMQ, QUEUE_HMAC_SECRET, Stripe, Firebase,
 * TAX_TIN_ENCRYPTION_KEY); in dev/test it is a no-op that never exits.
 *
 * IMPORTANT: validateConfig() is intentionally NOT called inside startWorkers().
 * Unit tests (e.g. scheduled-jobs.test.ts) invoke startWorkers() directly while
 * mocking '../config' WITHOUT a validateConfig export — calling it there would
 * throw "validateConfig is not a function" and break those tests. Keeping it in
 * this process-entry guard means direct startWorkers() unit calls are unaffected.
 */
export async function bootWorkerProcess(): Promise<void> {
  validateConfig();
  await startWorkers();
}

// Start workers if this file is run directly (ESM-compatible entry point guard)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  bootWorkerProcess().catch(error => {
    log.fatal({ err: error }, 'Fatal error starting workers');
    process.exit(1);
  });
}

export { startWorkers, registerWorkers };
