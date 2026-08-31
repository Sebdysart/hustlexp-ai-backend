import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  abortAIProviderSpendBeforeIO,
  aiBudgetTestOnly,
  type AIReservationRequest,
} from '../../src/ai/UserAIBudget';
import { getRedisCommandClient, type RedisCommandPort } from '../../src/redis/RedisCommandPort';

const REQUIRED_REDIS_URL = 'redis://127.0.0.1:16379';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe.sequential('AI spend authority real-Redis concurrency', () => {
  const testEpochSeconds = 4_102_444_800;
  const budgetDay = String(Math.floor(testEpochSeconds / 86400));
  const agent = `concurrency-agent-${randomUUID()}`;
  const userId = `concurrency-user-${randomUUID()}`;
  const operationIds = Array.from({ length: 40 }, () => randomUUID());
  const ownedKeys = new Set<string>();
  let redis: RedisCommandPort;

  beforeAll(() => {
    if (process.env.REDIS_URL !== REQUIRED_REDIS_URL) {
      throw new Error(`AI_BUDGET_CONCURRENCY_REQUIRES_EXACT_URL:${REQUIRED_REDIS_URL}`);
    }
    const client = getRedisCommandClient();
    if (!client || client.transport !== 'tcp') throw new Error('AI_BUDGET_CONCURRENCY_REQUIRES_TCP_REDIS');
    redis = client;

    const prefix = 'ai:{spend-authority}';
    ownedKeys.add(`${prefix}:global:${budgetDay}`);
    ownedKeys.add(`${prefix}:user:${digest(userId)}:${budgetDay}`);
    ownedKeys.add(`${prefix}:agent:${digest(agent)}:${digest(userId)}:${budgetDay}`);
    for (const operationId of operationIds) {
      ownedKeys.add(`${prefix}:operation:${digest(operationId)}`);
      ownedKeys.add(`${prefix}:operation:${digest(operationId)}:attempt:${digest('0:groq:0')}`);
    }
  });

  afterAll(async () => {
    if (redis && ownedKeys.size > 0) await redis.del(...ownedKeys);
  });

  it('never oversubscribes global, user, or agent ceilings under contention', async () => {
    const requests = operationIds.map((operationId): AIReservationRequest => ({
      agent,
      userId,
      operationId,
      fingerprint: digest(operationId),
      ownerToken: randomUUID(),
      attemptId: '0:groq:0',
      reserveCents: 1,
      agentLimitCents: 10,
    }));

    const results = await Promise.all(requests.map((request) => aiBudgetTestOnly.reserveAtEpoch(request, testEpochSeconds)));
    expect(results.filter((result) => result.status === 'reserved')).toHaveLength(10);
    expect(results.filter((result) => result.status === 'limit' && result.scope === 'agent')).toHaveLength(30);
    expect(results.filter((result) => result.status === 'reserved').every((result) => result.budgetDay === budgetDay)).toBe(true);

    const prefix = 'ai:{spend-authority}';
    await expect(redis.get(`${prefix}:global:${budgetDay}`)).resolves.toBe('10');
    await expect(redis.get(`${prefix}:user:${digest(userId)}:${budgetDay}`)).resolves.toBe('10');
    await expect(redis.get(`${prefix}:agent:${digest(agent)}:${digest(userId)}:${budgetDay}`)).resolves.toBe('10');
  });

  it('uses Redis-owned UTC epoch days across midnight regardless of application clock', async () => {
    const beforeMidnight = 4_104_086_399;
    const afterMidnight = beforeMidnight + 1;
    const beforeDay = String(Math.floor(beforeMidnight / 86400));
    const afterDay = String(Math.floor(afterMidnight / 86400));
    expect(afterDay).not.toBe(beforeDay);

    const skewedAgent = `clock-skew-agent-${randomUUID()}`;
    const skewedUser = `clock-skew-user-${randomUUID()}`;
    const base = {
      agent: skewedAgent,
      userId: skewedUser,
      fingerprint: digest('same-work-across-midnight'),
      ownerToken: randomUUID(),
      attemptId: '0:groq:0',
      reserveCents: 1,
      agentLimitCents: 1,
    };
    const beforeOperation = randomUUID();
    const afterOperation = randomUUID();
    const before = await aiBudgetTestOnly.reserveAtEpoch({ ...base, operationId: beforeOperation }, beforeMidnight);
    const after = await aiBudgetTestOnly.reserveAtEpoch({ ...base, ownerToken: randomUUID(), operationId: afterOperation }, afterMidnight);

    expect(before).toMatchObject({ status: 'reserved', budgetDay: beforeDay });
    expect(after).toMatchObject({ status: 'reserved', budgetDay: afterDay });
    await expect(aiBudgetTestOnly.readAtEpoch('agent', beforeMidnight, skewedUser, skewedAgent)).resolves.toBe(1);
    await expect(aiBudgetTestOnly.readAtEpoch('agent', afterMidnight, skewedUser, skewedAgent)).resolves.toBe(1);

    const prefix = 'ai:{spend-authority}';
    for (const day of [beforeDay, afterDay]) {
      ownedKeys.add(`${prefix}:global:${day}`);
      ownedKeys.add(`${prefix}:user:${digest(skewedUser)}:${day}`);
      ownedKeys.add(`${prefix}:agent:${digest(skewedAgent)}:${digest(skewedUser)}:${day}`);
    }
    for (const operationId of [beforeOperation, afterOperation]) {
      ownedKeys.add(`${prefix}:operation:${digest(operationId)}`);
      ownedKeys.add(`${prefix}:operation:${digest(operationId)}:attempt:${digest('0:groq:0')}`);
    }
  });

  it('atomically clears a proven pre-I/O reservation so the same operation can retry', async () => {
    const retryAgent = `pre-io-agent-${randomUUID()}`;
    const retryUser = `pre-io-user-${randomUUID()}`;
    const operationId = randomUUID();
    const request: AIReservationRequest = {
      agent: retryAgent,
      userId: retryUser,
      operationId,
      fingerprint: digest('pre-io-retry'),
      ownerToken: randomUUID(),
      attemptId: '0:groq:0',
      reserveCents: 3,
      agentLimitCents: 10,
    };
    const prefix = 'ai:{spend-authority}';
    const operationKey = `${prefix}:operation:${digest(operationId)}`;
    const attemptKey = `${operationKey}:attempt:${digest(request.attemptId)}`;
    for (const key of [
      operationKey,
      attemptKey,
      `${prefix}:global:${budgetDay}`,
      `${prefix}:user:${digest(retryUser)}:${budgetDay}`,
      `${prefix}:agent:${digest(retryAgent)}:${digest(retryUser)}:${budgetDay}`,
    ]) ownedKeys.add(key);

    await expect(aiBudgetTestOnly.reserveAtEpoch(request, testEpochSeconds)).resolves.toMatchObject({ status: 'reserved' });
    await expect(abortAIProviderSpendBeforeIO(request)).resolves.toBeUndefined();
    await expect(redis.get(operationKey)).resolves.toBeNull();
    await expect(redis.get(attemptKey)).resolves.toBeNull();
    await expect(aiBudgetTestOnly.readAtEpoch('agent', testEpochSeconds, retryUser, retryAgent)).resolves.toBe(0);

    await expect(aiBudgetTestOnly.reserveAtEpoch({ ...request, ownerToken: randomUUID() }, testEpochSeconds))
      .resolves.toMatchObject({ status: 'reserved' });
  });
});
