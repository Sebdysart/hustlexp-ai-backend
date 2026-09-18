import type { ServerType } from '@hono/node-server';
import { db } from './db.js';
import { logger } from './logger.js';
import { Sentry } from './sentry.js';

let shutdownInProgress = false;

function closeHttpServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function gracefulShutdown(
  server: ServerType,
  signal: string,
): Promise<void> {
  if (shutdownInProgress) {
    logger.warn('Shutdown already in progress, forcing exit...');
    process.exit(1);
  }

  shutdownInProgress = true;

  logger.info(
    { signal },
    `Received ${signal}, shutting down gracefully...`,
  );

  const forceExitTimeout = setTimeout(() => {
    logger.fatal(
      'Graceful shutdown timeout reached (10s), forcing exit...',
    );
    process.exit(1);
  }, 10_000);

  forceExitTimeout.unref();

  try {
    await closeHttpServer(server);
    logger.info('HTTP server closed — active requests drained');
  } catch (error) {
    logger.error(
      { err: error },
      'Error closing HTTP server',
    );
  }

  try {
    await db.close();
    logger.info('Database pool closed');
  } catch (error) {
    logger.error({ err: error }, 'Error closing database pool');
  }

  clearTimeout(forceExitTimeout);
  logger.info('Graceful shutdown complete');
  process.exit(0);
}

export function installProcessHandlers(server: ServerType): void {
  process.on('SIGINT', () => {
    void gracefulShutdown(server, 'SIGINT');
  });

  process.on('SIGTERM', () => {
    void gracefulShutdown(server, 'SIGTERM');
  });

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
