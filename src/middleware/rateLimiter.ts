/**
 * Rate Limiter — Fastify src/ layer
 *
 * Uses Upstash Ratelimit (sliding window) backed by @upstash/redis.
 * When Upstash env vars are not set (local dev / CI), both limiters are
 * exported as null so hooks.ts can safely skip rate limiting with:
 *   `if (adminRateLimiter) { ... }`
 *
 * Exported limiters:
 *   adminRateLimiter     — 10 requests / 60 seconds  (/api/admin routes)
 *   financialRateLimiter — 5 requests / 60 seconds   (payout / release / approve routes)
 */

import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Type: matches the Upstash Ratelimit public interface used in hooks.ts
// ---------------------------------------------------------------------------

interface RatelimitInstance {
  limit(identifier: string): Promise<{ success: boolean }>;
}

// ---------------------------------------------------------------------------
// Factory — creates a Ratelimit instance or returns null on config error
// ---------------------------------------------------------------------------

function createRatelimiter(
  requestsPerMinute: number,
  label: string,
): RatelimitInstance | null {
  const restUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!restUrl || !restToken) {
    logger.warn(
      `rateLimiter: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — ${label} disabled`,
    );
    return null;
  }

  try {
    const redis = new Redis({ url: restUrl, token: restToken });
    return new Ratelimit({
      redis,
      limiter:   Ratelimit.slidingWindow(requestsPerMinute, '1 m'),
      analytics: false,  // disable analytics to avoid extra Redis round-trips in hot path
      prefix:    `hustlexp:ratelimit:${label}`,
    }) as RatelimitInstance;
  } catch (err) {
    logger.error({ err }, `rateLimiter: failed to initialise ${label} — rate limiting disabled`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exported limiters
// ---------------------------------------------------------------------------

/** Admin endpoint rate limiter: 10 requests per minute per user/IP. */
export const adminRateLimiter: RatelimitInstance | null = createRatelimiter(10, 'admin');

/** Financial operation rate limiter: 5 requests per minute per user/IP. */
export const financialRateLimiter: RatelimitInstance | null = createRatelimiter(5, 'financial');
