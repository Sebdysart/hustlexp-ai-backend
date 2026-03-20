// backend/auth/middleware.ts

import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { adminAuth, revokeFirebaseRefreshTokens } from "./firebase.js";
import { redis, CACHE_KEYS } from "../cache/redis.js";
import { authLogger } from "../logger.js";
import { TOKEN_CACHE_TTL_SECONDS, REVOCATION_MARKER_TTL_SECONDS } from "./constants.js";
import { db } from "../db.js";
import { encryptSession, decryptSession } from "../middleware/encrypted-session.js";

export interface AuthenticatedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  is_banned?: boolean;
  account_status?: string;
}

// Redis key for revoked tokens (set when user signs out or changes password)
const REVOKED_KEY = (uid: string) => `auth:revoked:${uid}`;

export async function authenticateRequest(
  c: Context
): Promise<AuthenticatedUser | null> {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7).trim();

  if (!token || token.length < 10) {
    authLogger.warn("Invalid token format (too short)");
    return null;
  }

  // 🔥 Attempt Redis cache (5 minute sessions — keeps revocation window ≤5 min)
  const cachedSession = await redis.get<string>(CACHE_KEYS.sessionToken(token));
  if (cachedSession) {
    const user = decryptSession<AuthenticatedUser>(cachedSession);
    if (!user) {
      // Decryption failed — tampered or wrong key; evict and re-verify
      try { await redis.del(CACHE_KEYS.sessionToken(token)); } catch (_) { /* ignore */ }
      // Fall through to Firebase verification
    } else {
      // Check if user's tokens have been revoked since caching
      const revokedAt = await redis.get<string>(REVOKED_KEY(user.uid));
      if (revokedAt) {
        // Token was cached before revocation — invalidate and re-verify
        authLogger.info({ uid: user.uid }, "Cached session invalidated by revocation");
        try {
          await redis.del(CACHE_KEYS.sessionToken(token));
        } catch (err) {
          authLogger.error({ err }, '[auth] Failed to delete revoked session from cache — continuing with Firebase re-verification');
        }
        // Fall through to Firebase verification with checkRevoked
      } else {
        // A47-7 FIX: Check if the cached user has since been banned, suspended, or GDPR-deleted.
        // The ban status is stored in the cached session (populated from DB at cache-write time).
        // If the status is stale (user was banned after this cache entry was written), fall through
        // to Firebase re-verification which will perform a fresh DB ban-check.
        if (user.is_banned || user.account_status === 'SUSPENDED' || user.account_status === 'DELETED') {
          authLogger.warn({ uid: user.uid, is_banned: user.is_banned, account_status: user.account_status }, '[auth] Cached session rejected — user is banned/suspended/deleted; invalidating cache and re-verifying');
          try {
            await redis.del(CACHE_KEYS.sessionToken(token));
          } catch (err) {
            authLogger.error({ err }, '[auth] Failed to delete banned/suspended/deleted user session from cache — continuing with Firebase re-verification');
          }
          // Fall through to Firebase verification (which will re-check DB ban status)
        } else {
          return user;
        }
      }
    }
  }

  // 🔥 Verify Firebase ID Token (with revocation check)
  try {
    const decoded = await adminAuth.verifyIdToken(token, true); // checkRevoked = true

    const user: AuthenticatedUser = {
      uid: decoded.uid,
      email: decoded.email || "",
      emailVerified: decoded.email_verified ?? false,
      name: decoded.name || undefined,
    };

    // Check DB for ban/suspension/deletion — ensures non-tRPC Hono routes also enforce these states
    // Also populate is_banned/account_status on the user object so the warm-cache path (FIX A47-7)
    // can detect freshly-banned users without a full Firebase re-verification.
    try {
      const { rows: userRows } = await db.query<{ is_banned: boolean; account_status: string }>(
        'SELECT is_banned, account_status FROM users WHERE firebase_uid = $1',
        [decoded.uid]
      );
      if (userRows.length > 0) {
        const dbUser = userRows[0];
        if (dbUser.is_banned || dbUser.account_status === 'SUSPENDED' || dbUser.account_status === 'DELETED') {
          authLogger.warn({ uid: decoded.uid, is_banned: dbUser.is_banned, account_status: dbUser.account_status }, '[auth] Rejected banned/suspended/deleted user at Hono auth middleware');
          return null; // Rejected — route will return 401
        }
        // Store ban/status in the session so warm-cache checks (A47-7) can detect state changes.
        user.is_banned = dbUser.is_banned;
        user.account_status = dbUser.account_status;
      }
    } catch (err) {
      // INTENTIONAL FAIL-OPEN: DB errors must not block authentication — this is
      // a deliberate availability trade-off.  If the DB is unreachable we accept
      // the risk of a banned/suspended user making requests rather than denying
      // auth to all users.  DO NOT change this to fail-closed without evaluating
      // the blast radius of a DB outage on the entire user base.
      //
      // BUG 6 FIX: log at ERROR level with a clear SECURITY DEGRADED marker so
      // on-call engineers are alerted that ban enforcement is degraded.
      authLogger.error({ err, uid: decoded.uid }, '[auth] DB ban-check failed — proceeding without ban enforcement. SECURITY DEGRADED.');
      // NOTE: If this fires repeatedly, investigate DB connectivity / pool exhaustion.
      // A metric/alert should be wired to this log line in your observability stack.
    }

    // Cache session for 5 mins (TOKEN_CACHE_TTL_SECONDS) — reduces revocation window to ≤5 min
    try {
      await redis.set(
        CACHE_KEYS.sessionToken(token),
        encryptSession(user),
        TOKEN_CACHE_TTL_SECONDS
      );
    } catch (err) {
      // Log CRITICAL if session cache write fails — defense-in-depth degraded.
      // Do NOT fail authentication; the user is still verified by Firebase.
      authLogger.error({ err, uid: user.uid }, '[auth] CRITICAL: failed to write session cache — revocation window degraded, continuing');
    }

    return user;
  } catch (err: unknown) {
    // Firebase throws specific error for revoked tokens
    if ((err as Record<string, unknown>)?.code === "auth/id-token-revoked") {
      authLogger.warn("Token has been revoked");
      return null;
    }
    authLogger.error({ err }, "Firebase token verification failed");
    return null;
  }
}

