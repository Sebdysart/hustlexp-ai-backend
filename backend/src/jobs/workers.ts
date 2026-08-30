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
import {
  startWorkerHealthServer,
  type WorkerHealthServer,
} from './worker-health-server.js';
import { runStartupMigrations } from '../serverStartupMigrations.js';
import { closeRedisRuntime } from '../lib/redis-runtime-shutdown.js';
import { db } from '../db.js';

// Track all registered workers and outbox interval handles for graceful shutdown
const activeWorkers: Worker[] = [];
let outboxHandles: OutboxWorkerHandles | null = null;
let workerHealthServer: WorkerHealthServer | null = null;
const WORKER_DRAIN_TIMEOUT_MS = 30_000;
export const WORKER_TERMINAL_CLOSE_TIMEOUT_MS = 30_000;

export interface WorkerShutdownResources {
  workers: ReadonlyArray<Pick<Worker, 'name' | 'close'>>;
  closeHealthServer?: () => Promise<void>;
  closeRedis: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  workerDrainTimeoutMs?: number;
  terminalCloseTimeoutMs?: number;
}

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

  try {
    log.info('Starting HustleXP Worker Runtime...');
    await runStartupMigrations(log);
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

async function closeWorkerResourceWithDeadline(
  close: () => Promise<void>,
  resourceName: string,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`WORKER_RESOURCE_CLOSE_TIMEOUT:${resourceName}:${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    await Promise.race([Promise.resolve().then(close), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Drain worker jobs before closing their Redis dependencies, then close every
 * remaining process resource even when an earlier close fails. The aggregate
 * rejection is the worker process's authoritative non-zero shutdown signal.
 */
export async function shutdownWorkerResources(
  resources: WorkerShutdownResources,
): Promise<void> {
  const errors: unknown[] = [];
  const workerErrors: unknown[] = [];
  const drainTimeoutMs = resources.workerDrainTimeoutMs ?? WORKER_DRAIN_TIMEOUT_MS;
  const terminalCloseTimeoutMs = resources.terminalCloseTimeoutMs
    ?? WORKER_TERMINAL_CLOSE_TIMEOUT_MS;

  const closePromises = resources.workers.map(async (worker, index) => {
    try {
      log.info(
        { workerName: worker.name, index: index + 1, total: resources.workers.length },
        'Closing worker...',
      );
      await worker.close();
      log.info({ workerName: worker.name }, 'Worker closed');
    } catch (error) {
      workerErrors.push(error);
      log.error({ workerName: worker.name, err: error }, 'Error closing worker');
      throw error;
    }
  });

  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutMarker = Symbol('worker-drain-timeout');
  const drainResult = await Promise.race([
    Promise.allSettled(closePromises),
    new Promise<typeof timeoutMarker>((resolve) => {
      drainTimer = setTimeout(() => resolve(timeoutMarker), drainTimeoutMs);
      drainTimer.unref();
    }),
  ]);
  if (drainTimer) clearTimeout(drainTimer);

  errors.push(...workerErrors);
  if (drainResult === timeoutMarker) {
    const timeoutError = new Error(`WORKER_DRAIN_TIMEOUT: exceeded ${drainTimeoutMs}ms`);
    errors.push(timeoutError);
    log.error({ drainTimeoutMs }, 'Worker drain timeout reached');
  }

  const terminalCloseSteps: Array<{ name: string; close: () => Promise<void> }> = [];
  if (resources.closeHealthServer) {
    terminalCloseSteps.push({ name: 'worker health server', close: resources.closeHealthServer });
  }
  terminalCloseSteps.push(
    { name: 'Redis runtime', close: resources.closeRedis },
    { name: 'database pool', close: resources.closeDatabase },
  );

  for (const step of terminalCloseSteps) {
    try {
      await closeWorkerResourceWithDeadline(
        step.close,
        step.name.replaceAll(' ', '_'),
        terminalCloseTimeoutMs,
      );
      log.info(`${step.name} closed`);
    } catch (error) {
      errors.push(error);
      log.error({ err: error }, `Error closing ${step.name}`);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Worker runtime shutdown encountered one or more failures');
  }
}

export async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) {
    log.warn('Shutdown already in progress, forcing exit');
    process.exit(1);
    return;
  }

  shutdownInProgress = true;
  workerHealthServer?.markShuttingDown();
  log.info({ signal }, 'Received signal, shutting down gracefully...');

  // Clear all outbox interval timers to prevent accumulation on hot-reload
  if (outboxHandles) {
    clearInterval(outboxHandles.outboxInterval);
    clearInterval(outboxHandles.surgeInterval);
    clearInterval(outboxHandles.trustTierInterval);
    outboxHandles = null;
  }

  const workersToDrain = activeWorkers.splice(0, activeWorkers.length);
  const healthServerToClose = workerHealthServer;
  workerHealthServer = null;
  let exitCode = 0;
  try {
    await shutdownWorkerResources({
      workers: workersToDrain,
      closeHealthServer: healthServerToClose
        ? () => healthServerToClose.close()
        : undefined,
      closeRedis: closeRedisRuntime,
      closeDatabase: () => db.close(),
    });
  } catch (error) {
    exitCode = 1;
    log.error({ err: error }, 'Worker runtime shutdown failed');
  }

  log.info({ exitCode }, 'Worker runtime shutdown complete');
  process.exit(exitCode);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

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
  workerHealthServer = await startWorkerHealthServer();
  await startWorkers();
  workerHealthServer.markReady();
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
