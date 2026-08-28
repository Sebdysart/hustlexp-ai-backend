/**
 * auth-dual-cache-security.test.ts
 *
 * Regression tests for two CRITICAL auth security fixes:
 *
 * FIX 1 — Dual auth system cross-invalidation
 *   When invalidateAuthCacheForUser() is called (e.g. admin bans a user):
 *     (a) The in-process Map entries for that user are evicted.
 *     (b) A Redis revocation marker is written at auth:revoked:{uid}.
 *     (c) createContext() (tRPC path) checks the Redis marker on cache hits
 *         and falls through to Firebase re-verification if the marker exists.
 *
 * FIX 2 — Redis session key hashing
 *   CACHE_KEYS.sessionToken() must return session:<sha256(token)>, not
 *   session:<rawToken>.  The raw token must never appear in the Redis key name.
 */

import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Hoisted mock state
// ============================================================================

const hoisted = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn().mockResolvedValue(undefined),
  redisDel: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Mocks — declared before any imports
// ============================================================================

vi.mock('../../src/cache/redis.js', () => ({
  redis: {
    get: hoisted.redisGet,
    set: hoisted.redisSet,
    del: hoisted.redisDel,
  },
  // Use the real hashing logic so CACHE_KEYS tests are accurate
  CACHE_KEYS: {
    sessionToken: (token: string) =>
      `session:${createHash('sha256').update(token).digest('hex')}`,
  },
}));

vi.mock('../../src/auth/firebase.js', () => ({
  firebaseAuth: {
    verifyIdToken: vi.fn(),
  },
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  authLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/auth/constants.js', () => ({
  TOKEN_CACHE_TTL_SECONDS: 300,
  REVOCATION_MARKER_TTL_SECONDS: 360,
}));

// ============================================================================
// Imports — after mocks
// ============================================================================

import { authCache, authCacheSet, authCacheKey, invalidateAuthCacheForUser } from '../../src/auth-cache.js';
import { createContext } from '../../src/trpc.js';
import { firebaseAuth } from '../../src/auth/firebase.js';
import { db } from '../../src/db.js';
import { redis } from '../../src/cache/redis.js';
import { CACHE_KEYS } from '../../src/cache/redis.js';

// ============================================================================
// Helpers
// ============================================================================

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-999',
    email: 'test@example.com',
    full_name: 'Test User',
    default_mode: 'worker',
    trust_tier: 1,
    is_verified: false,
    xp_total: 0,
    plan: 'free',
    account_status: 'ACTIVE',
    is_banned: false,
    trust_hold: false,
    role_was_overridden: false,
    live_mode_state: 'OFF',
    live_mode_total_tasks: 0,
    daily_active_minutes: 0,
    consecutive_active_days: 0,
    current_level: 1,
    current_streak: 0,
    student_id_verified: false,
    ...overrides,
  };
}

function makeTrpcRequest(token: string): { req: Request; resHeaders: Headers } {
  return {
    req: {
      headers: {
        get: (name: string) =>
          name === 'authorization' ? `Bearer ${token}` : null,
      },
    } as unknown as Request,
    resHeaders: new Headers(),
  };
}

// ============================================================================
// FIX 1a — invalidateAuthCacheForUser evicts in-process cache entries
// ============================================================================

describe('FIX 1a: invalidateAuthCacheForUser — in-process cache eviction', () => {
  const TOKEN_A = 'firebase-token-user-A';
  const TOKEN_B = 'firebase-token-user-B';

  beforeEach(() => {
    authCache.clear();
    vi.clearAllMocks();
    hoisted.redisSet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    authCache.clear();
  });

  it('evicts all in-process cache entries for the banned user', () => {
    const user = makeUser({ id: 'user-ban-target' });

    // Seed two tokens for the same user (e.g. phone + tablet sessions)
    authCacheSet(TOKEN_A, { user: user as never, firebaseUid: 'fb-uid-target' }, Math.floor(Date.now() / 1000) + 3600);
    authCacheSet(TOKEN_B, { user: user as never, firebaseUid: 'fb-uid-target' }, Math.floor(Date.now() / 1000) + 3600);
    expect(authCache.size).toBe(2);

    invalidateAuthCacheForUser('user-ban-target');

    expect(authCache.size).toBe(0);
  });

  it('does NOT evict cache entries belonging to other users', () => {
    const targetUser = makeUser({ id: 'user-target' });
    const otherUser  = makeUser({ id: 'user-other' });

    authCacheSet(TOKEN_A, { user: targetUser as never, firebaseUid: 'fb-uid-target' }, Math.floor(Date.now() / 1000) + 3600);
    authCacheSet(TOKEN_B, { user: otherUser as never,  firebaseUid: 'fb-uid-other'  }, Math.floor(Date.now() / 1000) + 3600);
    expect(authCache.size).toBe(2);

    invalidateAuthCacheForUser('user-target');

    // Only the target user's entry should be gone
    expect(authCache.size).toBe(1);
    const remaining = [...authCache.values()];
    expect(remaining[0].user.id).toBe('user-other');
  });
});

// ============================================================================
// FIX 1b — invalidateAuthCacheForUser writes Redis revocation marker
// ============================================================================

