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
import { startWorkerHealthServer, type WorkerHealthServer } from './worker-health-server.js';
import {
  productionStartupMigrationRuntime,
  runStartupMigrations,
} from '../serverStartupMigrations.js';
import { closeRedisRuntime } from '../lib/redis-runtime-shutdown.js';
import { db } from '../db.js';
import { installConfiguredRuntimeDatabase } from './install-runtime-database.js';
import {
  startFakeFinancialOutboxPublisher,
  type FakeFinancialPublisherHandle,
} from './fake-financial-publisher-runtime.js';
import {
  startProviderEventReplayWorker,
  type ProviderEventReplayWorkerHandle,
} from './provider-event-replay-worker.js';
import {
  startFakeFinancialDurableRecovery,
  type FakeFinancialDurableRecoveryHandle,
} from './fake-financial-durable-recovery-runtime.js';
import {
  PostgresUniversalV1WorkOrderCompensationRepository,
  startUniversalV1WorkOrderCompensationPoller,
  UniversalV1WorkOrderCompensationWorker,
  type UniversalV1WorkOrderCompensationPollerHandle,
} from './universal-v1-work-order-compensation-worker.js';
import {
  startUniversalV1ChangeOrderRecoveryPoller,
  UniversalV1ChangeOrderRecoveryWorker,
  type UniversalV1ChangeOrderRecoveryPollerHandle,
} from './universal-v1-change-order-recovery-worker.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import { readNonproductionFinancialBootstrapReadiness } from '../services/payment/NonproductionFinancialBootstrapReadiness.js';
import { createUniversalV1FakeFinancialApplicationService } from '../services/payment/UniversalV1FinancialApplicationService.js';
import { buildIdentity } from '../buildIdentity.js';
import { readReleaseManifest } from '../releaseManifest.js';

// Track all registered workers and outbox interval handles for graceful shutdown
const activeWorkers: Worker[] = [];
let outboxHandles: OutboxWorkerHandles | null = null;
let fakeFinancialPublisher: FakeFinancialPublisherHandle | null = null;
let workerHealthServer: WorkerHealthServer | null = null;
let providerEventReplayWorker: ProviderEventReplayWorkerHandle | null = null;
let fakeFinancialCommandRecoveryWorker: FakeFinancialDurableRecoveryHandle | null = null;
let workOrderCompensationWorker: UniversalV1WorkOrderCompensationPollerHandle | null = null;
let changeOrderRecoveryWorker: UniversalV1ChangeOrderRecoveryPollerHandle | null = null;
const WORKER_DRAIN_TIMEOUT_MS = 30_000;
export const WORKER_TERMINAL_CLOSE_TIMEOUT_MS = 30_000;

export interface WorkerShutdownResources {
  workers: ReadonlyArray<Pick<Worker, 'name' | 'close'>>;
  closeFakeFinancialPublisher?: () => Promise<void>;
  closeProviderEventReplay?: () => Promise<void>;
  closeFakeFinancialCommandRecovery?: () => Promise<void>;
  closeWorkOrderCompensation?: () => Promise<void>;
  closeChangeOrderRecovery?: () => Promise<void>;
  closeHealthServer?: () => Promise<void>;
  closeRedis: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  workerDrainTimeoutMs?: number;
  terminalCloseTimeoutMs?: number;
}

const NONPRODUCTION_FINANCIAL_WORKER_ENVIRONMENTS = new Set(['local', 'preview', 'staging']);

function nonproductionFinancialWorkerEnvironment(): 'local' | 'preview' | 'staging' | null {
  const environment = process.env.HX_ENVIRONMENT?.trim().toLowerCase() ?? '';
  return NONPRODUCTION_FINANCIAL_WORKER_ENVIRONMENTS.has(environment)
    ? (environment as 'local' | 'preview' | 'staging')
    : null;
}

