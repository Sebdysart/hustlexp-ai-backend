/**
 * Rate Limiting Middleware (DEPRECATED)
 *
 * This file is superseded by the Redis-backed rateLimitMiddleware in security.ts.
 * The server uses @upstash/ratelimit via security.ts → cache/redis.ts.
 *
 * Kept only as a local-dev fallback reference. No active imports.
 * Safe to delete.
 *
 * @deprecated Use rateLimitMiddleware from './security' instead.
 */

// Re-export the production Redis-backed rate limiter for any legacy callers
export { rateLimitMiddleware } from './security';
