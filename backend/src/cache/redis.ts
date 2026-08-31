import { createHash, randomUUID } from 'crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getRedisCommandClient,
  takeSlidingWindow,
  type RedisCommandPort,
} from '../redis/RedisCommandPort.js';
const redisLog = logger.child({ module: 'redis' });

export type RedisClient = RedisCommandPort | null;
export type RedisReadMode = 'tolerant-cache' | 'authority';
const TYPED_CACHE_KEY_PREFIX = 'cache:typed:v1:';
const TYPED_CACHE_VALUE_PREFIX = 'hx:typed-cache:v1:';
const LEGACY_TCP_CACHE_VALUE_PREFIX = 'hx:cache-json:v1:';
const MAX_TYPED_CACHE_VALUE_BYTES = 1024 * 1024;
const MAX_TYPED_CACHE_DEPTH = 24;
const MAX_TYPED_CACHE_NODES = 10_000;
const MAX_LEGACY_TYPED_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VERSIONED_TYPED_CACHE_PREFIXES = [
  'task:feed:',
  'user:profile:',
  'ai:cache:',
  'task:details:',
  'user:stats:',
  'geocode:',
] as const;

/** Get the shared normalized Redis client for portable TCP or explicit legacy REST. */
export function getClient(): RedisCommandPort | null {
  return getRedisCommandClient();
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

function usesVersionedTypedCache(key: string): boolean {
  return VERSIONED_TYPED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function typedCacheStorageKey(key: string): string {
  return `${TYPED_CACHE_KEY_PREFIX}${key}`;
}

function assertSafeJsonValue(
  value: unknown,
  depth = 0,
  state: { nodes: number } = { nodes: 0 },
): void {
  state.nodes += 1;
  if (depth > MAX_TYPED_CACHE_DEPTH || state.nodes > MAX_TYPED_CACHE_NODES) {
    throw new Error('REDIS_TYPED_CACHE_VALUE_TOO_COMPLEX');
  }
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeJsonValue(entry, depth + 1, state);
    return;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('REDIS_TYPED_CACHE_VALUE_NOT_PLAIN_JSON');
    }
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) throw new Error('REDIS_TYPED_CACHE_VALUE_UNSAFE_KEY');
      assertSafeJsonValue(entry, depth + 1, state);
    }
    return;
  }
  throw new Error('REDIS_TYPED_CACHE_VALUE_NOT_JSON');
}

function boundedJsonParse(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > MAX_TYPED_CACHE_VALUE_BYTES) {
    throw new Error('REDIS_TYPED_CACHE_VALUE_TOO_LARGE');
  }
  const value = JSON.parse(raw) as unknown;
  assertSafeJsonValue(value);
  return value;
}

