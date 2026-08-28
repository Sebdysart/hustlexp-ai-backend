/**
 * Sentry utility wrappers.
 *
 * Actual Sentry initialisation is a top-level side-effect in
 * `src/sentry.ts` (imported first in entry-points).  This module
 * provides convenience helpers the rest of the codebase can import
 * without triggering init or depending on import order.
 */

import * as Sentry from '@sentry/node';

/**
 * No-op retained for call-site compatibility.
 * Sentry.init() is handled by `src/sentry.ts` at module load time.
 */
export function initSentry(): void {
  // intentional no-op — see src/sentry.ts
}

/**
 * Capture an error with optional structured context.
 *
 * When `context` is supplied each key-value pair is attached via
 * `Sentry.withScope` so it appears in the Sentry event UI.
 */
export function captureError(
  err: Error,
  context?: Record<string, unknown>,
): void {
  if (context) {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
      Sentry.captureException(err);
    });
  } else {
    Sentry.captureException(err);
  }
}
