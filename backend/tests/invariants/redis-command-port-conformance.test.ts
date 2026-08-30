import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeRedisCommandClient,
  getRedisCommandClient,
  takeSlidingWindow,
  type RedisCommandPort,
} from '../../src/redis/RedisCommandPort';
import { incrWithTtl } from '../../src/cache/redis';
import { enforceMessageRateLimit } from '../../src/services/MessagingPolicy';

const REQUIRED_REDIS_URL = 'redis://127.0.0.1:16379';
const PORT_METHODS = [
  'get',
  'set',
  'setex',
  'del',
  'exists',
  'incr',
  'incrby',
  'incrbyfloat',
  'decrby',
  'expire',
  'expireat',
  'ttl',
  'eval',
  'zadd',
  'zrange',
  'smembers',
  'sadd',
  'srem',
  'scard',
  'publish',
  'rpush',
  'ltrim',
  'scan',
  'dbsize',
  'pipeline',
  'multi',
  'close',
] as const;
const BATCH_METHODS = [
  'set',
  'setex',
  'del',
  'sadd',
  'srem',
  'scard',
  'expire',
  'incrby',
] as const;

describe.sequential('RedisCommandPort real Redis conformance', () => {
  const namespace = `hx:test:redis-port:${randomUUID()}`;
  const ownedKeys = new Set<string>();
  let redis: RedisCommandPort;

  const key = (suffix: string): string => {
    const value = `${namespace}:${suffix}`;
    ownedKeys.add(value);
    return value;
  };

  beforeAll(() => {
    if (process.env.REDIS_URL !== REQUIRED_REDIS_URL) {
      throw new Error(`REDIS_CONFORMANCE_REQUIRES_EXACT_URL:${REQUIRED_REDIS_URL}`);
    }
    const client = getRedisCommandClient();
    if (!client || client.transport !== 'tcp') {
      throw new Error('REDIS_CONFORMANCE_REQUIRES_TCP_COMMAND_PORT');
    }
    redis = client;
  });

  afterAll(async () => {
    if (redis && ownedKeys.size > 0) await redis.del(...ownedKeys);
    await closeRedisCommandClient();
  });

  it('binds the conformance inventory to all 27 port and 8 batch methods', () => {
    expect(new Set(PORT_METHODS).size).toBe(27);
    expect(new Set(BATCH_METHODS).size).toBe(8);
    for (const method of PORT_METHODS) expect(typeof redis[method]).toBe('function');
    const pipeline = redis.pipeline();
    for (const method of BATCH_METHODS) expect(typeof pipeline[method]).toBe('function');
  });

  it('conforms for raw strings, key state, expiry, and deletion', async () => {
    const primary = key('strings:primary');
    const expiring = key('strings:expiring');
    const second = key('strings:second');

    await expect(redis.set(primary, '{"raw":true}')).resolves.toBe('OK');
    await expect(redis.get(primary)).resolves.toBe('{"raw":true}');
    await expect(redis.exists(primary)).resolves.toBe(1);
    await expect(redis.setex(expiring, 120, 'expires')).resolves.toBe('OK');
    await expect(redis.ttl(expiring)).resolves.toBeGreaterThan(0);
    await expect(redis.expire(primary, 120)).resolves.toBe(1);
    await expect(redis.expireat(primary, Math.floor(Date.now() / 1000) + 120)).resolves.toBe(1);
    await redis.set(second, 'second');
    await expect(redis.del(primary, second)).resolves.toBe(2);
  });

  it('conforms for every numeric command', async () => {
    const counter = key('counter');
    await expect(redis.incr(counter)).resolves.toBe(1);
    await expect(redis.incrby(counter, 4)).resolves.toBe(5);
    await expect(redis.decrby(counter, 2)).resolves.toBe(3);
    await expect(redis.incrbyfloat(counter, 0.5)).resolves.toBe(3.5);
  });

  it('conforms for Lua, sorted sets, sets, pub/sub, and lists', async () => {
    const luaKey = key('lua');
    const sorted = key('sorted');
    const members = key('set');
    const list = key('list');

    await expect(redis.eval("return redis.call('SET', KEYS[1], ARGV[1])", [luaKey], ['lua-value']))
      .resolves.toBe('OK');
    await expect(redis.get(luaKey)).resolves.toBe('lua-value');

    await expect(redis.zadd(sorted, { score: 1, member: 'low' })).resolves.toBe(1);
    await expect(redis.zadd(sorted, { score: 2, member: 'high' })).resolves.toBe(1);
    await expect(redis.zrange(sorted, 0, -1)).resolves.toEqual(['low', 'high']);
    await expect(redis.zrange(sorted, 0, -1, { rev: true })).resolves.toEqual(['high', 'low']);

    await expect(redis.sadd(members, 'a', 'b')).resolves.toBe(2);
    await expect(redis.smembers(members)).resolves.toEqual(expect.arrayContaining(['a', 'b']));
    await expect(redis.scard(members)).resolves.toBe(2);
    await expect(redis.srem(members, 'b')).resolves.toBe(1);

    await expect(redis.publish(`${namespace}:channel`, 'event')).resolves.toBeGreaterThanOrEqual(0);
    await expect(redis.rpush(list, 'one', 'two', 'three')).resolves.toBe(3);
    await expect(redis.ltrim(list, -2, -1)).resolves.toBe('OK');
    await expect(redis.eval("return redis.call('LRANGE', KEYS[1], 0, -1)", [list], []))
      .resolves.toEqual(['two', 'three']);
  });

  it('conforms for SCAN and DBSIZE without touching unowned keys', async () => {
    const scanA = key('scan:a');
    const scanB = key('scan:b');
    await redis.set(scanA, 'a');
    await redis.set(scanB, 'b');

    const found = new Set<string>();
    let cursor = 0;
    do {
      const page = await redis.scan(cursor, { match: `${namespace}:scan:*`, count: 20 });
      cursor = page.cursor;
      for (const redisKey of page.keys) found.add(redisKey);
    } while (cursor !== 0);

    expect(found).toEqual(new Set([scanA, scanB]));
    await expect(redis.dbsize()).resolves.toBeGreaterThanOrEqual(2);
  });

  it.each(['pipeline', 'multi'] as const)(
    'conforms for all 8 normalized batch operations through %s',
    async (kind) => {
      const primary = key(`${kind}:primary`);
      const expiring = key(`${kind}:expiring`);
      const members = key(`${kind}:members`);
      const counter = key(`${kind}:counter`);
      const batch = redis[kind]();

      const results = await batch
        .set(primary, 'value')
        .setex(expiring, 120, 'temporary')
        .sadd(members, 'a', 'b')
        .srem(members, 'b')
        .scard(members)
        .expire(primary, 120)
        .incrby(counter, 2)
        .del(expiring)
        .exec();

      expect(results).toEqual(['OK', 'OK', 2, 1, 1, 1, 2, 1]);
    },
  );

  it('uses Redis server time and treats a duplicate request member idempotently', async () => {
    const rateKey = key('sliding-window');
    const first = await takeSlidingWindow(redis, {
      key: rateKey,
      limit: 1,
      windowMs: 60_000,
      member: 'request-1',
    });
    const duplicate = await takeSlidingWindow(redis, {
      key: rateKey,
      limit: 1,
      windowMs: 60_000,
      member: 'request-1',
    });
    const denied = await takeSlidingWindow(redis, {
      key: rateKey,
      limit: 1,
      windowMs: 60_000,
      member: 'request-2',
    });

    expect(first).toMatchObject({ allowed: true, remaining: 0 });
    expect(duplicate).toMatchObject({ allowed: true, remaining: 0 });
    expect(denied).toMatchObject({ allowed: false, remaining: 0 });
    expect(first.resetAt).toBeGreaterThan(Date.now());
    expect(first.resetAt).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it('atomically permits exactly thirty concurrent messages per conversation window', async () => {
    const senderId = namespace;
    const taskId = 'parallel-message-window';
    ownedKeys.add(`msg_rate:${senderId}:${taskId}`);

    const decisions = await Promise.all(
      Array.from({ length: 40 }, () => enforceMessageRateLimit(senderId, taskId)),
    );
    expect(decisions.filter((decision) => decision.success)).toHaveLength(30);
    expect(decisions.filter((decision) => !decision.success)).toHaveLength(10);
    expect(await redis.ttl(`msg_rate:${senderId}:${taskId}`)).toBeGreaterThan(0);
  });

  it('heals a legacy immortal fixed-window counter without resetting healthy windows', async () => {
    const counter = key('legacy-immortal-rate-counter');
    await redis.set(counter, '4');
    expect(await redis.ttl(counter)).toBe(-1);

    await expect(incrWithTtl(counter, 60)).resolves.toBe(5);
    const establishedTtl = await redis.ttl(counter);
    expect(establishedTtl).toBeGreaterThan(0);

    await expect(incrWithTtl(counter, 60)).resolves.toBe(6);
    expect(await redis.ttl(counter)).toBeLessThanOrEqual(establishedTtl);
  });
});
