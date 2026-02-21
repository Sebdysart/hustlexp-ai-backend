// ============================================================================
// HustleXP Query Result Caching
// Redis-based caching with tag-based invalidation
// ============================================================================

import { Redis } from '@upstash/redis';
import { config } from '../config';
import { logger } from '../logger';

const cacheLog = logger.child({ module: 'query-cache' });

// Initialize Redis client
const redis = new Redis({
  url: config.redis.restUrl,
  token: config.redis.restToken,
});

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
// Cache Key Generation
// ============================================================================
function generateCacheKey(prefix: string, ...parts: (string | number)[]): string {
  return `cache:${prefix}:${parts.join(':')}`;
}

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
  
  try {
    // Try to get from cache
    const cached = await redis.get<string>(cacheKey);
    
    if (cached) {
      const data = JSON.parse(cached);
      
      // Check if stale-while-revalidate is enabled
      if (staleWhileRevalidate > 0) {
        const isStale = await redis.get(staleKey);
        
        if (isStale) {
          // Data is stale, trigger background refresh
          cacheLog.debug({ key }, 'Cache stale, refreshing in background');
          refreshCache(cacheKey, staleKey, queryFn, ttl, staleWhileRevalidate, tags);
        }
      }
      
      cacheLog.debug({ key, hit: true }, 'Cache hit');
      return data;
    }
    
    // Cache miss - execute query
    cacheLog.debug({ key, hit: false }, 'Cache miss');
    
    const result = await queryFn();
    
    // Store in cache
    await storeInCache(cacheKey, staleKey, result, ttl, staleWhileRevalidate, tags);
    
    return result;
  } catch (error) {
    cacheLog.error({ err: error, key }, 'Cache error, falling back to query');
    
    // Fallback to query on cache error
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
  try {
    const result = await queryFn();
    await storeInCache(cacheKey, staleKey, result, ttl, staleWhileRevalidate, tags);
    cacheLog.debug({ key: cacheKey }, 'Cache refreshed in background');
  } catch (error) {
    cacheLog.error({ err: error, key: cacheKey }, 'Background cache refresh failed');
  }
}

// ============================================================================
// Store in Cache
// ============================================================================
async function storeInCache<T>(
  cacheKey: string,
  staleKey: string,
  data: T,
  ttl: number,
  staleWhileRevalidate: number,
  tags: string[]
): Promise<void> {
  const pipeline = redis.pipeline();
  
  // Store the data
  pipeline.setex(cacheKey, ttl + staleWhileRevalidate, JSON.stringify(data));
  
  // Set stale marker (data becomes stale after TTL)
  if (staleWhileRevalidate > 0) {
    pipeline.setex(staleKey, ttl, '1');
  }
  
  // Add to tag sets for bulk invalidation
  for (const tag of tags) {
    pipeline.sadd(`cache:tag:${tag}`, cacheKey);
    pipeline.expire(`cache:tag:${tag}`, ttl + staleWhileRevalidate);
  }
  
  await pipeline.exec();
}

// ============================================================================
// Cache Invalidation
// ============================================================================

/**
 * Invalidate a specific cache key
 */
export async function invalidateCache(key: string): Promise<void> {
  const cacheKey = `cache:query:${key}`;
  const staleKey = `cache:stale:${key}`;
  
  await redis.del(cacheKey, staleKey);
  
  cacheLog.debug({ key }, 'Cache invalidated');
}

/**
 * Invalidate all cache entries with a specific tag
 */
export async function invalidateCacheByTag(tag: string): Promise<number> {
  const tagKey = `cache:tag:${tag}`;
  const keys = await redis.smembers(tagKey);
  
  if (keys.length === 0) {
    return 0;
  }
  
  const pipeline = redis.pipeline();
  
  // Delete all cached entries
  for (const key of keys) {
    pipeline.del(key);
    pipeline.del(key.replace('cache:query:', 'cache:stale:'));
  }
  
  // Delete the tag set
  pipeline.del(tagKey);
  
  await pipeline.exec();
  
  cacheLog.debug({ tag, count: keys.length }, 'Cache invalidated by tag');
  
  return keys.length;
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
  // Get all cache keys
  let cursor = '0';
  do {
    const scanResult = await redis.scan(Number(cursor), { match: 'cache:*', count: 100 }) as unknown as [string, string[]];
    cursor = String(scanResult[0]);
    const keys = scanResult[1];

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
  
  cacheLog.info('All cache cleared');
}

// ============================================================================
// Cache Statistics
// ============================================================================
export async function getCacheStats(): Promise<{
  queryKeys: number;
  tagKeys: number;
  staleKeys: number;
}> {
  const [queryKeys, tagKeys, staleKeys] = await Promise.all([
    redis.dbsize(), // Approximate, would need scan for exact count
    redis.dbsize(),
    redis.dbsize(),
  ]);
  
  return {
    queryKeys: 0, // Would need to implement proper counting
    tagKeys: 0,
    staleKeys: 0,
  };
}

// ============================================================================
// Decorator for Service Methods
// ============================================================================
export function Cached(options: CacheOptions = {}) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
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
