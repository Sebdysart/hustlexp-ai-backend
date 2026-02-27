// backend/auth/middleware.ts

import { Context } from "hono";
import { adminAuth } from "./firebase";
import { redis, CACHE_KEYS } from "../cache/redis";
import { authLogger } from "../logger";
import { TOKEN_CACHE_TTL_SECONDS, REVOCATION_MARKER_TTL_SECONDS } from "./constants.js";

export interface AuthenticatedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
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
    const user: AuthenticatedUser = JSON.parse(cachedSession);

    // Check if user's tokens have been revoked since caching
    const revokedAt = await redis.get<string>(REVOKED_KEY(user.uid));
    if (revokedAt) {
      // Token was cached before revocation — invalidate and re-verify
      authLogger.info({ uid: user.uid }, "Cached session invalidated by revocation");
      await redis.del(CACHE_KEYS.sessionToken(token));
      // Fall through to Firebase verification with checkRevoked
    } else {
      return user;
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

    // Cache session for 5 mins (TOKEN_CACHE_TTL_SECONDS) — reduces revocation window to ≤5 min
    await redis.set(
      CACHE_KEYS.sessionToken(token),
      JSON.stringify(user),
      TOKEN_CACHE_TTL_SECONDS
    );

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
    // IMPORTANT: Throwing errors breaks Hono in prod — return proper response instead.
    return c.json({ error: "Unauthorized" }, 401) as unknown as AuthenticatedUser;
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
  await redis.set(REVOKED_KEY(uid), new Date().toISOString(), REVOCATION_MARKER_TTL_SECONDS); // 6 min (> 5 min cache TTL)
  authLogger.info({ uid }, "User sessions revoked");
}
