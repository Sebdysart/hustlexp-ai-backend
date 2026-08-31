import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {
    redis: {
      url: 'redis://portable:6379',
      restUrl: '',
      restToken: '',
    },
  },
  tcpConstructor: vi.fn(),
  restConstructor: vi.fn(),
  tcp: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn(),
    eval: vi.fn(),
    zadd: vi.fn().mockResolvedValue(1),
    zrange: vi.fn(),
    zrevrange: vi.fn(),
    scan: vi.fn(),
    pipeline: vi.fn(),
    multi: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  },
  rest: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    incrby: vi.fn().mockResolvedValue(2),
    incrbyfloat: vi.fn().mockResolvedValue(2.5),
    decrby: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    expireat: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(60),
    eval: vi.fn(),
    zadd: vi.fn().mockResolvedValue(1),
    zrange: vi.fn().mockResolvedValue([]),
    smembers: vi.fn().mockResolvedValue([]),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    scard: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(0),
    rpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    scan: vi.fn().mockResolvedValue(['0', []]),
    dbsize: vi.fn().mockResolvedValue(0),
    pipeline: vi.fn(),
    multi: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({ config: mocks.config }));
vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));
vi.mock('ioredis', () => ({
  default: function MockIORedis(
    this: Record<string, unknown>,
    url: string,
    options: Record<string, unknown>,
  ) {
    mocks.tcpConstructor(url, options);
    Object.assign(this, mocks.tcp);
  },
}));
vi.mock('@upstash/redis', () => ({
  Redis: function MockUpstashRedis(
    this: Record<string, unknown>,
    options: Record<string, unknown>,
  ) {
    mocks.restConstructor(options);
    Object.assign(this, mocks.rest);
  },
}));

