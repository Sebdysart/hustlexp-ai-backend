import { config } from '../config';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { logger } from '../logger';
const redisLog = logger.child({ module: 'redis' });

export type RedisClient = Redis | null;

// ─── Singleton Redis Client ────────────────────────────────────────────────
let redisClient: Redis | null = null;

function getClient(): Redis | null {
  if (redisClient) return redisClient;

  if (config.redis.restUrl && config.redis.restToken) {
    try {
      redisClient = new Redis({
        url: config.redis.restUrl,
        token: config.redis.restToken,
      });
      redisLog.info('Upstash Redis REST client initialized');
    } catch (error) {
      redisLog.error({ err: error }, 'Failed to initialize Upstash Redis client');
      redisClient = null;
    }
  } else {
    redisLog.warn('Redis REST not configured (UPSTASH_REDIS_REST_URL/TOKEN missing) — using stub fallbacks');
  }

  return redisClient;
}

// ─── Rate Limiter (lazy singleton) ─────────────────────────────────────────
const rateLimiters = new Map<string, Ratelimit>();

function getRateLimiter(windowMs: number, limit: number): Ratelimit | null {
  const client = getClient();
  if (!client) return null;

  const key = `${windowMs}:${limit}`;
  if (!rateLimiters.has(key)) {
    rateLimiters.set(key, new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
      analytics: false,
    }));
  }
  return rateLimiters.get(key)!;
}

// ─── Cache Key Patterns ────────────────────────────────────────────────────
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

// ─── Redis Operations ──────────────────────────────────────────────────────

export async function createRedisClient(): Promise<RedisClient> {
  return getClient();
}

export async function get<T = string>(key: string): Promise<T | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const value = await client.get<T>(key);
    return value;
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis GET error');
    return null;
  }
}

export async function set(
  key: string,
  value: string | number | object,
  ttl?: number
): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    if (ttl) {
      await client.set(key, value, { ex: ttl });
    } else {
      await client.set(key, value);
    }
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis SET error');
  }
}

export async function del(key: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    await client.del(key);
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis DEL error');
  }
}

export async function exists(key: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const result = await client.exists(key);
    return result === 1;
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis EXISTS error');
    return false;
  }
}

export async function incr(key: string): Promise<number> {
  const client = getClient();
  if (!client) return 1;

  try {
    return await client.incr(key);
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis INCR error');
    return 1;
  }
}

export async function expire(key: string, ttl: number): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    await client.expire(key, ttl);
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis EXPIRE error');
  }
}

export async function zadd(
  key: string,
  score: number,
  member: string
): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    await client.zadd(key, { score, member });
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis ZADD error');
  }
}

export async function zrange(
  key: string,
  start: number,
  stop: number
): Promise<string[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const result = await client.zrange<string[]>(key, start, stop);
    return result;
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis ZRANGE error');
    return [];
  }
}

export async function zrevrange(
  key: string,
  start: number,
  stop: number
): Promise<string[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const result = await client.zrange<string[]>(key, start, stop, { rev: true });
    return result;
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis ZREVRANGE error');
    return [];
  }
}

export async function checkRateLimit(
  userId: string,
  action: string,
  limit: number,
  window: number
): Promise<{ allowed: boolean; remaining: number; resetAt?: number }> {
  const limiter = getRateLimiter(window * 1000, limit);
  if (!limiter) {
    // Graceful fallback: allow everything if Redis not configured
    return { allowed: true, remaining: limit };
  }

  try {
    const identifier = CACHE_KEYS.rateLimit(userId, action);
    const result = await limiter.limit(identifier);
    return {
      allowed: result.success,
      remaining: result.remaining,
      resetAt: result.reset,
    };
  } catch (error) {
    redisLog.error({ err: error, userId, action }, 'Rate limit check error');
    return { allowed: true, remaining: limit };
  }
}

// ─── Exported Redis Object ─────────────────────────────────────────────────
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
