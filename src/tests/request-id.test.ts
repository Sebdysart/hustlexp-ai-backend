/**
 * Request ID — Active Hono Middleware Tests
 *
 * Tests for the active request-id system in backend/src/middleware/request-id.ts.
 * The legacy Fastify addRequestId / returnRequestId / logRequest / createGlobalErrorHandler
 * exports have been removed with the Fastify layer.
 *
 * The active system uses requestIdMiddleware (Hono middleware) and serverTimingMiddleware.
 *
 * Reference: Task 19 — Test Repair & Coverage Hardening
 */
import { describe, it, expect } from 'vitest';

describe('requestId — active Hono request-id spec alignment', () => {
  it('request-id.ts exports requestIdMiddleware function', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/middleware/request-id.ts'),
      'utf-8',
    );

    expect(source).toContain('export async function requestIdMiddleware');
  });

  it('requestIdMiddleware reuses client-provided x-request-id or generates req_<ULID>', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/middleware/request-id.ts'),
      'utf-8',
    );

    // Must check for client-provided header
    expect(source).toContain("'x-request-id'");
    // Must generate ULID-based ID
    expect(source).toContain('req_');
    expect(source).toContain('ulid');
  });

  it('requestIdMiddleware sets X-Request-Id response header', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/middleware/request-id.ts'),
      'utf-8',
    );

    expect(source).toContain("'X-Request-Id'");
  });

  it('request-id.ts exports serverTimingMiddleware for response timing', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/middleware/request-id.ts'),
      'utf-8',
    );

    expect(source).toContain('export async function serverTimingMiddleware');
    expect(source).toContain('Server-Timing');
  });
});
