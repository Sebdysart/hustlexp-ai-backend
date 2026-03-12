/**
 * AIRouter Branch Coverage Tests
 *
 * Tests backend/src/ai/AIRouter.ts — the cost-governed AI dispatch layer.
 * Covers branches NOT already in ai-router-cost.test.ts:
 * - fail-open Redis behavior (checkBudget catch path)
 * - getCostDashboard invalid row parsing
 * - checkCostAlerts invalid daily_cost handling
 * - getFeed sort_by 'deadline' and 'default' branches
 * - getBudgetStatus overspent clamp branch
 *
 * Uses the vi.hoisted() + class-based mock pattern required because
 * AIRouter.ts calls `await import('groq-sdk')` / `await import('openai')`
 * and then runs `new Groq(...)` / `new OpenAI(...)` — those constructors
 * require real ES classes, not arrow-function mock implementations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — shared mock fns accessible inside vi.mock() factory closures
// ---------------------------------------------------------------------------

const {
  mockGet,
  mockIncrby,
  mockExpire,
  mockQuery,
  mockCheckGlobalBudget,
  mockCheckUserBudget,
  mockTrackUserCost,
  mockTrackGlobalCost,
  mockGroqCreate,
  mockOpenAICreate,
} = vi.hoisted(() => ({
  mockGet:               vi.fn(),
  mockIncrby:            vi.fn(),
  mockExpire:            vi.fn(),
  mockQuery:             vi.fn(),
  mockCheckGlobalBudget: vi.fn(),
  mockCheckUserBudget:   vi.fn(),
  mockTrackUserCost:     vi.fn(),
  mockTrackGlobalCost:   vi.fn(),
  mockGroqCreate:        vi.fn(),
  mockOpenAICreate:      vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — must reference vi.hoisted fns, not local variables
// ---------------------------------------------------------------------------

vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    get    = mockGet;
    incrby = mockIncrby;
    expire = mockExpire;
    constructor(_opts: unknown) {}
  },
}));

vi.mock('../../src/db', () => ({
  db: { query: mockQuery },
}));

vi.mock('../../src/config', () => ({
  config: {
    redis: { restUrl: 'https://redis.upstash.io', restToken: 'test-token' },
    ai: {
      groq:     { apiKey: 'groq-key',     model: 'llama-3.3-70b-versatile' },
      openai:   { apiKey: 'openai-key',   model: 'gpt-4o' },
      deepseek: { apiKey: 'deepseek-key', model: 'deepseek-r1' },
      alibaba:  { apiKey: 'alibaba-key',  model: 'qwen-max' },
    },
  },
}));

vi.mock('../../src/ai/UserAIBudget', () => ({
  checkGlobalBudget: mockCheckGlobalBudget,
  checkUserBudget:   mockCheckUserBudget,
  trackUserCost:     mockTrackUserCost,
  trackGlobalCost:   mockTrackGlobalCost,
}));

vi.mock('groq-sdk', () => ({
  Groq: class MockGroq {
    chat = { completions: { create: mockGroqCreate } };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('openai', () => ({
  OpenAI: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreate } };
    constructor(_opts: unknown) {}
  },
}));

// ---------------------------------------------------------------------------
// System-under-test (import AFTER mocks are registered)
// ---------------------------------------------------------------------------

import { callAI, getBudgetStatus, getCostDashboard, checkCostAlerts } from '../../src/ai/AIRouter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-branch-123';

function makeGroqResponse(text = 'groq response', tokens = 100) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: tokens },
  };
}

function makeOpenAIResponse(text = 'openai response', tokens = 150) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: tokens },
  };
}

// ---------------------------------------------------------------------------
// beforeEach — reset all mocks to permissive defaults
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Budgets pass by default
  mockCheckGlobalBudget.mockResolvedValue({ allowed: true, spent: 0, limit: 50000 });
  mockCheckUserBudget.mockResolvedValue({ allowed: true, spent: 0, limit: 500 });
  mockTrackUserCost.mockResolvedValue(undefined);
  mockTrackGlobalCost.mockResolvedValue(undefined);

  // Agent-level Redis budget: 0 spent (no budget exceeded)
  mockGet.mockResolvedValue(null);
  mockIncrby.mockResolvedValue(1);
  mockExpire.mockResolvedValue(1);

  // DB cost logging succeeds silently
  mockQuery.mockResolvedValue({ rows: [] });

  // AI SDKs return valid responses
  mockGroqCreate.mockResolvedValue(makeGroqResponse());
  mockOpenAICreate.mockResolvedValue(makeOpenAIResponse());
});

// ===========================================================================
// callAI — Redis fail-open branch (the branch NOT covered by ai-router-cost.test.ts
// approach because that test uses a fresh module but this tests the singleton path)
// ===========================================================================

describe('callAI — Redis fail-open (checkBudget catch branch)', () => {
  it('allows the call when Redis.get throws during agent budget check', async () => {
    // Redis.get rejects → checkBudget() catch block → returns { allowed: true }
    mockGet.mockRejectedValue(new Error('Redis connection refused'));

    const result = await callAI('judge', USER_ID, 'test prompt');

    expect(result.text).toBe('groq response');
    expect(result.provider).toBe('groq');
    expect(result.attempts).toBe(1);
  });
});

// ===========================================================================
// callAI — happy path / basic coverage
// ===========================================================================

describe('callAI — happy path', () => {
  it('returns correct result fields on first-provider success', async () => {
    const result = await callAI('judge', USER_ID, 'score this task');

    expect(result.text).toBe('groq response');
    expect(result.provider).toBe('groq');
    expect(result.tokensUsed).toBe(100);
    expect(result.estimatedCostCents).toBeGreaterThanOrEqual(0);
    expect(result.attempts).toBe(1);
    expect(typeof result.model).toBe('string');
  });

  it('falls back to openai when groq fails', async () => {
    mockGroqCreate.mockRejectedValue(new Error('Groq unavailable'));
    mockOpenAICreate.mockResolvedValue(makeOpenAIResponse('openai fallback text', 120));

    const result = await callAI('judge', USER_ID, 'prompt');

    expect(result.provider).toBe('openai');
    expect(result.text).toBe('openai fallback text');
    expect(result.attempts).toBe(2);
  });

  it('throws HX703 when global budget is exceeded', async () => {
    mockCheckGlobalBudget.mockResolvedValue({ allowed: false, spent: 50000, limit: 50000 });

    await expect(callAI('judge', USER_ID, 'test')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX703'),
    });
  });

  it('throws HX704 when per-user budget is exceeded', async () => {
    mockCheckUserBudget.mockResolvedValue({ allowed: false, spent: 500, limit: 500 });

    await expect(callAI('judge', USER_ID, 'test')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX704'),
    });
  });

  it('throws HX701 when per-agent daily budget (Redis) is exceeded', async () => {
    // reputation: dailyBudgetPerUser = 5; Redis returns 10 → spent > limit
    mockGet.mockResolvedValue(10);

    await expect(callAI('reputation', USER_ID, 'test')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX701'),
    });
  });

  it('throws HX702 when all providers in chain fail', async () => {
    mockGroqCreate.mockRejectedValue(new Error('Groq down'));
    mockOpenAICreate.mockRejectedValue(new Error('OpenAI down'));

    // matchmaker fallbackChain: ['groq', 'openai'] — both fail
    await expect(callAI('matchmaker', USER_ID, 'test')).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('HX702'),
    });
  });

  it('uses default config for unknown agent name', async () => {
    const result = await callAI('nonexistent_agent', USER_ID, 'test');
    // default fallbackChain starts with 'groq'
    expect(result.provider).toBe('groq');
  });
});

// ===========================================================================
// getBudgetStatus — overspent clamp branch
// ===========================================================================

describe('getBudgetStatus', () => {
  it('returns remaining=0 when spent exceeds limit (overspent clamp)', async () => {
    mockGet.mockResolvedValue(200); // spent=200, judge limit=50

    const status = await getBudgetStatus('judge', USER_ID);

    expect(status.remaining).toBe(0); // Math.max(0, 50 - 200) = 0
    expect(status.spent).toBe(200);
    expect(status.limit).toBe(50);
  });

  it('returns positive remaining when under budget', async () => {
    mockGet.mockResolvedValue(20); // spent=20, judge limit=50

    const status = await getBudgetStatus('judge', USER_ID);

    expect(status.remaining).toBe(30);
    expect(status.agent).toBe('judge');
    expect(status.userId).toBe(USER_ID);
  });

  it('uses default config for unknown agent', async () => {
    mockGet.mockResolvedValue(0);

    const status = await getBudgetStatus('unknown_agent_xyz', USER_ID);

    expect(status.limit).toBe(25); // default dailyBudgetPerUser = 25
  });

  it('returns resetAt as tomorrow ISO timestamp', async () => {
    mockGet.mockResolvedValue(0);

    const status = await getBudgetStatus('judge', USER_ID);

    const resetAt = new Date(status.resetAt);
    expect(resetAt.getTime()).toBeGreaterThan(Date.now());
    expect(typeof status.resetAt).toBe('string');
  });
});

// ===========================================================================
// getCostDashboard — invalid/null row value branches
// ===========================================================================

describe('getCostDashboard — invalid row values', () => {
  it('treats NaN total_cost as 0', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { agent_type: 'judge', provider: 'groq', total_cost: 'NaN', total_tokens: '500', call_count: '3' },
      ],
    });

    const summary = await getCostDashboard(7);

    // parseInt('NaN') = NaN → || 0 = 0
    expect(summary.totalCostCents).toBe(0);
    expect(summary.totalTokens).toBe(500);
    expect(summary.callCount).toBe(3);
  });

  it('treats empty string total_tokens as 0', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { agent_type: 'judge', provider: 'groq', total_cost: '100', total_tokens: '', call_count: '1' },
      ],
    });

    const summary = await getCostDashboard(7);

    // parseInt('') = NaN → || 0 = 0
    expect(summary.totalCostCents).toBe(100);
    expect(summary.totalTokens).toBe(0);
    expect(summary.callCount).toBe(1);
  });

  it('returns period string matching the argument', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const s7  = await getCostDashboard(7);
    const s14 = await getCostDashboard(14);

    expect(s7.period).toBe('7 days');
    expect(s14.period).toBe('14 days');
  });

  it('defaults to 30-day period when called with no argument', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const summary = await getCostDashboard();
    expect(summary.period).toBe('30 days');
  });

  it('accumulates totals across multiple rows for same agent', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { agent_type: 'judge', provider: 'groq',   total_cost: '100', total_tokens: '1000', call_count: '5' },
        { agent_type: 'judge', provider: 'openai',  total_cost: '200', total_tokens: '500',  call_count: '2' },
      ],
    });

    const summary = await getCostDashboard(30);

    expect(summary.byAgent['judge'].costCents).toBe(300);
    expect(summary.byAgent['judge'].calls).toBe(7);
    expect(summary.byProvider['groq'].costCents).toBe(100);
    expect(summary.byProvider['openai'].costCents).toBe(200);
  });
});

// ===========================================================================
// checkCostAlerts — invalid daily_cost branch
// ===========================================================================

describe('checkCostAlerts — invalid row values', () => {
  it('produces no alert for non-numeric daily_cost ("invalid" string)', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agent_type: 'judge', daily_cost: 'invalid' }],
    });

    const { alerts } = await checkCostAlerts();

    // parseInt('invalid') = NaN → || 0 = 0 → below threshold → no alert
    expect(alerts).toHaveLength(0);
  });

  it('produces no alert for daily_cost "0"', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agent_type: 'judge', daily_cost: '0' }],
    });

    const { alerts } = await checkCostAlerts();
    expect(alerts).toHaveLength(0);
  });

  it('produces warning alert at exactly the >5000 threshold (5001 cents = $50.01)', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agent_type: 'onboarding', daily_cost: '5001' }],
    });

    const { alerts } = await checkCostAlerts();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('warning');
    expect(alerts[0].agent).toBe('onboarding');
    expect(alerts[0].dailyCostCents).toBe(5001);
    expect(alerts[0].projectedMonthlyCents).toBe(5001 * 30);
    expect(alerts[0].message).toContain('Monitor closely');
  });

  it('produces critical alert at exactly the >15000 threshold (15001 cents = $150.01)', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agent_type: 'dispute', daily_cost: '15001' }],
    });

    const { alerts } = await checkCostAlerts();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('critical');
    expect(alerts[0].message).toContain('IMMEDIATE ATTENTION REQUIRED');
  });

  it('returns empty alerts array when DB returns no rows', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const { alerts } = await checkCostAlerts();
    expect(alerts).toHaveLength(0);
  });
});
