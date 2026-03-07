import * as Sentry from '@sentry/node';

/**
 * Sentry is initialized automatically when ../sentry.ts is imported by server.ts.
 * That module also scrubs sensitive headers (authorization, cookie) AND body fields
 * (password, ssn, bankAccount) via its beforeSend callback.
 *
 * This function exists for compatibility with callers that expect an explicit init step;
 * the actual initialization happens via automatic module evaluation of src/sentry.ts.
 */
export function initSentry(): void {
  // No-op: initialization happens via automatic module evaluation of ../sentry.ts
}

export function captureError(error: unknown, context?: Record<string, unknown>) {
  if (context) {
    Sentry.withScope((scope) => {
      Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
      Sentry.captureException(error);
    });
  } else {
    Sentry.captureException(error);
  }
}

export { Sentry };
