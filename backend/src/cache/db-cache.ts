/**
 * DB result caching — Redis-backed cache for read queries with tag invalidation.
 *
 * Use cachedDbQuery() in routers for read-heavy endpoints (task by id, user by id,
 * task feed, skills). Call invalidate* after mutations so cache stays consistent.
 *
 * @see cache/redis.js (CACHE_KEYS, CACHE_TTL)
 * @see cache/query-cache.js (cachedQuery, invalidateCacheByTag)
 */

import { cachedQuery, invalidateCache, invalidateCacheByTag } from './query-cache.js';
import { CACHE_KEYS, CACHE_TTL } from './redis.js';
import { CACHE_TAGS } from './query-cache.js';

export { cachedQuery, invalidateCache, invalidateCacheByTag, invalidateCacheByTags } from './query-cache.js';
export { CACHE_KEYS, CACHE_TTL } from './redis.js';
export { CACHE_TAGS } from './query-cache.js';

export interface DbCacheOptions {
  ttl?: number;
  tags?: string[];
  staleWhileRevalidate?: number;
}

/**
 * Run a read query with Redis cache. Use for GET-by-id and list endpoints.
 * Serializes result as JSON; ensure queryFn returns JSON-serializable data.
 */
export async function cachedDbQuery<T>(
  key: string,
  queryFn: () => Promise<T>,
  options: DbCacheOptions = {}
): Promise<T> {
  return cachedQuery(key, queryFn, {
    ttl: options.ttl ?? 300,
    tags: options.tags ?? [],
    staleWhileRevalidate: options.staleWhileRevalidate ?? 60,
  });
}

// ─── Invalidation helpers (call after mutations) ─────────────────────────────

export async function invalidateTask(taskId: string): Promise<void> {
  await invalidateCache(CACHE_KEYS.taskDetails(taskId));
  await invalidateCacheByTag(CACHE_TAGS.TASK(taskId));
}

export async function invalidateUser(userId: string): Promise<void> {
  await invalidateCache(CACHE_KEYS.userProfile(userId));
  await invalidateCache(CACHE_KEYS.userStats(userId));
  await invalidateCacheByTag(CACHE_TAGS.USER(userId));
}

export async function invalidateTaskFeed(userId: string): Promise<void> {
  await invalidateCache(CACHE_KEYS.taskFeed(userId));
  await invalidateCacheByTag(CACHE_TAGS.TASK_FEED);
}

export async function invalidateSkills(): Promise<void> {
  await invalidateCacheByTag(CACHE_TAGS.SKILLS);
}
