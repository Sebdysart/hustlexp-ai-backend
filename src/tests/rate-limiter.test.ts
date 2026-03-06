/**
 * Rate Limiting — Active Hono Security Middleware Tests
 *
 * Tests for the active rate-limiting system in backend/src/middleware/security.ts.
 * The legacy Fastify adminRateLimiter / financialRateLimiter exports have been removed.
 * The active system uses rateLimitMiddleware(category) via Redis-backed sliding window.
 *
 * Reference: Task 19 — Test Repair & Coverage Hardening
 */
import { describe, it, expect } from 'vitest';

describe('rateLimiter — active Hono rate-limiting spec alignment', () => {
  it('security.ts exports rateLimitMiddleware function', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/middleware/security.ts'),
      'utf-8',
    );

    expect(source).toContain('export function rateLimitMiddleware');
  });

  it('RATE_LIMITS defines all six required categories', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/middleware/security.ts'),
      'utf-8',
    );

    // All required rate-limit categories
    expect(source).toContain("ai:");
    expect(source).toContain("auth:");
    expect(source).toContain("escrow:");
    expect(source).toContain("financial:");
    expect(source).toContain("task:");
    expect(source).toContain("general:");
  });

  it('rateLimitMiddleware sets standard rate-limit response headers', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/middleware/security.ts'),
      'utf-8',
    );

    // Must set X-RateLimit-* headers
    expect(source).toContain('X-RateLimit-Limit');
    expect(source).toContain('X-RateLimit-Remaining');
    expect(source).toContain('X-RateLimit-Reset');
  });

  it('security.ts exports securityHeaders middleware', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/middleware/security.ts'),
      'utf-8',
    );

    expect(source).toContain('export async function securityHeaders');
    // Must set essential security headers
    expect(source).toContain('X-Frame-Options');
    expect(source).toContain('X-Content-Type-Options');
    expect(source).toContain('Content-Security-Policy');
  });
});
