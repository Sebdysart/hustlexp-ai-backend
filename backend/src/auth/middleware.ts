// backend/auth/middleware.ts

import { Context } from "hono";
import { adminAuth } from "./firebase"; // UPDATED!
import { redis, CACHE_KEYS } from "../cache/redis";

export interface AuthenticatedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

export async function authenticateRequest(
  c: Context
): Promise<AuthenticatedUser | null> {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log("🔒 No Authorization header");
    return null;
  }

  const token = authHeader.substring(7).trim();

  if (!token || token.length < 10) {
    console.log("🔒 Invalid token format");
    return null;
  }

  // 🔥 Attempt Redis cache (15 minute sessions)
  const cachedSession = await redis.get<string>(CACHE_KEYS.sessionToken(token));
  if (cachedSession) {
    return JSON.parse(cachedSession);
  }

  // 🔥 Verify Firebase ID Token
  try {
    const decoded = await adminAuth.verifyIdToken(token);

    const user: AuthenticatedUser = {
      uid: decoded.uid,
      email: decoded.email || "",
      emailVerified: decoded.email_verified ?? false,
      name: decoded.name || undefined,
    };

    // Cache session for 15 mins
    await redis.set(
      CACHE_KEYS.sessionToken(token),
      JSON.stringify(user),
      15 * 60
    );

    console.log(`✅ Authenticated: ${user.email}`);
    return user;
  } catch (err) {
    console.error("❌ Invalid Firebase token:", err);
    return null;
  }
}

export async function requireAuth(c: Context): Promise<AuthenticatedUser> {
  const user = await authenticateRequest(c);

  if (!user) {
    // IMPORTANT: Throwing errors breaks Hono in prod — return proper response instead.
    return c.json({ error: "Unauthorized" }, 401) as any;
  }

  return user;
}
