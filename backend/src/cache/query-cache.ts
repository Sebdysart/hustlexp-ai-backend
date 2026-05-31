// ============================================================================
// HustleXP Query Result Caching
// Redis-based caching with tag-based invalidation (uses shared client from redis.js)
// ============================================================================

import { getClient } from './redis.js';
import { logger } from '../logger.js';

const cacheLog = logger.child({ module: 'query-cache' });

// ============================================================================
// Cache Configuration
// ============================================================================
interface CacheOptions {
  ttl?: number;           // Time to live in seconds
  tags?: string[];        // Tags for bulk invalidation
  staleWhileRevalidate?: number; // Serve stale data while refreshing
}

const DEFAULT_TTL = 300; // 5 minutes
const DEFAULT_STALE_WHILE_REVALIDATE = 60; // 1 minute

// ============================================================================
// Cached Query Function
// ============================================================================
export async function cachedQuery<T>(
  key: string,
  queryFn: () => Promise<T>,
  options: CacheOptions = {}
): Promise<T> {
  const { 
    ttl = DEFAULT_TTL, 
    tags = [],
    staleWhileRevalidate = DEFAULT_STALE_WHILE_REVALIDATE 
  } = options;
  
  const cacheKey = `cache:query:${key}`;
  const staleKey = `cache:stale:${key}`;
  const client = getClient();

  try {
    if (client) {
      const cached = await client.get<string>(cacheKey);

      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;

        if (staleWhileRevalidate > 0) {
          const isStale = await client.get(staleKey);
          if (isStale) {
            cacheLog.debug({ key }, 'Cache stale, refreshing in background');
            refreshCache(cacheKey, staleKey, queryFn, ttl, staleWhileRevalidate, tags);
          }
        }

        cacheLog.debug({ key, hit: true }, 'Cache hit');
        return data as T;
      }
    }

    cacheLog.debug({ key, hit: false }, 'Cache miss');
    const result = await queryFn();

    if (client) {
      await storeInCache(client, cacheKey, staleKey, result, ttl, staleWhileRevalidate, tags);
    }

    return result;
  } catch (error) {
    cacheLog.error({ err: error, key }, 'Cache error, falling back to query');
    return queryFn();
  }
}

// ============================================================================
// Background Cache Refresh
// ============================================================================
async function refreshCache<T>(
  cacheKey: string,
  staleKey: string,
  queryFn: () => Promise<T>,
  ttl: number,
  staleWhileRevalidate: number,
  tags: string[]
): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const result = await queryFn();
    await storeInCache(client, cacheKey, staleKey, result, ttl, staleWhileRevalidate, tags);
    cacheLog.debug({ key: cacheKey }, 'Cache refreshed in background');
  } catch (error) {
    cacheLog.error({ err: error, key: cacheKey }, 'Background cache refresh failed');
  }
}

// ============================================================================
// Store in Cache
// ============================================================================
async function storeInCache<T>(
  client: import('@upstash/redis').Redis,
  cacheKey: string,
  staleKey: string,
  data: T,
  ttl: number,
  staleWhileRevalidate: number,
  tags: string[]
): Promise<void> {
  const pipeline = client.pipeline();
  const fullTtl = ttl + staleWhileRevalidate;
  const payload = JSON.stringify(data);

  pipeline.setex(cacheKey, fullTtl, payload);
  if (staleWhileRevalidate > 0) {
    pipeline.setex(staleKey, ttl, '1');
  }
  for (const tag of tags) {
    pipeline.sadd(`cache:tag:${tag}`, cacheKey);
    pipeline.expire(`cache:tag:${tag}`, fullTtl);
  }
  try {
    await pipeline.exec();
  } catch (err) {
    cacheLog.warn({ err, key: cacheKey }, 'Cache store pipeline.exec failed — fail-open');
  }
}

// ============================================================================
// Cache Invalidation
// ============================================================================

/**
 * Invalidate a specific cache key.
 * Fail-open: a failing Upstash/Redis call must never break the caller's flow.
 */
