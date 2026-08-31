import IORedis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';
import { config } from '../config.js';

export type RedisTransport = 'tcp' | 'legacy-rest';
export const REDIS_COMMAND_CLOSE_TIMEOUT_MS = 5_000;

export interface RedisSetOptions {
  ex?: number;
  px?: number;
  nx?: boolean;
}

export interface RedisSortedSetMember {
  score: number;
  member: string;
}

export interface RedisRangeOptions {
  rev?: boolean;
}

export interface RedisScanResult {
  cursor: number;
  keys: string[];
}

export interface RedisCommandBatch {
  set(key: string, value: string, options?: RedisSetOptions): RedisCommandBatch;
  setex(key: string, ttlSeconds: number, value: string): RedisCommandBatch;
  del(key: string): RedisCommandBatch;
  sadd(key: string, ...members: string[]): RedisCommandBatch;
  srem(key: string, ...members: string[]): RedisCommandBatch;
  scard(key: string): RedisCommandBatch;
  expire(key: string, ttlSeconds: number): RedisCommandBatch;
  incrby(key: string, amount: number): RedisCommandBatch;
  exec(): Promise<unknown[]>;
}

export interface RedisCommandPort {
  readonly transport: RedisTransport;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  incrby(key: string, amount: number): Promise<number>;
  incrbyfloat(key: string, amount: number): Promise<number>;
  decrby(key: string, amount: number): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
  expireat(key: string, unixSeconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  zadd(key: string, value: RedisSortedSetMember): Promise<number>;
  zrange(key: string, start: number, stop: number, options?: RedisRangeOptions): Promise<string[]>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  scard(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string | null>;
  scan(cursor: number | string, options: { match?: string; count?: number }): Promise<RedisScanResult>;
  dbsize(): Promise<number>;
  pipeline(): RedisCommandBatch;
  multi(): RedisCommandBatch;
  close(): Promise<void>;
}

type BatchCommand =
  | { name: 'set'; key: string; value: string; options?: RedisSetOptions }
  | { name: 'setex'; key: string; ttlSeconds: number; value: string }
  | { name: 'del'; key: string }
  | { name: 'sadd'; key: string; members: string[] }
  | { name: 'srem'; key: string; members: string[] }
  | { name: 'scard'; key: string }
  | { name: 'expire'; key: string; ttlSeconds: number }
  | { name: 'incrby'; key: string; amount: number };

interface BatchExecutor {
  executeBatch(commands: BatchCommand[], transactional: boolean): Promise<unknown[]>;
}

class NormalizedCommandBatch implements RedisCommandBatch {
  private readonly commands: BatchCommand[] = [];

  constructor(
    private readonly executor: BatchExecutor,
    private readonly transactional: boolean,
  ) {}

  set(key: string, value: string, options?: RedisSetOptions): RedisCommandBatch {
    assertRawStringInput(value, 'SET');
    this.commands.push({ name: 'set', key, value, options });
    return this;
  }

  setex(key: string, ttlSeconds: number, value: string): RedisCommandBatch {
    assertRawStringInput(value, 'SETEX');
    this.commands.push({ name: 'setex', key, ttlSeconds, value });
    return this;
  }

  del(key: string): RedisCommandBatch {
    this.commands.push({ name: 'del', key });
    return this;
  }

  sadd(key: string, ...members: string[]): RedisCommandBatch {
    this.commands.push({ name: 'sadd', key, members });
    return this;
  }

  srem(key: string, ...members: string[]): RedisCommandBatch {
    this.commands.push({ name: 'srem', key, members });
    return this;
  }

  scard(key: string): RedisCommandBatch {
    this.commands.push({ name: 'scard', key });
    return this;
  }

  expire(key: string, ttlSeconds: number): RedisCommandBatch {
    this.commands.push({ name: 'expire', key, ttlSeconds });
    return this;
  }

  incrby(key: string, amount: number): RedisCommandBatch {
    this.commands.push({ name: 'incrby', key, amount });
    return this;
  }

  exec(): Promise<unknown[]> {
    return this.executor.executeBatch(this.commands, this.transactional);
  }
}

interface NativeBatch {
  set(...args: unknown[]): NativeBatch;
  setex(key: string, ttlSeconds: number, value: string): NativeBatch;
  del(key: string): NativeBatch;
  sadd(key: string, ...members: string[]): NativeBatch;
  srem(key: string, ...members: string[]): NativeBatch;
  scard(key: string): NativeBatch;
  expire(key: string, ttlSeconds: number): NativeBatch;
  incrby(key: string, amount: number): NativeBatch;
  exec(): Promise<unknown>;
}

interface NativeRedis {
  get(key: string): Promise<unknown>;
  set(...args: unknown[]): Promise<unknown>;
  setex(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  exists(key: string): Promise<unknown>;
  incr(key: string): Promise<unknown>;
  incrby(key: string, amount: number): Promise<unknown>;
  incrbyfloat(key: string, amount: number): Promise<unknown>;
  decrby(key: string, amount: number): Promise<unknown>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  expireat(key: string, unixSeconds: number): Promise<unknown>;
  ttl(key: string): Promise<unknown>;
  eval(...args: unknown[]): Promise<unknown>;
  zadd(...args: unknown[]): Promise<unknown>;
  zrange(...args: unknown[]): Promise<unknown>;
  zrevrange?(key: string, start: number, stop: number): Promise<unknown>;
  smembers(key: string): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  scard(key: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  rpush(key: string, ...values: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  scan(...args: unknown[]): Promise<unknown>;
  dbsize(): Promise<unknown>;
  pipeline(): NativeBatch;
  multi(): NativeBatch;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error('REDIS_COMMAND_RESULT_INVALID_NUMBER');
  return parsed;
}

function assertRawStringInput(value: unknown, command: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`REDIS_${command}_VALUE_MUST_BE_STRING`);
  }
}

function nullableString(value: unknown, command: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`REDIS_${command}_RESULT_INVALID_STRING`);
  }
  return value;
}

function stringArray(value: unknown, command: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`REDIS_${command}_RESULT_INVALID_STRING_ARRAY`);
  }
  return value;
}

