/**
 * Re-export from canonical src/cache/redis.ts
 * This file exists for backward compatibility with older import paths.
 */
export {
  redis,
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
  getRedisClient,
  CACHE_KEYS,
  CACHE_TTL,
} from '../src/cache/redis';
