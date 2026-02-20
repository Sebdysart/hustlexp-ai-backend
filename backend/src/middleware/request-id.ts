/**
 * Request ID Middleware v1.0.0
 *
 * Attaches a unique request ID to every incoming request for distributed tracing.
 *
 * The ID is:
 * - Generated as a ULID (time-sortable, unique)
 * - Attached to the response as `X-Request-Id` header
 * - Available in the Hono context for logging: `c.get('requestId')`
 * - Passed to Sentry for error correlation
 *
 * If the client sends an `X-Request-Id` header, it's reused (for end-to-end tracing).
 *
 * @see ARCHITECTURE.md §2.7 (Observability)
 */

import { Context, Next } from 'hono';
import { ulid } from 'ulidx';

/**
 * Hono middleware — inject request ID into every request
 */
export async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
  // Reuse client-provided ID or generate new one
  const requestId = c.req.header('x-request-id') || `req_${ulid()}`;

  // Make available to downstream handlers via Hono context
  c.set('requestId', requestId);

  // Add to response headers for client-side correlation
  c.header('X-Request-Id', requestId);

  await next();
}

/**
 * Response time middleware — adds Server-Timing header
 */
export async function serverTimingMiddleware(c: Context, next: Next): Promise<void> {
  const start = performance.now();

  await next();

  const duration = (performance.now() - start).toFixed(1);
  c.header('Server-Timing', `total;dur=${duration}`);
}