function normalizeBatchResults(
  value: unknown,
  expectedCount: number,
  tcp: boolean,
): unknown[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error('REDIS_BATCH_RESULT_INVALID');
  }
  if (!tcp) return value;

  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error('REDIS_BATCH_RESULT_INVALID');
    }
    const [error, result] = entry;
    if (error !== null) {
      if (error instanceof Error) throw error;
      throw new Error('REDIS_BATCH_RESULT_INVALID');
    }
    return result;
  });
}

function applyBatchCommand(batch: NativeBatch, command: BatchCommand, tcp: boolean): void {
  switch (command.name) {
    case 'set': {
      if (tcp) {
        const args: unknown[] = [command.key, command.value];
        if (command.options?.ex !== undefined) args.push('EX', command.options.ex);
        if (command.options?.px !== undefined) args.push('PX', command.options.px);
        if (command.options?.nx) args.push('NX');
        batch.set(...args);
      } else if (command.options) {
        batch.set(command.key, command.value, command.options);
      } else {
        batch.set(command.key, command.value);
      }
      break;
    }
    case 'setex':
      batch.setex(command.key, command.ttlSeconds, command.value);
      break;
    case 'del':
      batch.del(command.key);
      break;
    case 'sadd':
      batch.sadd(command.key, ...command.members);
      break;
    case 'srem':
      batch.srem(command.key, ...command.members);
      break;
    case 'scard':
      batch.scard(command.key);
      break;
    case 'expire':
      batch.expire(command.key, command.ttlSeconds);
      break;
    case 'incrby':
      batch.incrby(command.key, command.amount);
      break;
  }
}

abstract class BaseRedisCommandPort implements RedisCommandPort, BatchExecutor {
  abstract readonly transport: RedisTransport;

  constructor(protected readonly native: NativeRedis) {}

  async get(key: string): Promise<string | null> {
    return nullableString(await this.native.get(key), 'GET');
  }

  abstract set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;

  async setex(key: string, ttlSeconds: number, value: string): Promise<string | null> {
    assertRawStringInput(value, 'SETEX');
    return nullableString(await this.native.setex(key, ttlSeconds, value), 'SETEX');
  }

  async del(...keys: string[]): Promise<number> {
    return numeric(await this.native.del(...keys));
  }

  async exists(key: string): Promise<number> {
    return numeric(await this.native.exists(key));
  }

  async incr(key: string): Promise<number> {
    return numeric(await this.native.incr(key));
  }

  async incrby(key: string, amount: number): Promise<number> {
    return numeric(await this.native.incrby(key, amount));
  }

  async incrbyfloat(key: string, amount: number): Promise<number> {
    return numeric(await this.native.incrbyfloat(key, amount));
  }

  async decrby(key: string, amount: number): Promise<number> {
    return numeric(await this.native.decrby(key, amount));
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    return numeric(await this.native.expire(key, ttlSeconds));
  }

