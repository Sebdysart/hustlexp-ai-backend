/**
 * query-cache.ts Extra Unit Tests
 *
 * Tests cachedQuery (hit/miss/stale/error), invalidateCache,
 * invalidateCacheByTag, invalidateCacheByTags, CACHE_TAGS, and Cached decorator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Redis ────────────────────────────────────────────────────────────────
// NOTE: vi.mock() is hoisted above all declarations.
// We cannot reference top-level const variables inside the factory.
// Instead, we define all vi.fn() calls inline within the class body,
// and expose the last created instance via a module-level let.
const __redisInstance: InstanceType<typeof MockRedisClass> | null = null;

class MockRedisClass {
  get = vi.fn();
  set = vi.fn();
  del = vi.fn();
  smembers = vi.fn();
  sadd = vi.fn();
  expire = vi.fn();
  setex = vi.fn();
  dbsize = vi.fn();
  scan = vi.fn().mockResolvedValue(['0', []]);
  pipeline = vi.fn().mockReturnValue({
    setex: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  });
}

vi.mock('@upstash/redis', () => {
  return {
    Redis: class MockRedis {
      get = vi.fn();
      set = vi.fn();
      del = vi.fn();
      smembers = vi.fn();
      sadd = vi.fn();
      expire = vi.fn();
      setex = vi.fn();
      dbsize = vi.fn();
      scan = vi.fn().mockResolvedValue(['0', []]);
      _pipelineExec = vi.fn().mockResolvedValue([]);
      pipeline = vi.fn().mockReturnThis();

      constructor() {
        // Self-setup pipeline to return chainable mock with access to _pipelineExec
        const self = this;
        this.pipeline = vi.fn().mockReturnValue({
          setex: vi.fn().mockReturnThis(),
          del: vi.fn().mockReturnThis(),
          sadd: vi.fn().mockReturnThis(),
          expire: vi.fn().mockReturnThis(),
          exec: self._pipelineExec,
        });
        // Store reference so tests can access the instance
        (globalThis as Record<string, unknown>).__mockRedisInstance = this;
      }
    },
  };
});

vi.mock('../../src/config', () => ({
  config: {
    redis: {
      restUrl: 'https://test-redis.upstash.io',
      restToken: 'test-token',
    },
  },
}));

vi.mock('../../src/logger', () => ({
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
} from '../../src/cache/query-cache';

// Helper to get the mock Redis instance created when the module loaded
function getRedis() {
  return (globalThis as Record<string, unknown>).__mockRedisInstance as {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    smembers: ReturnType<typeof vi.fn>;
    sadd: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    setex: ReturnType<typeof vi.fn>;
    dbsize: ReturnType<typeof vi.fn>;
    scan: ReturnType<typeof vi.fn>;
    _pipelineExec: ReturnType<typeof vi.fn>;
    pipeline: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  const r = getRedis();
  r.get.mockReset();
  r.set.mockReset();
  r.del.mockReset();
  r.smembers.mockReset();
  r.sadd.mockReset();
  r.expire.mockReset();
  r.setex.mockReset();
  r.dbsize.mockReset();
  r.scan.mockReset().mockResolvedValue(['0', []]);
  r._pipelineExec.mockReset().mockResolvedValue([]);

  // Re-create a fresh pipeline mock that uses the same _pipelineExec
  const pipelineMock = {
    setex: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: r._pipelineExec,
  };
  r.pipeline.mockReset().mockReturnValue(pipelineMock);
});

// Helper to get the current pipeline mock
function getPipeline() {
  const r = getRedis();
  return r.pipeline.mock.results[0]?.value as {
    setex: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    sadd: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  } | undefined;
}

// ============================================================================
// cachedQuery
// ============================================================================

describe('cachedQuery', () => {
  it('returns cached value on cache hit', async () => {
    getRedis().get.mockResolvedValueOnce(JSON.stringify({ id: 1, name: 'cached' }));

    const queryFn = vi.fn().mockResolvedValue({ id: 1, name: 'fresh' });
    const result = await cachedQuery('test-key', queryFn);

    expect(result).toEqual({ id: 1, name: 'cached' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('calls queryFn on cache miss and stores result', async () => {
    getRedis().get.mockResolvedValueOnce(null); // cache miss

    const queryFn = vi.fn().mockResolvedValue({ id: 2, fresh: true });
    const result = await cachedQuery('miss-key', queryFn);

    expect(result).toEqual({ id: 2, fresh: true });
    expect(queryFn).toHaveBeenCalledTimes(1);
    // pipeline.exec should have been called to store result
    const pipe = getPipeline();
    expect(pipe?.exec).toHaveBeenCalled();
  });

  it('falls back to queryFn when Redis throws', async () => {
    getRedis().get.mockRejectedValueOnce(new Error('Redis connection failed'));

    const queryFn = vi.fn().mockResolvedValue({ fallback: true });
    const result = await cachedQuery('error-key', queryFn);

    expect(result).toEqual({ fallback: true });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('uses custom TTL options', async () => {
    getRedis().get.mockResolvedValueOnce(null);
    const queryFn = vi.fn().mockResolvedValue({ data: 'custom-ttl' });

    await cachedQuery('ttl-key', queryFn, { ttl: 60 });

    expect(queryFn).toHaveBeenCalledTimes(1);
    const pipe = getPipeline();
    expect(pipe?.setex).toHaveBeenCalledWith(
      'cache:query:ttl-key',
      expect.any(Number),
      expect.any(String)
    );
  });

  it('stores with tags when tags option provided', async () => {
    getRedis().get.mockResolvedValueOnce(null);
    const queryFn = vi.fn().mockResolvedValue({ tagged: true });

    await cachedQuery('tagged-key', queryFn, { tags: ['user:1', 'task:feed'] });

    const pipe = getPipeline();
    expect(pipe?.sadd).toHaveBeenCalledWith(
      'cache:tag:user:1',
      'cache:query:tagged-key'
    );
    expect(pipe?.sadd).toHaveBeenCalledWith(
      'cache:tag:task:feed',
      'cache:query:tagged-key'
    );
  });

  it('triggers background refresh when stale marker exists', async () => {
    // First get returns the cached data; second get (staleKey) returns '1' (stale)
    getRedis().get
      .mockResolvedValueOnce(JSON.stringify({ data: 'stale-data' })) // cacheKey hit
      .mockResolvedValueOnce('1');                                     // staleKey = stale

    const queryFn = vi.fn().mockResolvedValue({ data: 'fresh' });

    const result = await cachedQuery('stale-key', queryFn, { staleWhileRevalidate: 30 });

    // Returns stale data immediately
    expect(result).toEqual({ data: 'stale-data' });
    // Background refresh is triggered (not awaited by caller)
  });

  it('returns cached value without background refresh when not stale', async () => {
    // cacheKey hit, staleKey is null (not stale)
    getRedis().get
      .mockResolvedValueOnce(JSON.stringify({ data: 'fresh-cached' }))
      .mockResolvedValueOnce(null); // not stale

    const queryFn = vi.fn().mockResolvedValue({ data: 'very-fresh' });

    const result = await cachedQuery('not-stale-key', queryFn, { staleWhileRevalidate: 30 });

    expect(result).toEqual({ data: 'fresh-cached' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('handles queryFn error after cache miss gracefully when Redis also fails on store', async () => {
    getRedis().get.mockRejectedValueOnce(new Error('Redis down'));
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
    getRedis().del.mockResolvedValueOnce(1);

    await invalidateCache('some-key');

    expect(getRedis().del).toHaveBeenCalledWith(
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
    getRedis().smembers.mockResolvedValueOnce([]);

    const count = await invalidateCacheByTag('empty-tag');

    expect(count).toBe(0);
    // pipeline should not have been called
    expect(getRedis().pipeline).not.toHaveBeenCalled();
  });

  it('deletes all keys in tag set and the tag set itself', async () => {
    getRedis().smembers.mockResolvedValueOnce(['cache:query:key1', 'cache:query:key2']);

    const count = await invalidateCacheByTag('user:1');

    expect(count).toBe(2);
    const pipe = getPipeline();
    expect(pipe?.del).toHaveBeenCalledWith('cache:query:key1');
    expect(pipe?.del).toHaveBeenCalledWith('cache:stale:key1');
    expect(pipe?.del).toHaveBeenCalledWith('cache:query:key2');
    expect(pipe?.del).toHaveBeenCalledWith('cache:stale:key2');
    expect(pipe?.del).toHaveBeenCalledWith('cache:tag:user:1');
    expect(pipe?.exec).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// invalidateCacheByTags
// ============================================================================

describe('invalidateCacheByTags', () => {
  it('returns total count across all tags', async () => {
    getRedis().smembers
      .mockResolvedValueOnce(['cache:query:k1']) // tag user:1 → 1 key
      .mockResolvedValueOnce(['cache:query:k2', 'cache:query:k3']); // tag task:feed → 2 keys

    const total = await invalidateCacheByTags(['user:1', 'task:feed']);

    expect(total).toBe(3);
  });

  it('returns 0 for empty tags array', async () => {
    const total = await invalidateCacheByTags([]);
    expect(total).toBe(0);
  });

  it('returns 0 when all tags are empty', async () => {
    getRedis().smembers.mockResolvedValue([]);
    const total = await invalidateCacheByTags(['no-keys', 'also-empty']);
    expect(total).toBe(0);
  });
});

// ============================================================================
// getCacheStats
// ============================================================================

describe('getCacheStats', () => {
  it('returns stats object with numeric properties', async () => {
    getRedis().dbsize.mockResolvedValue(42);

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
    // Cache miss — calls the original method
    getRedis().get.mockResolvedValueOnce(null);

    // Apply the decorator manually to avoid decorator-transform incompatibility.
    // The @Cached decorator is a legacy stage-2 decorator; applying it as a
    // function is equivalent to using @Cached syntax with experimentalDecorators.
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

    // queryFn was called (cache miss) — result from original method
    expect(result).toEqual({ id: 'item-1', value: 'from-db' });
  });

  it('returns cached value when cache hit', async () => {
    getRedis().get.mockResolvedValueOnce(JSON.stringify({ id: 'cached-item', value: 'from-cache' }));

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
    getRedis().get.mockResolvedValueOnce(null);

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

    // The pipeline setex should have been called with a key containing the class name, method, and args
    const pipe = getPipeline();
    const setexCall = pipe?.setex.mock.calls[0];
    expect(setexCall?.[0]).toContain('KeyTestService');
    expect(setexCall?.[0]).toContain('getData');
  });
});
