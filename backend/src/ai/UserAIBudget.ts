/**
 * Atomic AI spend authority.
 *
 * Every possible provider request reserves its worst-case cost before provider
 * I/O. The three daily counters deliberately include both settled spend and
 * unresolved reservations. Unknown provider outcomes keep their reservation;
 * only a proven no-I/O outcome may release it.
 */

import { createHash } from 'node:crypto';
import { getRedisCommandClient, type RedisCommandPort } from '../redis/RedisCommandPort.js';

export const USER_DAILY_CEILING_CENTS = 500; // $5.00
export const GLOBAL_DAILY_CEILING_CENTS = 50000; // $500.00

const OPERATION_TTL_SECONDS = 30 * 24 * 60 * 60;
const COUNTER_TTL_GRACE_SECONDS = 60 * 60;
const REDIS_PREFIX = 'ai:{spend-authority}';

let redis: RedisCommandPort | null = null;

function getRedis(): RedisCommandPort {
  if (!redis) {
    redis = getRedisCommandClient();
    if (!redis) throw new Error('AI_BUDGET_REDIS_UNAVAILABLE');
  }
  return redis;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSafeInteger(value: number, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`AI_BUDGET_INVALID_${field.toUpperCase()}`);
  }
}

function assertReservationRequest(input: AIReservationRequest): void {
  for (const [field, value] of Object.entries({
    agent: input.agent,
    user_id: input.userId,
    operation_id: input.operationId,
    fingerprint: input.fingerprint,
    owner_token: input.ownerToken,
    attempt_id: input.attemptId,
  })) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
      throw new Error(`AI_BUDGET_INVALID_${field.toUpperCase()}`);
    }
  }
  assertSafeInteger(input.reserveCents, 'reserve_cents', 1);
  assertSafeInteger(input.agentLimitCents, 'agent_limit_cents', 1);
}

function keysFor(input: Pick<AIReservationRequest, 'operationId' | 'attemptId'>) {
  // One hash tag keeps every key used by Lua in the same Redis Cluster slot.
  const operation = digest(input.operationId);
  const attempt = digest(input.attemptId);
  return {
    operation: `${REDIS_PREFIX}:operation:${operation}`,
    attempt: `${REDIS_PREFIX}:operation:${operation}:attempt:${attempt}`,
  };
}

const RESERVE_LUA = `
local operation_key = KEYS[1]
local attempt_key = KEYS[2]

local amount = tonumber(ARGV[1])
local global_limit = tonumber(ARGV[2])
local user_limit = tonumber(ARGV[3])
local agent_limit = tonumber(ARGV[4])
local operation_ttl = tonumber(ARGV[5])
local counter_ttl_grace = tonumber(ARGV[6])
local fingerprint = ARGV[7]
local owner = ARGV[8]
local user_digest = ARGV[9]
local agent_digest = ARGV[10]
local test_epoch = ARGV[11]

-- Redis TIME, not an application host clock, owns the UTC budget boundary.
-- The optional epoch is reachable only through the NODE_ENV=test-only wrapper.
local time = redis.call('TIME')
local epoch_seconds = tonumber(time[1])
if test_epoch ~= '' then
  epoch_seconds = tonumber(test_epoch)
  if not epoch_seconds then return {'INVALID_TEST_EPOCH'} end
end
local day = tostring(math.floor(epoch_seconds / 86400))
local counter_ttl = math.floor(((tonumber(day) + 1) * 86400) - epoch_seconds) + counter_ttl_grace
if counter_ttl < 1 then return {'INVALID_COUNTER_TTL'} end

local prefix = 'ai:{spend-authority}'
local global_key = prefix .. ':global:' .. day
local user_key = prefix .. ':user:' .. user_digest .. ':' .. day
local agent_key = prefix .. ':agent:' .. agent_digest .. ':' .. user_digest .. ':' .. day

local operation_raw = redis.call('GET', operation_key)
local operation = nil
if operation_raw then
  local ok, decoded = pcall(cjson.decode, operation_raw)
  if not ok or type(decoded) ~= 'table' then
    return {'CORRUPT'}
  end
  operation = decoded
  if operation.fingerprint ~= fingerprint then
    return {'CONFLICT'}
  end
  if operation.state == 'completed' then
    return {'COMPLETED', cjson.encode(operation.result)}
  end
  if operation.state == 'failed' then
    return {'FAILED', tostring(operation.error or 'AI operation failed')}
  end
  if operation.owner ~= owner then
    return {'IN_PROGRESS'}
  end
end

if redis.call('EXISTS', attempt_key) == 1 then
  return {'ATTEMPT_EXISTS'}
end

local global_spent = tonumber(redis.call('GET', global_key) or '0')
local user_spent = tonumber(redis.call('GET', user_key) or '0')
local agent_spent = tonumber(redis.call('GET', agent_key) or '0')
if global_spent + amount > global_limit then
  return {'LIMIT', 'global', tostring(global_spent), tostring(global_limit)}
end
if user_spent + amount > user_limit then
  return {'LIMIT', 'user', tostring(user_spent), tostring(user_limit)}
end
if agent_spent + amount > agent_limit then
  return {'LIMIT', 'agent', tostring(agent_spent), tostring(agent_limit)}
end

if not operation then
  redis.call('SET', operation_key, cjson.encode({
    fingerprint = fingerprint,
    owner = owner,
    state = 'in_progress'
  }), 'EX', operation_ttl)
end
redis.call('INCRBY', global_key, amount)
redis.call('INCRBY', user_key, amount)
redis.call('INCRBY', agent_key, amount)
redis.call('EXPIRE', global_key, counter_ttl)
redis.call('EXPIRE', user_key, counter_ttl)
redis.call('EXPIRE', agent_key, counter_ttl)
redis.call('SET', attempt_key, cjson.encode({
  state = 'reserved',
  amount = amount,
  day = day
}), 'EX', operation_ttl)
redis.call('EXPIRE', operation_key, operation_ttl)
return {'RESERVED', tostring(amount), day, tostring(counter_ttl)}
`;

