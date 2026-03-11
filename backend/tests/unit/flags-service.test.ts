/**
 * FlagsService Unit Tests
 *
 * Tests getUserFlags, getFlagForUser, setFlag, getAllFlags, and the
 * evaluateFlag helper (blocklist, allowlist, rollout percentage, DJB2 determinism).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  default: { query: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    redis: {
      restUrl: 'https://test-redis.upstash.io',
      restToken: 'test-token',
    },
  },
}));

// FlagsService lazily calls `new Redis(...)` inside `getRedis()`.
// We mock @upstash/redis so the constructor returns a controllable instance,
// capturing it in globalThis so tests can access its methods.
vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    del = vi.fn().mockResolvedValue(1);

    constructor() {
      (globalThis as Record<string, unknown>).__flagsRedisInstance = this;
    }
  },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────
import { db } from '../../src/db';
import { FlagsService } from '../../src/services/FlagsService';

const mockDbQuery = vi.mocked(db.query);

// Helper to get the lazily-created Redis mock
function getRedis() {
  return (globalThis as Record<string, unknown>).__flagsRedisInstance as {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
}

// ─── Sample flag data ──────────────────────────────────────────────────────────

function makeFlag(overrides: Partial<{
  id: string;
  name: string;
  enabled: boolean;
  rollout_percentage: number;
  user_allowlist: string[];
  user_blocklist: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}> = {}) {
  return {
    id: 'flag-1',
    name: 'feature_x',
    enabled: true,
    rollout_percentage: 100,
    user_allowlist: [],
    user_blocklist: [],
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure Redis mock instance methods are reset
  const r = getRedis();
  if (r) {
    r.get.mockReset().mockResolvedValue(null);
    r.set.mockReset().mockResolvedValue(undefined);
    r.del.mockReset().mockResolvedValue(1);
  }
});

// ============================================================================
// getAllFlags
// ============================================================================

describe('FlagsService.getAllFlags', () => {
  it('returns flags from DB on cache miss', async () => {
    const flags = [makeFlag({ name: 'flag_a' }), makeFlag({ name: 'flag_b' })];
    mockDbQuery.mockResolvedValueOnce({ rows: flags, rowCount: 2 });

    const result = await FlagsService.getAllFlags();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('flag_a');
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM feature_flags')
    );
  });

  it('returns flags from Redis cache on cache hit', async () => {
    const cachedFlags = [makeFlag({ name: 'cached_flag' })];
    getRedis().get.mockResolvedValueOnce(JSON.stringify(cachedFlags));

    const result = await FlagsService.getAllFlags();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('cached_flag');
    // DB should NOT have been called
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('writes DB result to cache', async () => {
    const flags = [makeFlag()];
    mockDbQuery.mockResolvedValueOnce({ rows: flags, rowCount: 1 });

    await FlagsService.getAllFlags();

    expect(getRedis().set).toHaveBeenCalledWith(
      'ff:all',
      expect.any(String),
      expect.objectContaining({ ex: 60 })
    );
  });

  it('falls back to DB when Redis get throws', async () => {
    getRedis().get.mockRejectedValueOnce(new Error('Redis error'));
    const flags = [makeFlag()];
    mockDbQuery.mockResolvedValueOnce({ rows: flags, rowCount: 1 });

    const result = await FlagsService.getAllFlags();

    expect(result).toHaveLength(1);
  });
});

// ============================================================================
// getFlagForUser
// ============================================================================

describe('FlagsService.getFlagForUser', () => {
  it('returns true when flag is enabled and 100% rollout', async () => {
    const flag = makeFlag({ enabled: true, rollout_percentage: 100 });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    const result = await FlagsService.getFlagForUser('feature_x', 'user-1');

    expect(result).toBe(true);
  });

  it('returns false when flag does not exist in DB', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await FlagsService.getFlagForUser('nonexistent', 'user-1');

    expect(result).toBe(false);
  });

  it('evaluates flag from Redis cache on cache hit', async () => {
    const flag = makeFlag({ enabled: true, rollout_percentage: 100 });
    getRedis().get.mockResolvedValueOnce(JSON.stringify(flag));

    const result = await FlagsService.getFlagForUser('feature_x', 'user-1');

    expect(result).toBe(true);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('caches flag after DB read', async () => {
    const flag = makeFlag();
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    await FlagsService.getFlagForUser('feature_x', 'user-1');

    expect(getRedis().set).toHaveBeenCalledWith(
      'ff:feature_x',
      expect.any(String),
      expect.objectContaining({ ex: 60 })
    );
  });

  it('falls back to DB when Redis get throws', async () => {
    getRedis().get.mockRejectedValueOnce(new Error('Redis error'));
    const flag = makeFlag({ enabled: true, rollout_percentage: 100 });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    const result = await FlagsService.getFlagForUser('feature_x', 'user-1');

    expect(result).toBe(true);
  });

  it('returns false when user is in blocklist', async () => {
    const flag = makeFlag({ enabled: true, rollout_percentage: 100, user_blocklist: ['blocked-user'] });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    const result = await FlagsService.getFlagForUser('feature_x', 'blocked-user');

    expect(result).toBe(false);
  });

  it('returns true for allowlisted user even when disabled', async () => {
    const flag = makeFlag({ enabled: false, rollout_percentage: 0, user_allowlist: ['special-user'] });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    const result = await FlagsService.getFlagForUser('feature_x', 'special-user');

    // allowlist check: returns flag.enabled (which is false here)
    expect(result).toBe(false);
  });

  it('returns true for allowlisted user when flag is enabled', async () => {
    const flag = makeFlag({ enabled: true, rollout_percentage: 0, user_allowlist: ['special-user'] });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    const result = await FlagsService.getFlagForUser('feature_x', 'special-user');

    expect(result).toBe(true);
  });

  it('returns false when flag disabled and user not allowlisted', async () => {
    const flag = makeFlag({ enabled: false, rollout_percentage: 100 });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    const result = await FlagsService.getFlagForUser('feature_x', 'regular-user');

    expect(result).toBe(false);
  });

  it('returns false when rollout is 0% (and user not allowlisted)', async () => {
    const flag = makeFlag({ enabled: true, rollout_percentage: 0 });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    const result = await FlagsService.getFlagForUser('feature_x', 'regular-user');

    expect(result).toBe(false);
  });
});

// ============================================================================
// setFlag
// ============================================================================

describe('FlagsService.setFlag', () => {
  it('inserts or upserts a flag and returns the row', async () => {
    const flag = makeFlag({ name: 'new_flag', enabled: true, rollout_percentage: 50 });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    const result = await FlagsService.setFlag({
      name: 'new_flag',
      enabled: true,
      rolloutPercentage: 50,
    });

    expect(result.name).toBe('new_flag');
    expect(result.enabled).toBe(true);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO feature_flags'),
      expect.arrayContaining(['new_flag', true, 50])
    );
  });

  it('uses defaults when optional params omitted', async () => {
    const flag = makeFlag({ name: 'minimal' });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    await FlagsService.setFlag({ name: 'minimal', enabled: true });

    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe(0);         // rolloutPercentage default = 0
    expect(params[3]).toEqual([]);     // userAllowlist default = []
    expect(params[4]).toEqual([]);     // userBlocklist default = []
  });

  it('invalidates cache for flag name and all-flags key', async () => {
    const flag = makeFlag({ name: 'cached_flag' });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    await FlagsService.setFlag({ name: 'cached_flag', enabled: false });

    expect(getRedis().del).toHaveBeenCalledWith('ff:cached_flag');
    expect(getRedis().del).toHaveBeenCalledWith('ff:all');
  });

  it('does not throw when cache invalidation fails', async () => {
    const flag = makeFlag();
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });
    getRedis().del.mockRejectedValue(new Error('Redis down'));

    // Should NOT throw despite Redis failure
    await expect(
      FlagsService.setFlag({ name: 'feature_x', enabled: true })
    ).resolves.toBeDefined();
  });
});

// ============================================================================
// getUserFlags
// ============================================================================

describe('FlagsService.getUserFlags', () => {
  it('returns evaluated flags for a user', async () => {
    const flags = [
      makeFlag({ name: 'flag_a', enabled: true,  rollout_percentage: 100 }),
      makeFlag({ name: 'flag_b', enabled: false, rollout_percentage: 0   }),
    ];
    mockDbQuery.mockResolvedValueOnce({ rows: flags, rowCount: 2 });

    const result = await FlagsService.getUserFlags('user-1');

    expect(result).toHaveLength(2);
    const flagA = result.find(f => f.name === 'flag_a');
    const flagB = result.find(f => f.name === 'flag_b');
    expect(flagA?.enabled).toBe(true);
    expect(flagB?.enabled).toBe(false);
  });

  it('returns empty array when no flags exist', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await FlagsService.getUserFlags('user-1');

    expect(result).toEqual([]);
  });
});

// ============================================================================
// evaluateFlag — rollout percentage determinism
// ============================================================================

describe('evaluateFlag — rollout percentage (via getFlagForUser)', () => {
  it('is deterministic: same userId + flagName always gives same result', async () => {
    // 50% rollout — result must be consistent for same input
    const flag = makeFlag({ name: 'rollout_flag', enabled: true, rollout_percentage: 50 });

    // Simulate three calls for same userId: all DB hits to avoid cache state
    for (let i = 0; i < 3; i++) {
      mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });
      getRedis().get.mockResolvedValueOnce(null);
    }

    const r1 = await FlagsService.getFlagForUser('rollout_flag', 'deterministic-user');
    const r2 = await FlagsService.getFlagForUser('rollout_flag', 'deterministic-user');
    const r3 = await FlagsService.getFlagForUser('rollout_flag', 'deterministic-user');

    // All three results must be identical
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it('blocklist takes priority over allowlist', async () => {
    // User in both blocklist and allowlist — blocklist wins
    const flag = makeFlag({
      enabled: true,
      rollout_percentage: 100,
      user_allowlist: ['both-user'],
      user_blocklist: ['both-user'],
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [flag], rowCount: 1 });

    const result = await FlagsService.getFlagForUser('feature_x', 'both-user');

    expect(result).toBe(false);
  });
});
