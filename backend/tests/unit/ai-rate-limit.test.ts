/**
 * AI Rate Limiting Unit Tests (backend/src/ai/rateLimit.ts)
 *
 * Tests checkRateLimit and requireRateLimit with mocked Upstash Ratelimit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

// The Ratelimit instance that will be returned for any agent
const mockLimit = vi.fn();

vi.mock('@upstash/ratelimit', () => {
  class MockRatelimit {
    limit = mockLimit;
    constructor(_opts: unknown) {}
    static slidingWindow = vi.fn().mockReturnValue({ type: 'sliding', requests: 10, window: '1 m' });
  }
  return { Ratelimit: MockRatelimit };
});

// Redis (used by Ratelimit internally) — just needs to be constructable
vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
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

import { checkRateLimit, requireRateLimit } from '../../src/ai/rateLimit';

// ---------------------------------------------------------------------------
// beforeEach — reset mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// checkRateLimit — allowed
// ---------------------------------------------------------------------------

describe('checkRateLimit — allowed', () => {
  beforeEach(() => {
    mockLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60000 });
  });

  it('returns allowed=true for a new user under the limit', async () => {
    const result = await checkRateLimit('judge', 'user-1');

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(10);
    expect(result.remaining).toBe(9);
  });

  it('calls the ratelimit with the correct key (agent:userId)', async () => {
    await checkRateLimit('judge', 'user-abc');

    expect(mockLimit).toHaveBeenCalledWith('judge:user-abc');
  });

  it('works for different known agents', async () => {
    for (const agent of ['judge', 'matchmaker', 'dispute', 'reputation', 'onboarding', 'moderation']) {
      vi.clearAllMocks();
      mockLimit.mockResolvedValue({ success: true, limit: 20, remaining: 19, reset: Date.now() + 60000 });

      const result = await checkRateLimit(agent, 'user-1');
      expect(result.allowed).toBe(true);
    }
  });

  it('uses default config for an unknown agent', async () => {
    mockLimit.mockResolvedValue({ success: true, limit: 20, remaining: 20, reset: Date.now() + 60000 });

    const result = await checkRateLimit('unknown_agent', 'user-1');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit — denied
// ---------------------------------------------------------------------------

describe('checkRateLimit — denied', () => {
  beforeEach(() => {
    mockLimit.mockResolvedValue({
      success:   false,
      limit:     10,
      remaining: 0,
      reset:     Date.now() + 30000,
    });
  });

  it('returns allowed=false when the ratelimit returns success=false', async () => {
    const result = await checkRateLimit('dispute', 'user-1');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit — Redis/Ratelimit failure (fail-open)
// ---------------------------------------------------------------------------

describe('checkRateLimit — failure fallback', () => {
  it('returns allowed=true when the ratelimit throws (fail-open)', async () => {
    mockLimit.mockRejectedValue(new Error('Redis unavailable'));

    const result = await checkRateLimit('judge', 'user-1');

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.reset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// requireRateLimit — passes through when allowed
// ---------------------------------------------------------------------------

describe('requireRateLimit — allowed', () => {
  it('resolves without throwing when under the limit', async () => {
    mockLimit.mockResolvedValue({ success: true, limit: 10, remaining: 5, reset: Date.now() + 60000 });

    await expect(requireRateLimit('judge', 'user-1')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// requireRateLimit — throws when rate-limited
// ---------------------------------------------------------------------------

describe('requireRateLimit — denied', () => {
  it('throws TOO_MANY_REQUESTS TRPCError when rate limit exceeded', async () => {
    const resetAt = Date.now() + 45000;
    mockLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: resetAt });

    await expect(requireRateLimit('judge', 'user-1')).rejects.toMatchObject({
      code:    'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX703'),
    });
  });

  it('includes the agent name in the error message', async () => {
    mockLimit.mockResolvedValue({ success: false, limit: 5, remaining: 0, reset: Date.now() + 10000 });

    await expect(requireRateLimit('dispute', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining('dispute'),
    });
  });

  it('includes a retry-in seconds value in the error message', async () => {
    const resetAt = Date.now() + 30000; // 30 seconds from now
    mockLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: resetAt });

    let caughtMessage = '';
    try {
      await requireRateLimit('moderation', 'user-1');
    } catch (err: any) {
      caughtMessage = err.message || '';
    }

    // Should contain a positive number of seconds
    expect(caughtMessage).toMatch(/\d+s/);
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit — distinct keys per user
// ---------------------------------------------------------------------------

describe('checkRateLimit — key isolation', () => {
  it('uses different Redis keys for different users', async () => {
    mockLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60000 });

    await checkRateLimit('judge', 'user-1');
    await checkRateLimit('judge', 'user-2');

    const calls = mockLimit.mock.calls;
    expect(calls[0][0]).toBe('judge:user-1');
    expect(calls[1][0]).toBe('judge:user-2');
    expect(calls[0][0]).not.toBe(calls[1][0]);
  });

  it('uses different Redis keys for different agents', async () => {
    mockLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60000 });

    await checkRateLimit('judge', 'user-1');
    await checkRateLimit('matchmaker', 'user-1');

    const calls = mockLimit.mock.calls;
    expect(calls[0][0]).toBe('judge:user-1');
    expect(calls[1][0]).toBe('matchmaker:user-1');
    expect(calls[0][0]).not.toBe(calls[1][0]);
  });
});
