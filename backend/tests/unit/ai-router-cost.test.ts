/**
 * Backend AIRouter (backend/src/ai/AIRouter.ts) Unit Tests
 *
 * Tests callAI, getBudgetStatus, getCostDashboard, and checkCostAlerts.
 * All external dependencies (Redis, DB, AI SDKs) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — creates shared mock fns that can be referenced inside vi.mock()
// factories (which are hoisted to the top of the file by the Vitest transform).
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
// Module mocks — use vi.hoisted-created fns, safe to reference here
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

const USER_ID = 'user-123';

function makeGroqResponse(text = 'AI response', tokens = 100) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: tokens },
  };
}

function makeOpenAIResponse(text = 'OpenAI response', tokens = 200) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 140, completion_tokens: 60, total_tokens: tokens },
  };
}

// ---------------------------------------------------------------------------
// beforeEach — reset all mocks to "allow everything" defaults
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Budgets pass by default
  mockCheckGlobalBudget.mockResolvedValue({ allowed: true, spent: 0, limit: 50000 });
  mockCheckUserBudget.mockResolvedValue({ allowed: true, spent: 0, limit: 500 });
  mockTrackUserCost.mockResolvedValue(undefined);
  mockTrackGlobalCost.mockResolvedValue(undefined);

  // Agent-level Redis budget: 0 spent
  mockGet.mockResolvedValue(null);
  mockIncrby.mockResolvedValue(1);
  mockExpire.mockResolvedValue(1);

  // DB cost logging succeeds silently
  mockQuery.mockResolvedValue({ rows: [] });

  // AI SDKs return valid responses
  mockGroqCreate.mockResolvedValue(makeGroqResponse());
  mockOpenAICreate.mockResolvedValue(makeOpenAIResponse());
});

// ---------------------------------------------------------------------------
// callAI — happy path
// ---------------------------------------------------------------------------

describe('callAI — happy path', () => {
  it('calls the first provider in the fallback chain and returns a result', async () => {
    const result = await callAI('judge', USER_ID, 'Score this task');

    expect(result.text).toBe('AI response');
    expect(result.provider).toBe('groq'); // judge fallbackChain: ['groq', 'openai', 'deepseek']
    expect(result.tokensUsed).toBe(100);
    expect(result.estimatedCostCents).toBeGreaterThanOrEqual(0);
    expect(result.attempts).toBe(1);
  });

  it('uses default agent config for unknown agent names', async () => {
    const result = await callAI('unknown_agent', USER_ID, 'Hello');
    // default fallbackChain starts with 'groq'
    expect(result.provider).toBe('groq');
  });

  it('tracks cost in Redis and DB after successful call', async () => {
    await callAI('judge', USER_ID, 'Score this');

    expect(mockIncrby).toHaveBeenCalled();
    expect(mockExpire).toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ai_cost_logs'),
      expect.any(Array),
    );
    expect(mockTrackUserCost).toHaveBeenCalled();
    expect(mockTrackGlobalCost).toHaveBeenCalled();
  });

  it('returns the correct model name from the provider config', async () => {
    const result = await callAI('matchmaker', USER_ID, 'Find me a match');
    // matchmaker also starts with 'groq'
    expect(result.model).toBe('llama-3.3-70b-versatile');
  });
});

// ---------------------------------------------------------------------------
// callAI — budget enforcement
// ---------------------------------------------------------------------------

describe('callAI — global budget exceeded', () => {
  it('throws TOO_MANY_REQUESTS when platform daily budget is exceeded', async () => {
    mockCheckGlobalBudget.mockResolvedValue({ allowed: false, spent: 50000, limit: 50000 });

    await expect(callAI('judge', USER_ID, 'test')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX703'),
    });
  });
});

describe('callAI — per-user budget exceeded', () => {
  it('throws TOO_MANY_REQUESTS when user daily budget is exceeded', async () => {
    mockCheckUserBudget.mockResolvedValue({ allowed: false, spent: 500, limit: 500 });

    await expect(callAI('judge', USER_ID, 'test')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX704'),
    });
  });
});

describe('callAI — agent-level budget exceeded', () => {
  it('throws TOO_MANY_REQUESTS when agent daily budget is exceeded', async () => {
    // Simulate agent budget already at the limit (reputation: 5 cents/day)
    mockGet.mockResolvedValue(5);

    await expect(callAI('reputation', USER_ID, 'test')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX701'),
    });
  });
});

// ---------------------------------------------------------------------------
// callAI — provider fallback
// ---------------------------------------------------------------------------

describe('callAI — provider fallback', () => {
  it('falls back to OpenAI when Groq fails', async () => {
    mockGroqCreate.mockRejectedValue(new Error('Groq unavailable'));
    mockOpenAICreate.mockResolvedValue(makeOpenAIResponse('OpenAI fallback', 150));

    const result = await callAI('judge', USER_ID, 'Score this task');

    expect(result.provider).toBe('openai');
    expect(result.text).toBe('OpenAI fallback');
    expect(result.attempts).toBe(2);
  });

  it('throws INTERNAL_SERVER_ERROR when all providers in the chain fail', async () => {
    mockGroqCreate.mockRejectedValue(new Error('Groq down'));
    mockOpenAICreate.mockRejectedValue(new Error('OpenAI down'));

    // matchmaker only has ['groq', 'openai'] in its fallbackChain
    await expect(callAI('matchmaker', USER_ID, 'find match')).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('HX702'),
    });
  });
});

// ---------------------------------------------------------------------------
// callAI — Redis failure (budget check fallback to "allow")
// ---------------------------------------------------------------------------

describe('callAI — Redis unavailable', () => {
  it('allows the call when Redis is unavailable during budget check', async () => {
    // Simulate Redis.get throwing
    mockGet.mockRejectedValue(new Error('Redis connection refused'));

    // Should still succeed (fail-open)
    const result = await callAI('judge', USER_ID, 'test');
    expect(result.text).toBe('AI response');
  });
});

// ---------------------------------------------------------------------------
// getBudgetStatus
// ---------------------------------------------------------------------------

describe('getBudgetStatus', () => {
  it('returns budget status with spent/limit/remaining', async () => {
    mockGet.mockResolvedValue(3); // 3 cents spent

    const status = await getBudgetStatus('judge', USER_ID);

    expect(status.agent).toBe('judge');
    expect(status.userId).toBe(USER_ID);
    expect(status.spent).toBe(3);
    expect(status.limit).toBe(50); // judge dailyBudgetPerUser
    expect(status.remaining).toBe(47);
    expect(status.resetAt).toBeDefined();
    expect(new Date(status.resetAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('clamps remaining to 0 when over budget', async () => {
    mockGet.mockResolvedValue(100); // spent more than limit

    const status = await getBudgetStatus('judge', USER_ID);
    expect(status.remaining).toBe(0);
  });

  it('uses default config for unknown agents', async () => {
    mockGet.mockResolvedValue(0);

    const status = await getBudgetStatus('unknown_agent', USER_ID);
    expect(status.limit).toBe(25); // default dailyBudgetPerUser
  });
});

// ---------------------------------------------------------------------------
// getCostDashboard
// ---------------------------------------------------------------------------

describe('getCostDashboard', () => {
  it('returns aggregated cost summary from DB rows', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { agent_type: 'judge',     provider: 'groq',   total_cost: '120', total_tokens: '8000',  call_count: '10' },
        { agent_type: 'matchmaker',provider: 'openai', total_cost: '80',  total_tokens: '5000',  call_count: '5'  },
        { agent_type: 'judge',     provider: 'openai', total_cost: '200', total_tokens: '15000', call_count: '20' },
      ],
    });

    const summary = await getCostDashboard(7);

    expect(summary.totalCostCents).toBe(400);
    expect(summary.totalTokens).toBe(28000);
    expect(summary.callCount).toBe(35);
    expect(summary.period).toBe('7 days');

    // By agent
    expect(summary.byAgent['judge'].costCents).toBe(320);
    expect(summary.byAgent['judge'].calls).toBe(30);
    expect(summary.byAgent['matchmaker'].costCents).toBe(80);

    // By provider
    expect(summary.byProvider['groq'].costCents).toBe(120);
    expect(summary.byProvider['openai'].costCents).toBe(280);
  });

  it('returns zeroed summary when no rows exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const summary = await getCostDashboard(30);

    expect(summary.totalCostCents).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.callCount).toBe(0);
    expect(Object.keys(summary.byAgent)).toHaveLength(0);
    expect(Object.keys(summary.byProvider)).toHaveLength(0);
  });

  it('defaults to 30 days when no periodDays given', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const summary = await getCostDashboard();
    expect(summary.period).toBe('30 days');
  });
});

// ---------------------------------------------------------------------------
// checkCostAlerts
// ---------------------------------------------------------------------------

describe('checkCostAlerts', () => {
  it('returns no alerts when daily spend is below thresholds', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agent_type: 'judge', daily_cost: '3000' }], // $30 — below $50 warning
    });

    const { alerts } = await checkCostAlerts();
    expect(alerts).toHaveLength(0);
  });

  it('returns a warning alert when daily spend exceeds $50/day', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agent_type: 'dispute', daily_cost: '6000' }], // $60/day
    });

    const { alerts } = await checkCostAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('warning');
    expect(alerts[0].agent).toBe('dispute');
    expect(alerts[0].dailyCostCents).toBe(6000);
    expect(alerts[0].projectedMonthlyCents).toBe(180000);
    expect(alerts[0].message).toContain('Monitor closely');
  });

  it('returns a critical alert when daily spend exceeds $150/day', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ agent_type: 'dispute', daily_cost: '20000' }], // $200/day
    });

    const { alerts } = await checkCostAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('critical');
    expect(alerts[0].message).toContain('IMMEDIATE ATTENTION');
  });

  it('handles multiple agents with mixed alert levels', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { agent_type: 'judge',      daily_cost: '2000'  }, // no alert
        { agent_type: 'dispute',    daily_cost: '7000'  }, // warning
        { agent_type: 'reputation', daily_cost: '18000' }, // critical
      ],
    });

    const { alerts } = await checkCostAlerts();
    expect(alerts).toHaveLength(2);
    const levels = alerts.map(a => a.level).sort();
    expect(levels).toEqual(['critical', 'warning']);
  });

  it('returns empty alerts when no rows in DB', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const { alerts } = await checkCostAlerts();
    expect(alerts).toHaveLength(0);
  });
});
