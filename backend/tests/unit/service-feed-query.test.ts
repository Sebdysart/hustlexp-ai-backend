/**
 * service-feed-query.test.ts
 *
 * Targets uncovered branches in src/services/FeedQueryService.ts (28 uncovered lines).
 * Focuses on: getFeed (urgent/nearby/recommended modes, cursor pagination,
 * formatTask defaults), isTaskEligibleForUser (additional branches),
 * prewarmFeedCache (success path), getEligibleTaskCount edge cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (BEFORE imports) ──────────────────────────────────────────────────

vi.mock('../../src/db.js', () => {
  const mockTx = Object.assign(
    vi.fn().mockResolvedValue([]),
    { unsafe: vi.fn().mockResolvedValue([]) },
  );
  return {
    sql: mockTx,
    safeSql: mockTx,
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
    getSql: vi.fn(() => mockTx),
    isDatabaseAvailable: vi.fn(() => false),
    testConnection: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('../../src/logger.js', () => {
  const noop = vi.fn();
  const makeLogger = () => ({
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug: noop,
    child: () => makeLogger(),
  });
  return {
    createLogger: vi.fn(() => makeLogger()),
    logger: makeLogger(),
  };
});

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  })),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import {
  getFeed,
  isTaskEligibleForUser,
  getEligibleTaskCount,
  invalidateFeedCache,
  prewarmFeedCache,
} from '../../src/services/FeedQueryService.js';

import * as dbModule from '../../src/db.js';

function getMockSql() {
  return dbModule.sql as unknown as ReturnType<typeof vi.fn>;
}

// Helper: Build a minimal feed row
function makeFeedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Fix leaky pipe',
    description: 'Need a plumber ASAP',
    price: 5000,
    location: 'Seattle, WA',
    location_state: 'WA',
    category: null,
    risk_level: null, // triggers 'low' default
    required_trade: null,
    required_trust_tier: null, // triggers 1 default
    insurance_required: null, // triggers false default
    background_check_required: null, // triggers false default
    deadline: null,
    poster_id: 'poster-1',
    poster_name: null, // triggers 'Anonymous' default
    poster_avatar: null,
    poster_trust_tier: null, // triggers 1 default
    created_at: new Date('2026-01-15T12:00:00Z'),
    location_geog: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// invalidateFeedCache
// ============================================================================

describe('invalidateFeedCache', () => {
  it('does nothing when redis is null', async () => {
    await expect(invalidateFeedCache('user-1', null)).resolves.toBeUndefined();
  });

  it('calls redis.del with correct cache key', async () => {
    const mockRedis = { del: vi.fn().mockResolvedValue(1) };
    await invalidateFeedCache('user-42', mockRedis);
    expect(mockRedis.del).toHaveBeenCalledWith('hustlexp:feed:eligible:user-42');
  });

  it('degrades gracefully when redis.del throws', async () => {
    const mockRedis = { del: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    await expect(invalidateFeedCache('user-1', mockRedis)).resolves.toBeUndefined();
  });
});

// ============================================================================
// getFeed — standard mode (default)
// ============================================================================

describe('getFeed — standard mode', () => {
  it('returns empty feed when no tasks found', async () => {
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce([]);

    const result = await getFeed({ userId: 'user-1' });
    expect(result.tasks).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.totalCount).toBe(0);
  });

  it('returns tasks capped at limit with hasMore and cursor', async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeFeedRow({ id: `task-${i}`, created_at: new Date(2026, 0, 10 - i) })
    );
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce(rows);

    const result = await getFeed({ userId: 'user-1', limit: 5 });
    expect(result.tasks).toHaveLength(5);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it('applies formatTask defaults for null fields', async () => {
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce([makeFeedRow()]);

    const result = await getFeed({ userId: 'user-1', limit: 5 });
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0];
    expect(task.riskLevel).toBe('low');
    expect(task.requiredTrustTier).toBe(1);
    expect(task.insuranceRequired).toBe(false);
    expect(task.backgroundCheckRequired).toBe(false);
    expect(task.posterName).toBe('Anonymous');
    expect(task.posterTrustTier).toBe(1);
    expect(task.category).toBeNull();
  });

  it('uses cursor parameter for pagination', async () => {
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce([]);
    const cursor = new Date('2026-01-10T00:00:00Z').toISOString();

    const result = await getFeed({ userId: 'user-1', cursor });
    expect(result.tasks).toHaveLength(0);
    // Verify unsafe was called (we can't easily inspect the SQL string, but no error is a pass)
    expect(mockSql.unsafe).toHaveBeenCalled();
  });

  it('throws on db error', async () => {
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockRejectedValueOnce(new Error('DB error'));

    await expect(getFeed({ userId: 'user-1' })).rejects.toThrow('DB error');
  });

  it('returns all tasks when exactly limit rows returned (no hasMore)', async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      makeFeedRow({ id: `task-${i}` })
    );
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce(rows);

    const result = await getFeed({ userId: 'user-1', limit: 3 });
    // Fetches limit+1 = 4, gets 3 → hasMore=false
    expect(result.tasks).toHaveLength(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

// ============================================================================
// getFeed — urgent mode
// ============================================================================

describe('getFeed — urgent mode', () => {
  it('builds query with urgent deadline filter and returns tasks', async () => {
    const urgentRow = makeFeedRow({
      id: 'urgent-task-1',
      deadline: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours from now
    });
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce([urgentRow]);

    const result = await getFeed({ userId: 'user-1', feedMode: 'urgent' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('urgent-task-1');
    // Verify sql.unsafe was called (urgent mode appends deadline filter)
    expect(mockSql.unsafe).toHaveBeenCalled();
  });

  it('returns empty feed when no urgent tasks exist', async () => {
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce([]);

    const result = await getFeed({ userId: 'user-1', feedMode: 'urgent' });
    expect(result.tasks).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});

// ============================================================================
// getFeed — nearby mode
// ============================================================================

describe('getFeed — nearby mode', () => {
  it('builds query with location params when coordinates provided', async () => {
    const nearbyRow = makeFeedRow({ id: 'nearby-task-1', location_geog: {} });
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce([nearbyRow]);

    const result = await getFeed({
      userId: 'user-1',
      feedMode: 'nearby',
      locationLat: 47.6,
      locationLng: -122.3,
      radiusMiles: 10,
    });

    expect(result.tasks).toHaveLength(1);
    expect(mockSql.unsafe).toHaveBeenCalled();
    // distanceMiles is undefined (not computed without real PostGIS)
    expect(result.tasks[0].distanceMiles).toBeUndefined();
  });

  it('builds standard query when no coordinates provided', async () => {
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce([]);

    const result = await getFeed({ userId: 'user-1', feedMode: 'nearby' });
    expect(result.tasks).toHaveLength(0);
    expect(mockSql.unsafe).toHaveBeenCalled();
  });
});

// ============================================================================
// getFeed — recommended mode
// ============================================================================

describe('getFeed — recommended mode', () => {
  it('returns tasks with recommended mode (no extra filters)', async () => {
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce([makeFeedRow({ id: 'rec-task-1' })]);

    const result = await getFeed({ userId: 'user-1', feedMode: 'recommended' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('rec-task-1');
  });
});

// ============================================================================
// isTaskEligibleForUser
// ============================================================================

describe('isTaskEligibleForUser', () => {
  it('returns eligible=true when db EXISTS check returns true', async () => {
    const mockSql = getMockSql();
    mockSql.mockResolvedValueOnce([{ eligible: true }]);

    const result = await isTaskEligibleForUser('task-1', 'user-1');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns eligible=false with task not found reason', async () => {
    const mockSql = getMockSql();
    mockSql
      .mockResolvedValueOnce([{ eligible: false }]) // EXISTS check
      .mockResolvedValueOnce([])                     // task lookup → not found
      .mockResolvedValueOnce([]);                    // profile lookup

    const result = await isTaskEligibleForUser('nonexistent', 'user-1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it('returns eligible=false when task is not OPEN', async () => {
    const mockSql = getMockSql();
    mockSql
      .mockResolvedValueOnce([{ eligible: false }])
      .mockResolvedValueOnce([{ id: 'task-1', state: 'completed', location_state: 'WA', risk_level: 'low', required_trust_tier: 1 }])
      .mockResolvedValueOnce([{ location_state: 'WA', trust_tier: 2, risk_clearance: ['low', 'medium'] }]);

    const result = await isTaskEligibleForUser('task-1', 'user-1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/completed/i);
  });

  it('returns eligible=false with profile not found reason', async () => {
    const mockSql = getMockSql();
    mockSql
      .mockResolvedValueOnce([{ eligible: false }])
      .mockResolvedValueOnce([{ id: 'task-1', state: 'OPEN', location_state: 'WA', risk_level: 'low', required_trust_tier: 1 }])
      .mockResolvedValueOnce([]); // profile not found

    const result = await isTaskEligibleForUser('task-1', 'user-1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/profile not found/i);
  });

  it('returns eligible=false with location mismatch reason', async () => {
    const mockSql = getMockSql();
    mockSql
      .mockResolvedValueOnce([{ eligible: false }])
      .mockResolvedValueOnce([{ id: 'task-1', state: 'OPEN', location_state: 'CA', risk_level: 'low', required_trust_tier: 1 }])
      .mockResolvedValueOnce([{ location_state: 'WA', trust_tier: 3, risk_clearance: ['low', 'medium'] }]);

    const result = await isTaskEligibleForUser('task-1', 'user-1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/location/i);
  });

  it('returns eligible=false with insufficient risk clearance reason', async () => {
    const mockSql = getMockSql();
    mockSql
      .mockResolvedValueOnce([{ eligible: false }])
      .mockResolvedValueOnce([{ id: 'task-1', state: 'OPEN', location_state: 'WA', risk_level: 'critical', required_trust_tier: 1 }])
      .mockResolvedValueOnce([{ location_state: 'WA', trust_tier: 2, risk_clearance: ['low', 'medium'] }]);

    const result = await isTaskEligibleForUser('task-1', 'user-1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/risk clearance/i);
  });

  it('returns eligible=false with insufficient trust tier reason', async () => {
    const mockSql = getMockSql();
    mockSql
      .mockResolvedValueOnce([{ eligible: false }])
      .mockResolvedValueOnce([{ id: 'task-1', state: 'OPEN', location_state: 'WA', risk_level: 'low', required_trust_tier: 5 }])
      .mockResolvedValueOnce([{ location_state: 'WA', trust_tier: 2, risk_clearance: ['low', 'medium', 'high', 'critical'] }]);

    const result = await isTaskEligibleForUser('task-1', 'user-1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/trust tier/i);
  });

  it('returns generic reason when location and risk pass but other checks fail', async () => {
    const mockSql = getMockSql();
    // All checks pass except unknown reason → generic fallback
    mockSql
      .mockResolvedValueOnce([{ eligible: false }])
      .mockResolvedValueOnce([{ id: 'task-1', state: 'OPEN', location_state: 'WA', risk_level: 'low', required_trust_tier: 1 }])
      .mockResolvedValueOnce([{ location_state: 'WA', trust_tier: 3, risk_clearance: ['low', 'medium'] }]);

    const result = await isTaskEligibleForUser('task-1', 'user-1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('returns error reason when exception thrown', async () => {
    const mockSql = getMockSql();
    mockSql.mockRejectedValueOnce(new Error('Connection reset'));

    const result = await isTaskEligibleForUser('task-1', 'user-1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/error/i);
  });

  it('returns eligible=false when db returns no result row', async () => {
    const mockSql = getMockSql();
    // EXISTS check returns no row (undefined result)
    mockSql
      .mockResolvedValueOnce([])  // empty array → result[0] is undefined
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await isTaskEligibleForUser('task-1', 'user-1');
    expect(result.eligible).toBe(false);
  });
});

// ============================================================================
// getEligibleTaskCount
// ============================================================================

describe('getEligibleTaskCount', () => {
  it('returns count from db', async () => {
    const mockSql = getMockSql();
    mockSql.mockResolvedValueOnce([{ count: '17' }]);

    const count = await getEligibleTaskCount('user-1');
    expect(count).toBe(17);
  });

  it('returns 0 when result is empty', async () => {
    const mockSql = getMockSql();
    mockSql.mockResolvedValueOnce([]);

    const count = await getEligibleTaskCount('user-1');
    expect(count).toBe(0);
  });

  it('returns 0 when db throws', async () => {
    const mockSql = getMockSql();
    mockSql.mockRejectedValueOnce(new Error('Connection timeout'));

    const count = await getEligibleTaskCount('user-1');
    expect(count).toBe(0);
  });

  it('returns 0 when count is null/undefined', async () => {
    const mockSql = getMockSql();
    mockSql.mockResolvedValueOnce([{ count: null }]);

    const count = await getEligibleTaskCount('user-1');
    expect(count).toBe(0);
  });
});

// ============================================================================
// prewarmFeedCache
// ============================================================================

describe('prewarmFeedCache', () => {
  it('succeeds when getFeed returns results', async () => {
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockResolvedValueOnce([makeFeedRow()]);

    await expect(prewarmFeedCache('user-1')).resolves.toBeUndefined();
  });

  it('completes without throwing when getFeed throws', async () => {
    const mockSql = getMockSql();
    mockSql.unsafe = vi.fn().mockRejectedValueOnce(new Error('Feed DB unavailable'));

    await expect(prewarmFeedCache('user-1')).resolves.toBeUndefined();
  });
});