async function importPort() {
  return import('../../src/redis/RedisCommandPort');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.config.redis.url = 'redis://portable:6379';
  mocks.config.redis.restUrl = '';
  mocks.config.redis.restToken = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RedisCommandPort', () => {
  it('uses portable TCP Redis when no explicit legacy REST pair exists', async () => {
    const { getRedisCommandClient } = await importPort();
    const client = getRedisCommandClient();

    expect(client?.transport).toBe('tcp');
    await client?.set('lock:key', 'holder', { ex: 30, nx: true });
    expect(mocks.tcp.set).toHaveBeenCalledWith('lock:key', 'holder', 'EX', 30, 'NX');
  });

  it('gives canonical REDIS_URL precedence over a complete legacy REST pair', async () => {
    mocks.config.redis.restUrl = 'https://explicit-rest.upstash.io';
    mocks.config.redis.restToken = 'explicit-rest-token';
    vi.resetModules();
    const { getRedisCommandClient } = await importPort();

    expect(getRedisCommandClient()?.transport).toBe('tcp');
    expect(mocks.tcpConstructor).toHaveBeenCalledOnce();
    expect(mocks.rest.set).not.toHaveBeenCalled();
  });

  it('enables TLS only for an explicit rediss scheme', async () => {
    mocks.config.redis.url = 'redis://cache.upstash.io:6379';
    vi.resetModules();
    let port = await importPort();
    port.getRedisCommandClient();
    expect(mocks.tcpConstructor.mock.calls[0][1]).not.toHaveProperty('tls');

    mocks.config.redis.url = 'rediss://secure.example.test:6380';
    vi.resetModules();
    port = await importPort();
    port.getRedisCommandClient();
    expect(mocks.tcpConstructor.mock.calls[1][1]).toMatchObject({ tls: {} });
  });

  it('normalizes the portable TCP Lua signature to keys and arguments arrays', async () => {
    mocks.tcp.eval.mockResolvedValue(1);
    const { getRedisCommandClient } = await importPort();
    const result = await getRedisCommandClient()?.eval('return 1', ['lock:key'], ['holder']);

    expect(result).toBe(1);
    expect(mocks.tcp.eval).toHaveBeenCalledWith('return 1', 1, 'lock:key', 'holder');
  });

  it('normalizes sorted-set commands for portable TCP Redis', async () => {
    mocks.tcp.zrange.mockResolvedValue(['oldest']);
    mocks.tcp.zrevrange.mockResolvedValue(['newest']);
    const { getRedisCommandClient } = await importPort();
    const client = getRedisCommandClient();

    await client?.zadd('scores', { score: 42, member: 'provider' });
    await expect(client?.zrange('scores', 0, -1)).resolves.toEqual(['oldest']);
    await expect(client?.zrange('scores', 0, -1, { rev: true })).resolves.toEqual(['newest']);
    expect(mocks.tcp.zadd).toHaveBeenCalledWith('scores', 42, 'provider');
  });

  it('normalizes TCP pipeline results for registry and cache consumers', async () => {
    const batch = {
      setex: vi.fn().mockReturnThis(),
      sadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null, 'OK'], [null, 1], [null, 1]]),
    };
    mocks.tcp.pipeline.mockReturnValue(batch);
    const { getRedisCommandClient } = await importPort();
    const pipeline = getRedisCommandClient()?.pipeline();

    const result = await pipeline
      ?.setex('conn:1', 300, '{"userId":"user-1"}')
      .sadd('conn:user:user-1', 'conn-1')
      .expire('conn:user:user-1', 300)
      .exec();

    expect(result).toEqual(['OK', 1, 1]);
    expect(batch.setex).toHaveBeenCalledWith('conn:1', 300, '{"userId":"user-1"}');
  });

  it('normalizes TCP scan cursor and option arguments', async () => {
    mocks.tcp.scan.mockResolvedValue(['7', ['cache:a', 'cache:b']]);
    const { getRedisCommandClient } = await importPort();
    const result = await getRedisCommandClient()?.scan(0, { match: 'cache:*', count: 100 });

    expect(result).toEqual({ cursor: 7, keys: ['cache:a', 'cache:b'] });
    expect(mocks.tcp.scan).toHaveBeenCalledWith('0', 'MATCH', 'cache:*', 'COUNT', 100);
  });

  it('round-trips structured and scalar cache values through TCP strings', async () => {
    const cache = await import('../../src/cache/redis');

    await cache.set('geocode:addr:object', { status: 'ready' }, 60);
    await cache.set('ai:cache:number', 42, 60);
    expect(mocks.tcp.set).toHaveBeenNthCalledWith(
      1,
      'cache:typed:v1:geocode:addr:object',
      'hx:typed-cache:v1:{"status":"ready"}',
      'EX',
      60,
    );
    expect(mocks.tcp.set).toHaveBeenNthCalledWith(
      2,
      'cache:typed:v1:ai:cache:number',
      'hx:typed-cache:v1:42',
      'EX',
      60,
    );

    mocks.tcp.get.mockResolvedValueOnce('hx:typed-cache:v1:{"status":"ready"}');
    mocks.tcp.get.mockResolvedValueOnce('hx:typed-cache:v1:"literal"');
    await expect(cache.get('geocode:addr:object')).resolves.toEqual({ status: 'ready' });
    await expect(cache.get('ai:cache:string')).resolves.toBe('literal');
  });

  it('uses explicit legacy REST credentials only as a compatibility transport', async () => {
    mocks.config.redis.url = '';
    mocks.config.redis.restUrl = 'https://explicit-rest.upstash.io';
    mocks.config.redis.restToken = 'explicit-rest-token';
    vi.resetModules();
    const { getRedisCommandClient } = await importPort();
    const client = getRedisCommandClient();

    expect(client?.transport).toBe('legacy-rest');
    expect(mocks.restConstructor).toHaveBeenCalledWith({
      url: 'https://explicit-rest.upstash.io',
      token: 'explicit-rest-token',
      automaticDeserialization: false,
    });
    await client?.set('cache:key', 'value', { ex: 60 });
    await client?.eval('return 1', ['cache:key'], ['value']);
    expect(mocks.rest.set).toHaveBeenCalledWith('cache:key', 'value', { ex: 60 });
    expect(mocks.rest.eval).toHaveBeenCalledWith('return 1', ['cache:key'], ['value']);
  });

  it('keeps REST GET raw and rejects a deserialized non-string value', async () => {
    mocks.config.redis.url = '';
    mocks.config.redis.restUrl = 'https://explicit-rest.upstash.io';
    mocks.config.redis.restToken = 'explicit-rest-token';
    mocks.rest.get.mockResolvedValueOnce('{"raw":true}');
    vi.resetModules();
    const { getRedisCommandClient } = await importPort();
    const client = getRedisCommandClient();

    await expect(client?.get('raw:key')).resolves.toBe('{"raw":true}');
    mocks.rest.get.mockResolvedValueOnce({ raw: false });
    await expect(client?.get('invalid:key')).rejects.toThrow('REDIS_GET_RESULT_INVALID_STRING');
  });

  it('rejects non-string raw values before either adapter receives them', async () => {
    const { getRedisCommandClient } = await importPort();
    const client = getRedisCommandClient();
    if (!client) throw new Error('expected TCP client');
    const invalid = { not: 'raw' } as unknown as string;

    await expect(client.set('key', invalid)).rejects.toThrow('REDIS_SET_VALUE_MUST_BE_STRING');
    expect(() => client.pipeline().set('key', invalid)).toThrow('REDIS_SET_VALUE_MUST_BE_STRING');
    expect(mocks.tcp.set).not.toHaveBeenCalled();
  });

  it('normalizes every direct REST command with raw string semantics', async () => {
    mocks.config.redis.url = '';
    mocks.config.redis.restUrl = 'https://explicit-rest.upstash.io';
    mocks.config.redis.restToken = 'explicit-rest-token';
    mocks.rest.get.mockResolvedValue('value');
    mocks.rest.eval.mockResolvedValue('lua');
    mocks.rest.zrange.mockResolvedValue(['a', 'b']);
    mocks.rest.smembers.mockResolvedValue(['a']);
    mocks.rest.scan.mockResolvedValue(['0', ['key:a']]);
    vi.resetModules();
    const { getRedisCommandClient } = await importPort();
    const client = getRedisCommandClient();
    if (!client) throw new Error('expected REST client');

    await expect(client.get('key')).resolves.toBe('value');
    await expect(client.set('key', 'value')).resolves.toBe('OK');
    await expect(client.setex('key', 60, 'value')).resolves.toBe('OK');
    await expect(client.del('key')).resolves.toBe(1);
    await expect(client.exists('key')).resolves.toBe(1);
    await expect(client.incr('counter')).resolves.toBe(1);
    await expect(client.incrby('counter', 2)).resolves.toBe(2);
    await expect(client.incrbyfloat('counter', 0.5)).resolves.toBe(2.5);
    await expect(client.decrby('counter', 1)).resolves.toBe(1);
    await expect(client.expire('key', 60)).resolves.toBe(1);
    await expect(client.expireat('key', 1_800_000_000)).resolves.toBe(1);
    await expect(client.ttl('key')).resolves.toBe(60);
    await expect(client.eval('return 1', ['key'], ['arg'])).resolves.toBe('lua');
    await expect(client.zadd('sorted', { score: 1, member: 'a' })).resolves.toBe(1);
    await expect(client.zrange('sorted', 0, -1)).resolves.toEqual(['a', 'b']);
    await expect(client.zrange('sorted', 0, -1, { rev: true })).resolves.toEqual(['a', 'b']);
    await expect(client.smembers('members')).resolves.toEqual(['a']);
    await expect(client.sadd('members', 'a')).resolves.toBe(1);
    await expect(client.srem('members', 'a')).resolves.toBe(1);
    await expect(client.scard('members')).resolves.toBe(1);
    await expect(client.publish('channel', 'message')).resolves.toBe(0);
    await expect(client.rpush('list', 'a')).resolves.toBe(1);
    await expect(client.ltrim('list', 0, -1)).resolves.toBe('OK');
    await expect(client.scan(0, { match: 'key:*', count: 10 })).resolves.toEqual({
      cursor: 0,
      keys: ['key:a'],
    });
    await expect(client.dbsize()).resolves.toBe(0);
    await expect(client.close()).resolves.toBeUndefined();

    expect(mocks.rest.zadd).toHaveBeenCalledWith('sorted', { score: 1, member: 'a' });
    expect(mocks.rest.zrange).toHaveBeenLastCalledWith('sorted', 0, -1, { rev: true });
    expect(mocks.rest.scan).toHaveBeenCalledWith(0, { match: 'key:*', count: 10 });
  });

  it('maps all REST batch commands and preserves result ordering', async () => {
    const batch = {
      set: vi.fn().mockReturnThis(),
      setex: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      sadd: vi.fn().mockReturnThis(),
      srem: vi.fn().mockReturnThis(),
      scard: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      incrby: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(['OK', 'OK', 1, 2, 1, 1, 1, 4]),
    };
    const transaction = {
      set: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(['OK']),
    };
    mocks.config.redis.url = '';
    mocks.config.redis.restUrl = 'https://explicit-rest.upstash.io';
    mocks.config.redis.restToken = 'explicit-rest-token';
    mocks.rest.pipeline.mockReturnValue(batch);
    mocks.rest.multi.mockReturnValue(transaction);
    vi.resetModules();
    const { getRedisCommandClient } = await importPort();

    const result = await getRedisCommandClient()?.pipeline()
      .set('one', '1', { ex: 60 })
      .setex('two', 60, '2')
      .del('three')
      .sadd('members', 'a', 'b')
      .srem('members', 'b')
      .scard('members')
      .expire('one', 60)
      .incrby('counter', 4)
      .exec();

    expect(result).toEqual(['OK', 'OK', 1, 2, 1, 1, 1, 4]);
    expect(batch.set).toHaveBeenCalledWith('one', '1', { ex: 60 });
    await expect(
      getRedisCommandClient()?.multi().set('transactional', 'yes').exec(),
    ).resolves.toEqual(['OK']);
  });

  it.each([
    ['null execution', null],
    ['wrong result count', ['OK', 'UNEXPECTED_EXTRA_RESULT']],
  ])('rejects malformed REST batch results: %s', async (_label, nativeResult) => {
    const batch = {
      set: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(nativeResult),
    };
    mocks.config.redis.url = '';
    mocks.config.redis.restUrl = 'https://explicit-rest.upstash.io';
    mocks.config.redis.restToken = 'explicit-rest-token';
    mocks.rest.pipeline.mockReturnValue(batch);
    vi.resetModules();
    const { getRedisCommandClient } = await importPort();

    await expect(
      getRedisCommandClient()?.pipeline().set('key', 'value').exec(),
    ).rejects.toThrow('REDIS_BATCH_RESULT_INVALID');
  });

  it('rejects a malformed TCP batch tuple instead of inventing a result', async () => {
    const batch = {
      set: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([['not-a-null-error-slot', 'OK']]),
    };
    mocks.tcp.pipeline.mockReturnValue(batch);
    const { getRedisCommandClient } = await importPort();

    await expect(
      getRedisCommandClient()?.pipeline().set('key', 'value').exec(),
    ).rejects.toThrow('REDIS_BATCH_RESULT_INVALID');
  });

  it('returns null when neither Redis transport is configured', async () => {
    mocks.config.redis.url = '';
    vi.resetModules();
    const { getRedisCommandClient } = await importPort();
    expect(getRedisCommandClient()).toBeNull();
  });

  it('bounds TCP command-client quit and forces socket disconnect', async () => {
    vi.useFakeTimers();
    mocks.tcp.quit.mockImplementationOnce(() => new Promise(() => undefined));
    const { getRedisCommandClient, REDIS_COMMAND_CLOSE_TIMEOUT_MS } = await importPort();
    const client = getRedisCommandClient();
    if (!client) throw new Error('expected Redis client');

    const close = client.close();
    const closeExpectation = expect(close).rejects.toThrow('REDIS_COMMAND_CLOSE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(REDIS_COMMAND_CLOSE_TIMEOUT_MS);

    await closeExpectation;
    expect(mocks.tcp.disconnect).toHaveBeenCalledOnce();
  });
});

