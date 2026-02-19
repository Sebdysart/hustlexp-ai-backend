/**
 * Structured Logger v1.0.0
 *
 * Pino-based structured JSON logging for production observability.
 * - Development: pretty-printed, colorized (pino-pretty)
 * - Production: JSON lines (machine-parseable for Railway / Datadog / Sentry)
 *
 * Usage:
 *   import { logger } from './logger';
 *   logger.info({ taskId, userId }, 'Task claimed');
 *   logger.error({ err, escrowId }, 'Escrow release failed');
 *
 * Child loggers for subsystems:
 *   const log = logger.child({ module: 'escrow-worker' });
 *   log.info({ jobId }, 'Processing escrow release');
 */

import pino from 'pino';
import { config } from './config';

const isDev = config.app.isDevelopment;

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),

  // Redact sensitive fields from log output
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'token',
      'secret',
      'apiKey',
      'stripe_secret',
      'firebase_uid',
    ],
    censor: '[REDACTED]',
  },

  // Base context attached to every log line
  base: {
    service: 'hustlexp-api',
    env: config.app.env,
  },

  // Timestamp as ISO string (easier to read in Railway logs)
  timestamp: pino.stdTimeFunctions.isoTime,

  // Pretty print in development
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
        },
      }
    : undefined,
});

/**
 * Pre-built child loggers for major subsystems.
 * Import directly: `import { authLogger } from './logger';`
 */
export const authLogger = logger.child({ module: 'auth' });
export const taskLogger = logger.child({ module: 'task' });
export const escrowLogger = logger.child({ module: 'escrow' });
export const workerLogger = logger.child({ module: 'worker' });
export const dbLogger = logger.child({ module: 'db' });
export const stripeLogger = logger.child({ module: 'stripe' });
export const aiLogger = logger.child({ module: 'ai' });