const SETTLE_LUA = `
local operation_key = KEYS[1]
local attempt_key = KEYS[2]
local actual = tonumber(ARGV[1])
local fingerprint = ARGV[2]
local owner = ARGV[3]
local completed_json = ARGV[4]
local operation_ttl = tonumber(ARGV[5])
local user_digest = ARGV[6]
local agent_digest = ARGV[7]

local operation_raw = redis.call('GET', operation_key)
if not operation_raw then return {'MISSING_OPERATION'} end
local ok, operation = pcall(cjson.decode, operation_raw)
if not ok or type(operation) ~= 'table' then return {'CORRUPT'} end
if operation.fingerprint ~= fingerprint then return {'CONFLICT'} end
if operation.state == 'completed' then return {'COMPLETED'} end
if operation.owner ~= owner then return {'OWNER_MISMATCH'} end

local attempt_raw = redis.call('GET', attempt_key)
if not attempt_raw then return {'MISSING_ATTEMPT'} end
local attempt_ok, attempt = pcall(cjson.decode, attempt_raw)
if not attempt_ok or type(attempt) ~= 'table' or attempt.state ~= 'reserved' then return {'INVALID_ATTEMPT_STATE'} end
local reserved = tonumber(attempt.amount)
local day = tostring(attempt.day or '')
if not reserved or not string.match(day, '^%d+$') then return {'INVALID_ATTEMPT_STATE'} end
if actual > reserved then return {'ACTUAL_EXCEEDS_RESERVATION'} end

local prefix = 'ai:{spend-authority}'
local global_key = prefix .. ':global:' .. day
local user_key = prefix .. ':user:' .. user_digest .. ':' .. day
local agent_key = prefix .. ':agent:' .. agent_digest .. ':' .. user_digest .. ':' .. day

local refund = reserved - actual
if refund > 0 then
  if tonumber(redis.call('GET', global_key) or '0') < refund or
     tonumber(redis.call('GET', user_key) or '0') < refund or
     tonumber(redis.call('GET', agent_key) or '0') < refund then
    return {'COUNTER_CORRUPT'}
  end
  redis.call('DECRBY', global_key, refund)
  redis.call('DECRBY', user_key, refund)
  redis.call('DECRBY', agent_key, refund)
end
redis.call('SET', attempt_key, cjson.encode({ state = 'settled', amount = actual, day = day }), 'EX', operation_ttl)
redis.call('SET', operation_key, completed_json, 'EX', operation_ttl)
return {'SETTLED', tostring(refund), day}
`;

