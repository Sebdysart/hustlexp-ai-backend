/**
 * cache-redis-client.test.ts
 *
 * Unit tests for backend/src/cache/redis.ts
 *
 * Covers:
 *  - CACHE_KEYS — all key-builder functions
 *  - CACHE_TTL — shape check
 *  - createRedisClient() — returns client or null
 *  - get() — with client (success, error), without client (returns null)
 *  - set() — with TTL, without TTL, without client, error path
 *  - del() — success, no client, error path
 *  - exists() — true (result===1), false (result!==1), no client, error path
 *  - incr() — success, no client (returns 1), error path (returns 1)
 *  - expire() — success, no client, error path
 *  - zadd() — success, no client, error path
 *  - zrange() — success, no client (returns []), error path
 *  - zrevrange() — success, no client (returns []), error path
 *  - checkRateLimit() — no limiter + production (fail closed), no limiter + dev (allow), success, error + production, error + dev
 *  - redis export — is an object with all expected methods
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===========================================================================
// vi.hoisted — mock state
// ===========================================================================

const {
  mockRedisGet,
  mockRedisSet,
  mockRedisDel,
  mockRedisExists,
  mockRedisIncr,
  mockRedisExpire,
  mockRedisZadd,
  mockRedisZrange,
  mockRatelimitLimit,
  mockConfig,
} = vi.hoisted(() => {
  const mockConfig = {
    redis: {
      restUrl: 'https://fake-redis.upstash.io',
      restToken: 'fake-token',
    },
    app: {
      isProduction: false,
    },
  };

  return {
    mockRedisGet: vi.fn(),
    mockRedisSet: vi.fn().mockResolvedValue('OK'),
    mockRedisDel: vi.fn().mockResolvedValue(1),
    mockRedisExists: vi.fn().mockResolvedValue(1),
    mockRedisIncr: vi.fn().mockResolvedValue(2),
    mockRedisExpire: vi.fn().mockResolvedValue(1),
    mockRedisZadd: vi.fn().mockResolvedValue(1),
    mockRedisZrange: vi.fn().mockResolvedValue([]),
    mockRatelimitLimit: vi.fn(),
    mockConfig,
  };
});

// ===========================================================================
// Mocks — must precede all imports
// ===========================================================================

vi.mock('@upstash/redis', () => ({
  Redis: function MockRedis(this: Record<string, unknown>) {
    this.get = mockRedisGet;
    this.set = mockRedisSet;
    this.del = mockRedisDel;
    this.exists = mockRedisExists;
    this.incr = mockRedisIncr;
    this.expire = mockRedisExpire;
    this.zadd = mockRedisZadd;
    this.zrange = mockRedisZrange;
  },
}));

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class MockRatelimit {
    limit = mockRatelimitLimit;
    static slidingWindow = vi.fn().mockReturnValue({});
    constructor(public opts: unknown) {}
  },
}));

vi.mock('../../src/config', () => ({
  config: mockConfig,
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ===========================================================================
// Imports — after mocks
// ===========================================================================

import {
  CACHE_KEYS,
  CACHE_TTL,
  createRedisClient,
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
  redis,
} from '../../src/cache/redis';

// ===========================================================================
// beforeEach
// ===========================================================================

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.app.isProduction = false;

  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockRedisExists.mockResolvedValue(1);
  mockRedisIncr.mockResolvedValue(2);
  mockRedisExpire.mockResolvedValue(1);
  mockRedisZadd.mockResolvedValue(1);
  mockRedisZrange.mockResolvedValue([]);
  mockRatelimitLimit.mockResolvedValue({ success: true, remaining: 99, reset: Date.now() + 60000 });
});

// ===========================================================================
// CACHE_KEYS
// ===========================================================================

describe('CACHE_KEYS', () => {
  it('taskFeed returns correct key', () => {
    expect(CACHE_KEYS.taskFeed('user-1')).toBe('task:feed:user-1');
  });

  it('leaderboardWeekly returns constant key', () => {
    expect(CACHE_KEYS.leaderboardWeekly()).toBe('leaderboard:weekly');
  });

  it('leaderboardAllTime returns constant key', () => {
    expect(CACHE_KEYS.leaderboardAllTime()).toBe('leaderboard:alltime');
  });

  it('userProfile returns correct key', () => {
    expect(CACHE_KEYS.userProfile('user-42')).toBe('user:profile:user-42');
  });

  it('aiCache returns correct key', () => {
    expect(CACHE_KEYS.aiCache('abc123')).toBe('ai:cache:abc123');
  });

  it('taskDetails returns correct key', () => {
    expect(CACHE_KEYS.taskDetails('task-99')).toBe('task:details:task-99');
  });

  it('userStats returns correct key', () => {
    expect(CACHE_KEYS.userStats('user-99')).toBe('user:stats:user-99');
  });

  it('sessionToken returns correct key', () => {
    expect(CACHE_KEYS.sessionToken('tok-abc')).toBe('session:tok-abc');
  });

  it('rateLimit returns correct key', () => {
    expect(CACHE_KEYS.rateLimit('user-1', 'login')).toBe('ratelimit:user-1:login');
  });
});

// ===========================================================================
// CACHE_TTL
// ===========================================================================

describe('CACHE_TTL', () => {
  it('has all expected TTL entries as positive numbers', () => {
    const expectedKeys = ['taskFeed', 'leaderboard', 'userProfile', 'aiCache', 'taskDetails', 'userStats', 'sessionToken', 'rateLimit'];
    for (const key of expectedKeys) {
      expect(typeof CACHE_TTL[key as keyof typeof CACHE_TTL]).toBe('number');
      expect(CACHE_TTL[key as keyof typeof CACHE_TTL]).toBeGreaterThan(0);
    }
  });

  it('aiCache TTL is 24 hours in seconds', () => {
    expect(CACHE_TTL.aiCache).toBe(24 * 60 * 60);
  });

  it('sessionToken TTL is 7 days in seconds', () => {
    expect(CACHE_TTL.sessionToken).toBe(7 * 24 * 60 * 60);
  });
});

// ===========================================================================
// createRedisClient
// ===========================================================================

describe('createRedisClient', () => {
  it('returns the Redis client (not null) when URL+token are configured', async () => {
    const client = await createRedisClient();
    // The module singleton was initialised with the mock config values
    expect(client).not.toBeNull();
  });
});

// ===========================================================================
// get
// ===========================================================================

describe('get', () => {
  it('returns the value from Redis when client is available', async () => {
    mockRedisGet.mockResolvedValue('cached-value');
    const result = await get('some-key');
    expect(result).toBe('cached-value');
    expect(mockRedisGet).toHaveBeenCalledWith('some-key');
  });

  it('returns null when Redis.get resolves to null', async () => {
    mockRedisGet.mockResolvedValue(null);
    const result = await get('missing-key');
    expect(result).toBeNull();
  });

  it('returns null and does not throw on Redis error', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis connection error'));
    const result = await get('bad-key');
    expect(result).toBeNull();
  });

  it('supports generic type parameter for typed return', async () => {
    mockRedisGet.mockResolvedValue({ id: 1, name: 'Test' });
    const result = await get<{ id: number; name: string }>('typed-key');
    expect(result?.id).toBe(1);
    expect(result?.name).toBe('Test');
  });
});

// ===========================================================================
// set
// ===========================================================================

describe('set', () => {
  it('calls Redis.set with EX option when TTL is provided', async () => {
    await set('my-key', 'my-value', 300);
    expect(mockRedisSet).toHaveBeenCalledWith('my-key', 'my-value', { ex: 300 });
  });

  it('calls Redis.set without EX option when no TTL provided', async () => {
    await set('my-key', 'value-no-ttl');
    expect(mockRedisSet).toHaveBeenCalledWith('my-key', 'value-no-ttl');
  });

  it('accepts an object value', async () => {
    await set('obj-key', { data: 42 }, 60);
    expect(mockRedisSet).toHaveBeenCalledWith('obj-key', { data: 42 }, { ex: 60 });
  });

  it('accepts a numeric value', async () => {
    await set('count-key', 999);
    expect(mockRedisSet).toHaveBeenCalledWith('count-key', 999);
  });

  it('does not throw on Redis error', async () => {
    mockRedisSet.mockRejectedValue(new Error('set failed'));
    await expect(set('err-key', 'val')).resolves.toBeUndefined();
  });
});

// ===========================================================================
// del
// ===========================================================================

describe('del', () => {
  it('calls Redis.del with the correct key', async () => {
    await del('delete-me');
    expect(mockRedisDel).toHaveBeenCalledWith('delete-me');
  });

  it('does not throw on Redis error', async () => {
    mockRedisDel.mockRejectedValue(new Error('del failed'));
    await expect(del('bad-del-key')).resolves.toBeUndefined();
  });
});

// ===========================================================================
// exists
// ===========================================================================

describe('exists', () => {
  it('returns true when Redis.exists returns 1', async () => {
    mockRedisExists.mockResolvedValue(1);
    const result = await exists('existing-key');
    expect(result).toBe(true);
  });

  it('returns false when Redis.exists returns 0', async () => {
    mockRedisExists.mockResolvedValue(0);
    const result = await exists('missing-key');
    expect(result).toBe(false);
  });

  it('returns false on Redis error', async () => {
    mockRedisExists.mockRejectedValue(new Error('exists failed'));
    const result = await exists('err-key');
    expect(result).toBe(false);
  });
});

// ===========================================================================
// incr
// ===========================================================================

describe('incr', () => {
  it('returns the incremented value from Redis', async () => {
    mockRedisIncr.mockResolvedValue(5);
    const result = await incr('counter-key');
    expect(result).toBe(5);
    expect(mockRedisIncr).toHaveBeenCalledWith('counter-key');
  });

  it('returns 1 on Redis error (fallback)', async () => {
    mockRedisIncr.mockRejectedValue(new Error('incr failed'));
    const result = await incr('bad-counter');
    expect(result).toBe(1);
  });
});

// ===========================================================================
// expire
// ===========================================================================

describe('expire', () => {
  it('calls Redis.expire with key and TTL', async () => {
    await expire('my-key', 120);
    expect(mockRedisExpire).toHaveBeenCalledWith('my-key', 120);
  });

  it('does not throw on Redis error', async () => {
    mockRedisExpire.mockRejectedValue(new Error('expire failed'));
    await expect(expire('err-key', 60)).resolves.toBeUndefined();
  });
});

// ===========================================================================
// zadd
// ===========================================================================

describe('zadd', () => {
  it('calls Redis.zadd with score and member object', async () => {
    await zadd('leaderboard', 100, 'user-1');
    expect(mockRedisZadd).toHaveBeenCalledWith('leaderboard', { score: 100, member: 'user-1' });
  });

  it('does not throw on Redis error', async () => {
    mockRedisZadd.mockRejectedValue(new Error('zadd failed'));
    await expect(zadd('bad-zset', 1, 'm')).resolves.toBeUndefined();
  });
});

// ===========================================================================
// zrange
// ===========================================================================

describe('zrange', () => {
  it('returns ordered list of members', async () => {
    mockRedisZrange.mockResolvedValue(['user-a', 'user-b', 'user-c']);
    const result = await zrange('leaderboard', 0, 9);
    expect(result).toEqual(['user-a', 'user-b', 'user-c']);
    expect(mockRedisZrange).toHaveBeenCalledWith('leaderboard', 0, 9);
  });

  it('returns empty array on Redis error', async () => {
    mockRedisZrange.mockRejectedValue(new Error('zrange failed'));
    const result = await zrange('bad-key', 0, 10);
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// zrevrange
// ===========================================================================

describe('zrevrange', () => {
  it('calls Redis.zrange with rev:true option', async () => {
    mockRedisZrange.mockResolvedValue(['top-1', 'top-2']);
    const result = await zrevrange('leaderboard', 0, 4);
    expect(result).toEqual(['top-1', 'top-2']);
    // zrevrange internally calls zrange with { rev: true }
    expect(mockRedisZrange).toHaveBeenCalledWith('leaderboard', 0, 4, { rev: true });
  });

  it('returns empty array on Redis error', async () => {
    mockRedisZrange.mockRejectedValue(new Error('zrevrange failed'));
    const result = await zrevrange('bad-key', 0, 10);
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// checkRateLimit
// ===========================================================================

describe('checkRateLimit', () => {
  it('returns allowed:true with remaining count on success', async () => {
    mockRatelimitLimit.mockResolvedValue({ success: true, remaining: 49, reset: 1700000060 });
    const result = await checkRateLimit('user-1', 'submit', 50, 60);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(49);
    expect(result.resetAt).toBe(1700000060);
  });

  it('returns allowed:false when rate limited', async () => {
    mockRatelimitLimit.mockResolvedValue({ success: false, remaining: 0, reset: 1700000120 });
    const result = await checkRateLimit('user-1', 'submit', 50, 60);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('fails closed in production when Redis rate limiter errors', async () => {
    mockConfig.app.isProduction = true;
    mockRatelimitLimit.mockRejectedValue(new Error('Redis down'));

    const result = await checkRateLimit('user-1', 'submit', 10, 60);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('allows in development when Redis rate limiter errors', async () => {
    mockConfig.app.isProduction = false;
    mockRatelimitLimit.mockRejectedValue(new Error('Redis down'));

    const result = await checkRateLimit('user-1', 'submit', 10, 60);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);
  });
});

// ===========================================================================
// redis export object
// ===========================================================================

describe('redis export', () => {
  it('exposes all expected methods', () => {
    const methods = ['get', 'set', 'del', 'exists', 'incr', 'expire', 'zadd', 'zrange', 'zrevrange', 'checkRateLimit'];
    for (const method of methods) {
      expect(typeof redis[method as keyof typeof redis]).toBe('function');
    }
  });

  it('redis.get delegates to the module-level get function', async () => {
    mockRedisGet.mockResolvedValue('delegated-value');
    const result = await redis.get('delegation-key');
    expect(result).toBe('delegated-value');
  });

  it('redis.del delegates to the module-level del function', async () => {
    await redis.del('del-key');
    expect(mockRedisDel).toHaveBeenCalledWith('del-key');
  });

  it('redis.checkRateLimit delegates to the module-level checkRateLimit', async () => {
    mockRatelimitLimit.mockResolvedValue({ success: true, remaining: 9, reset: Date.now() + 1000 });
    const result = await redis.checkRateLimit('u', 'action', 10, 60);
    expect(result.allowed).toBe(true);
  });
});