export async function invalidateCache(key: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  const cacheKey = `cache:query:${key}`;
  const staleKey = `cache:stale:${key}`;
  try {
    await client.del(cacheKey, staleKey);
    cacheLog.debug({ key }, 'Cache invalidated');
  } catch (err) {
    cacheLog.warn({ err, key }, 'Cache invalidate failed — fail-open');
  }
}

/**
 * Invalidate all cache entries with a specific tag.
 * Fail-open: any Upstash/Redis error (rate limit, transport, malformed pipeline
 * response such as `res.map is not a function`) is swallowed and logged. Money
 * flows (task.create, escrow funding) must never break because the cache is
 * unhealthy.
 */
export async function invalidateCacheByTag(tag: string): Promise<number> {
  const client = getClient();
  if (!client) return 0;
  const tagKey = `cache:tag:${tag}`;

  let keys: string[];
  try {
    const raw = await client.smembers(tagKey);
    keys = Array.isArray(raw) ? (raw as string[]) : [];
  } catch (err) {
    cacheLog.warn({ err, tag }, 'Cache smembers failed — fail-open');
    return 0;
  }

  if (keys.length === 0) return 0;

  try {
    const pipeline = client.pipeline();
    for (const key of keys) {
      pipeline.del(key);
      pipeline.del(key.replace('cache:query:', 'cache:stale:'));
    }
    pipeline.del(tagKey);
    await pipeline.exec();
    cacheLog.debug({ tag, count: keys.length }, 'Cache invalidated by tag');
    return keys.length;
  } catch (err) {
    cacheLog.warn({ err, tag }, 'Cache pipeline.exec failed — fail-open');
    return 0;
  }
}

/**
 * Invalidate multiple tags at once
 */
export async function invalidateCacheByTags(tags: string[]): Promise<number> {
  let total = 0;
  
  for (const tag of tags) {
    total += await invalidateCacheByTag(tag);
  }
  
  return total;
}

/**
 * Clear all cache (use with caution!)
 */
export async function clearAllCache(): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    let cursor: number | string = 0;
    do {
      const result = await client.scan(cursor, { match: 'cache:*', count: 100 }) as unknown as { cursor: number; keys: string[] };
      cursor = result.cursor;
      const keys = result.keys ?? [];
      if (keys.length > 0) await client.del(...keys);
    } while (cursor !== 0);
    cacheLog.info('All cache cleared');
  } catch (err) {
    cacheLog.warn({ err }, 'clearAllCache failed — fail-open');
  }
}

// ============================================================================
// Cache Statistics
// ============================================================================
export async function getCacheStats(): Promise<{
  queryKeys: number;
  tagKeys: number;
  staleKeys: number;
}> {
  const client = getClient();
  if (!client) return { queryKeys: 0, tagKeys: 0, staleKeys: 0 };
  // Approximate; exact count would require SCAN
  const dbsize = await client.dbsize();
  return { queryKeys: dbsize, tagKeys: 0, staleKeys: 0 };
}

// ============================================================================
// Decorator for Service Methods
// ============================================================================
export function Cached(options: CacheOptions = {}) {
  return function (
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      // Generate cache key from method name and arguments
      const key = `${target.constructor.name}:${propertyKey}:${JSON.stringify(args)}`;
      
      return cachedQuery(key, () => originalMethod.apply(this, args), options);
    };
    
    return descriptor;
  };
}

// ============================================================================
// Predefined Cache Tags
// ============================================================================
export const CACHE_TAGS = {
  USER: (userId: string) => `user:${userId}`,
  TASK: (taskId: string) => `task:${taskId}`,
  TASK_FEED: 'task:feed',
  LEADERBOARD: 'leaderboard',
  SKILLS: 'skills',
  USER_STATS: (userId: string) => `user:stats:${userId}`,
  NOTIFICATIONS: (userId: string) => `notifications:${userId}`,
} as const;