function encodeTypedCacheValue(value: unknown): string {
  assertSafeJsonValue(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('REDIS_TYPED_CACHE_VALUE_NOT_JSON');
  boundedJsonParse(serialized);
  return `${TYPED_CACHE_VALUE_PREFIX}${serialized}`;
}

function decodeTypedCacheValue(raw: string): unknown {
  if (!raw.startsWith(TYPED_CACHE_VALUE_PREFIX)) {
    throw new Error('REDIS_TYPED_CACHE_VALUE_VERSION_INVALID');
  }
  return boundedJsonParse(raw.slice(TYPED_CACHE_VALUE_PREFIX.length));
}

function decodeLegacyTypedCacheValue(key: string, raw: string): unknown {
  if (raw.startsWith(LEGACY_TCP_CACHE_VALUE_PREFIX)) {
    const decoded = boundedJsonParse(raw.slice(LEGACY_TCP_CACHE_VALUE_PREFIX.length));
    if (key.startsWith('ai:cache:') && typeof decoded !== 'string') {
      throw new Error('REDIS_LEGACY_AI_CACHE_TYPE_INVALID');
    }
    return decoded;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_TYPED_CACHE_VALUE_BYTES) {
    throw new Error('REDIS_TYPED_CACHE_VALUE_TOO_LARGE');
  }
  // AI responses are opaque text. A valid model response may itself be JSON,
  // so an unversioned legacy value such as `{"answer":42}` must not be
  // reinterpreted as a structured cache object during migration.
  if (key.startsWith('ai:cache:')) return raw;
  try {
    return boundedJsonParse(raw);
  } catch (error) {
    if (/^\s*[[{"]/.test(raw)) throw error;
    return raw;
  }
}

function boundedLegacyTtl(ttlSeconds: number): boolean {
  return Number.isSafeInteger(ttlSeconds)
    && ttlSeconds > 0
    && ttlSeconds <= MAX_LEGACY_TYPED_CACHE_TTL_SECONDS;
}

// ─── Redis Operations ──────────────────────────────────────────────────────

export async function createRedisClient(): Promise<RedisClient> {
  return getClient();
}

/**
 * Read a value from Redis.
 *
 * Ordinary cache reads are intentionally tolerant: an unavailable Redis
 * service or failed command is treated as a cache miss. Authentication and
 * other authority boundaries must opt into `authority`; those reads preserve
 * the distinction between a genuine null miss and an unavailable authority
 * store by propagating failures to the caller.
 */
export async function get<T = string>(
  key: string,
  mode: RedisReadMode = 'tolerant-cache',
): Promise<T | null> {
  const client = getClient();
  if (!client) {
    if (mode === 'authority') {
      throw new Error('Redis unavailable for authoritative read');
    }
    return null;
  }

  try {
    if (!usesVersionedTypedCache(key)) {
      return await client.get(key) as T | null;
    }

    const versionedKey = typedCacheStorageKey(key);
    const currentValue = await client.get(versionedKey);
    if (currentValue !== null) {
      return decodeTypedCacheValue(currentValue) as T;
    }

    // The legacy read is deliberately TTL-bounded. Persistent, expired, and
    // unexpectedly long-lived keys are treated as misses; they are never
    // deleted or promoted. This drains old cache values without flushing or
    // touching counters, revocation markers, locks, or rate-limit windows.
    const legacyTtl = await client.ttl(key);
    if (!boundedLegacyTtl(legacyTtl)) return null;
    const legacyValue = await client.get(key);
    if (legacyValue === null) return null;
    const decoded = decodeLegacyTypedCacheValue(key, legacyValue);
    try {
      await client.set(versionedKey, encodeTypedCacheValue(decoded), { ex: legacyTtl });
    } catch (error) {
      redisLog.warn({ err: error, key }, 'Legacy cache promotion failed');
    }
    return decoded as T;
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis GET error');
    if (mode === 'authority') throw error;
    return null;
  }
}

export async function set(
  key: string,
  value: unknown,
  ttl?: number
): Promise<void> {
  const typed = usesVersionedTypedCache(key);
  if (
    typed
    && (
      !Number.isSafeInteger(ttl)
      || (ttl ?? 0) <= 0
      || (ttl ?? 0) > MAX_LEGACY_TYPED_CACHE_TTL_SECONDS
    )
  ) {
    throw new Error('REDIS_TYPED_CACHE_TTL_INVALID');
  }
  if (!typed && typeof value !== 'string') {
    throw new Error('REDIS_RAW_VALUE_MUST_BE_STRING');
  }
  const storageKey = typed ? typedCacheStorageKey(key) : key;
  const transportValue = typed ? encodeTypedCacheValue(value) : value as string;

  const client = getClient();
  if (!client) {
    if (config.app.isProduction) {
      throw new Error('Redis unavailable — cache set fail-closed');
    }
    return;
  }

  try {
    if (ttl) {
      await client.set(storageKey, transportValue, { ex: ttl });
    } else {
      await client.set(storageKey, transportValue);
    }
  } catch (error) {
    redisLog.error({ err: error, key }, 'Redis SET error');
    if (config.app.isProduction) {
      throw error; // re-throw so callers can detect write failures (e.g. revocation marker)
    }
  }
}

export async function del(key: string): Promise<void> {
  const client = getClient();
  if (!client) {
    if (config.app.isProduction) {
      throw new Error('Redis unavailable — cache del fail-closed');
    }
    return;
  }

  try {
    if (usesVersionedTypedCache(key)) {
      await client.del(typedCacheStorageKey(key), key);
    } else {
      await client.del(key);
    }
  } catch (err) {
    redisLog.error({ err, key }, 'Redis del failed');
    throw err; // re-throw so callers can handle or log appropriately
  }
}

export async function exists(key: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    if (!usesVersionedTypedCache(key)) return await client.exists(key) === 1;
    if (await client.exists(typedCacheStorageKey(key)) === 1) return true;
    return boundedLegacyTtl(await client.ttl(key));
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
 * The EXPIRE is applied when the key is new or when a legacy broken counter
 * has no TTL. Setting it on every call would reset the window on each request,
 * allowing unlimited throughput at (windowSeconds - ε) intervals.
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

  // Lua script: INCR the key, then establish expiry for a new key or heal an
  // old counter stranded without a TTL by the former two-command flow.
  // Existing healthy windows keep their original deadline.
  const luaScript = `
    local current = redis.call('INCR', KEYS[1])
    if current == 1 or redis.call('TTL', KEYS[1]) < 0 then
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
    const result = await client.zrange(key, start, stop);
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
    const result = await client.zrange(key, start, stop, { rev: true });
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
  const client = getClient();
  if (!client) {
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
    const result = await takeSlidingWindow(client, {
      key: identifier,
      limit,
      windowMs: window * 1000,
      member: randomUUID(),
    });
    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt: result.resetAt,
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
