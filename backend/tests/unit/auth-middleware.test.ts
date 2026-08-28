/**
 * Auth Middleware Security Tests
 *
 * R53-AUTH security regression tests:
 * - A53-1: DB ban-check fail-open → must fail closed on DB error
 * - A53-2: Role switch must invalidate session cache
 * - A53-4: Admin gate must use consistent is_admin check
 * - A53-5: Role switch clears session cache (revocation marker written for Hono path)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

// ─── Mock dependencies ──────────────────────────────────────────────────────

const mockRedisDel = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();

vi.mock('../../src/cache/redis', () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  },
  CACHE_KEYS: {
    sessionToken: (token: string) => `session:${token}`,
  },
}));

const mockDbQuery = vi.fn();
vi.mock('../../src/db', () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

const mockVerifyIdToken = vi.fn();
vi.mock('../../src/auth/firebase', () => {
  const verifyIdTokenShared = (...args: unknown[]) => mockVerifyIdToken(...args);
  const authObj = { verifyIdToken: verifyIdTokenShared };
  return {
    adminAuth: authObj,
    firebaseAuth: authObj,
    revokeFirebaseRefreshTokens: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../src/logger', () => ({
  authLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const mockEncryptSession = vi.fn();
const mockDecryptSession = vi.fn();
vi.mock('../../src/middleware/encrypted-session', () => ({
  encryptSession: (...args: unknown[]) => mockEncryptSession(...args),
  decryptSession: (...args: unknown[]) => mockDecryptSession(...args),
}));

vi.mock('../../src/auth/constants', () => ({
  TOKEN_CACHE_TTL_SECONDS: 300,
  REVOCATION_MARKER_TTL_SECONDS: 720,
}));

// ─── Import SUT after mocks ──────────────────────────────────────────────────

// We import after all vi.mock() calls so the module loads with mocked deps.
import { authenticateRequest } from '../../src/auth/middleware';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeContext(token = 'valid-token-1234567890') {
  return {
    req: {
      header: (name: string) =>
        name === 'Authorization' ? `Bearer ${token}` : undefined,
    },
  } as never;
}

const DECODED_TOKEN = {
  uid: 'firebase-uid-001',
  email: 'user@test.com',
  email_verified: true,
  name: 'Test User',
};

// ============================================================================
// A53-1: DB ban-check fail-open
// ============================================================================
describe('A53-1: DB ban-check fail-closed on DB error', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // No cached session — fall through to Firebase verification
    mockRedisGet.mockResolvedValue(null);
    // Firebase token is valid
    mockVerifyIdToken.mockResolvedValue(DECODED_TOKEN);
    // encryptSession returns a dummy string so redis.set doesn't throw
    mockEncryptSession.mockReturnValue('encrypted-session-data');
  });

  it('should throw when DB ban-check throws (fail closed)', async () => {
    // Simulate DB outage during ban-check
    mockDbQuery.mockRejectedValueOnce(new Error('DB connection refused'));

    const ctx = makeContext();
    await expect(authenticateRequest(ctx)).rejects.toThrow();
  });

  it('should NOT return a user when DB ban-check throws', async () => {
    mockDbQuery.mockRejectedValueOnce(new Error('timeout'));

    const ctx = makeContext();
    let result: unknown;
    try {
      result = await authenticateRequest(ctx);
    } catch {
      result = undefined;
    }
    // Either throws (preferred) or returns null — must NOT return a user object with uid
    expect(result).toBeUndefined();
  });

  it('should NOT cache the session when DB ban-check throws', async () => {
    mockDbQuery.mockRejectedValueOnce(new Error('pool exhausted'));

    const ctx = makeContext();
    try {
      await authenticateRequest(ctx);
    } catch {
      // expected to throw
    }

    // redis.set must NOT have been called with a session token (caching the unverified user)
    const sessionCacheWriteCalls = mockRedisSet.mock.calls.filter(
      (args) => String(args[0]).startsWith('session:')
    );
    expect(sessionCacheWriteCalls).toHaveLength(0);
  });

  it('should return user when DB ban-check succeeds and user is not banned', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ is_banned: false, account_status: 'ACTIVE' }],
    });
    mockRedisSet.mockResolvedValue(undefined);

    const ctx = makeContext();
    const user = await authenticateRequest(ctx);
    expect(user).not.toBeNull();
    expect(user?.uid).toBe('firebase-uid-001');
  });

  it('should return null when DB confirms user is banned', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ is_banned: true, account_status: 'ACTIVE' }],
    });

    const ctx = makeContext();
    const user = await authenticateRequest(ctx);
    expect(user).toBeNull();
  });

  it('should return null when DB confirms user is SUSPENDED', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ is_banned: false, account_status: 'SUSPENDED' }],
    });

    const ctx = makeContext();
    const user = await authenticateRequest(ctx);
    expect(user).toBeNull();
  });
});

// ============================================================================
// A53-2: Role switch must invalidate session cache
// ============================================================================
describe('A53-2: invalidateAuthCacheForUser clears in-process cache on role switch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('evicts in-process cache entries for the given userId', async () => {
    // Test the auth-cache module directly — the contract that role-switch calls
    const { authCache, invalidateAuthCacheForUser } = await import(
      '../../src/auth-cache'
    );

    // Seed the in-process cache with a user entry
    const fakeEntry = {
      user: { id: 'user-uuid-abc', email: 'test@test.com' } as never,
      firebaseUid: 'fb-uid-abc',
      expiresAt: Date.now() + 300_000,
    };
    authCache.set('some-token-hash', fakeEntry);
    expect(authCache.size).toBeGreaterThanOrEqual(1);

    // Mock redis.set for the revocation marker write
    mockRedisSet.mockResolvedValue(undefined);
    // Mock db.query fallback (no in-process hit needed — we seeded it above)
    mockDbQuery.mockResolvedValue({ rows: [] });

    await invalidateAuthCacheForUser('user-uuid-abc', 'fb-uid-abc');

    // The entry must be evicted
    expect(authCache.has('some-token-hash')).toBe(false);
  });

  it('writes a Redis revocation marker so Redis-cached sessions are also invalidated', async () => {
    vi.resetAllMocks();
    mockRedisSet.mockResolvedValue(undefined);
    mockDbQuery.mockResolvedValue({ rows: [] });

    const { authCache, invalidateAuthCacheForUser } = await import(
      '../../src/auth-cache'
    );

    // Seed with a firebaseUid we can observe
    const fakeEntry = {
      user: { id: 'user-uuid-xyz' } as never,
      firebaseUid: 'fb-uid-xyz',
      expiresAt: Date.now() + 300_000,
    };
    authCache.set('hash-xyz', fakeEntry);

    await invalidateAuthCacheForUser('user-uuid-xyz', 'fb-uid-xyz');

    // Redis revocation marker must have been written for the firebaseUid
    const revocationCalls = mockRedisSet.mock.calls.filter(
      (args) => String(args[0]) === 'auth:revoked:fb-uid-xyz'
    );
    expect(revocationCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT write a revocation marker when writeRevocationMarker=false', async () => {
    vi.resetAllMocks();
    mockRedisSet.mockResolvedValue(undefined);

    const { authCache, invalidateAuthCacheForUser } = await import(
      '../../src/auth-cache'
    );

    const fakeEntry = {
      user: { id: 'user-admin-role' } as never,
      firebaseUid: 'fb-uid-admin',
      expiresAt: Date.now() + 300_000,
    };
    authCache.set('hash-admin', fakeEntry);

    await invalidateAuthCacheForUser('user-admin-role', 'fb-uid-admin', false);

    // No Redis writes expected for the revocation marker
    const revocationCalls = mockRedisSet.mock.calls.filter(
      (args) => String(args[0]).startsWith('auth:revoked:')
    );
    expect(revocationCalls).toHaveLength(0);
    // But the in-process entry MUST still be evicted
    expect(authCache.has('hash-admin')).toBe(false);
  });
});

// ============================================================================
// A53-4: Admin gate consistency (is_admin, not role === 'admin')
// ============================================================================
describe('A53-4: Admin gate uses consistent is_admin check', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('isAdminCheck in tRPC grants access when is_admin is true', async () => {
    // Test the createContext path that populates is_admin from admin_roles table
    mockVerifyIdToken.mockResolvedValueOnce({
      uid: 'fb-001',
      email: 'admin@test.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    mockDbQuery
      // First call: SELECT * FROM users WHERE firebase_uid = $1
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-001',
          firebase_uid: 'fb-001',
          email: 'admin@test.com',
          is_banned: false,
          account_status: 'ACTIVE',
          default_mode: 'poster',
        }],
      })
      // Second call: SELECT 1 FROM admin_roles WHERE user_id = $1 AND role = ANY(...)
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // has admin role

    // Ensure authCacheSet doesn't interfere
    mockRedisSet.mockResolvedValue(undefined);

    const { createContext } = await import('../../src/trpc');
    const req = new Request('https://api.hustlexp.app/trpc', {
      headers: { authorization: 'Bearer test-firebase-token-admin' },
    });
    const resHeaders = new Headers();

    const { authCache } = await import('../../src/auth-cache');
    authCache.clear();

    const ctx = await createContext({ req, resHeaders });

    // The user must have is_admin populated from admin_roles lookup
    expect(ctx.user).not.toBeNull();
    expect(ctx.user?.is_admin).toBe(true);
  });

  it('isAdminCheck denies access when user has no admin_roles row', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      uid: 'fb-002',
      email: 'regular@test.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-002',
          firebase_uid: 'fb-002',
          email: 'regular@test.com',
          is_banned: false,
          account_status: 'ACTIVE',
          default_mode: 'worker',
        }],
      })
      // No admin roles row
      .mockResolvedValueOnce({ rows: [] });

    mockRedisSet.mockResolvedValue(undefined);

    const { createContext } = await import('../../src/trpc');
    const req = new Request('https://api.hustlexp.app/trpc', {
      headers: { authorization: 'Bearer test-regular-token-002' },
    });
    const resHeaders = new Headers();

    const { authCache } = await import('../../src/auth-cache');
    authCache.clear();

    const ctx = await createContext({ req, resHeaders });

    expect(ctx.user).not.toBeNull();
    // is_admin must be false — prevents role==='admin' bypass
    expect(ctx.user?.is_admin).toBe(false);
  });

  it('task router getTask falls back to admin_roles table check (not role field)', async () => {
    // This test verifies the ad-hoc admin_roles check in task.ts uses the DB table,
    // not a role string field — confirming A53-4 is handled at the DB level.
    // The check `SELECT 1 FROM admin_roles WHERE user_id = $1` is the correct
    // pattern (consistent with is_admin population in createContext).
    // We just verify the pattern is present via static analysis.

    const fs = await import('fs');
    const path = await import('path');
    const taskRouterPath = path.resolve(
      fileURLToPath(import.meta.url),
      '../../../src/routers/task.ts'
    );
    const taskRouterSrc = fs.readFileSync(taskRouterPath, 'utf8');

    // Must NOT use `role === 'admin'` (string-based check)
    expect(taskRouterSrc).not.toMatch(/\.role\s*===\s*['"]admin['"]/);
    expect(taskRouterSrc).not.toMatch(/user\.role\s*===\s*['"]admin['"]/);

    // Must use admin_roles table check OR ctx.user.is_admin
    const usesAdminRolesTable = taskRouterSrc.includes('admin_roles');
    const usesIsAdmin = taskRouterSrc.includes('is_admin');
    expect(usesAdminRolesTable || usesIsAdmin).toBe(true);
  });

  it('no source file uses role===admin string check as admin gate', async () => {
    // Walk source files and assert no `role === 'admin'` gating pattern
    const fs = await import('fs');
    const path = await import('path');

    const srcDir = path.resolve(
      fileURLToPath(import.meta.url),
      '../../../src'
    );

    function walkTs(dir: string): string[] {
      const files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...walkTs(fullPath));
        } else if (entry.name.endsWith('.ts')) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const violations: string[] = [];
    for (const file of walkTs(srcDir)) {
      const src = fs.readFileSync(file, 'utf8');
      // Flag any line that checks `role === 'admin'` or `role == 'admin'`
      // as an admin security gate (as opposed to a role enum value comparison)
      if (/(?:user|ctx\.user)\.role\s*===?\s*['"]admin['"]/.test(src)) {
        violations.push(file);
      }
    }

    expect(violations).toHaveLength(0);
  });
});

// ============================================================================
// A53-5: Role switch clears session cache
// Verifies that:
//   (a) A regular role switch (worker↔poster via updateProfile) writes a
//       Redis revocation marker so the Hono session cache is lazily evicted
//       on the next request — not just the in-process tRPC cache.
//   (b) Admin role grant/revoke evict the in-process cache but do NOT write
//       a Redis revocation marker (by design — avoids 12-min Firebase round-trip
//       tax for all admin role changes, since is_admin is not in the Hono session).
// ============================================================================
describe('A53-5: Role switch clears session cache (revocation marker)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('regular role switch: invalidateAuthCacheForUser writes Redis revocation marker (writeRevocationMarker=true by default)', async () => {
    // Simulate the in-process cache holding a session for the user.
    const { authCache, invalidateAuthCacheForUser } = await import(
      '../../src/auth-cache'
    );

    const fakeEntry = {
      user: { id: 'user-role-switch-001' } as never,
      firebaseUid: 'fb-uid-role-switch',
      expiresAt: Date.now() + 300_000,
    };
    authCache.set('hash-role-switch', fakeEntry);

    mockRedisSet.mockResolvedValue(undefined);
    mockDbQuery.mockResolvedValue({ rows: [] });

    // Call without writeRevocationMarker arg → defaults to true (revocation marker IS written)
    await invalidateAuthCacheForUser('user-role-switch-001', 'fb-uid-role-switch');

    // 1. In-process cache entry must be evicted
    expect(authCache.has('hash-role-switch')).toBe(false);

    // 2. Redis revocation marker MUST be written (so Hono session is cleared on next request)
    const revocationCalls = mockRedisSet.mock.calls.filter(
      (args) => String(args[0]) === 'auth:revoked:fb-uid-role-switch'
    );
    expect(revocationCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('admin role grant/revoke: invalidateAuthCacheForUser with writeRevocationMarker=false evicts in-process cache but does NOT write Redis marker', async () => {
    vi.resetAllMocks();
    const { authCache, invalidateAuthCacheForUser } = await import(
      '../../src/auth-cache'
    );

    const fakeEntry = {
      user: { id: 'user-admin-grant-001' } as never,
      firebaseUid: 'fb-uid-admin-grant',
      expiresAt: Date.now() + 300_000,
    };
    authCache.set('hash-admin-grant', fakeEntry);

    mockRedisSet.mockResolvedValue(undefined);

    // Admin role grant/revoke uses writeRevocationMarker=false
    await invalidateAuthCacheForUser('user-admin-grant-001', 'fb-uid-admin-grant', false);

    // 1. In-process cache entry MUST still be evicted
    expect(authCache.has('hash-admin-grant')).toBe(false);

    // 2. Redis revocation marker must NOT be written (by design for admin role changes)
    const revocationCalls = mockRedisSet.mock.calls.filter(
      (args) => String(args[0]).startsWith('auth:revoked:')
    );
    expect(revocationCalls).toHaveLength(0);
  });

  it('Hono middleware clears the Redis session cache when revocation marker is present on next request', async () => {
    // This test exercises the Hono auth/middleware.ts path:
    // When a cached session is hit but a revocation marker exists, the session
    // cache key is deleted and Firebase re-verification runs.
    const encryptedSession = 'encrypted-session-abc';
    const cachedUser: ReturnType<typeof mockDecryptSession.mockReturnValue> = {
      uid: 'fb-uid-session-test',
      email: 'sess@test.com',
      emailVerified: true,
      is_banned: false,
      account_status: 'ACTIVE',
    };

    // Arrange: cached session hit, then revocation marker present
    mockRedisGet
      .mockResolvedValueOnce(encryptedSession)  // session cache hit
      .mockResolvedValueOnce('2026-01-01T00:00:00.000Z'); // revocation marker present

    mockDecryptSession.mockReturnValue(cachedUser as never);
    mockRedisDel.mockResolvedValue(undefined);

    // Firebase re-verification runs after cache eviction
    mockVerifyIdToken.mockResolvedValue({
      uid: 'fb-uid-session-test',
      email: 'sess@test.com',
      email_verified: true,
      name: 'Session Test',
    });
    // DB ban-check: user is active
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ is_banned: false, account_status: 'ACTIVE' }],
    });
    mockRedisSet.mockResolvedValue(undefined);
    mockEncryptSession.mockReturnValue('new-encrypted-session');

    const ctx = makeContext('session-test-token-123456');
    const user = await authenticateRequest(ctx);

    // The session cache key was deleted (evicted) due to revocation marker
    expect(mockRedisDel).toHaveBeenCalled();

    // Firebase re-verification ran and returned a valid user
    expect(user).not.toBeNull();
    expect(user?.uid).toBe('fb-uid-session-test');
  });
});
