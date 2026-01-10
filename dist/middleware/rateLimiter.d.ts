import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
export declare const redis: Redis | null;
/**
 * Rate limiter for AI endpoints
 * 10 requests per 10 seconds per user (sliding window)
 */
export declare const aiRateLimiter: Ratelimit | null;
/**
 * Rate limiter for general API endpoints
 * 100 requests per minute per IP
 */
export declare const apiRateLimiter: Ratelimit | null;
/**
 * PHASE 6.1: Rate limiter for admin endpoints
 * 10 requests per minute per admin (stricter)
 */
export declare const adminRateLimiter: Ratelimit | null;
/**
 * PHASE 6.1: Rate limiter for financial endpoints
 * 5 requests per minute per user (very strict for payouts)
 */
export declare const financialRateLimiter: Ratelimit | null;
/**
 * Check if rate limiting is available
 */
export declare function isRateLimitingEnabled(): boolean;
/**
 * Check rate limit for a given identifier
 * @param limiter - Which rate limiter to use
 * @param identifier - User ID, IP address, or other unique identifier
 * @returns Object with success boolean and remaining requests
 */
export declare function checkRateLimit(limiter: 'ai' | 'api', identifier: string): Promise<{
    success: boolean;
    remaining: number;
    reset: number;
}>;
/**
 * Test Redis connection
 */
export declare function testRedisConnection(): Promise<boolean>;
//# sourceMappingURL=rateLimiter.d.ts.map