  async expireat(key: string, unixSeconds: number): Promise<number> {
    return numeric(await this.native.expireat(key, unixSeconds));
  }

  async ttl(key: string): Promise<number> {
    return numeric(await this.native.ttl(key));
  }

  abstract eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  abstract zadd(key: string, value: RedisSortedSetMember): Promise<number>;
  abstract zrange(
    key: string,
    start: number,
    stop: number,
    options?: RedisRangeOptions,
  ): Promise<string[]>;

  async smembers(key: string): Promise<string[]> {
    return stringArray(await this.native.smembers(key), 'SMEMBERS');
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return numeric(await this.native.sadd(key, ...members));
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return numeric(await this.native.srem(key, ...members));
  }

  async scard(key: string): Promise<number> {
    return numeric(await this.native.scard(key));
  }

  async publish(channel: string, message: string): Promise<number> {
    return numeric(await this.native.publish(channel, message));
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return numeric(await this.native.rpush(key, ...values));
  }

  async ltrim(key: string, start: number, stop: number): Promise<string | null> {
    return nullableString(await this.native.ltrim(key, start, stop), 'LTRIM');
  }

  abstract scan(
    cursor: number | string,
    options: { match?: string; count?: number },
  ): Promise<RedisScanResult>;

  async dbsize(): Promise<number> {
    return numeric(await this.native.dbsize());
  }

  pipeline(): RedisCommandBatch {
    return new NormalizedCommandBatch(this, false);
  }

  multi(): RedisCommandBatch {
    return new NormalizedCommandBatch(this, true);
  }

  async executeBatch(commands: BatchCommand[], transactional: boolean): Promise<unknown[]> {
    const batch = transactional ? this.native.multi() : this.native.pipeline();
    for (const command of commands) applyBatchCommand(batch, command, this.transport === 'tcp');
    return normalizeBatchResults(
      await batch.exec(),
      commands.length,
      this.transport === 'tcp',
    );
  }

  abstract close(): Promise<void>;
}

class TcpRedisCommandPort extends BaseRedisCommandPort {
  readonly transport = 'tcp' as const;

  async set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    assertRawStringInput(value, 'SET');
    const args: unknown[] = [key, value];
    if (options?.ex !== undefined) args.push('EX', options.ex);
    if (options?.px !== undefined) args.push('PX', options.px);
    if (options?.nx) args.push('NX');
    return nullableString(await this.native.set(...args), 'SET');
  }

  eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.native.eval(script, keys.length, ...keys, ...args);
  }

  async zadd(key: string, value: RedisSortedSetMember): Promise<number> {
    return numeric(await this.native.zadd(key, value.score, value.member));
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    options?: RedisRangeOptions,
  ): Promise<string[]> {
    if (options?.rev) {
      if (!this.native.zrevrange) throw new Error('REDIS_ZREVRANGE_UNAVAILABLE');
      return stringArray(await this.native.zrevrange(key, start, stop), 'ZREVRANGE');
    }
    return stringArray(await this.native.zrange(key, start, stop), 'ZRANGE');
  }

  async scan(
    cursor: number | string,
    options: { match?: string; count?: number },
  ): Promise<RedisScanResult> {
    const args: unknown[] = [String(cursor)];
    if (options.match) args.push('MATCH', options.match);
    if (options.count !== undefined) args.push('COUNT', options.count);
    const result = await this.native.scan(...args);
    if (!Array.isArray(result) || result.length !== 2) {
      throw new Error('REDIS_SCAN_RESULT_INVALID');
    }
    return { cursor: numeric(result[0]), keys: stringArray(result[1], 'SCAN') };
  }

  async close(): Promise<void> {
    if (this.native.quit) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(
            `REDIS_COMMAND_CLOSE_TIMEOUT:${REDIS_COMMAND_CLOSE_TIMEOUT_MS}ms`,
          ));
        }, REDIS_COMMAND_CLOSE_TIMEOUT_MS);
        timeout.unref();
      });
      try {
        await Promise.race([this.native.quit(), deadline]);
        return;
      } catch (quitError) {
        try {
          this.native.disconnect?.();
        } catch (disconnectError) {
          throw new AggregateError(
            [quitError, disconnectError],
            'Redis command client failed graceful quit and forced disconnect',
          );
        }
        throw quitError;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    this.native.disconnect?.();
  }
}

class LegacyRestRedisCommandPort extends BaseRedisCommandPort {
  readonly transport = 'legacy-rest' as const;