const MARK_UNKNOWN_LUA = `
local operation_key = KEYS[1]
local attempt_key = KEYS[2]
local fingerprint = ARGV[1]
local owner = ARGV[2]
local operation_ttl = tonumber(ARGV[3])
local operation_raw = redis.call('GET', operation_key)
if not operation_raw then return {'MISSING_OPERATION'} end
local ok, operation = pcall(cjson.decode, operation_raw)
if not ok or type(operation) ~= 'table' then return {'CORRUPT'} end
if operation.fingerprint ~= fingerprint then return {'CONFLICT'} end
if operation.owner ~= owner then return {'OWNER_MISMATCH'} end
local attempt_raw = redis.call('GET', attempt_key)
if not attempt_raw then return {'MISSING_ATTEMPT'} end
local attempt_ok, attempt = pcall(cjson.decode, attempt_raw)
if not attempt_ok or type(attempt) ~= 'table' then return {'INVALID_ATTEMPT_STATE'} end
local amount = tonumber(attempt.amount)
local day = tostring(attempt.day or '')
if not amount or not string.match(day, '^%d+$') then return {'INVALID_ATTEMPT_STATE'} end
if attempt.state == 'unknown' then return {'MARKED_UNKNOWN', day} end
if attempt.state ~= 'reserved' then return {'INVALID_ATTEMPT_STATE'} end
redis.call('SET', attempt_key, cjson.encode({ state = 'unknown', amount = amount, day = day }), 'EX', operation_ttl)
redis.call('EXPIRE', operation_key, operation_ttl)
return {'MARKED_UNKNOWN', day}
`;

const RELEASE_LUA = `
local operation_key = KEYS[1]
local attempt_key = KEYS[2]
local fingerprint = ARGV[1]
local owner = ARGV[2]
local operation_ttl = tonumber(ARGV[3])
local user_digest = ARGV[4]
local agent_digest = ARGV[5]
local operation_raw = redis.call('GET', operation_key)
if not operation_raw then return {'MISSING_OPERATION'} end
local ok, operation = pcall(cjson.decode, operation_raw)
if not ok or type(operation) ~= 'table' then return {'CORRUPT'} end
if operation.fingerprint ~= fingerprint then return {'CONFLICT'} end
if operation.owner ~= owner then return {'OWNER_MISMATCH'} end
local attempt_raw = redis.call('GET', attempt_key)
if not attempt_raw then return {'MISSING_ATTEMPT'} end
local attempt_ok, attempt = pcall(cjson.decode, attempt_raw)
if not attempt_ok or type(attempt) ~= 'table' then return {'INVALID_ATTEMPT_STATE'} end
local amount = tonumber(attempt.amount)
local day = tostring(attempt.day or '')
if not amount or not string.match(day, '^%d+$') then return {'INVALID_ATTEMPT_STATE'} end
if attempt.state == 'released' then return {'RELEASED', day} end
if attempt.state ~= 'reserved' then return {'INVALID_ATTEMPT_STATE'} end
local prefix = 'ai:{spend-authority}'
local global_key = prefix .. ':global:' .. day
local user_key = prefix .. ':user:' .. user_digest .. ':' .. day
local agent_key = prefix .. ':agent:' .. agent_digest .. ':' .. user_digest .. ':' .. day
if tonumber(redis.call('GET', global_key) or '0') < amount or
   tonumber(redis.call('GET', user_key) or '0') < amount or
   tonumber(redis.call('GET', agent_key) or '0') < amount then
  return {'COUNTER_CORRUPT'}
end
redis.call('DECRBY', global_key, amount)
redis.call('DECRBY', user_key, amount)
redis.call('DECRBY', agent_key, amount)
redis.call('SET', attempt_key, cjson.encode({ state = 'released', amount = amount, day = day }), 'EX', operation_ttl)
redis.call('EXPIRE', operation_key, operation_ttl)
return {'RELEASED', day}
`;