export async function requireAuth(c: Context): Promise<AuthenticatedUser> {
  const user = await authenticateRequest(c);

  if (!user) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  return user;
}

/**
 * Revoke all cached sessions for a user.
 * Call this when:
 * - User signs out
 * - User changes password
 * - Admin force-revokes tokens
 *
 * Sets a revocation marker in Redis that causes cached sessions
 * to be invalidated on next use.
 */
export async function revokeUserSessions(uid: string): Promise<void> {
  try {
    await redis.set(REVOKED_KEY(uid), new Date().toISOString(), REVOCATION_MARKER_TTL_SECONDS); // 6 min (> 5 min cache TTL)
  } catch (err) {
    // Log CRITICAL — revocation marker failed to write; Redis is the primary protection mechanism here.
    // The Firebase token revocation below still runs as a second line of defense.
    authLogger.error({ uid, err }, '[auth] CRITICAL: failed to write revocation marker to Redis — ban/suspend protection degraded');
  }
  authLogger.info({ uid }, "User sessions revoked");

  // Also revoke Firebase refresh tokens so checkRevoked=true works after Redis TTL expires
  try {
    await revokeFirebaseRefreshTokens(uid);
  } catch (firebaseErr) {
    // Log but don't fail — Redis marker provides short-term protection
    authLogger.warn({ uid, err: firebaseErr }, 'Failed to revoke Firebase refresh tokens — Redis marker still active');
  }
}