async function startProviderEventReplayRuntime(): Promise<ProviderEventReplayWorkerHandle | null> {
  const environment = nonproductionFinancialWorkerEnvironment();
  if (!environment) return null;
  const release = readReleaseManifest();
  const readiness = await readNonproductionFinancialBootstrapReadiness({
    environment,
    component: 'worker',
    env: process.env,
    release,
    identity: buildIdentity,
    database: db,
  });
  if (!readiness.ready || readiness.status !== 'ready') {
    throw new Error(`PROVIDER_EVENT_REPLAY_BOOTSTRAP_NOT_READY:${readiness.status}`);
  }
  const configuredInterval = Number(process.env.HX_PROVIDER_EVENT_REPLAY_INTERVAL_MS ?? 5_000);
  return startProviderEventReplayWorker(configuredInterval);
}

async function startFakeFinancialCommandRecoveryRuntime(): Promise<void> {
  const environment = nonproductionFinancialWorkerEnvironment();
  if (!environment) {
    fakeFinancialCommandRecoveryWorker = null;
    return;
  }
  const release = readReleaseManifest();
  const readiness = await readNonproductionFinancialBootstrapReadiness({
    environment,
    component: 'worker',
    env: process.env,
    release,
    identity: buildIdentity,
    database: db,
  });
  if (!readiness.ready || readiness.status !== 'ready') {
    throw new Error(`FAKE_FINANCIAL_RECOVERY_BOOTSTRAP_NOT_READY:${readiness.status}`);
  }

  if (shutdownInProgress) throw new Error('WORKER_STARTUP_ABORTED');
  const configuredInterval = Number(
    process.env.HX_FAKE_FINANCIAL_COMMAND_RECOVERY_INTERVAL_MS ?? 5_000
  );
  fakeFinancialCommandRecoveryWorker = startFakeFinancialDurableRecovery(configuredInterval);
  await fakeFinancialCommandRecoveryWorker.ready;
  if (shutdownInProgress) throw new Error('WORKER_STARTUP_ABORTED');
}

async function startWorkOrderCompensationRuntime(): Promise<UniversalV1WorkOrderCompensationPollerHandle | null> {
  const environment = nonproductionFinancialWorkerEnvironment();
  if (!environment) return null;
  const release = readReleaseManifest();
  const readiness = await readNonproductionFinancialBootstrapReadiness({
    environment,
    component: 'worker',
    env: process.env,
    release,
    identity: buildIdentity,
    database: db,
  });
  if (!readiness.ready || readiness.status !== 'ready') {
    throw new Error(`WORK_ORDER_COMPENSATION_BOOTSTRAP_NOT_READY:${readiness.status}`);
  }

  const assertAuthorized = () => {
    assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
  };
  const configuredInterval = Number(
    process.env.HX_UNIVERSAL_V1_WORK_ORDER_COMPENSATION_INTERVAL_MS ?? 5_000
  );
  return startUniversalV1WorkOrderCompensationPoller(configuredInterval, {
    worker: new UniversalV1WorkOrderCompensationWorker(
      new PostgresUniversalV1WorkOrderCompensationRepository(db),
      () => createUniversalV1FakeFinancialApplicationService()
    ),
    assertAuthorized,
  });
}

