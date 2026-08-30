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
  mockCheckAgentBudget,
  mockReserveSpend,
  mockSettleSpend,
  mockMarkUnknown,
  mockReleaseSpend,
  mockFailOperation,
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
  mockCheckAgentBudget:  vi.fn(),
  mockReserveSpend:      vi.fn(),
  mockSettleSpend:       vi.fn(),
  mockMarkUnknown:       vi.fn(),
  mockReleaseSpend:      vi.fn(),
  mockFailOperation:     vi.fn(),
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
    // AUDIT FIX L3: trackCost now uses an atomic MULTI/EXEC chain
    // (incrby + expire in one transaction). The chainable mock records the
    // same incrby/expire spies so existing assertions keep working.
    multi = () => {
      const chain = {
        incrby: (key: string, value: number) => { mockIncrby(key, value); return chain; },
        expire: (key: string, seconds: number) => { mockExpire(key, seconds); return chain; },
        exec: vi.fn().mockResolvedValue([1, 1]),
      };
      return chain;
    };
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

// AUDIT FIX H6: AIRouter now imports circuit breakers (module chain pulls in
// logger → real config). Pass-through mock keeps this suite hermetic.
vi.mock('../../src/middleware/circuit-breaker', () => ({
  CircuitOpenError: class CircuitOpenError extends Error {},
  openaiBreaker: { execute: (fn: () => unknown) => fn() },
  groqBreaker: { execute: (fn: () => unknown) => fn() },
  deepseekBreaker: { execute: (fn: () => unknown) => fn() },
  alibabaBreaker: { execute: (fn: () => unknown) => fn() },
}));

vi.mock('../../src/ai/UserAIBudget', () => ({
  checkGlobalBudget: mockCheckGlobalBudget,
  checkUserBudget:   mockCheckUserBudget,
  trackUserCost:     mockTrackUserCost,
  trackGlobalCost:   mockTrackGlobalCost,
  checkAgentBudget:  mockCheckAgentBudget,
  failAIOperation: mockFailOperation,
}));
vi.mock('../../src/ai/AISpendAttemptLedger', () => ({
  reserveAIProviderAttempt: mockReserveSpend,
  settleAIProviderAttempt: mockSettleSpend,
  markAIProviderAttemptUnknown: mockMarkUnknown,
  releaseAIProviderAttempt: mockReleaseSpend,
}));
vi.mock('../../src/ai/ExternalAIProviderAuthority', () => ({
  assertExternalAIProviderIOAuthorized: vi.fn(),
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

import { callAI as callAIRaw, getBudgetStatus, getCostDashboard, checkCostAlerts } from '../../src/ai/AIRouter';

let operationSequence = 0;
const callAI = (agent: string, userId: string, prompt: string) => callAIRaw(
  agent,
  userId,
  prompt,
  { operationId: `unit-cost-${++operationSequence}` },
);

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
  operationSequence = 0;

  // Budgets pass by default
  mockCheckGlobalBudget.mockResolvedValue({ allowed: true, spent: 0, limit: 50000 });
  mockCheckUserBudget.mockResolvedValue({ allowed: true, spent: 0, limit: 500 });
  mockTrackUserCost.mockResolvedValue(undefined);
  mockTrackGlobalCost.mockResolvedValue(undefined);
  mockCheckAgentBudget.mockImplementation(async (_agent: string, _userId: string, limit: number) => {
    const spent = Number(await mockGet() ?? 0);
    return { allowed: spent < limit, spent, limit };
  });
  mockReserveSpend.mockResolvedValue({ status: 'reserved', reservedCents: 4 });
  mockSettleSpend.mockResolvedValue(undefined);
  mockMarkUnknown.mockResolvedValue(undefined);
  mockReleaseSpend.mockResolvedValue(undefined);
  mockFailOperation.mockResolvedValue(undefined);

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

  it('reserves first, writes the audit row, and settles after a successful call', async () => {
    await callAI('judge', USER_ID, 'Score this');

    expect(mockReserveSpend).toHaveBeenCalledTimes(1);
    expect(mockSettleSpend).toHaveBeenCalledTimes(1);
    expect(mockReserveSpend.mock.invocationCallOrder[0]).toBeLessThan(mockGroqCreate.mock.invocationCallOrder[0]);
    expect(mockGroqCreate.mock.invocationCallOrder[0]).toBeLessThan(mockQuery.mock.invocationCallOrder[0]);
    expect(mockQuery.mock.invocationCallOrder[0]).toBeLessThan(mockSettleSpend.mock.invocationCallOrder[0]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ai_cost_logs'),
      ['judge', USER_ID, 'groq', 'llama-3.3-70b-versatile', 100, 70, 30, expect.any(Number), expect.any(String)],
    );
    expect(mockGroqCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 4000 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
    mockReserveSpend.mockResolvedValue({ status: 'limit', scope: 'global', spent: 50000, limit: 50000 });

    await expect(callAI('judge', USER_ID, 'test')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX703'),
    });
  });
});

describe('callAI — per-user budget exceeded', () => {
  it('throws TOO_MANY_REQUESTS when user daily budget is exceeded', async () => {
    mockReserveSpend.mockResolvedValue({ status: 'limit', scope: 'user', spent: 500, limit: 500 });

    await expect(callAI('judge', USER_ID, 'test')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('HX704'),
    });
  });
});