  async set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    assertRawStringInput(value, 'SET');
    const result = options
      ? await this.native.set(key, value, options)
      : await this.native.set(key, value);
    return nullableString(result, 'SET');
  }

  eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.native.eval(script, keys, args);
  }

  async zadd(key: string, value: RedisSortedSetMember): Promise<number> {
    return numeric(await this.native.zadd(key, value));
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    options?: RedisRangeOptions,
  ): Promise<string[]> {
    const result = options?.rev
      ? await this.native.zrange(key, start, stop, { rev: true })
      : await this.native.zrange(key, start, stop);
    return stringArray(result, options?.rev ? 'ZREVRANGE' : 'ZRANGE');
  }

  async scan(
    cursor: number | string,
    options: { match?: string; count?: number },
  ): Promise<RedisScanResult> {
    const result = await this.native.scan(cursor, options);
    if (Array.isArray(result) && result.length === 2) {
      return { cursor: numeric(result[0]), keys: stringArray(result[1], 'SCAN') };
    }
    if (result && typeof result === 'object') {
      const record = result as { cursor?: unknown; keys?: unknown };
      return { cursor: numeric(record.cursor), keys: stringArray(record.keys, 'SCAN') };
    }
    throw new Error('REDIS_SCAN_RESULT_INVALID');
  }

  async close(): Promise<void> {
    // The REST client owns no persistent TCP socket.
  }
}

let commandClient: RedisCommandPort | null | undefined;

/**
 * Return the shared normalized Redis command client.
 *
 * REDIS_URL is authoritative whenever it is present. The explicit legacy REST
 * pair selects an alternate only when TCP is not configured, so it cannot
 * override the portable transport. Commands never fail over between Redis
 * services at runtime because that could split counters, locks, and windows.
 */
export function getRedisCommandClient(): RedisCommandPort | null {
  if (commandClient !== undefined) return commandClient;

  if (config.redis.url) {
    const redisUrl = config.redis.url;
    const native = new IORedis(redisUrl, {
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 1,
      ...(redisUrl.startsWith('rediss://') ? { tls: {} } : {}),
    }) as unknown as NativeRedis;
    commandClient = new TcpRedisCommandPort(native);
    return commandClient;
  }

  if (config.redis.restUrl && config.redis.restToken) {
    const native = new UpstashRedis({
      url: config.redis.restUrl,
      token: config.redis.restToken,
      automaticDeserialization: false,
    }) as unknown as NativeRedis;
    commandClient = new LegacyRestRedisCommandPort(native);
    return commandClient;
  }

  commandClient = null;
  return commandClient;
}

export async function closeRedisCommandClient(): Promise<void> {
  if (commandClient) await commandClient.close();
  commandClient = undefined;
}

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local member = ARGV[1]
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local server_time = redis.call('TIME')
local now = (tonumber(server_time[1]) * 1000) + math.floor(tonumber(server_time[2]) / 1000)
local cutoff = now - window

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)
local allowed = 0
local existing = redis.call('ZSCORE', key, member)
if existing then
  allowed = 1
elseif count < limit then
  local added = redis.call('ZADD', key, 'NX', now, member)
  if added == 1 then
    count = count + 1
    allowed = 1
  end
end
redis.call('PEXPIRE', key, window)

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local reset = now + window
if oldest[2] then
  reset = tonumber(oldest[2]) + window
end
return { allowed, math.max(limit - count, 0), reset }
`;

export interface SlidingWindowRequest {
  key: string;
  limit: number;
  windowMs: number;
  member: string;
}

export interface SlidingWindowResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

/** Execute one atomic, transport-neutral Redis sliding-window decision. */
export async function takeSlidingWindow(
  client: RedisCommandPort,
  request: SlidingWindowRequest,
): Promise<SlidingWindowResult> {
  if (
    !request.key.trim()
    || !request.member.trim()
    || !Number.isSafeInteger(request.limit)
    || request.limit <= 0
    || !Number.isSafeInteger(request.windowMs)
    || request.windowMs <= 0
  ) {
    throw new Error('REDIS_RATE_LIMIT_INVALID');
  }

  const raw = await client.eval(
    SLIDING_WINDOW_LUA,
    [request.key],
    [
      request.member,
      String(request.limit),
      String(request.windowMs),
    ],
  );
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error('REDIS_RATE_LIMIT_RESULT_INVALID');
  }
  return {
    allowed: numeric(raw[0]) === 1,
    limit: request.limit,
    remaining: numeric(raw[1]),
    resetAt: numeric(raw[2]),
  };
}
