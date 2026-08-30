import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: true,
  transport: 'tcp' as 'tcp' | 'legacy-rest',
  get: vi.fn(),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  exists: vi.fn().mockResolvedValue(0),
  ttl: vi.fn().mockResolvedValue(-2),
}));

vi.mock('../../src/redis/RedisCommandPort', () => ({
  getRedisCommandClient: () => (mocks.available ? {
    get transport() {
      return mocks.transport;
    },
    get: mocks.get,
    set: mocks.set,
    del: mocks.del,
    exists: mocks.exists,
    ttl: mocks.ttl,
  } : null),
  takeSlidingWindow: vi.fn(),
}));
vi.mock('../../src/config', () => ({
  config: { app: { isProduction: true } },
}));
vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { del, exists, get, set } from '../../src/cache/redis';

const LOGICAL_CACHE_KEY = 'geocode:addr:1 main st';
const VERSIONED_CACHE_KEY = `cache:typed:v1:${LOGICAL_CACHE_KEY}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.available = true;
  mocks.transport = 'tcp';
  mocks.get.mockResolvedValue(null);
  mocks.set.mockResolvedValue('OK');
  mocks.del.mockResolvedValue(1);
  mocks.exists.mockResolvedValue(0);
  mocks.ttl.mockResolvedValue(-2);
});

describe('versioned typed cache codec', () => {
  it.each(['tcp', 'legacy-rest'] as const)(
    'writes the identical versioned key and value envelope through %s',
    async (transport) => {
      mocks.transport = transport;
      await set(LOGICAL_CACHE_KEY, { lat: 47.6, lng: -122.3 }, 600);

      expect(mocks.set).toHaveBeenCalledWith(
        VERSIONED_CACHE_KEY,
        'hx:typed-cache:v1:{"lat":47.6,"lng":-122.3}',
        { ex: 600 },
      );
      expect(mocks.set).not.toHaveBeenCalledWith(LOGICAL_CACHE_KEY, expect.anything(), expect.anything());
    },
  );

  it('requires a bounded positive TTL for every versioned typed-cache write', async () => {
    await expect(set(LOGICAL_CACHE_KEY, { lat: 1, lng: 2 })).rejects.toThrow(
      'REDIS_TYPED_CACHE_TTL_INVALID',
    );
    await expect(set(LOGICAL_CACHE_KEY, { lat: 1, lng: 2 }, 2_592_001)).rejects.toThrow(
      'REDIS_TYPED_CACHE_TTL_INVALID',
    );
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('rejects non-string writes outside the typed-cache namespace', async () => {
    await expect(set('auth:revoked:user-1', { unsafe: true }, 60)).rejects.toThrow(
      'REDIS_RAW_VALUE_MUST_BE_STRING',
    );
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each([
    ['non-finite number', { lat: Number.NaN }],
    ['undefined property', { lat: undefined }],
    ['non-plain object', { capturedAt: new Date('2026-08-28T00:00:00.000Z') }],
  ])('rejects lossy typed-cache input: %s', async (_label, value) => {
    await expect(set(LOGICAL_CACHE_KEY, value, 60)).rejects.toThrow(/REDIS_TYPED_CACHE_VALUE/u);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('decodes a versioned value without consulting the legacy key', async () => {
    mocks.get.mockImplementation(async (key: string) => (
      key === VERSIONED_CACHE_KEY
        ? 'hx:typed-cache:v1:{"lat":47.6,"lng":-122.3}'
        : null
    ));

    await expect(get<{ lat: number; lng: number }>(LOGICAL_CACHE_KEY)).resolves.toEqual({
      lat: 47.6,
      lng: -122.3,
    });
    expect(mocks.ttl).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalledWith(LOGICAL_CACHE_KEY);
  });

  it('dual-reads only a bounded expiring legacy value and promotes it with remaining TTL', async () => {
    mocks.get.mockImplementation(async (key: string) => (
      key === LOGICAL_CACHE_KEY ? '{"lat":47.6,"lng":-122.3}' : null
    ));
    mocks.ttl.mockResolvedValue(120);

    await expect(get<{ lat: number; lng: number }>(LOGICAL_CACHE_KEY)).resolves.toEqual({
      lat: 47.6,
      lng: -122.3,
    });
    expect(mocks.ttl).toHaveBeenCalledWith(LOGICAL_CACHE_KEY);
    expect(mocks.set).toHaveBeenCalledWith(
      VERSIONED_CACHE_KEY,
      'hx:typed-cache:v1:{"lat":47.6,"lng":-122.3}',
      { ex: 120 },
    );
  });

  it('decodes and promotes the previous TCP-only value envelope', async () => {
    mocks.get.mockImplementation(async (key: string) => (
      key === LOGICAL_CACHE_KEY ? 'hx:cache-json:v1:{"lat":47.6,"lng":-122.3}' : null
    ));
    mocks.ttl.mockResolvedValue(90);

    await expect(get<{ lat: number; lng: number }>(LOGICAL_CACHE_KEY)).resolves.toEqual({
      lat: 47.6,
      lng: -122.3,
    });
    expect(mocks.set).toHaveBeenCalledWith(
      VERSIONED_CACHE_KEY,
      'hx:typed-cache:v1:{"lat":47.6,"lng":-122.3}',
      { ex: 90 },
    );
  });

  it('preserves JSON-looking legacy AI output as opaque text', async () => {
    const aiKey = 'ai:cache:json-looking-output';
    const versionedAiKey = `cache:typed:v1:${aiKey}`;
    mocks.get.mockImplementation(async (key: string) => (
      key === aiKey ? '{"answer":42}' : null
    ));
    mocks.ttl.mockResolvedValue(120);

    await expect(get<string>(aiKey)).resolves.toBe('{"answer":42}');
    expect(mocks.set).toHaveBeenCalledWith(
      versionedAiKey,
      'hx:typed-cache:v1:"{\\"answer\\":42}"',
      { ex: 120 },
    );
  });

  it.each([-1, 0, 2_592_001])(
    'refuses a legacy cache key outside the bounded TTL window (%s)',
    async (legacyTtl) => {
      mocks.ttl.mockResolvedValue(legacyTtl);
      mocks.get.mockImplementation(async (key: string) => (
        key === VERSIONED_CACHE_KEY ? null : '{"lat":1,"lng":2}'
      ));

      await expect(get(LOGICAL_CACHE_KEY)).resolves.toBeNull();
      expect(mocks.get).not.toHaveBeenCalledWith(LOGICAL_CACHE_KEY);
      expect(mocks.set).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed structured legacy data instead of returning a typed lie', async () => {
    mocks.ttl.mockResolvedValue(60);
    mocks.get.mockImplementation(async (key: string) => (
      key === LOGICAL_CACHE_KEY ? '{"lat":47.6' : null
    ));

    await expect(get(LOGICAL_CACHE_KEY)).resolves.toBeNull();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('distinguishes a tolerant cache miss from a failed authoritative read', async () => {
    const failure = new Error('redis get rejected');
    mocks.get.mockRejectedValue(failure);

    await expect(get('ordinary-cache-key')).resolves.toBeNull();
    await expect(get('auth:revoked:firebase-user-1', 'authority')).rejects.toBe(failure);
  });

  it('propagates an unavailable client only for authoritative reads', async () => {
    mocks.available = false;

    await expect(get('ordinary-cache-key')).resolves.toBeNull();
    await expect(get('auth:revoked:firebase-user-1', 'authority')).rejects.toThrow(
      'Redis unavailable for authoritative read',
    );
  });

  it('does not resurrect legacy data when the canonical value is malformed', async () => {
    mocks.get.mockImplementation(async (key: string) => {
      if (key === VERSIONED_CACHE_KEY) return 'hx:typed-cache:v1:{"lat":47.6';
      if (key === LOGICAL_CACHE_KEY) return '{"lat":1,"lng":2}';
      return null;
    });
    mocks.ttl.mockResolvedValue(60);

    await expect(get(LOGICAL_CACHE_KEY)).resolves.toBeNull();
    expect(mocks.ttl).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalledWith(LOGICAL_CACHE_KEY);
  });

  it('keeps revocation state on its exact legacy key and raw string value', async () => {
    const revocationKey = 'auth:revoked:firebase-user-1';
    const marker = '2026-08-28T12:00:00.000Z';
    mocks.get.mockResolvedValue(marker);

    await set(revocationKey, marker, 360);
    await expect(get<string>(revocationKey)).resolves.toBe(marker);

    expect(mocks.set).toHaveBeenCalledWith(revocationKey, marker, { ex: 360 });
    expect(mocks.get).toHaveBeenCalledWith(revocationKey);
    expect(mocks.get).not.toHaveBeenCalledWith(`cache:typed:v1:${revocationKey}`);
  });

  it('keeps revocation delete and existence checks on the exact key', async () => {
    const revocationKey = 'auth:revoked:firebase-user-1';
    mocks.exists.mockResolvedValue(1);

    await del(revocationKey);
    await expect(exists(revocationKey)).resolves.toBe(true);

    expect(mocks.del).toHaveBeenCalledWith(revocationKey);
    expect(mocks.exists).toHaveBeenCalledWith(revocationKey);
    expect(mocks.del).not.toHaveBeenCalledWith(expect.stringContaining('cache:typed:v1:'));
  });

  it('deletes and checks only the bounded typed-cache pair for cache namespaces', async () => {
    mocks.exists.mockResolvedValueOnce(0);
    mocks.ttl.mockResolvedValueOnce(30);

    await del(LOGICAL_CACHE_KEY);
    await expect(exists(LOGICAL_CACHE_KEY)).resolves.toBe(true);

    expect(mocks.del).toHaveBeenCalledWith(VERSIONED_CACHE_KEY, LOGICAL_CACHE_KEY);
    expect(mocks.exists).toHaveBeenCalledWith(VERSIONED_CACHE_KEY);
    expect(mocks.ttl).toHaveBeenCalledWith(LOGICAL_CACHE_KEY);
  });
});
