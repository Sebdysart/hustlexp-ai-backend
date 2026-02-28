/**
 * rateLimiter Middleware Unit Tests (TDD — RED phase)
 *
 * Tests for:
 *   adminRateLimiter      — Upstash Ratelimit or null when not configured
 *   financialRateLimiter  — Upstash Ratelimit or null when not configured
 *
 * Design: when Upstash env vars are absent (CI/test env), exportsnull so
 * hooks.ts' `if (adminRateLimiter)` guard safely skips limiting.
 */
import { describe, it, expect } from 'vitest';

describe('rateLimiter module', () => {
  it('exports without throwing even when Upstash is not configured', async () => {
    await expect(import('../middleware/rateLimiter.js')).resolves.toBeDefined();
  });

  it('adminRateLimiter is either null or has a .limit() method', async () => {
    const { adminRateLimiter } = await import('../middleware/rateLimiter.js');

    if (adminRateLimiter === null) {
      expect(adminRateLimiter).toBeNull();
    } else {
      expect(typeof adminRateLimiter.limit).toBe('function');
    }
  });

  it('financialRateLimiter is either null or has a .limit() method', async () => {
    const { financialRateLimiter } = await import('../middleware/rateLimiter.js');

    if (financialRateLimiter === null) {
      expect(financialRateLimiter).toBeNull();
    } else {
      expect(typeof financialRateLimiter.limit).toBe('function');
    }
  });

  it('when Upstash is not configured, both limiters are null', async () => {
    // In test environment UPSTASH_REDIS_REST_URL is not set
    if (!process.env.UPSTASH_REDIS_REST_URL) {
      const { adminRateLimiter, financialRateLimiter } = await import('../middleware/rateLimiter.js');
      expect(adminRateLimiter).toBeNull();
      expect(financialRateLimiter).toBeNull();
    }
  });
});
