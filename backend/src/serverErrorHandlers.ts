import { config } from './config.js';
import { logger } from './logger.js';
import { Sentry } from './sentry.js';
import type { HustleApp } from './serverTypes.js';

export function registerErrorHandlers(app: HustleApp): void {
  app.notFound((context) => context.json({ error: 'Not Found' }, 404));
  app.onError((error, context) => {
    const requestId = context.get('requestId');
    if (error.name === 'CircuitOpenError' && 'retryAfterMs' in error) {
      const retryAfter = Math.ceil(
        (error as unknown as { retryAfterMs: number }).retryAfterMs / 1000,
      );
      context.header('Retry-After', String(retryAfter));
      logger.warn({ requestId, service: error.message, retryAfterSec: retryAfter },
        'Circuit breaker open — service unavailable');
      return context.json({
        error: 'Service Unavailable',
        code: 'CIRCUIT_OPEN',
        requestId,
        retryAfter,
        message: 'An external service is temporarily unavailable. Please retry.',
      }, 503);
    }
    logger.error({
      err: error,
      requestId,
      path: context.req.path,
      method: context.req.method,
    }, 'Unhandled server error');
    Sentry.captureException(error, {
      extra: { requestId, path: context.req.path, method: context.req.method },
    });
    return context.json({
      error: 'Internal Server Error',
      requestId,
      message: config.app.isDevelopment
        ? error.message
        : 'An unexpected error occurred. Please try again later.',
      ...(config.app.isDevelopment && { stack: error.stack }),
    }, 500);
  });
}
