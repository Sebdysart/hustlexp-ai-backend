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
import { db } from './db.js';

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
 *
 * The Redis revocation key is keyed on firebaseUid (not the DB UUID) because
 * trpc.ts and auth/middleware.ts both look up `auth:revoked:<firebaseUid>`.
 * If firebaseUid is known at the call site, pass it directly.  Otherwise,
 * this function collects it from any matching in-process cache entries it evicts.
 */
/**
 * Invalidate all auth cache entries for a given user ID.
 *
 * @param writeRevocationMarker - When true (default), also writes a Redis
 *   revocation marker keyed on firebaseUid so every replica sees the
 *   invalidation signal immediately.  Pass false for role-change paths
 *   (grantAdminRole / revokeAdminRole) — the in-process cache is still
 *   evicted so the new is_admin value loads on the next request, but no
 *   Redis ban marker is written.  Writing a revocation marker on a role
 *   change causes 12 minutes of forced Firebase round-trips unnecessarily.
 *   Ban and suspend paths should always use the default (true).
 */
export async function invalidateAuthCacheForUser(userId: string, firebaseUid?: string, writeRevocationMarker: boolean = true): Promise<void> {
  // 1. Evict in-process cache entries for this user and collect firebaseUid
  //    from the evicted entries if not supplied by the caller.
  const collectedFirebaseUids = new Set<string>(firebaseUid ? [firebaseUid] : []);
  for (const [key, entry] of authCache.entries()) {
    if (entry.user.id === userId) {
      collectedFirebaseUids.add(entry.firebaseUid);
      authCache.delete(key);
    }
  }

  // Skip Redis revocation marker write when the caller explicitly opts out
  // (e.g. admin role grant/revoke — in-process eviction above is sufficient).
  if (!writeRevocationMarker) return;

  // 1b. If no firebaseUid was supplied and none was collected from the
  //     in-process cache (e.g. this replica never saw the user, or all
  //     entries had already expired), fall back to a DB lookup so the
  //     Redis revocation marker is still written on every replica that
  //     handles the ban/suspend/delete operation.
  if (collectedFirebaseUids.size === 0 && userId) {
    try {
      const row = await db.query<{ firebase_uid: string }>(
        'SELECT firebase_uid FROM users WHERE id = $1',
        [userId]
      );
      if (row.rows[0]) {
        const fuid = row.rows[0].firebase_uid;
        if (fuid) collectedFirebaseUids.add(fuid);
      }
    } catch (err) {
      console.error(
        `[auth-cache] Failed to fetch firebase_uid for userId=${userId} during invalidation:`,
        err,
      );
    }
  }

  // 2. Write a Redis revocation marker keyed on firebaseUid so the Redis
  //    session cache used by auth/middleware.ts and the tRPC createContext
  //    cross-invalidation check both see the signal immediately.
  //
  //    BUG GG1 FIX: the key MUST use firebaseUid (not the DB userId) because
  //    trpc.ts line ~79 reads `auth:revoked:<cached.firebaseUid>` and
  //    middleware.ts reads `auth:revoked:<user.uid>` — both are Firebase UIDs.
  //    Using the DB UUID here means the markers are never matched.
  const now = new Date().toISOString();
  for (const fuid of collectedFirebaseUids) {
    try {
      // BUG GG3 FIX: await the Redis write and catch errors so a Redis failure
      // is logged rather than silently swallowed.  We do not re-throw because
      // the in-process cache has already been evicted above — the operation
      // should not be rolled back on a Redis error.
      await redis.set(REDIS_REVOKED_KEY(fuid), now, REVOCATION_MARKER_TTL_SECONDS);
    } catch (err) {
      // Log but do not re-throw — in-process eviction already happened.
      // A Redis failure degrades cross-replica invalidation but must not
      // prevent the ban/delete operation from completing.
      console.error(
        `[auth-cache] Failed to write Redis revocation marker for firebaseUid=${fuid}:`,
        err,
      );
    }
  }
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
