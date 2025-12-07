import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { logger } from '../utils/logger.js';

// Get Redis credentials from environment
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Check if Redis is configured
const isRedisConfigured = !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

if (!isRedisConfigured) {
    logger.warn('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set - rate limiting disabled');
}

// Create Redis client
export const redis = isRedisConfigured
    ? new Redis({
        url: UPSTASH_REDIS_REST_URL,
        token: UPSTASH_REDIS_REST_TOKEN,
    })
    : null;

/**
 * Rate limiter for AI endpoints
 * 10 requests per 10 seconds per user (sliding window)
 */
export const aiRateLimiter = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, '10 s'),
        analytics: true,
        prefix: 'ratelimit:ai',
    })
    : null;

/**
 * Rate limiter for general API endpoints
 * 100 requests per minute per IP
 */
export const apiRateLimiter = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(100, '60 s'),
        analytics: true,
        prefix: 'ratelimit:api',
    })
    : null;

/**
 * Check if rate limiting is available
 */
export function isRateLimitingEnabled(): boolean {
    return redis !== null;
}

/**
 * Check rate limit for a given identifier
 * @param limiter - Which rate limiter to use
 * @param identifier - User ID, IP address, or other unique identifier
 * @returns Object with success boolean and remaining requests
 */
export async function checkRateLimit(
    limiter: 'ai' | 'api',
    identifier: string
): Promise<{ success: boolean; remaining: number; reset: number }> {
    const rateLimiter = limiter === 'ai' ? aiRateLimiter : apiRateLimiter;

    if (!rateLimiter) {
        // Rate limiting not configured, allow all requests
        return { success: true, remaining: -1, reset: 0 };
    }

    try {
        const result = await rateLimiter.limit(identifier);

        if (!result.success) {
            logger.warn({ identifier, limiter, remaining: result.remaining }, 'Rate limit exceeded');
        }

        return {
            success: result.success,
            remaining: result.remaining,
            reset: result.reset,
        };
    } catch (error) {
        logger.error({ error, identifier, limiter }, 'Rate limit check failed');
        // On error, allow the request to proceed
        return { success: true, remaining: -1, reset: 0 };
    }
}

/**
 * Test Redis connection
 */
export async function testRedisConnection(): Promise<boolean> {
    if (!redis) return false;

    try {
        await redis.ping();
        logger.info('Redis connection successful');
        return true;
    } catch (error) {
        logger.error({ error }, 'Redis connection failed');
        return false;
    }
}
