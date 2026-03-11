/**
 * AI Guard — Extra Coverage Tests (backend/src/middleware/ai-guard.ts)
 *
 * The existing ai-guard.test.ts already covers validateAIOutput, estimateAICost,
 * and basic checkAIBudget (in-memory path, within-budget).
 *
 * This file covers the remaining uncovered paths:
 *  - trackAIUsage (log emission)
 *  - checkAIBudget with Redis available (happy path + budget exceeded + rollback)
 *  - checkAIBudget in-memory fallback when Redis throws
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — safe to reference inside vi.mock() factories
// ---------------------------------------------------------------------------

const { mockLogInfo, mockLogWarn, mockLogError, mockIncrbyfloat, mockTtl, mockExpire } = vi.hoisted(() => ({
  mockLogInfo:      vi.fn(),
  mockLogWarn:      vi.fn(),
  mockLogError:     vi.fn(),
  mockIncrbyfloat:  vi.fn(),
  mockTtl:          vi.fn(),
  mockExpire:       vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      info:  mockLogInfo,
      warn:  mockLogWarn,
      error: mockLogError,
      debug: vi.fn(),
    }),
    info:  mockLogInfo,
    warn:  mockLogWarn,
    error: mockLogError,
    debug: vi.fn(),
  },
  escrowLogger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}));

vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    incrbyfloat = mockIncrbyfloat;
    ttl         = mockTtl;
    expire      = mockExpire;
    constructor(_opts: unknown) {}
  },
}));

// ---------------------------------------------------------------------------
// System-under-test — imported AFTER mocks
// ---------------------------------------------------------------------------

import { trackAIUsage, checkAIBudget, estimateAICost } from '../../src/middleware/ai-guard';

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default Redis behaviour: cost within budget, no existing TTL
  mockIncrbyfloat.mockResolvedValue(5.0);   // $5 accumulated (well under $50 budget)
  mockTtl.mockResolvedValue(-1);            // No TTL set → trigger expire()
  mockExpire.mockResolvedValue(1);
});

// ---------------------------------------------------------------------------
// trackAIUsage
// ---------------------------------------------------------------------------

describe('trackAIUsage', () => {
  it('logs an ai_usage event with the correct fields', () => {
    trackAIUsage({
      provider:     'openai',
      model:        'gpt-4o',
      inputTokens:  500,
      outputTokens: 200,
      latencyMs:    350,
      cached:       false,
      userId:       'user-123',
      endpoint:     '/api/ai/judge',
    });

    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    const [payload, message] = mockLogInfo.mock.calls[0];
    expect(payload).toMatchObject({
      provider:         'openai',
      model:            'gpt-4o',
      inputTokens:      500,
      outputTokens:     200,
      latencyMs:        350,
      cached:           false,
      userId:           'user-123',
      endpoint:         '/api/ai/judge',
      type:             'ai_usage',
      estimatedCostUSD: expect.any(Number),
    });
    expect(message).toBe('AI usage tracked');
  });

  it('calculates estimatedCostUSD using estimateAICost', () => {
    const expectedCost = estimateAICost('gpt-4o-mini', 1000, 500);

    trackAIUsage({
      provider:     'openai',
      model:        'gpt-4o-mini',
      inputTokens:  1000,
      outputTokens: 500,
      latencyMs:    100,
      cached:       false,
      endpoint:     '/api/ai/match',
    });

    const [payload] = mockLogInfo.mock.calls[0];
    expect(payload.estimatedCostUSD).toBeCloseTo(expectedCost, 8);
  });

  it('works without a userId (optional field)', () => {
    trackAIUsage({
      provider:     'groq',
      model:        'llama-3.1-70b-versatile',
      inputTokens:  200,
      outputTokens: 100,
      latencyMs:    80,
      cached:       true,
      endpoint:     '/api/ai/pricing',
    });

    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    const [payload] = mockLogInfo.mock.calls[0];
    expect(payload.userId).toBeUndefined();
  });

  it('logs cached=true correctly', () => {
    trackAIUsage({
      provider:     'openai',
      model:        'gpt-4o',
      inputTokens:  0,
      outputTokens: 0,
      latencyMs:    2,
      cached:       true,
      endpoint:     '/api/ai/match',
    });

    const [payload] = mockLogInfo.mock.calls[0];
    expect(payload.cached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkAIBudget — Redis path (happy path, within budget)
// ---------------------------------------------------------------------------

describe('checkAIBudget — Redis path (within budget)', () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL   = 'https://redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('sets TTL when the key has no TTL (ttl returns -1)', async () => {
    mockIncrbyfloat.mockResolvedValue(1.0);
    mockTtl.mockResolvedValue(-1);

    await checkAIBudget(0.1);

    expect(mockExpire).toHaveBeenCalledTimes(1);
    const [, ttl] = mockExpire.mock.calls[0];
    expect(ttl).toBe(90000);
  });

  it('does NOT call expire when TTL is already set (ttl > 0)', async () => {
    mockIncrbyfloat.mockResolvedValue(2.0);
    mockTtl.mockResolvedValue(80000);

    await checkAIBudget(0.1);

    expect(mockExpire).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkAIBudget — Redis path (budget exceeded → rollback)
// ---------------------------------------------------------------------------

describe('checkAIBudget — Redis path (budget exceeded)', () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL   = 'https://redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('returns allowed=false when increment would exceed the $50 daily budget', async () => {
    mockIncrbyfloat
      .mockResolvedValueOnce(55.0) // initial increment — over budget
      .mockResolvedValueOnce(-5.0); // rollback decrement

    const result = await checkAIBudget(5.0);

    expect(result.allowed).toBe(false);
  });

  it('calls rollback decrement when budget is exceeded', async () => {
    mockIncrbyfloat
      .mockResolvedValueOnce(60.0)   // over budget
      .mockResolvedValueOnce(-10.0); // rollback

    await checkAIBudget(10.0);

    // First call is the increment, second is the rollback
    expect(mockIncrbyfloat).toHaveBeenCalledTimes(2);
    const rollbackAmount = mockIncrbyfloat.mock.calls[1][1];
    expect(rollbackAmount).toBe(-10.0);
  });

  it('still returns allowed=false even if rollback throws', async () => {
    mockIncrbyfloat
      .mockResolvedValueOnce(60.0)
      .mockRejectedValueOnce(new Error('rollback error'));

    const result = await checkAIBudget(10.0);
    expect(result.allowed).toBe(false);
  });

  it('logs an error when budget is exceeded', async () => {
    mockIncrbyfloat
      .mockResolvedValueOnce(55.0)
      .mockResolvedValueOnce(-5.0);

    await checkAIBudget(5.0);

    expect(mockLogError).toHaveBeenCalledTimes(1);
    const [payload] = mockLogError.mock.calls[0];
    expect(payload).toMatchObject({
      budget: 50,
      source: 'redis',
    });
  });
});

// ---------------------------------------------------------------------------
// checkAIBudget — in-memory fallback (Redis throws)
// ---------------------------------------------------------------------------

describe('checkAIBudget — in-memory fallback', () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL   = 'https://redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('falls back to in-memory when Redis incrbyfloat throws', async () => {
    mockIncrbyfloat.mockRejectedValue(new Error('Redis command timeout'));

    const result = await checkAIBudget(0.1);

    // Should fall back to in-memory and not throw
    expect(typeof result.allowed).toBe('boolean');
    expect(typeof result.remaining).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// estimateAICost — additional model coverage
// ---------------------------------------------------------------------------

describe('estimateAICost — model coverage', () => {
  it('calculates correct cost for gpt-4o-mini', () => {
    const cost = estimateAICost('gpt-4o-mini', 10000, 2000);
    // 10000 * 0.00000015 + 2000 * 0.0000006 = 0.0015 + 0.0012 = 0.0027
    expect(cost).toBeCloseTo(0.0027, 5);
  });

  it('calculates correct cost for gemini-1.5-pro', () => {
    const cost = estimateAICost('gemini-1.5-pro', 1000, 500);
    // 1000 * 0.00000125 + 500 * 0.000005 = 0.00125 + 0.0025 = 0.00375
    expect(cost).toBeCloseTo(0.00375, 5);
  });

  it('calculates correct cost for gemini-1.5-flash', () => {
    const cost = estimateAICost('gemini-1.5-flash', 2000, 1000);
    // 2000 * 0.000000075 + 1000 * 0.0000003 = 0.00015 + 0.0003 = 0.00045
    expect(cost).toBeCloseTo(0.00045, 6);
  });

  it('calculates correct cost for claude-3-haiku', () => {
    const cost = estimateAICost('claude-3-haiku', 4000, 2000);
    // 4000 * 0.00000025 + 2000 * 0.00000125 = 0.001 + 0.0025 = 0.0035
    expect(cost).toBeCloseTo(0.0035, 5);
  });

  it('calculates correct cost for gpt-4-turbo', () => {
    const cost = estimateAICost('gpt-4-turbo', 1000, 500);
    // 1000 * 0.00001 + 500 * 0.00003 = 0.01 + 0.015 = 0.025
    expect(cost).toBeCloseTo(0.025, 5);
  });

  it('uses default pricing for completely unknown model', () => {
    const known   = estimateAICost('default', 1000, 500);
    const unknown = estimateAICost('my-custom-model-v9', 1000, 500);
    expect(unknown).toBeCloseTo(known, 8);
  });
});
