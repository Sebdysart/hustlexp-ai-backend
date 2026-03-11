/**
 * UserAIBudget Unit Tests (backend/src/ai/UserAIBudget.ts)
 *
 * Tests per-user and global AI spending limits with mocked Redis.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const mockGet    = vi.fn();
const mockIncrby = vi.fn();
const mockExpire = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    get    = mockGet;
    incrby = mockIncrby;
    expire = mockExpire;
    constructor(_opts: unknown) {}
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    redis: {
      restUrl:   'https://redis.upstash.io',
      restToken: 'test-token',
    },
  },
}));

// ---------------------------------------------------------------------------
// System-under-test
// ---------------------------------------------------------------------------

import {
  checkUserBudget,
  trackUserCost,
  checkGlobalBudget,
  trackGlobalCost,
} from '../../src/ai/UserAIBudget';

// ---------------------------------------------------------------------------
// beforeEach — reset mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// checkUserBudget
// ---------------------------------------------------------------------------

describe('checkUserBudget', () => {
  it('returns allowed=true when nothing spent yet (null from Redis)', async () => {
    mockGet.mockResolvedValue(null);

    const result = await checkUserBudget('user-1');

    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(0);
    expect(result.limit).toBe(500); // USER_DAILY_CEILING_CENTS = 500 ($5.00)
  });

  it('returns allowed=true when spent is below the ceiling', async () => {
    mockGet.mockResolvedValue('499');

    const result = await checkUserBudget('user-1');

    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(499);
  });

  it('returns allowed=false when spent equals or exceeds the ceiling', async () => {
    mockGet.mockResolvedValue('500');

    const result = await checkUserBudget('user-1');

    expect(result.allowed).toBe(false);
    expect(result.spent).toBe(500);
  });

  it('returns allowed=false when heavily over budget', async () => {
    mockGet.mockResolvedValue('9999');

    const result = await checkUserBudget('user-1');

    expect(result.allowed).toBe(false);
  });

  it('fails-open (allowed=true) when Redis throws', async () => {
    mockGet.mockRejectedValue(new Error('Redis down'));

    const result = await checkUserBudget('user-1');

    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(0);
  });

  it('uses a date-scoped Redis key (contains today in YYYY-MM-DD)', async () => {
    mockGet.mockResolvedValue(null);

    await checkUserBudget('user-abc');

    const calledKey = mockGet.mock.calls[0][0] as string;
    const today = new Date().toISOString().split('T')[0];
    expect(calledKey).toContain('user-abc');
    expect(calledKey).toContain(today);
    expect(calledKey).toMatch(/^ai:user_spend:/);
  });
});

// ---------------------------------------------------------------------------
// trackUserCost
// ---------------------------------------------------------------------------

describe('trackUserCost', () => {
  it('increments the Redis key by costCents and sets TTL', async () => {
    mockIncrby.mockResolvedValue(50);
    mockExpire.mockResolvedValue(1);

    await trackUserCost('user-1', 50);

    expect(mockIncrby).toHaveBeenCalledTimes(1);
    const [key, amount] = mockIncrby.mock.calls[0];
    expect(key).toContain('user-1');
    expect(amount).toBe(50);

    expect(mockExpire).toHaveBeenCalledTimes(1);
    const [expKey, ttl] = mockExpire.mock.calls[0];
    expect(expKey).toContain('user-1');
    expect(ttl).toBe(86400);
  });

  it('is non-fatal when Redis throws (does not throw)', async () => {
    mockIncrby.mockRejectedValue(new Error('Redis connection refused'));

    // Should not throw
    await expect(trackUserCost('user-1', 10)).resolves.toBeUndefined();
  });

  it('correctly accumulates cost increments', async () => {
    mockIncrby
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(60)
      .mockResolvedValueOnce(90);
    mockExpire.mockResolvedValue(1);

    await trackUserCost('user-1', 30);
    await trackUserCost('user-1', 30);
    await trackUserCost('user-1', 30);

    expect(mockIncrby).toHaveBeenCalledTimes(3);
    const amounts = mockIncrby.mock.calls.map(c => c[1]);
    expect(amounts).toEqual([30, 30, 30]);
  });
});

// ---------------------------------------------------------------------------
// checkGlobalBudget
// ---------------------------------------------------------------------------

describe('checkGlobalBudget', () => {
  it('returns allowed=true when nothing spent globally', async () => {
    mockGet.mockResolvedValue(null);

    const result = await checkGlobalBudget();

    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(0);
    expect(result.limit).toBe(50000); // GLOBAL_DAILY_CEILING_CENTS = 50000 ($500)
  });

  it('returns allowed=true when global spend is below ceiling', async () => {
    mockGet.mockResolvedValue('49999');

    const result = await checkGlobalBudget();

    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(49999);
  });

  it('returns allowed=false when global spend meets or exceeds ceiling', async () => {
    mockGet.mockResolvedValue('50000');

    const result = await checkGlobalBudget();

    expect(result.allowed).toBe(false);
    expect(result.spent).toBe(50000);
  });

  it('uses a date-scoped global key', async () => {
    mockGet.mockResolvedValue(null);

    await checkGlobalBudget();

    const calledKey = mockGet.mock.calls[0][0] as string;
    const today = new Date().toISOString().split('T')[0];
    expect(calledKey).toMatch(/^ai:global_spend:/);
    expect(calledKey).toContain(today);
  });

  it('fails-open (allowed=true) when Redis throws', async () => {
    mockGet.mockRejectedValue(new Error('Redis down'));

    const result = await checkGlobalBudget();

    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// trackGlobalCost
// ---------------------------------------------------------------------------

describe('trackGlobalCost', () => {
  it('increments the global spend key and sets TTL', async () => {
    mockIncrby.mockResolvedValue(200);
    mockExpire.mockResolvedValue(1);

    await trackGlobalCost(200);

    expect(mockIncrby).toHaveBeenCalledTimes(1);
    const [key, amount] = mockIncrby.mock.calls[0];
    expect(key).toMatch(/^ai:global_spend:/);
    expect(amount).toBe(200);

    expect(mockExpire).toHaveBeenCalledTimes(1);
    expect(mockExpire.mock.calls[0][1]).toBe(86400);
  });

  it('is non-fatal when Redis throws', async () => {
    mockIncrby.mockRejectedValue(new Error('Redis down'));

    await expect(trackGlobalCost(100)).resolves.toBeUndefined();
  });

  it('tracks zero-cost calls without error', async () => {
    mockIncrby.mockResolvedValue(0);
    mockExpire.mockResolvedValue(1);

    await expect(trackGlobalCost(0)).resolves.toBeUndefined();
    expect(mockIncrby).toHaveBeenCalledWith(expect.any(String), 0);
  });
});