async function startChangeOrderRecoveryRuntime(): Promise<UniversalV1ChangeOrderRecoveryPollerHandle | null> {
  const environment = nonproductionFinancialWorkerEnvironment();
  if (!environment) return null;
  const release = readReleaseManifest();
  const readiness = await readNonproductionFinancialBootstrapReadiness({
    environment,
    component: 'worker',
    env: process.env,
    release,
    identity: buildIdentity,
    database: db,
  });
  if (!readiness.ready || readiness.status !== 'ready') {
    throw new Error(`CHANGE_ORDER_RECOVERY_BOOTSTRAP_NOT_READY:${readiness.status}`);
  }

  const assertAuthorized = () => {
    assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
  };
  const configuredInterval = Number(
    process.env.HX_UNIVERSAL_V1_CHANGE_ORDER_RECOVERY_INTERVAL_MS ?? 5_000
  );
  return startUniversalV1ChangeOrderRecoveryPoller(configuredInterval, {
    worker: new UniversalV1ChangeOrderRecoveryWorker(),
    assertAuthorized,
  });
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
    await runStartupMigrations(log, productionStartupMigrationRuntime(db.readQuery));
    if (shutdownInProgress) throw new Error('WORKER_STARTUP_ABORTED');
    if (nonproductionFinancialWorkerEnvironment()) {
      fakeFinancialPublisher = startFakeFinancialOutboxPublisher();
      await fakeFinancialPublisher.ready;
      if (shutdownInProgress) throw new Error('WORKER_STARTUP_ABORTED');
    }
    providerEventReplayWorker = await startProviderEventReplayRuntime();
    await startFakeFinancialCommandRecoveryRuntime();
    workOrderCompensationWorker = await startWorkOrderCompensationRuntime();
    changeOrderRecoveryWorker = await startChangeOrderRecoveryRuntime();
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
    throw error;
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let shutdownInProgress = false;

async function closeWorkerResourceWithDeadline(
  close: () => Promise<void>,
  resourceName: string,
  timeoutMs: number
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
export async function shutdownWorkerResources(resources: WorkerShutdownResources): Promise<void> {
  const errors: unknown[] = [];
  const workerErrors: unknown[] = [];
  const drainTimeoutMs = resources.workerDrainTimeoutMs ?? WORKER_DRAIN_TIMEOUT_MS;
  const terminalCloseTimeoutMs =
    resources.terminalCloseTimeoutMs ?? WORKER_TERMINAL_CLOSE_TIMEOUT_MS;

  const producers = [
    { close: resources.closeFakeFinancialPublisher, name: 'fake_financial_publisher' },
    { close: resources.closeFakeFinancialCommandRecovery, name: 'fake_financial_recovery' },
  ];
  await Promise.all(
    producers.map(async ({ close, name }) => {
      if (!close) return;
      try {
        await closeWorkerResourceWithDeadline(close, name, terminalCloseTimeoutMs);
      } catch (error) {
        errors.push(error);
        log.error({ err: error, resource: name }, 'Error draining fake-financial producer');
      }
    })
  );

  const closePromises = resources.workers.map(async (worker, index) => {
    try {
      log.info(
        { workerName: worker.name, index: index + 1, total: resources.workers.length },
        'Closing worker...'
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
  if (resources.closeProviderEventReplay) {
    terminalCloseSteps.push({
      name: 'provider event replay worker',
      close: resources.closeProviderEventReplay,
    });
  }
  if (resources.closeWorkOrderCompensation) {
    terminalCloseSteps.push({
      name: 'WorkOrder compensation worker',
      close: resources.closeWorkOrderCompensation,
    });
  }
  if (resources.closeChangeOrderRecovery) {
    terminalCloseSteps.push({
      name: 'change-order recovery worker',
      close: resources.closeChangeOrderRecovery,
    });
  }
  if (resources.closeHealthServer) {
    terminalCloseSteps.push({ name: 'worker health server', close: resources.closeHealthServer });
  }
  terminalCloseSteps.push(
    { name: 'Redis runtime', close: resources.closeRedis },
    { name: 'database pool', close: resources.closeDatabase }
  );

  for (const step of terminalCloseSteps) {
    try {
      await closeWorkerResourceWithDeadline(
        step.close,
        step.name.replaceAll(' ', '_'),
        terminalCloseTimeoutMs
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
  const fakeFinancialPublisherToClose = fakeFinancialPublisher;
  fakeFinancialPublisher = null;
  const providerEventReplayToClose = providerEventReplayWorker;
  providerEventReplayWorker = null;
  const fakeFinancialCommandRecoveryToClose = fakeFinancialCommandRecoveryWorker;
  fakeFinancialCommandRecoveryWorker = null;
  const workOrderCompensationToClose = workOrderCompensationWorker;
  workOrderCompensationWorker = null;
  const changeOrderRecoveryToClose = changeOrderRecoveryWorker;
  changeOrderRecoveryWorker = null;
  const healthServerToClose = workerHealthServer;
  workerHealthServer = null;
  let exitCode = 0;
  try {
    await shutdownWorkerResources({
      workers: workersToDrain,
      closeFakeFinancialPublisher: fakeFinancialPublisherToClose?.stop.bind(
        fakeFinancialPublisherToClose
      ),
      closeProviderEventReplay: providerEventReplayToClose
        ? () => providerEventReplayToClose.stop()
        : undefined,
      closeFakeFinancialCommandRecovery: fakeFinancialCommandRecoveryToClose
        ? () => fakeFinancialCommandRecoveryToClose.stop()
        : undefined,
      closeWorkOrderCompensation: workOrderCompensationToClose
        ? () => workOrderCompensationToClose.stop()
        : undefined,
      closeChangeOrderRecovery: changeOrderRecoveryToClose
        ? () => changeOrderRecoveryToClose.stop()
        : undefined,
      closeHealthServer: healthServerToClose ? () => healthServerToClose.close() : undefined,
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

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

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
  const installed = await installConfiguredRuntimeDatabase('worker');
  try {
    workerHealthServer = await startWorkerHealthServer({
      fakeFinancialPublisherHealth: () => fakeFinancialPublisher?.status() ?? null,
      providerEventReplayHealth: () => providerEventReplayWorker?.health() ?? null,
      fakeFinancialCommandRecoveryHealth: () =>
        fakeFinancialCommandRecoveryWorker?.health() ?? null,
      workOrderCompensationHealth: () => workOrderCompensationWorker?.health() ?? null,
      changeOrderRecoveryHealth: () => changeOrderRecoveryWorker?.health() ?? null,
    });
    await startWorkers();
    if (shutdownInProgress) throw new Error('WORKER_STARTUP_ABORTED');
    workerHealthServer.markReady();
  } catch (error) {
    if (outboxHandles) {
      clearInterval(outboxHandles.outboxInterval);
      clearInterval(outboxHandles.surgeInterval);
      clearInterval(outboxHandles.trustTierInterval);
      outboxHandles = null;
    }
    try {
      await shutdownWorkerResources({
        workers: activeWorkers.splice(0, activeWorkers.length),
        closeFakeFinancialPublisher: fakeFinancialPublisher?.stop.bind(fakeFinancialPublisher),
        closeProviderEventReplay: providerEventReplayWorker?.stop.bind(providerEventReplayWorker),
        closeFakeFinancialCommandRecovery: fakeFinancialCommandRecoveryWorker?.stop.bind(
          fakeFinancialCommandRecoveryWorker
        ),
        closeWorkOrderCompensation: workOrderCompensationWorker?.stop.bind(
          workOrderCompensationWorker
        ),
        closeChangeOrderRecovery: changeOrderRecoveryWorker?.stop.bind(changeOrderRecoveryWorker),
        closeHealthServer: workerHealthServer?.close.bind(workerHealthServer),
        closeRedis: closeRedisRuntime,
        closeDatabase: () => installed.close(),
      });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'WORKER_BOOT_AND_CLEANUP_FAILED');
    } finally {
      fakeFinancialPublisher = null;
      providerEventReplayWorker = null;
      fakeFinancialCommandRecoveryWorker = null;
      workOrderCompensationWorker = null;
      changeOrderRecoveryWorker = null;
      workerHealthServer = null;
    }
    throw error;
  }
}

// Start workers if this file is run directly (ESM-compatible entry point guard)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  bootWorkerProcess().catch((error) => {
    log.fatal({ err: error }, 'Fatal error starting workers');
    process.exit(1);
  });
}

export { startWorkers, registerWorkers };
