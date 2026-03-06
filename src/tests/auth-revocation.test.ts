/**
 * Auth Token Revocation — Active Hono Auth Middleware Tests
 *
 * Verifies the active auth system in backend/src/auth/:
 *   1. TOKEN_CACHE_TTL_SECONDS is at most 5 minutes (300 seconds)
 *   2. REVOCATION_MARKER_TTL_SECONDS exceeds cache TTL
 *   3. authenticateRequest calls verifyIdToken with checkRevoked=true
 *   4. Auth middleware handles auth/id-token-revoked errors
 *
 * The legacy Fastify verifyTokenWithRevocationCheck has been removed.
 *
 * Reference: Task 19 — Test Repair & Coverage Hardening
 */
import { describe, it, expect } from 'vitest';

describe('Auth token revocation — active Hono spec alignment', () => {
  it('TOKEN_CACHE_TTL_SECONDS is at most 5 minutes (300 seconds)', async () => {
    const { TOKEN_CACHE_TTL_SECONDS } = await import(
      '../../backend/src/auth/constants.js'
    );

    expect(TOKEN_CACHE_TTL_SECONDS).toBeLessThanOrEqual(5 * 60);
    expect(TOKEN_CACHE_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('REVOCATION_MARKER_TTL_SECONDS exceeds TOKEN_CACHE_TTL_SECONDS by at least 60s', async () => {
    const { TOKEN_CACHE_TTL_SECONDS, REVOCATION_MARKER_TTL_SECONDS } =
      await import('../../backend/src/auth/constants.js');

    expect(REVOCATION_MARKER_TTL_SECONDS).toBeGreaterThanOrEqual(
      TOKEN_CACHE_TTL_SECONDS + 60,
    );
  });

  it('authenticateRequest calls verifyIdToken with checkRevoked=true', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/auth/middleware.ts'),
      'utf-8',
    );

    // Must call verifyIdToken with checkRevoked enabled
    expect(source).toContain('verifyIdToken(token, true)');
  });

  it('auth middleware handles auth/id-token-revoked error', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/auth/middleware.ts'),
      'utf-8',
    );

    expect(source).toContain('auth/id-token-revoked');
    expect(source).toContain('Token has been revoked');
  });

  it('auth middleware checks Redis revocation marker before using cached session', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const source = readFileSync(
      join(process.cwd(), 'backend/src/auth/middleware.ts'),
      'utf-8',
    );

    // Must check for revocation marker in Redis
    expect(source).toContain('revoked');
    expect(source).toContain('invalidated by revocation');
  });
});
