import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDelete: vi.fn(),
  redisGet: vi.fn(),
  verify: vi.fn(),
  query: vi.fn(),
  ensure: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/auth-cache', () => ({
  authCache: { delete: mocks.cacheDelete },
  authCacheKey: (token: string) => `auth:${token}`,
  authCacheGet: mocks.cacheGet,
  authCacheSet: mocks.cacheSet,
}));
vi.mock('../../src/cache/redis', () => ({ redis: { get: mocks.redisGet } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: mocks.verify } }));
vi.mock('../../src/auth/ensure-user', () => ({ ensureUserRowForFirebaseUid: mocks.ensure }));
vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: mocks.warn, info: vi.fn(), error: vi.fn() }) },
}));

import { createContext } from '../../src/trpc-context';

function request(headers: Record<string, string>) {
  return new Request('https://api.hustlexp.test/trpc', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cacheGet.mockReturnValue(null);
});

describe('tRPC context edge behavior', () => {
  it('uses a trimmed Cloudflare IP', async () => {
    const result = await createContext({
      req: request({ 'cf-connecting-ip': ' 203.0.113.8 ' }), resHeaders: new Headers(),
    });
    expect(result.ip).toBe('203.0.113.8');
  });

  it('uses the trusted last non-empty forwarded hop', async () => {
    const result = await createContext({
      req: request({ 'x-forwarded-for': '198.51.100.9, , 10.0.0.2' }), resHeaders: new Headers(),
    });
    expect(result.ip).toBe('10.0.0.2');
  });

  it('falls through to Firebase when Redis revocation lookup is unavailable', async () => {
    const cachedUser = { id: 'cached-user', firebase_uid: 'uid-1' };
    mocks.cacheGet.mockReturnValueOnce({ user: cachedUser, firebaseUid: 'uid-1' });
    mocks.redisGet.mockRejectedValueOnce(new Error('redis unavailable'));
    mocks.verify.mockResolvedValueOnce({ uid: 'uid-1', exp: Math.floor(Date.now() / 1000) + 300 });
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: 'user-1', firebase_uid: 'uid-1', account_status: 'ACTIVE', is_banned: false }], rowCount: 1,
    }).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await createContext({
      req: request({ authorization: 'Bearer token', 'x-real-ip': '192.0.2.5' }),
      resHeaders: new Headers(),
    });
    expect(result.user).toMatchObject({ id: 'user-1' });
    expect(result.ip).toBe('192.0.2.5');
    expect(mocks.verify).toHaveBeenCalledWith('token', true);
    expect(mocks.warn).toHaveBeenCalled();
  });
});