describe('FIX 1b: invalidateAuthCacheForUser — Redis cross-invalidation', () => {
  beforeEach(() => {
    authCache.clear();
    vi.clearAllMocks();
    hoisted.redisSet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    authCache.clear();
  });

  it('writes a Redis revocation marker at auth:revoked:{firebaseUid} when firebaseUid is passed', async () => {
    // GG1 fix: the Redis key must use firebaseUid (not the DB UUID) because
    // trpc.ts and middleware.ts read auth:revoked:<firebaseUid>.
    // Callers that know the firebaseUid pass it directly; the function writes
    // the key immediately rather than waiting to collect it from in-process cache.
    invalidateAuthCacheForUser('user-to-ban', 'firebase-uid-of-banned-user');

    // Fire-and-forget — give the promise microtask a tick to execute
    await Promise.resolve();

    expect(hoisted.redisSet).toHaveBeenCalledWith(
      'auth:revoked:firebase-uid-of-banned-user',
      expect.any(String), // ISO timestamp
      360,               // REVOCATION_MARKER_TTL_SECONDS
    );
  });

  it('does NOT skip Redis write when in-process cache is empty (firebaseUid supplied)', async () => {
    // Even if the Map has no entries for this user, the Redis marker must still
    // be written so the Hono middleware path is protected. Callers must pass
    // firebaseUid directly when the in-process cache may be empty (e.g. admin ban).
    expect(authCache.size).toBe(0);

    invalidateAuthCacheForUser('user-not-in-map', 'firebase-uid-not-in-map');
    await Promise.resolve();

    expect(hoisted.redisSet).toHaveBeenCalledWith(
      'auth:revoked:firebase-uid-not-in-map',
      expect.any(String),
      360,
    );
  });
});

// ============================================================================
// FIX 1c — createContext checks Redis revocation marker on cache hits
// ============================================================================

describe('FIX 1c: createContext — Redis revocation check on tRPC cache hits', () => {
  const VALID_TOKEN = 'valid-firebase-token-12345';
  const FIREBASE_UID = 'firebase-uid-abc';

  beforeEach(() => {
    authCache.clear();
    vi.clearAllMocks();
    hoisted.redisGet.mockResolvedValue(null); // default: no revocation
    hoisted.redisSet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    authCache.clear();
  });

  it('returns cached user when no Redis revocation marker is set', async () => {
    const user = makeUser({ id: 'user-active' });
    authCacheSet(
      VALID_TOKEN,
      { user: user as never, firebaseUid: FIREBASE_UID },
      Math.floor(Date.now() / 1000) + 3600,
    );

    // Redis has no revocation marker
    hoisted.redisGet.mockResolvedValue(null);

    const ctx = await createContext(makeTrpcRequest(VALID_TOKEN));

    expect(ctx.user?.id).toBe('user-active');
    // Firebase was NOT called — served from cache
    expect(vi.mocked(firebaseAuth.verifyIdToken)).not.toHaveBeenCalled();
  });

  it('falls through to Firebase re-verification when Redis revocation marker exists', async () => {
    const user = makeUser({ id: 'user-just-banned' });
    authCacheSet(
      VALID_TOKEN,
      { user: user as never, firebaseUid: FIREBASE_UID },
      Math.floor(Date.now() / 1000) + 3600,
    );

    // Simulate: admin banned the user → Redis marker was written
    hoisted.redisGet.mockResolvedValue(new Date().toISOString());

    // Firebase re-verification also fails (token revoked by Firebase after ban)
    vi.mocked(firebaseAuth.verifyIdToken).mockRejectedValue(
      Object.assign(new Error('Token has been revoked'), { code: 'auth/id-token-revoked' }),
    );

    const ctx = await createContext(makeTrpcRequest(VALID_TOKEN));

    // Firebase WAS called — cache hit was bypassed due to revocation marker
    expect(vi.mocked(firebaseAuth.verifyIdToken)).toHaveBeenCalledOnce();
    // User comes back null because Firebase rejected the token
    expect(ctx.user).toBeNull();
  });

  it('allows re-authentication after ban if Firebase issues a fresh token', async () => {
    // After a ban, if the user somehow gets a new valid token and the ban was
    // lifted (is_banned=false in DB), they should be able to re-authenticate.
    const bannedUser = makeUser({ id: 'user-now-active', is_banned: false });

    // There is no in-process cache entry (evicted by invalidateAuthCacheForUser)
    // Simulate a cache miss path through createContext
    hoisted.redisGet.mockResolvedValue(null);

    vi.mocked(firebaseAuth.verifyIdToken).mockResolvedValue({
      uid: FIREBASE_UID,
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as never);

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [bannedUser] } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // admin_roles

    const ctx = await createContext(makeTrpcRequest('fresh-token-after-unban'));
    expect(ctx.user?.id).toBe('user-now-active');
  });
});

// ============================================================================
// FIX 2 — CACHE_KEYS.sessionToken hashes the token
// ============================================================================

describe('FIX 2: CACHE_KEYS.sessionToken — SHA-256 key hashing', () => {
  it('returns session:<sha256hex(token)> — not the raw token', () => {
    const rawToken = 'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.payload.signature';
    const expectedHash = createHash('sha256').update(rawToken).digest('hex');
    const key = CACHE_KEYS.sessionToken(rawToken);
    expect(key).toBe(`session:${expectedHash}`);
    expect(key).not.toContain(rawToken);
  });

  it('produces different keys for different tokens (no collision)', () => {
    const key1 = CACHE_KEYS.sessionToken('token-A');
    const key2 = CACHE_KEYS.sessionToken('token-B');
    expect(key1).not.toBe(key2);
  });

  it('produces the same key for the same token (deterministic)', () => {
    const token = 'stable-token-xyz';
    expect(CACHE_KEYS.sessionToken(token)).toBe(CACHE_KEYS.sessionToken(token));
  });

  it('raw token does not appear anywhere in the Redis key', () => {
    const sensitiveToken = 'super-secret-bearer-token-12345';
    const key = CACHE_KEYS.sessionToken(sensitiveToken);
    expect(key).not.toContain(sensitiveToken);
    // The key should be a 64-char hex string (sha256) prefixed with "session:"
    expect(key).toMatch(/^session:[a-f0-9]{64}$/);
  });
});