describe('callAI — agent-level budget exceeded', () => {
  it('throws TOO_MANY_REQUESTS when agent daily budget is exceeded', async () => {
    mockReserveSpend.mockResolvedValue({ status: 'limit', scope: 'agent', spent: 5, limit: 5 });

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
    expect(result.attempts).toBe(3);
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
// callAI — Redis failure (budget check fails CLOSED)
// ---------------------------------------------------------------------------

describe('callAI — Redis unavailable', () => {
  it('denies the call before provider I/O when atomic reservation is unavailable', async () => {
    mockReserveSpend.mockRejectedValue(new Error('Redis connection refused'));

    await expect(callAI('judge', USER_ID, 'test')).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('HX705'),
    });
    expect(mockGroqCreate).not.toHaveBeenCalled();
  });
});

describe('callAI — spend authority and idempotency', () => {
  it('requires a caller-supplied stable operation identity', async () => {
    await expect(callAIRaw('judge', USER_ID, 'test', undefined as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('HX700'),
    });
    expect(mockReserveSpend).not.toHaveBeenCalled();
    expect(mockGroqCreate).not.toHaveBeenCalled();
  });

  it('returns a completed replay without another provider call or reservation', async () => {
    const cached = { text: 'cached', provider: 'groq', model: 'm', tokensUsed: 10, estimatedCostCents: 1, attempts: 1 };
    mockReserveSpend.mockResolvedValue({ status: 'completed', resultJson: JSON.stringify(cached) });

    await expect(callAIRaw('judge', USER_ID, 'same', { operationId: 'stable-op' })).resolves.toEqual(cached);
    expect(mockGroqCreate).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSettleSpend).not.toHaveBeenCalled();
  });

  it('rejects a concurrent/uncertain replay without provider I/O', async () => {
    mockReserveSpend.mockResolvedValue({ status: 'in_progress' });
    await expect(callAIRaw('judge', USER_ID, 'same', { operationId: 'stable-op' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('HX706'),
    });
    expect(mockGroqCreate).not.toHaveBeenCalled();
  });

  it('retains each unknown reservation before retrying or falling back', async () => {
    mockGroqCreate.mockRejectedValue(new Error('unknown outcome'));
    mockOpenAICreate.mockResolvedValue(makeOpenAIResponse('fallback', 150));

    await callAIRaw('judge', USER_ID, 'test', { operationId: 'retry-reservations' });

    expect(mockReserveSpend).toHaveBeenCalledTimes(3);
    expect(mockMarkUnknown).toHaveBeenCalledTimes(2);
    expect(mockReserveSpend.mock.calls.map((call) => call[0].reservation.attemptId)).toEqual([
      '0:groq:0',
      '0:groq:1',
      '1:openai:0',
    ]);
  });

  it('does not call a fallback after successful provider I/O when audit persistence fails', async () => {
    mockQuery.mockRejectedValue(new Error('Postgres unavailable'));

    await expect(callAIRaw('judge', USER_ID, 'test', { operationId: 'audit-failure' })).rejects.toMatchObject({
      message: expect.stringContaining('HX705'),
    });
    expect(mockGroqCreate).toHaveBeenCalledTimes(1);
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(mockSettleSpend).not.toHaveBeenCalled();
  });

  it('does not call a fallback when post-provider Redis settlement fails', async () => {
    mockSettleSpend.mockRejectedValue(new Error('Redis unavailable'));

    await expect(callAIRaw('judge', USER_ID, 'test', { operationId: 'settle-failure' })).rejects.toMatchObject({
      message: expect.stringContaining('HX705'),
    });
    expect(mockGroqCreate).toHaveBeenCalledTimes(1);
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getBudgetStatus
// ---------------------------------------------------------------------------

describe('getBudgetStatus', () => {
  it('returns budget status with spent/limit/remaining', async () => {
    mockGet.mockResolvedValue('3'); // raw Redis string: 3 cents spent

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
    mockGet.mockResolvedValue('100'); // raw Redis string: spent more than limit

    const status = await getBudgetStatus('judge', USER_ID);
    expect(status.remaining).toBe(0);
  });

  it('uses default config for unknown agents', async () => {
    mockGet.mockResolvedValue('0');

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
