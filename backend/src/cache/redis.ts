import { createHash } from 'crypto';
import { config } from '../config.js';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { logger } from '../logger.js';
const redisLog = logger.child({ module: 'redis' });

export type RedisClient = Redis | null;

// ─── Singleton Redis Client ────────────────────────────────────────────────
let redisClient: Redis | null = null;

/** Get shared Redis REST client; null if not configured (cache/rate-limit no-op). */
export function getClient(): Redis | null {
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
  sessionToken: (token: string) =>
    `session:${createHash('sha256').update(token).digest('hex')}`,
  rateLimit: (userId: string, action: string) => `ratelimit:${userId}:${action}`,
} as const;

export const CACHE_TTL = {
  taskFeed: 5 * 60,
  leaderboard: 60 * 60,
  userProfile: 15 * 60,
  aiCache: 24 * 60 * 60,
  taskDetails: 10 * 60,
  userStats: 30 * 60,
  sessionToken: 300, // 5 minutes — matches TOKEN_CACHE_TTL_SECONDS in auth/middleware.ts
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

/**
 * Atomically increment a counter and set its TTL on first creation.
 *
 * Uses a Lua script so that the INCR and the conditional EXPIRE are executed
 * as a single atomic operation on the Redis server.  This prevents the
 * "immortal key" race where a process crash between a bare INCR and a
 * subsequent EXPIRE leaves a key with no expiry, permanently rate-limiting
 * the affected user/IP.
 *
 * The EXPIRE is applied only when current === 1 (i.e. the key was just
 * created).  Setting it on every call would reset the window on each
 * request, allowing unlimited throughput at (windowSeconds - ε) intervals.
 *
 * @param key          Redis key to increment.
 * @param windowSeconds TTL to apply on first creation, in seconds.
 * @returns The post-increment counter value.
 * @throws  Re-throws any Redis error — callers are responsible for deciding
 *          whether to fail-open (dev) or fail-closed (production).
 */
export async function incrWithTtl(key: string, windowSeconds: number): Promise<number> {
  const client = getClient();
  if (!client) {
    if (config.app.isProduction) {
      throw new Error('Redis unavailable — rate limiting fail-closed');
    }
    return 1; // dev/test: allow
  }

  // Lua script: INCR the key, then EXPIRE only if this is the first increment
  // (current === 1).  Executed atomically — no race window between the two
  // Redis commands.
  const luaScript = `
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return current
  `;

  try {
    const result = await client.eval(luaScript, [key], [String(windowSeconds)]);
    return typeof result === 'number' ? result : Number(result);
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis incrWithTtl (Lua) error');
    throw error; // Let callers decide fail-open vs fail-closed
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
    // FAIL CLOSED in production — deny if rate limiting is unavailable
    if (config.app.isProduction) {
      redisLog.error('Rate limiting unavailable (Redis not configured) — denying request');
      return { allowed: false, remaining: 0, resetAt: Date.now() + window * 1000 };
    }
    // Allow in development with warning
    redisLog.warn('Rate limiting disabled — Redis not configured (dev mode)');
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
    // FAIL CLOSED in production on Redis errors too
    if (config.app.isProduction) {
      return { allowed: false, remaining: 0, resetAt: Date.now() + window * 1000 };
    }
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
  incrWithTtl,
  zadd,
  zrange,
  zrevrange,
  checkRateLimit,
};
