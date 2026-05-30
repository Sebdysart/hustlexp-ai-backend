/**
 * query-cache.ts Unit Tests
 *
 * Tests cachedQuery (hit/miss/stale/error), invalidateCache,
 * invalidateCacheByTag, invalidateCacheByTags, CACHE_TAGS, and Cached decorator.
 *
 * AUDIT FIX (P6): Rewrote mock strategy. Previous version mocked @upstash/redis
 * directly and relied on globalThis.__mockRedisInstance. The real query-cache.ts
 * imports getClient from ./redis.js, so we mock that module instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Redis Client ─────────────────────────────────────────────────────
const mockPipelineExec = vi.fn().mockResolvedValue([]);
const mockPipeline = {
  setex: vi.fn().mockReturnThis(),
  del: vi.fn().mockReturnThis(),
  sadd: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  exec: mockPipelineExec,
};

const mockRedisClient = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  smembers: vi.fn(),
  sadd: vi.fn(),
  expire: vi.fn(),
  setex: vi.fn(),
  dbsize: vi.fn(),
  scan: vi.fn().mockResolvedValue({ cursor: 0, keys: [] }),
  pipeline: vi.fn().mockReturnValue(mockPipeline),
};

vi.mock('../../src/cache/redis.js', () => ({
  getClient: vi.fn(() => mockRedisClient),
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
    }),
  },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────
import {
  cachedQuery,
  invalidateCache,
  invalidateCacheByTag,
  invalidateCacheByTags,
  getCacheStats,
  CACHE_TAGS,
  Cached,
} from '../../src/cache/query-cache.js';

beforeEach(() => {
  mockRedisClient.get.mockReset();
  mockRedisClient.set.mockReset();
  mockRedisClient.del.mockReset();
  mockRedisClient.smembers.mockReset();
  mockRedisClient.sadd.mockReset();
  mockRedisClient.expire.mockReset();
  mockRedisClient.setex.mockReset();
  mockRedisClient.dbsize.mockReset();
  mockRedisClient.scan.mockReset().mockResolvedValue({ cursor: 0, keys: [] });
  mockPipelineExec.mockReset().mockResolvedValue([]);
  mockPipeline.setex.mockReset().mockReturnThis();
  mockPipeline.del.mockReset().mockReturnThis();
  mockPipeline.sadd.mockReset().mockReturnThis();
  mockPipeline.expire.mockReset().mockReturnThis();
  mockRedisClient.pipeline.mockReset().mockReturnValue(mockPipeline);
});

// ============================================================================
// cachedQuery
// ============================================================================

describe('cachedQuery', () => {
  it('returns cached value on cache hit', async () => {
    mockRedisClient.get.mockResolvedValueOnce(JSON.stringify({ id: 1, name: 'cached' }));

    const queryFn = vi.fn().mockResolvedValue({ id: 1, name: 'fresh' });
    const result = await cachedQuery('test-key', queryFn);

    expect(result).toEqual({ id: 1, name: 'cached' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('calls queryFn on cache miss and stores result', async () => {
    mockRedisClient.get.mockResolvedValueOnce(null);

    const queryFn = vi.fn().mockResolvedValue({ id: 2, fresh: true });
    const result = await cachedQuery('miss-key', queryFn);

    expect(result).toEqual({ id: 2, fresh: true });
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(mockPipelineExec).toHaveBeenCalled();
  });

  it('falls back to queryFn when Redis throws', async () => {
    mockRedisClient.get.mockRejectedValueOnce(new Error('Redis connection failed'));

    const queryFn = vi.fn().mockResolvedValue({ fallback: true });
    const result = await cachedQuery('error-key', queryFn);

    expect(result).toEqual({ fallback: true });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('uses custom TTL options', async () => {
    mockRedisClient.get.mockResolvedValueOnce(null);
    const queryFn = vi.fn().mockResolvedValue({ data: 'custom-ttl' });

    await cachedQuery('ttl-key', queryFn, { ttl: 60 });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(mockPipeline.setex).toHaveBeenCalledWith(
      'cache:query:ttl-key',
      expect.any(Number),
      expect.any(String)
    );
  });

  it('stores with tags when tags option provided', async () => {
    mockRedisClient.get.mockResolvedValueOnce(null);
    const queryFn = vi.fn().mockResolvedValue({ tagged: true });

    await cachedQuery('tagged-key', queryFn, { tags: ['user:1', 'task:feed'] });

    expect(mockPipeline.sadd).toHaveBeenCalledWith(
      'cache:tag:user:1',
      'cache:query:tagged-key'
    );
    expect(mockPipeline.sadd).toHaveBeenCalledWith(
      'cache:tag:task:feed',
      'cache:query:tagged-key'
    );
  });

  it('triggers background refresh when stale marker exists', async () => {
    mockRedisClient.get
      .mockResolvedValueOnce(JSON.stringify({ data: 'stale-data' }))
      .mockResolvedValueOnce('1');

    const queryFn = vi.fn().mockResolvedValue({ data: 'fresh' });

    const result = await cachedQuery('stale-key', queryFn, { staleWhileRevalidate: 30 });

    expect(result).toEqual({ data: 'stale-data' });
  });

  it('returns cached value without background refresh when not stale', async () => {
    mockRedisClient.get
      .mockResolvedValueOnce(JSON.stringify({ data: 'fresh-cached' }))
      .mockResolvedValueOnce(null);

    const queryFn = vi.fn().mockResolvedValue({ data: 'very-fresh' });

    const result = await cachedQuery('not-stale-key', queryFn, { staleWhileRevalidate: 30 });

    expect(result).toEqual({ data: 'fresh-cached' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('handles queryFn error after cache miss gracefully when Redis also fails on store', async () => {
    mockRedisClient.get.mockRejectedValueOnce(new Error('Redis down'));
    const queryFn = vi.fn().mockResolvedValue([1, 2, 3]);

    const result = await cachedQuery('fallback-key', queryFn);

    expect(result).toEqual([1, 2, 3]);
  });
});

// ============================================================================
// invalidateCache
// ============================================================================

describe('invalidateCache', () => {
  it('deletes cache key and stale key', async () => {
    mockRedisClient.del.mockResolvedValueOnce(1);

    await invalidateCache('some-key');

    expect(mockRedisClient.del).toHaveBeenCalledWith(
      'cache:query:some-key',
      'cache:stale:some-key'
    );
  });
});

// ============================================================================
// invalidateCacheByTag
// ============================================================================

describe('invalidateCacheByTag', () => {
  it('returns 0 when no keys are tagged', async () => {
    mockRedisClient.smembers.mockResolvedValueOnce([]);

    const count = await invalidateCacheByTag('empty-tag');

    expect(count).toBe(0);
    expect(mockRedisClient.pipeline).not.toHaveBeenCalled();
  });

  it('deletes all keys in tag set and the tag set itself', async () => {
    mockRedisClient.smembers.mockResolvedValueOnce(['cache:query:key1', 'cache:query:key2']);

    const count = await invalidateCacheByTag('user:1');

    expect(count).toBe(2);
    expect(mockPipeline.del).toHaveBeenCalledWith('cache:query:key1');
    expect(mockPipeline.del).toHaveBeenCalledWith('cache:stale:key1');
    expect(mockPipeline.del).toHaveBeenCalledWith('cache:query:key2');
    expect(mockPipeline.del).toHaveBeenCalledWith('cache:stale:key2');
    expect(mockPipeline.del).toHaveBeenCalledWith('cache:tag:user:1');
    expect(mockPipelineExec).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// invalidateCacheByTags
// ============================================================================

describe('invalidateCacheByTags', () => {
  it('returns total count across all tags', async () => {
    mockRedisClient.smembers
      .mockResolvedValueOnce(['cache:query:k1'])
      .mockResolvedValueOnce(['cache:query:k2', 'cache:query:k3']);

    const total = await invalidateCacheByTags(['user:1', 'task:feed']);

    expect(total).toBe(3);
  });

  it('returns 0 for empty tags array', async () => {
    const total = await invalidateCacheByTags([]);
    expect(total).toBe(0);
  });

  it('returns 0 when all tags are empty', async () => {
    mockRedisClient.smembers.mockResolvedValue([]);
    const total = await invalidateCacheByTags(['no-keys', 'also-empty']);
    expect(total).toBe(0);
  });
});

// ============================================================================
// getCacheStats
// ============================================================================

describe('getCacheStats', () => {
  it('returns stats object with numeric properties', async () => {
    mockRedisClient.dbsize.mockResolvedValue(42);

    const stats = await getCacheStats();

    expect(typeof stats.queryKeys).toBe('number');
    expect(typeof stats.tagKeys).toBe('number');
    expect(typeof stats.staleKeys).toBe('number');
  });
});

// ============================================================================
// CACHE_TAGS
// ============================================================================

describe('CACHE_TAGS', () => {
  it('USER tag includes userId', () => {
    expect(CACHE_TAGS.USER('user-123')).toBe('user:user-123');
  });

  it('TASK tag includes taskId', () => {
    expect(CACHE_TAGS.TASK('task-456')).toBe('task:task-456');
  });

  it('TASK_FEED is a string constant', () => {
    expect(CACHE_TAGS.TASK_FEED).toBe('task:feed');
  });

  it('LEADERBOARD is a string constant', () => {
    expect(CACHE_TAGS.LEADERBOARD).toBe('leaderboard');
  });

  it('SKILLS is a string constant', () => {
    expect(CACHE_TAGS.SKILLS).toBe('skills');
  });

  it('USER_STATS tag includes userId', () => {
    expect(CACHE_TAGS.USER_STATS('user-789')).toBe('user:stats:user-789');
  });

  it('NOTIFICATIONS tag includes userId', () => {
    expect(CACHE_TAGS.NOTIFICATIONS('user-789')).toBe('notifications:user-789');
  });
});

// ============================================================================
// Cached decorator
// ============================================================================

describe('Cached decorator', () => {
  it('wraps a method to use cachedQuery on cache miss', async () => {
    mockRedisClient.get.mockResolvedValueOnce(null);

    class TestService {
      async getItem(id: string) {
        return { id, value: 'from-db' };
      }
    }

    const proto = TestService.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(proto, 'getItem')!;
    const decoratedDescriptor = Cached({ ttl: 60 })(proto, 'getItem', originalDescriptor);
    Object.defineProperty(proto, 'getItem', decoratedDescriptor ?? originalDescriptor);

    const service = new TestService();
    const result = await service.getItem('item-1');

    expect(result).toEqual({ id: 'item-1', value: 'from-db' });
  });

  it('returns cached value when cache hit', async () => {
    mockRedisClient.get.mockResolvedValueOnce(JSON.stringify({ id: 'cached-item', value: 'from-cache' }));

    class CachedService {
      async getItem(id: string) {
        return { id, value: 'from-db-never-called' };
      }
    }

    const proto = CachedService.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(proto, 'getItem')!;
    const decoratedDescriptor = Cached({ ttl: 60 })(proto, 'getItem', originalDescriptor);
    Object.defineProperty(proto, 'getItem', decoratedDescriptor ?? originalDescriptor);

    const service = new CachedService();
    const result = await service.getItem('cached-item');

    expect(result).toEqual({ id: 'cached-item', value: 'from-cache' });
  });

  it('generates cache key from class name, method name and arguments', async () => {
    mockRedisClient.get.mockResolvedValueOnce(null);

    class KeyTestService {
      async getData(type: string, id: number) {
        return { type, id };
      }
    }

    const proto = KeyTestService.prototype;
    const originalDescriptor = Object.getOwnPropertyDescriptor(proto, 'getData')!;
    const decoratedDescriptor = Cached({ ttl: 30 })(proto, 'getData', originalDescriptor);
    Object.defineProperty(proto, 'getData', decoratedDescriptor ?? originalDescriptor);

    const service = new KeyTestService();
    await service.getData('user', 42);

    const setexCall = mockPipeline.setex.mock.calls[0];
    expect(setexCall?.[0]).toContain('KeyTestService');
    expect(setexCall?.[0]).toContain('getData');
  });
});
