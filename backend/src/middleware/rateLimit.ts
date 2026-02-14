/**
 * Rate Limiting Middleware v1.0.0
 *
 * Simple sliding-window rate limiter using in-memory Map.
 * For beta scale (100 users), in-memory is sufficient.
 * Production: swap to Redis-based (Upstash @upstash/ratelimit).
 *
 * Limits:
 * - General API: 100 requests per minute per IP
 * - Auth endpoints: 10 requests per minute per IP
 * - Registration: 5 requests per minute per IP
 */

import type { Context, Next } from 'hono';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) {
      store.delete(key);
    }
  }
}, 5 * 60 * 1000);

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  keyPrefix?: string;
}) {
  return async (c: Context, next: Next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || 'unknown';

    const key = `${opts.keyPrefix || 'api'}:${ip}`;
    const now = Date.now();

    let entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      store.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(opts.max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, opts.max - entry.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > opts.max) {
      return c.json(
        { error: 'Too many requests. Please try again later.' },
        429
      );
    }

    await next();
  };
}

// Pre-configured limiters
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  keyPrefix: 'api',
});

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyPrefix: 'auth',
});

export const registrationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyPrefix: 'register',
});
