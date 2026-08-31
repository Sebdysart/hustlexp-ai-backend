/**
 * AI Rate Limiting Unit Tests (backend/src/ai/rateLimit.ts)
 *
 * Tests checkRateLimit and requireRateLimit through the normalized Redis port.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const mockEval = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    constructor(_opts: unknown) {}
    eval = mockEval;
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    redis: {
      restUrl:   'https://redis.upstash.io',
      restToken: 'test-token',
      url: '',
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
    mockEval.mockResolvedValue([1, 9, Date.now() + 60000]);
  });

  it('returns allowed=true for a new user under the limit', async () => {
    const result = await checkRateLimit('judge', 'user-1');

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(10);
    expect(result.remaining).toBe(9);
  });

  it('calls the ratelimit with the correct key (agent:userId)', async () => {
    await checkRateLimit('judge', 'user-abc');

    expect(mockEval.mock.calls[0][1]).toEqual(['ratelimit:ai:judge:user-abc']);
  });

  it('works for different known agents', async () => {
    for (const agent of ['judge', 'matchmaker', 'dispute', 'reputation', 'onboarding', 'moderation']) {
      vi.clearAllMocks();
      mockEval.mockResolvedValue([1, 19, Date.now() + 60000]);

      const result = await checkRateLimit(agent, 'user-1');
      expect(result.allowed).toBe(true);
    }
  });

  it('uses default config for an unknown agent', async () => {
    mockEval.mockResolvedValue([1, 20, Date.now() + 60000]);

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
    mockEval.mockResolvedValue([0, 0, Date.now() + 30000]);
  });

  it('returns allowed=false when the ratelimit returns success=false', async () => {
    const result = await checkRateLimit('dispute', 'user-1');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit — Redis/Ratelimit failure (fail-closed)
// ---------------------------------------------------------------------------

describe('checkRateLimit — failure fallback', () => {
  it('returns allowed=false when the ratelimit throws (fail-closed)', async () => {
    mockEval.mockRejectedValue(new Error('Redis unavailable'));

    const result = await checkRateLimit('judge', 'user-1');

    // Intentional fail-CLOSED: consistent with UserAIBudget and AIRouter budget guards.
    // A Redis failure must not silently bypass per-user limits.
    expect(result.allowed).toBe(false);
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
    mockEval.mockResolvedValue([1, 5, Date.now() + 60000]);

    await expect(requireRateLimit('judge', 'user-1')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// requireRateLimit — throws when rate-limited
// ---------------------------------------------------------------------------

describe('requireRateLimit — denied', () => {
  it('throws TOO_MANY_REQUESTS TRPCError when rate limit exceeded', async () => {
    const resetAt = Date.now() + 45000;
    mockEval.mockResolvedValue([0, 0, resetAt]);

    await expect(requireRateLimit('judge', 'user-1')).rejects.toMatchObject({
      code:    'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX703'),
    });
  });

  it('includes the agent name in the error message', async () => {
    mockEval.mockResolvedValue([0, 0, Date.now() + 10000]);

    await expect(requireRateLimit('dispute', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining('dispute'),
    });
  });

  it('includes a retry-in seconds value in the error message', async () => {
    const resetAt = Date.now() + 30000; // 30 seconds from now
    mockEval.mockResolvedValue([0, 0, resetAt]);

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
    mockEval.mockResolvedValue([1, 9, Date.now() + 60000]);

    await checkRateLimit('judge', 'user-1');
    await checkRateLimit('judge', 'user-2');

    const calls = mockEval.mock.calls;
    expect(calls[0][1]).toEqual(['ratelimit:ai:judge:user-1']);
    expect(calls[1][1]).toEqual(['ratelimit:ai:judge:user-2']);
    expect(calls[0][1]).not.toEqual(calls[1][1]);
  });

  it('uses different Redis keys for different agents', async () => {
    mockEval.mockResolvedValue([1, 9, Date.now() + 60000]);

    await checkRateLimit('judge', 'user-1');
    await checkRateLimit('matchmaker', 'user-1');

    const calls = mockEval.mock.calls;
    expect(calls[0][1]).toEqual(['ratelimit:ai:judge:user-1']);
    expect(calls[1][1]).toEqual(['ratelimit:ai:matchmaker:user-1']);
    expect(calls[0][1]).not.toEqual(calls[1][1]);
  });
});
