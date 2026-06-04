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
import { randomUUID } from 'crypto';

/**
 * Hono middleware — inject request ID into every request
 */
export async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
  // A48-1 FIX: Validate the X-Request-Id header before using it in structured logs.
  // An attacker could inject arbitrary JSON keys via an unvalidated header value.
  // Strip to alphanumeric + hyphens + underscores, max 64 chars. If absent or
  // invalid, generate a new UUID (not a ULID — randomUUID is the safe fallback
  // when the raw header cannot be trusted).
  const rawId = c.req.header('X-Request-Id');
  const requestId = (rawId && /^[a-zA-Z0-9_-]{1,64}$/.test(rawId)) ? rawId : randomUUID();

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
