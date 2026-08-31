import type { ServerType } from '@hono/node-server';
import { db } from './db.js';
import { closeRedisRuntime } from './lib/redis-runtime-shutdown.js';
import { logger } from './logger.js';
import { Sentry } from './sentry.js';

// Redis runtime closes queue connections, pub/sub roles, and the command port
// in a bounded sequence (currently at most 20s). Keep the outer resource
// deadline above that sum so every role gets its own forced-close attempt.
export const API_SHUTDOWN_TIMEOUT_MS = 30_000;

interface ApiShutdownResources {
  closeHttp: () => Promise<unknown> | unknown;
  closeRedis: () => Promise<unknown> | unknown;
  closeDatabase: () => Promise<unknown> | unknown;
  closeTimeoutMs?: number;
}

let shutdownPromise: Promise<void> | undefined;

async function runWithShutdownDeadline(
  operation: () => Promise<unknown> | unknown,
  timeoutMs: number,
  timeoutCode: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${timeoutCode}: resource did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
  });

  try {
    await Promise.race([
      Promise.resolve().then(operation),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function stopHttpIntake(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Close every API runtime dependency in order. Each resource receives its own
 * bounded deadline, and a failure never prevents later resources from being
 * attempted. The terminal AggregateError is the process-outcome authority.
 */
export async function shutdownServerResources({
  closeHttp,
  closeRedis,
  closeDatabase,
  closeTimeoutMs = API_SHUTDOWN_TIMEOUT_MS,
}: ApiShutdownResources): Promise<void> {
  const resources = [
    {
      name: 'HTTP server',
      timeoutCode: 'HTTP_CLOSE_TIMEOUT',
      close: closeHttp,
      successMessage: 'HTTP server closed — no new connections',
    },
    {
      name: 'Redis runtime',
      timeoutCode: 'REDIS_RUNTIME_CLOSE_TIMEOUT',
      close: closeRedis,
      successMessage: 'Redis queues, pub/sub, and command client closed',
    },
    {
      name: 'database pool',
      timeoutCode: 'DATABASE_CLOSE_TIMEOUT',
      close: closeDatabase,
      successMessage: 'Database pool closed',
    },
  ];
  const errors: unknown[] = [];

  for (const resource of resources) {
    try {
      await runWithShutdownDeadline(
        resource.close,
        closeTimeoutMs,
        resource.timeoutCode,
      );
      logger.info(resource.successMessage);
    } catch (error) {
      errors.push(error);
      logger.error({ err: error, resource: resource.name }, `Error closing ${resource.name}`);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'API runtime shutdown encountered one or more failures');
  }
}

async function performGracefulShutdown(server: ServerType, signal: string): Promise<void> {
  logger.info({ signal }, `Received ${signal}, shutting down gracefully...`);
  let exitCode = 0;
  try {
    await shutdownServerResources({
      closeHttp: () => stopHttpIntake(server),
      closeRedis: closeRedisRuntime,
      closeDatabase: () => db.close(),
    });
  } catch (error) {
    exitCode = 1;
    logger.error({ err: error }, 'Graceful shutdown completed with cleanup failures');
  }

  logger.info({ exitCode }, 'Graceful shutdown complete');
  process.exit(exitCode);
}

export function gracefulShutdown(server: ServerType, signal: string): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = performGracefulShutdown(server, signal);
  } else {
    logger.warn({ signal }, 'Shutdown already in progress; reusing the active shutdown operation');
  }
  return shutdownPromise;
}

export function installProcessHandlers(server: ServerType): void {
  process.on('SIGINT', () => { void gracefulShutdown(server, 'SIGINT'); });
  process.on('SIGTERM', () => { void gracefulShutdown(server, 'SIGTERM'); });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
    Sentry.captureException(reason);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception — shutting down');
    Sentry.captureException(error);
    setTimeout(() => process.exit(1), 2000);
  });
}
