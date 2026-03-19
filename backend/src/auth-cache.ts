/**
 * Auth cache module — isolated so services can import `invalidateAuthCacheForUser`
 * without pulling in the full trpc.ts (and its Firebase/db side-effects).
 *
 * The cache itself lives here; trpc.ts imports the cache operations from this
 * module so the single in-process Map is shared across all callers.
 */

import { createHash } from 'crypto';
import type { User } from './types.js';
import { redis } from './cache/redis.js';
import { REVOCATION_MARKER_TTL_SECONDS } from './auth/constants.js';

// Matches the REVOKED_KEY pattern used in auth/middleware.ts.
// Must be kept in sync if that constant is ever renamed.
const REDIS_REVOKED_KEY = (uid: string) => `auth:revoked:${uid}`;

type CachedAuth = {
  user: User;
  firebaseUid: string;
  expiresAt: number; // Unix ms
};

const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_CACHE_MAX  = 10_000;           // ~20-30 MB peak

export const authCache = new Map<string, CachedAuth>();

export function authCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function authCacheGet(token: string): CachedAuth | null {
  const entry = authCache.get(authCacheKey(token));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    authCache.delete(authCacheKey(token));
    return null;
  }
  return entry;
}

/**
 * Invalidate all auth cache entries for a given user ID.
 * Call this immediately after banning, suspending, or deleting a user so the
 * cached user row is evicted before the 5-minute TTL expires.
 *
 * Cross-invalidation: also writes a Redis revocation marker so the Hono
 * middleware path (auth/middleware.ts) and the tRPC createContext path both
 * see the invalidation signal immediately.  The marker TTL matches
 * REVOCATION_MARKER_TTL_SECONDS (TOKEN_CACHE_TTL_SECONDS + 60s), which is
 * deliberately longer than the in-process cache TTL so the marker is still
 * present if the Redis-cached session outlives the in-process entry.
 */
export function invalidateAuthCacheForUser(userId: string): void {
  // 1. Evict in-process cache entries for this user.
  for (const [key, entry] of authCache.entries()) {
    if (entry.user.id === userId) {
      authCache.delete(key);
    }
  }

  // 2. Write a Redis revocation marker so the Redis session cache used by
  //    auth/middleware.ts is also invalidated on next request.  We fire-and-
  //    forget (no await) because this function is intentionally synchronous at
  //    call sites; Redis errors are logged inside redis.set().
  void redis.set(
    REDIS_REVOKED_KEY(userId),
    new Date().toISOString(),
    REVOCATION_MARKER_TTL_SECONDS,
  );
}

export function authCacheSet(
  token: string,
  value: { user: User; firebaseUid: string },
  tokenExp: number
): void {
  // Evict oldest entry when at capacity (Map preserves insertion order)
  if (authCache.size >= AUTH_CACHE_MAX) {
    const oldestKey = authCache.keys().next().value;
    if (oldestKey !== undefined) authCache.delete(oldestKey);
  }
  // Clamp effective TTL to token's remaining validity minus 30s clock-skew margin
  const tokenRemainingMs = tokenExp * 1000 - Date.now() - 30_000;
  const effectiveTtlMs  = Math.min(AUTH_CACHE_TTL_MS, Math.max(0, tokenRemainingMs));
  if (effectiveTtlMs <= 0) return; // Token already too close to expiry — don't cache
  authCache.set(authCacheKey(token), {
    ...value,
    expiresAt: Date.now() + effectiveTtlMs,
  });
}