describe('sliding-window rate limit contract', () => {
  it('executes one atomic Lua command and returns normalized limit state', async () => {
    mocks.tcp.eval.mockResolvedValue([1, 7, 123456]);
    const { getRedisCommandClient, takeSlidingWindow } = await importPort();
    const client = getRedisCommandClient();
    if (!client) throw new Error('expected test Redis client');

    const result = await takeSlidingWindow(client, {
      key: 'ratelimit:ai:judge:user-1',
      limit: 8,
      windowMs: 60_000,
      member: 'request-1',
    });

    expect(result).toEqual({ allowed: true, limit: 8, remaining: 7, resetAt: 123456 });
    expect(mocks.tcp.eval).toHaveBeenCalledTimes(1);
    expect(mocks.tcp.eval.mock.calls[0].slice(1, 3)).toEqual([
      1,
      'ratelimit:ai:judge:user-1',
    ]);
  });

  it('rejects invalid limits before issuing Redis commands', async () => {
    const { getRedisCommandClient, takeSlidingWindow } = await importPort();
    const client = getRedisCommandClient();
    if (!client) throw new Error('expected test Redis client');

    await expect(takeSlidingWindow(client, {
      key: 'ratelimit:test',
      limit: 0,
      windowMs: 60_000,
      member: 'request-1',
    })).rejects.toThrow('REDIS_RATE_LIMIT_INVALID');
    expect(mocks.tcp.eval).not.toHaveBeenCalled();
  });
});