// Used only when durable RESERVED persistence failed before provider I/O.
// Counter rollback and operation/attempt removal are one same-slot atomic
// action, so the operation cannot remain poisoned as in_progress for 30 days.
const ABORT_PRE_IO_LUA = `
local operation_key = KEYS[1]
local attempt_key = KEYS[2]
local fingerprint = ARGV[1]
local owner = ARGV[2]
local user_digest = ARGV[3]
local agent_digest = ARGV[4]
local operation_raw = redis.call('GET', operation_key)
if not operation_raw then return {'MISSING_OPERATION'} end
local ok, operation = pcall(cjson.decode, operation_raw)
if not ok or type(operation) ~= 'table' then return {'CORRUPT'} end
if operation.fingerprint ~= fingerprint then return {'CONFLICT'} end
if operation.owner ~= owner then return {'OWNER_MISMATCH'} end
if operation.state ~= 'in_progress' then return {'INVALID_OPERATION_STATE'} end
local attempt_raw = redis.call('GET', attempt_key)
if not attempt_raw then return {'MISSING_ATTEMPT'} end
local attempt_ok, attempt = pcall(cjson.decode, attempt_raw)
if not attempt_ok or type(attempt) ~= 'table' or attempt.state ~= 'reserved' then
  return {'INVALID_ATTEMPT_STATE'}
end
local amount = tonumber(attempt.amount)
local day = tostring(attempt.day or '')
if not amount or not string.match(day, '^%d+$') then return {'INVALID_ATTEMPT_STATE'} end
local prefix = 'ai:{spend-authority}'
local global_key = prefix .. ':global:' .. day
local user_key = prefix .. ':user:' .. user_digest .. ':' .. day
local agent_key = prefix .. ':agent:' .. agent_digest .. ':' .. user_digest .. ':' .. day
if tonumber(redis.call('GET', global_key) or '0') < amount or
   tonumber(redis.call('GET', user_key) or '0') < amount or
   tonumber(redis.call('GET', agent_key) or '0') < amount then
  return {'COUNTER_CORRUPT'}
end
redis.call('DECRBY', global_key, amount)
redis.call('DECRBY', user_key, amount)
redis.call('DECRBY', agent_key, amount)
redis.call('DEL', attempt_key)
redis.call('DEL', operation_key)
return {'ABORTED', day}
`;

const READ_SPEND_LUA = `
local kind = ARGV[1]
local user_digest = ARGV[2]
local agent_digest = ARGV[3]
local test_epoch = ARGV[4]
local time = redis.call('TIME')
local epoch_seconds = tonumber(time[1])
if test_epoch ~= '' then
  epoch_seconds = tonumber(test_epoch)
  if not epoch_seconds then return {'INVALID_TEST_EPOCH'} end
end
local day = tostring(math.floor(epoch_seconds / 86400))
local prefix = 'ai:{spend-authority}'
local key = nil
if kind == 'global' then
  key = prefix .. ':global:' .. day
elseif kind == 'user' then
  key = prefix .. ':user:' .. user_digest .. ':' .. day
elseif kind == 'agent' then
  key = prefix .. ':agent:' .. agent_digest .. ':' .. user_digest .. ':' .. day
else
  return {'INVALID_KIND'}
end
return {'SPEND', tostring(redis.call('GET', key) or '0'), day}
`;

const FAIL_OPERATION_LUA = `
local operation_key = KEYS[1]
local fingerprint = ARGV[1]
local owner = ARGV[2]
local failed_json = ARGV[3]
local operation_ttl = tonumber(ARGV[4])
local operation_raw = redis.call('GET', operation_key)
if not operation_raw then return {'MISSING_OPERATION'} end
local ok, operation = pcall(cjson.decode, operation_raw)
if not ok or type(operation) ~= 'table' then return {'CORRUPT'} end
if operation.fingerprint ~= fingerprint then return {'CONFLICT'} end
if operation.state == 'completed' then return {'COMPLETED'} end
if operation.owner ~= owner then return {'OWNER_MISMATCH'} end
redis.call('SET', operation_key, failed_json, 'EX', operation_ttl)
return {'FAILED'}
`;

export interface AIReservationRequest {
  agent: string;
  userId: string;
  operationId: string;
  fingerprint: string;
  ownerToken: string;
  attemptId: string;
  reserveCents: number;
  agentLimitCents: number;
}

export type AIReservationResult =
  | { status: 'reserved'; reservedCents: number; budgetDay: string }
  | { status: 'completed'; resultJson: string }
  | { status: 'failed'; message: string }
  | { status: 'in_progress' }
  | { status: 'conflict' }
  | { status: 'limit'; scope: 'global' | 'user' | 'agent'; spent: number; limit: number };

function evalResult(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('AI_BUDGET_INVALID_REDIS_RESULT');
  return value.map((part) => String(part));
}

