import type { ServerType } from '@hono/node-server';
import { db } from './db.js';
import { logger } from './logger.js';
import { Sentry } from './sentry.js';

let shutdownInProgress = false;

async function gracefulShutdown(server: ServerType, signal: string): Promise<void> {
  if (shutdownInProgress) {
    logger.warn('Shutdown already in progress, forcing exit...');
    process.exit(1);
  }
  shutdownInProgress = true;
  logger.info({ signal }, `Received ${signal}, shutting down gracefully...`);
  server.close((error) => {
    if (error) logger.error({ err: error }, 'Error closing HTTP server');
    else logger.info('HTTP server closed — no new connections');
  });
  const drainTimeout = setTimeout(() => {
    logger.warn('Drain timeout reached (10s), forcing shutdown...');
  }, 10_000);
  try {
    await db.close();
    logger.info('Database pool closed');
  } catch (error) {
    logger.error({ err: error }, 'Error closing database pool');
  }
  clearTimeout(drainTimeout);
  logger.info('Graceful shutdown complete');
  process.exit(0);
}

export function installProcessHandlers(server: ServerType): void {
  process.on('SIGINT', () => gracefulShutdown(server, 'SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown(server, 'SIGTERM'));
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
