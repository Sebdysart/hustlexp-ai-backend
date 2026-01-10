/**
 * Rate Limiter (Upstash Redis)
 */
import { Redis } from '@upstash/redis';
import { serviceLogger } from '../../utils/logger.js';
let redis = null;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (UPSTASH_URL && UPSTASH_TOKEN) {
    redis = new Redis({
        url: UPSTASH_URL,
        token: UPSTASH_TOKEN,
    });
}
// Rate limit configuration
const LIMITS = {
    emailSend: { max: 3, windowMs: 60 * 60 * 1000 }, // 3 per hour
    smsSend: { max: 3, windowMs: 60 * 60 * 1000 }, // 3 per hour
    verify: { max: 5, windowMs: 60 * 60 * 1000 }, // 5 attempts per hour
    ipGlobal: { max: 20, windowMs: 60 * 60 * 1000 }, // 20 per hour per IP
};
/**
 * Check rate limit
 */
export async function checkRateLimit(key, type) {
    const limit = LIMITS[type];
    const redisKey = `ivs:ratelimit:${type}:${key}`;
    if (!redis) {
        // No Redis - allow but log warning
        return { allowed: true, remaining: limit.max };
    }
    try {
        const windowStart = Date.now() - limit.windowMs;
        // Clean old entries and count current
        await redis.zremrangebyscore(redisKey, 0, windowStart);
        const count = await redis.zcard(redisKey);
        if (count >= limit.max) {
            // Get oldest entry to calculate retry time
            const oldest = await redis.zrange(redisKey, 0, 0, { withScores: true });
            const retryAfterMs = oldest.length > 0
                ? Math.max(0, oldest[0].score + limit.windowMs - Date.now())
                : limit.windowMs;
            return {
                allowed: false,
                remaining: 0,
                retryAfterMs,
            };
        }
        // Add this request
        await redis.zadd(redisKey, { score: Date.now(), member: Date.now().toString() });
        await redis.expire(redisKey, Math.ceil(limit.windowMs / 1000));
        return {
            allowed: true,
            remaining: limit.max - count - 1,
        };
    }
    catch (error) {
        serviceLogger.error({ error, key, type }, 'Rate limit check failed');
        // Fail open
        return { allowed: true, remaining: limit.max };
    }
}
export function isRateLimitConfigured() {
    return !!redis;
}
//# sourceMappingURL=rateLimiter.js.map