async function reserveAIProviderSpendInternal(
  input: AIReservationRequest,
  testEpochSeconds = '',
): Promise<AIReservationResult> {
  assertReservationRequest(input);
  const keys = keysFor(input);
  const result = evalResult(await getRedis().eval(
    RESERVE_LUA,
    [keys.operation, keys.attempt],
    [
      String(input.reserveCents),
      String(GLOBAL_DAILY_CEILING_CENTS),
      String(USER_DAILY_CEILING_CENTS),
      String(input.agentLimitCents),
      String(OPERATION_TTL_SECONDS),
      String(COUNTER_TTL_GRACE_SECONDS),
      input.fingerprint,
      input.ownerToken,
      digest(input.userId),
      digest(input.agent),
      testEpochSeconds,
    ],
  ));

  switch (result[0]) {
    case 'RESERVED': {
      const reservedCents = Number(result[1]);
      if (!Number.isSafeInteger(reservedCents) || reservedCents !== input.reserveCents) {
        throw new Error('AI_BUDGET_INVALID_RESERVED_AMOUNT');
      }
      const budgetDay = result[2];
      if (!/^\d+$/u.test(budgetDay ?? '')) throw new Error('AI_BUDGET_INVALID_SERVER_DAY');
      return { status: 'reserved', reservedCents, budgetDay };
    }
    case 'COMPLETED': return { status: 'completed', resultJson: result[1] };
    case 'FAILED': return { status: 'failed', message: result[1] };
    case 'IN_PROGRESS': return { status: 'in_progress' };
    case 'CONFLICT': return { status: 'conflict' };
    case 'LIMIT': {
      const scope = result[1];
      if (scope !== 'global' && scope !== 'user' && scope !== 'agent') throw new Error('AI_BUDGET_INVALID_LIMIT_SCOPE');
      return { status: 'limit', scope, spent: Number(result[2]), limit: Number(result[3]) };
    }
    default: throw new Error(`AI_BUDGET_RESERVATION_REJECTED:${result[0]}`);
  }
}

export async function reserveAIProviderSpend(input: AIReservationRequest): Promise<AIReservationResult> {
  return reserveAIProviderSpendInternal(input);
}

export interface AIReservationMutation extends AIReservationRequest {
  actualCostCents?: number;
  resultJson?: string;
}

export async function settleAIProviderSpend(input: AIReservationMutation): Promise<void> {
  assertReservationRequest(input);
  if (input.actualCostCents === undefined || input.resultJson === undefined) throw new Error('AI_BUDGET_SETTLEMENT_INPUT_MISSING');
  assertSafeInteger(input.actualCostCents, 'actual_cost_cents');
  if (input.actualCostCents > input.reserveCents) throw new Error('AI_BUDGET_ACTUAL_EXCEEDS_RESERVATION');
  const keys = keysFor(input);
  const completed = JSON.stringify({
    fingerprint: input.fingerprint,
    owner: input.ownerToken,
    state: 'completed',
    result: JSON.parse(input.resultJson) as unknown,
  });
  const result = evalResult(await getRedis().eval(
    SETTLE_LUA,
    [keys.operation, keys.attempt],
    [
      String(input.actualCostCents), input.fingerprint, input.ownerToken, completed,
      String(OPERATION_TTL_SECONDS), digest(input.userId), digest(input.agent),
    ],
  ));
  if (result[0] !== 'SETTLED' && result[0] !== 'COMPLETED') throw new Error(`AI_BUDGET_SETTLEMENT_REJECTED:${result[0]}`);
}

export async function markAIProviderSpendUnknown(input: AIReservationRequest): Promise<void> {
  assertReservationRequest(input);
  const keys = keysFor(input);
  const result = evalResult(await getRedis().eval(
    MARK_UNKNOWN_LUA,
    [keys.operation, keys.attempt],
    [input.fingerprint, input.ownerToken, String(OPERATION_TTL_SECONDS)],
  ));
  if (result[0] !== 'MARKED_UNKNOWN') throw new Error(`AI_BUDGET_UNKNOWN_MARK_REJECTED:${result[0]}`);
}

export async function releaseAIProviderSpend(input: AIReservationRequest): Promise<void> {
  assertReservationRequest(input);
  const keys = keysFor(input);
  const result = evalResult(await getRedis().eval(
    RELEASE_LUA,
    [keys.operation, keys.attempt],
    [input.fingerprint, input.ownerToken, String(OPERATION_TTL_SECONDS), digest(input.userId), digest(input.agent)],
  ));
  if (result[0] !== 'RELEASED') throw new Error(`AI_BUDGET_RELEASE_REJECTED:${result[0]}`);
}

