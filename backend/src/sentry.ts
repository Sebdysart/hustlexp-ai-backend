/**
 * Sentry Error Tracking v1.0.0
 *
 * Initializes Sentry for error and performance monitoring.
 * Must be imported BEFORE other modules in server.ts and workers.ts.
 *
 * Features:
 * - Automatic error capture for unhandled exceptions
 * - Performance tracing (configurable sample rate)
 * - User context attachment (userId, trustTier)
 * - Sensitive data scrubbing (tokens, passwords)
 *
 * Setup:
 *   1. Set SENTRY_DSN in .env
 *   2. Import this module at the very top of entry points
 */

import * as Sentry from '@sentry/node';
import { config } from './config';

const dsn = config.sentry.dsn;

if (dsn) {
  Sentry.init({
    dsn,
    environment: config.sentry.environment,
    release: `hustlexp-api@${process.env.npm_package_version || '1.0.0'}`,

    // Performance monitoring — sample 10% of transactions in production
    tracesSampleRate: config.sentry.tracesSampleRate,

    // Don't send PII automatically
    sendDefaultPii: false,

    // Scrub sensitive data from breadcrumbs and events
    beforeSend(event) {
      // Strip authorization headers from request data
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
      }
      return event;
    },

    // Only capture errors in production (skip noisy dev errors)
    enabled: config.app.isProduction || !!process.env.SENTRY_FORCE_ENABLE,

    // Ignore common non-actionable errors
    ignoreErrors: [
      'ECONNRESET',
      'EPIPE',
      'AbortError',
      'Client network socket disconnected',
    ],
  });

  console.log('✅ Sentry error tracking initialized');
} else {
  console.log('⚠️  Sentry DSN not configured — error tracking disabled');
}

export { Sentry };

/**
 * Attach user context to Sentry scope.
 * Call this in auth middleware after verifying the user.
 */
export function setSentryUser(userId: string, extra?: Record<string, string>): void {
  Sentry.setUser({
    id: userId,
    ...extra,
  });
}

/**
 * Clear user context (on logout or request end).
 */
export function clearSentryUser(): void {
  Sentry.setUser(null);
}
