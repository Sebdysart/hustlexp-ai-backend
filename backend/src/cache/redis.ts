/**
 * Redis Cache & Rate Limiting via Upstash
 *
 * Uses @upstash/redis REST client for caching and rate limiting.
 * Falls back to no-op stubs when Redis is not configured (dev mode).
 *
 * @see config.ts for UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { config } from '../config';

// ============================================================================
// CLIENT INITIALIZATION
// ============================================================================

let redisClient: Redis | null = null;

export function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  if (config.redis.restUrl && config.redis.restToken) {
    try {
      redisClient = new Redis({
        url: config.redis.restUrl,
        token: config.redis.restToken,
      });
      console.log('✅ Redis client connected (Upstash REST)');
    } catch (err) {
      console.error('❌ Redis client initialization failed:', err);
      redisClient = null;
    }
  } else {
    console.warn('⚠️  Redis not configured — caching and rate limiting disabled');
  }

  return redisClient;
}

// Initialize on import
getRedisClient();

// ============================================================================
// CACHE KEYS & TTL
// ============================================================================

export const CACHE_KEYS = {
  taskFeed: (userId: string) => `task:feed:${userId}`,
  leaderboardWeekly: () => 'leaderboard:weekly',
  leaderboardAllTime: () => 'leaderboard:alltime',
  userProfile: (userId: string) => `user:profile:${userId}`,
  aiCache: (hash: string) => `ai:cache:${hash}`,
  taskDetails: (taskId: string) => `task:details:${taskId}`,
  userStats: (userId: string) => `user:stats:${userId}`,
  sessionToken: (token: string) => `session:${token}`,
  rateLimit: (userId: string, action: string) => `ratelimit:${userId}:${action}`,
} as const;

export const CACHE_TTL = {
  taskFeed: 5 * 60,
  leaderboard: 60 * 60,
  userProfile: 15 * 60,
  aiCache: 24 * 60 * 60,
  taskDetails: 10 * 60,
  userStats: 30 * 60,
  sessionToken: 7 * 24 * 60 * 60,
  rateLimit: 60,
} as const;

// ============================================================================
// CACHE OPERATIONS (with fallback for unconfigured Redis)
// ============================================================================

export async function get<T = string>(key: string): Promise<T | null> {
  const client = getRedisClient();
  if (!client) return null;
  try {
    return await client.get<T>(key);
  } catch (err) {
    console.error(`Redis GET error [${key}]:`, err);
    return null;
  }
}

export async function set(
  key: string,
  value: string,
  ttl?: number,
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    if (ttl) {
      await client.set(key, value, { ex: ttl });
    } else {
      await client.set(key, value);
    }
  } catch (err) {
    console.error(`Redis SET error [${key}]:`, err);
  }
}

export async function del(key: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.del(key);
  } catch (err) {
    console.error(`Redis DEL error [${key}]:`, err);
  }
}

export async function exists(key: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;
  try {
    const result = await client.exists(key);
    return result === 1;
  } catch (err) {
    console.error(`Redis EXISTS error [${key}]:`, err);
    return false;
  }
}

export async function incr(key: string): Promise<number> {
  const client = getRedisClient();
  if (!client) return 1;
  try {
    return await client.incr(key);
  } catch (err) {
    console.error(`Redis INCR error [${key}]:`, err);
    return 1;
  }
}

export async function expire(key: string, ttl: number): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.expire(key, ttl);
  } catch (err) {
    console.error(`Redis EXPIRE error [${key}]:`, err);
  }
}

export async function zadd(
  key: string,
  score: number,
  member: string,
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.zadd(key, { score, member });
  } catch (err) {
    console.error(`Redis ZADD error [${key}]:`, err);
  }
}

export async function zrange(
  key: string,
  start: number,
  stop: number,
): Promise<string[]> {
  const client = getRedisClient();
  if (!client) return [];
  try {
    return (await client.zrange(key, start, stop)) as string[];
  } catch (err) {
    console.error(`Redis ZRANGE error [${key}]:`, err);
    return [];
  }
}

export async function zrevrange(
  key: string,
  start: number,
  stop: number,
): Promise<string[]> {
  const client = getRedisClient();
  if (!client) return [];
  try {
    return (await client.zrange(key, start, stop, { rev: true })) as string[];
  } catch (err) {
    console.error(`Redis ZREVRANGE error [${key}]:`, err);
    return [];
  }
}

// ============================================================================
// RATE LIMITING (Upstash Ratelimit)
// ============================================================================

const rateLimiters = new Map<string, Ratelimit>();

function getRateLimiter(
  action: string,
  limit: number,
  windowSeconds: number,
): Ratelimit | null {
  const client = getRedisClient();
  if (!client) return null;

  const cacheKey = `${action}:${limit}:${windowSeconds}`;
  if (rateLimiters.has(cacheKey)) {
    return rateLimiters.get(cacheKey)!;
  }

  const limiter = new Ratelimit({
    redis: client,
    limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    prefix: `ratelimit:${action}`,
  });

  rateLimiters.set(cacheKey, limiter);
  return limiter;
}

/**
 * Check rate limit for a user + action combination.
 *
 * When Redis is unconfigured the call is DENIED in production (fail-closed)
 * and ALLOWED in development (fail-open) for convenience.
 */
export async function checkRateLimit(
  userId: string,
  action: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetAt?: number }> {
  const limiter = getRateLimiter(action, limit, windowSeconds);

  if (!limiter) {
    if (config.app.isProduction) {
      console.warn(`Rate limit DENIED (Redis unconfigured, production): ${userId}:${action}`);
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: limit };
  }

  try {
    const result = await limiter.limit(userId);
    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.reset,
    };
  } catch (err) {
    console.error(`Rate limit check error [${userId}:${action}]:`, err);
    if (config.app.isProduction) {
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: limit };
  }
}

// ============================================================================
// CONVENIENCE EXPORT
// ============================================================================

export const redis = {
  get,
  set,
  del,
  exists,
  incr,
  expire,
  zadd,
  zrange,
  zrevrange,
  checkRateLimit,
};
