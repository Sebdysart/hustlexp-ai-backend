/**
 * DB Query Tracing Helper
 *
 * postgres.js (used via the `sql` tagged-template) does NOT use the native
 * `pg` driver under the hood, so @opentelemetry/instrumentation-pg cannot
 * auto-instrument it.  This module provides a lightweight manual wrapper.
 *
 * Usage:
 *   import { tracedQuery } from '../telemetry/dbTracer.js';
 *   const rows = await tracedQuery('users.findById', () => sql`SELECT ...`);
 *
 * Only wrap critical / high-traffic operations — wrapping every query is too
 * invasive and reduces readability without proportional observability gain.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from './index.js';

/**
 * Execute `fn` inside an OTel span named `db.query ${name}`.
 *
 * The span carries:
 *   db.system     = 'postgresql'
 *   db.operation  = the human-readable operation name passed as `name`
 *
 * Errors are recorded on the span before being re-thrown so that callers
 * still receive the original exception.
 */
export function tracedQuery<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`db.query ${name}`, async (span) => {
    span.setAttribute('db.system', 'postgresql');
    span.setAttribute('db.operation', name);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: unknown) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
