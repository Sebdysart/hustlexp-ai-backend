import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => vi.unstubAllEnvs());

function syntheticOperatorToken(now: number, secret: string): string {
  const header = Buffer.from(JSON.stringify({
    alg: 'HS256', typ: 'JWT', kid: 'hxos-nonprod-operator-v1',
  })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'hxos-deployed-synthetic-operator',
    aud: 'hustlexp-nonprod-operations',
    sub: 'hxos-staging-operator-alice000',
    iat: now - 20,
    auth_time: now - 20,
    exp: now + 300,
    environment: 'staging',
    operator_name: 'Alice Staging Operator',
    mfa_method: 'totp',
    hxos_synthetic_operator: true,
  })).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
}

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

  it('derives and caches operator assurance only from the verified token', async () => {
    const now = Math.floor(Date.now() / 1000);
    mocks.verify.mockResolvedValueOnce({
      uid: 'uid-mfa',
      auth_time: now - 20,
      exp: now + 900,
      firebase: {
        sign_in_provider: 'password',
        sign_in_second_factor: 'phone',
      },
    });
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: 'user-mfa', firebase_uid: 'uid-mfa', account_status: 'ACTIVE', is_banned: false }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ role: 'support' }], rowCount: 1 });

    const result = await createContext({
      req: request({ authorization: 'Bearer token-with-verified-mfa' }),
      resHeaders: new Headers(),
    });

    expect(result.identityAssurance).toMatchObject({
      authenticatedAtSeconds: now - 20,
      tokenExpiresAtSeconds: now + 900,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    });
    expect(mocks.cacheSet).toHaveBeenCalledWith(
      'token-with-verified-mfa',
      expect.objectContaining({ identityAssurance: result.identityAssurance }),
      now + 900,
    );
  });

  it('preserves verified assurance on an unrevoked auth-cache hit', async () => {
    const assurance = {
      authenticatedAtSeconds: 1_999_999_990,
      tokenExpiresAtSeconds: 2_000_000_900,
      signInProvider: 'password',
      secondFactor: 'totp',
      mfaVerified: true,
    };
    mocks.cacheGet.mockReturnValueOnce({
      user: { id: 'cached-user', account_status: 'ACTIVE', is_banned: false },
      firebaseUid: 'uid-cached-mfa',
      identityAssurance: assurance,
    });
    mocks.redisGet.mockResolvedValueOnce(null);

    const result = await createContext({
      req: request({ authorization: 'Bearer cached-token' }),
      resHeaders: new Headers(),
    });
    expect(result.identityAssurance).toEqual(assurance);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('authenticates a seeded named staging operator without Firebase or lazy provisioning', async () => {
    const now = Math.floor(Date.now() / 1000);
    const secret = 'synthetic-operator-auth-secret-v1';
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HX_ENVIRONMENT', 'staging');
    vi.stubEnv('ENGINE_API_MODE', 'test');
    vi.stubEnv('STRIPE_MODE', 'test');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');
    vi.stubEnv('HX_SYNTHETIC_OPERATOR_AUTH_MODE', 'signed_hmac');
    vi.stubEnv('HX_SYNTHETIC_OPERATOR_AUTH_SECRET', secret);
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'operator-user-1',
          firebase_uid: 'hxos-staging-operator-alice000',
          account_status: 'ACTIVE',
          is_banned: false,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ role: 'support' }], rowCount: 1 });

    const result = await createContext({
      req: request({ authorization: `Bearer ${syntheticOperatorToken(now, secret)}` }),
      resHeaders: new Headers(),
    });

    expect(result).toMatchObject({
      firebaseUid: 'hxos-staging-operator-alice000',
      user: { id: 'operator-user-1', is_admin: true },
      identityAssurance: {
        mfaVerified: true,
        signInProvider: 'synthetic_nonprod_hmac',
        secondFactor: 'totp',
      },
    });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});
