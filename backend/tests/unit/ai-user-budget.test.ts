import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEval } = vi.hoisted(() => ({
  mockEval: vi.fn(),
}));

vi.mock('../../src/redis/RedisCommandPort', () => ({
  getRedisCommandClient: () => ({ transport: 'tcp', eval: mockEval }),
}));

import {
  abortAIProviderSpendBeforeIO,
  aiBudgetTestOnly,
  checkAgentBudget,
  checkGlobalBudget,
  checkUserBudget,
  failAIOperation,
  markAIProviderSpendUnknown,
  releaseAIProviderSpend,
  reserveAIProviderSpend,
  settleAIProviderSpend,
  type AIReservationRequest,
} from '../../src/ai/UserAIBudget';

const request: AIReservationRequest = {
  agent: 'judge',
  userId: 'user-1',
  operationId: 'operation-1',
  fingerprint: 'fingerprint-1',
  ownerToken: 'owner-1',
  attemptId: '0:groq:0',
  reserveCents: 9,
  agentLimitCents: 50,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('atomic AI spend reservations', () => {
  it('reserves all three ceilings in one Lua operation', async () => {
    mockEval.mockResolvedValue(['RESERVED', '9', '20700', '3601']);

    await expect(reserveAIProviderSpend(request)).resolves.toEqual({ status: 'reserved', reservedCents: 9, budgetDay: '20700' });

    const [script, keys, args] = mockEval.mock.calls[0] as [string, string[], string[]];
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.includes('{spend-authority}'))).toBe(true);
    expect(args.slice(0, 4)).toEqual(['9', '50000', '500', '50']);
    expect(args).toContain('fingerprint-1');
    expect(args).toContain('owner-1');
    expect(args.at(-1)).toBe('');
    expect(script).toContain("redis.call('TIME')");
  });

  it.each([
    [['LIMIT', 'global', '49999', '50000'], { status: 'limit', scope: 'global', spent: 49999, limit: 50000 }],
    [['LIMIT', 'user', '499', '500'], { status: 'limit', scope: 'user', spent: 499, limit: 500 }],
    [['LIMIT', 'agent', '49', '50'], { status: 'limit', scope: 'agent', spent: 49, limit: 50 }],
  ])('maps an atomic ceiling rejection without a partial increment', async (redisResult, expected) => {
    mockEval.mockResolvedValue(redisResult);
    await expect(reserveAIProviderSpend(request)).resolves.toEqual(expected);
  });

  it('returns a completed operation for idempotent replay', async () => {
    const result = { text: 'cached', provider: 'groq', model: 'm', tokensUsed: 3, estimatedCostCents: 1, attempts: 1 };
    mockEval.mockResolvedValue(['COMPLETED', JSON.stringify(result)]);
    await expect(reserveAIProviderSpend(request)).resolves.toEqual({ status: 'completed', resultJson: JSON.stringify(result) });
  });

  it('fails closed when Redis reservation is unavailable', async () => {
    mockEval.mockRejectedValue(new Error('Redis unavailable'));
    await expect(reserveAIProviderSpend(request)).rejects.toThrow('Redis unavailable');
  });

  it('settles only at or below the reserved amount', async () => {
    mockEval.mockResolvedValue(['SETTLED', '7']);
    await expect(settleAIProviderSpend({
      ...request,
      actualCostCents: 2,
      resultJson: JSON.stringify({ ok: true }),
    })).resolves.toBeUndefined();
    expect(mockEval.mock.calls[0][2][0]).toBe('2');

    await expect(settleAIProviderSpend({
      ...request,
      actualCostCents: 10,
      resultJson: JSON.stringify({ ok: true }),
    })).rejects.toThrow('AI_BUDGET_ACTUAL_EXCEEDS_RESERVATION');
  });

  it('retains unknown spend, releases proven no-I/O spend, and finalizes failure via Lua', async () => {
    mockEval
      .mockResolvedValueOnce(['MARKED_UNKNOWN'])
      .mockResolvedValueOnce(['RELEASED'])
      .mockResolvedValueOnce(['FAILED']);

    await markAIProviderSpendUnknown(request);
    await releaseAIProviderSpend(request);
    await failAIOperation(request, 'providers exhausted');

    expect(mockEval).toHaveBeenCalledTimes(3);
  });

  it('atomically rolls back counters and removes the poisoned operation after proven pre-I/O failure', async () => {
    mockEval.mockResolvedValueOnce(['ABORTED', '20700']);
    await expect(abortAIProviderSpendBeforeIO(request)).resolves.toBeUndefined();
    const [script, keys] = mockEval.mock.calls[0] as [string, string[]];
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.includes('{spend-authority}'))).toBe(true);
    expect(script).toContain("redis.call('DECRBY', global_key, amount)");
    expect(script).toContain("redis.call('DEL', attempt_key)");
    expect(script).toContain("redis.call('DEL', operation_key)");
  });

  it('rejects corrupt or unexpected Redis state instead of proceeding', async () => {
    mockEval.mockResolvedValue(['ATTEMPT_EXISTS']);
    await expect(reserveAIProviderSpend(request)).rejects.toThrow('AI_BUDGET_RESERVATION_REJECTED:ATTEMPT_EXISTS');
  });
});

describe('budget status reads', () => {
  it('uses the reservation counters for global, user, and agent status', async () => {
    mockEval
      .mockResolvedValueOnce(['SPEND', '12', '20700'])
      .mockResolvedValueOnce(['SPEND', '13', '20700'])
      .mockResolvedValueOnce(['SPEND', '14', '20700']);
    await expect(checkGlobalBudget()).resolves.toEqual({ allowed: true, spent: 12, limit: 50000 });
    await expect(checkUserBudget('user-1')).resolves.toEqual({ allowed: true, spent: 13, limit: 500 });
    await expect(checkAgentBudget('judge', 'user-1', 50)).resolves.toEqual({ allowed: true, spent: 14, limit: 50 });
  });

  it('fails closed on missing or corrupt metering', async () => {
    mockEval.mockRejectedValue(new Error('down'));
    await expect(checkGlobalBudget()).resolves.toMatchObject({ allowed: false });
    await expect(checkUserBudget('user-1')).resolves.toMatchObject({ allowed: false });
    await expect(checkAgentBudget('judge', 'user-1', 50)).resolves.toMatchObject({ allowed: false });
  });

  it('permits clock injection only through the test-only wrapper', async () => {
    mockEval.mockResolvedValue(['RESERVED', '9', '47481', '3601']);
    await expect(aiBudgetTestOnly.reserveAtEpoch(request, 4_102_444_799)).resolves.toMatchObject({
      status: 'reserved',
      budgetDay: '47481',
    });
    expect(mockEval.mock.calls[0][2].at(-1)).toBe('4102444799');
  });
});
