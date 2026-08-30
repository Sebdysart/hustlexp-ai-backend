import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  redisGet: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: mocks.verifyIdToken },
}));
vi.mock('../../src/cache/redis', () => ({
  redis: { get: mocks.redisGet },
}));
vi.mock('../../src/db', () => ({
  db: { query: mocks.query },
}));

import { getAuthUser } from '../../src/serverRestAuth';

function bearerContext(token = 'valid-firebase-token'): Context {
  return {
    req: {
      header: vi.fn((name: string) => (
        name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined
      )),
    },
  } as unknown as Context;
}

const activeUser = {
  id: 'user-1',
  firebase_uid: 'firebase-user-1',
  email: 'user@example.invalid',
  full_name: 'Active User',
  is_banned: false,
  account_status: 'ACTIVE',
  default_mode: 'poster',
  role: 'user',
  trust_tier: 'NEW',
  stripe_connect_id: null,
};

describe('REST authentication revocation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyIdToken.mockResolvedValue({ uid: activeUser.firebase_uid });
    mocks.redisGet.mockResolvedValue(null);
    mocks.query.mockResolvedValue({ rows: [activeUser], rowCount: 1 });
  });

  it('returns null when the strict Redis revocation lookup rejects', async () => {
    const authorityFailure = new Error('Redis authority unavailable');
    mocks.redisGet.mockRejectedValueOnce(authorityFailure);

    await expect(getAuthUser(bearerContext())).resolves.toBeNull();

    expect(mocks.verifyIdToken).toHaveBeenCalledWith('valid-firebase-token', true);
    expect(mocks.redisGet).toHaveBeenCalledWith(
      `auth:revoked:${activeUser.firebase_uid}`,
      'authority',
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty marker', ''],
    ['an undefined response', undefined],
  ])('fails closed when the authority read returns %s', async (_label, malformedValue) => {
    mocks.redisGet.mockResolvedValueOnce(malformedValue);

    await expect(getAuthUser(bearerContext())).resolves.toBeNull();

    expect(mocks.redisGet).toHaveBeenCalledWith(
      `auth:revoked:${activeUser.firebase_uid}`,
      'authority',
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns the active database user only after an exact null authority miss', async () => {
    await expect(getAuthUser(bearerContext())).resolves.toEqual(activeUser);

    expect(mocks.redisGet).toHaveBeenCalledWith(
      `auth:revoked:${activeUser.firebase_uid}`,
      'authority',
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE firebase_uid = $1'),
      [activeUser.firebase_uid],
    );
  });
});