export async function abortAIProviderSpendBeforeIO(input: AIReservationRequest): Promise<void> {
  assertReservationRequest(input);
  const keys = keysFor(input);
  const result = evalResult(await getRedis().eval(
    ABORT_PRE_IO_LUA,
    [keys.operation, keys.attempt],
    [input.fingerprint, input.ownerToken, digest(input.userId), digest(input.agent)],
  ));
  if (result[0] !== 'ABORTED') throw new Error(`AI_BUDGET_PRE_IO_ABORT_REJECTED:${result[0]}`);
}

export async function failAIOperation(input: AIReservationRequest, message: string): Promise<void> {
  assertReservationRequest(input);
  const keys = keysFor(input);
  const failed = JSON.stringify({
    fingerprint: input.fingerprint,
    owner: input.ownerToken,
    state: 'failed',
    error: message.slice(0, 200),
  });
  const result = evalResult(await getRedis().eval(
    FAIL_OPERATION_LUA,
    [keys.operation],
    [input.fingerprint, input.ownerToken, failed, String(OPERATION_TTL_SECONDS)],
  ));
  if (result[0] !== 'FAILED') throw new Error(`AI_BUDGET_FAILURE_FINALIZE_REJECTED:${result[0]}`);
}

async function readSpend(
  kind: 'global' | 'user' | 'agent',
  userId = '',
  agent = '',
  testEpochSeconds = '',
): Promise<number> {
  const result = evalResult(await getRedis().eval(
    READ_SPEND_LUA,
    [`${REDIS_PREFIX}:clock`],
    [kind, digest(userId), digest(agent), testEpochSeconds],
  ));
  if (result[0] !== 'SPEND') throw new Error(`AI_BUDGET_READ_REJECTED:${result[0]}`);
  const spent = Number(result[1]);
  if (!Number.isSafeInteger(spent) || spent < 0) throw new Error('AI_BUDGET_COUNTER_INVALID');
  return spent;
}

/** Read-only status helper. Dispatch authority comes only from reserveAIProviderSpend. */
export async function checkUserBudget(userId: string): Promise<{ allowed: boolean; spent: number; limit: number }> {
  try {
    const spent = await readSpend('user', userId);
    return { allowed: spent < USER_DAILY_CEILING_CENTS, spent, limit: USER_DAILY_CEILING_CENTS };
  } catch {
    return { allowed: false, spent: 0, limit: USER_DAILY_CEILING_CENTS };
  }
}

/** Read-only status helper. Dispatch authority comes only from reserveAIProviderSpend. */
export async function checkGlobalBudget(): Promise<{ allowed: boolean; spent: number; limit: number }> {
  try {
    const spent = await readSpend('global');
    return { allowed: spent < GLOBAL_DAILY_CEILING_CENTS, spent, limit: GLOBAL_DAILY_CEILING_CENTS };
  } catch {
    return { allowed: false, spent: 0, limit: GLOBAL_DAILY_CEILING_CENTS };
  }
}

/** Read-only per-agent status using the same counter mutated by reservations. */
export async function checkAgentBudget(
  agent: string,
  userId: string,
  limit: number,
): Promise<{ allowed: boolean; spent: number; limit: number }> {
  try {
    assertSafeInteger(limit, 'agent_limit_cents', 1);
    const spent = await readSpend('agent', userId, agent);
    return { allowed: spent < limit, spent, limit };
  } catch {
    return { allowed: false, spent: 0, limit };
  }
}

/** Test-only clock injection. Production callers cannot supply a budget day or TTL. */
export const aiBudgetTestOnly = {
  reserveAtEpoch: async (input: AIReservationRequest, epochSeconds: number): Promise<AIReservationResult> => {
    if (process.env.NODE_ENV !== 'test') throw new Error('AI_BUDGET_TEST_CLOCK_FORBIDDEN');
    assertSafeInteger(epochSeconds, 'test_epoch_seconds');
    return reserveAIProviderSpendInternal(input, String(epochSeconds));
  },
  readAtEpoch: async (
    kind: 'global' | 'user' | 'agent',
    epochSeconds: number,
    userId = '',
    agent = '',
  ): Promise<number> => {
    if (process.env.NODE_ENV !== 'test') throw new Error('AI_BUDGET_TEST_CLOCK_FORBIDDEN');
    assertSafeInteger(epochSeconds, 'test_epoch_seconds');
    return readSpend(kind, userId, agent, String(epochSeconds));
  },
};
