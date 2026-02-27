/**
 * Firebase Auth Middleware — Fastify
 *
 * Provides token verification with a Redis-backed session cache.
 *
 * Security design:
 *  - TOKEN_CACHE_TTL = 5 min  →  revoked tokens are rejected within ≤5 min
 *  - requireFreshToken()       →  bypasses cache and calls verifyIdToken with
 *                                  checkRevoked=true; use on admin / financial routes
 *  - requireAdminFromJWT()     →  validates admin claim from the JWT itself (no DB round-trip)
 *  - requireRole(role)         →  validates role claim stored in the JWT custom claims
 */

import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Firebase Admin initialisation (singleton)
// ---------------------------------------------------------------------------

let firebaseInitialised = false;

function ensureFirebase(): ReturnType<typeof getAuth> | null {
  if (!process.env.FIREBASE_PROJECT_ID ||
      !process.env.FIREBASE_CLIENT_EMAIL ||
      !process.env.FIREBASE_PRIVATE_KEY) {
    return null;
  }

  if (!firebaseInitialised && getApps().length === 0) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    firebaseInitialised = true;
  }

  const apps = getApps();
  return apps.length > 0 ? getAuth(apps[0]) : null;
}

// ---------------------------------------------------------------------------
// Cache — in-process Map (TTL enforced via expiry timestamps)
// No external dependency required; shared across requests in one process.
// ---------------------------------------------------------------------------

/** Cache TTL for verified tokens.  ≤5 min keeps the revocation window tight. */
export const TOKEN_CACHE_TTL = 5 * 60; // 5 minutes (300 seconds)

interface CacheEntry {
  decoded: DecodedIdToken;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, CacheEntry>();

function cacheGet(token: string): DecodedIdToken | null {
  const entry = tokenCache.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenCache.delete(token);
    return null;
  }
  return entry.decoded;
}

function cacheSet(token: string, decoded: DecodedIdToken): void {
  tokenCache.set(token, {
    decoded,
    expiresAt: Date.now() + TOKEN_CACHE_TTL * 1000,
  });
}

// ---------------------------------------------------------------------------
// Core verification helper (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Verify a Firebase ID token.
 *
 * @param token        - Raw Bearer token string
 * @param adminSdk     - Firebase Auth instance (injectable for testing)
 * @param checkRevoked - When true, forces a network call to Firebase to check
 *                       revocation status; bypass cache.  Use on sensitive routes.
 */
export async function verifyTokenWithRevocationCheck(
  token: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminSdk: { auth: () => { verifyIdToken: (t: string, r: boolean) => Promise<DecodedIdToken> } } | any = null,
  checkRevoked = true,
): Promise<DecodedIdToken> {
  const sdk = adminSdk ?? { auth: () => ensureFirebase() };
  const auth = sdk.auth();
  if (!auth) {
    throw new Error('Firebase Admin is not configured — missing credentials');
  }
  return (auth as ReturnType<typeof getAuth>).verifyIdToken(token, checkRevoked);
}

// ---------------------------------------------------------------------------
// Internal: verify with cache (for normal authenticated requests)
// ---------------------------------------------------------------------------

async function verifyWithCache(token: string): Promise<DecodedIdToken | null> {
  // Cache hit
  const cached = cacheGet(token);
  if (cached) return cached;

  // Cache miss — verify via Firebase (checkRevoked=true on first verification)
  const auth = ensureFirebase();
  if (!auth) {
    logger.warn('Firebase Admin not configured — skipping token verification');
    return null;
  }

  try {
    const decoded = await auth.verifyIdToken(token, true); // checkRevoked=true
    cacheSet(token, decoded);
    return decoded;
  } catch (err: unknown) {
    logger.warn({ err: getErrorMessage(err) }, 'Firebase token verification failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// isAuthEnabled
// ---------------------------------------------------------------------------

/**
 * Returns true when Firebase credentials are present in the environment.
 * Can be used to conditionally skip auth in development/test environments.
 */
export function isAuthEnabled(): boolean {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY,
  );
}

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler: require a valid Firebase Bearer token.
 * Token is cached for TOKEN_CACHE_TTL seconds (5 minutes).
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized', code: 'HX_AUTH_REQUIRED' });
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.length < 10) {
    return reply.status(401).send({ error: 'Invalid token format', code: 'HX_AUTH_INVALID' });
  }

  // In environments without Firebase credentials, skip verification
  if (!isAuthEnabled()) {
    logger.warn('Auth disabled (no Firebase credentials) — allowing request in dev mode');
    return;
  }

  const decoded = await verifyWithCache(token);
  if (!decoded) {
    return reply.status(401).send({ error: 'Unauthorized', code: 'HX_AUTH_INVALID' });
  }

  request.user = decoded;
}

// ---------------------------------------------------------------------------
// optionalAuth
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler: validate token if present but do not reject if absent.
 * Populates request.user when a valid token is supplied.
 */
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return;

  const token = authHeader.slice(7).trim();
  if (!token || token.length < 10) return;

  if (!isAuthEnabled()) return;

  const decoded = await verifyWithCache(token);
  if (decoded) request.user = decoded;
}

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler factory: require auth AND a specific role in the JWT custom claims.
 *
 * @example
 *   fastify.post('/api/escrow/create', { preHandler: [requireRole('poster')] }, handler)
 */
export function requireRole(role: string) {
  return async function roleMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await requireAuth(request, reply);
    if (reply.sent) return; // requireAuth already rejected

    const claims = request.user;
    if (!claims) {
      return reply.status(401).send({ error: 'Unauthorized', code: 'HX_AUTH_REQUIRED' });
    }

    // Role can be stored in custom claims as `role` or `roles` (array)
    const userRole: string | undefined = claims['role'] as string | undefined;
    const userRoles: string[] = Array.isArray(claims['roles'])
      ? (claims['roles'] as string[])
      : [];

    if (userRole !== role && !userRoles.includes(role)) {
      return reply.status(403).send({
        error: `Role '${role}' required`,
        code: 'HX_FORBIDDEN_ROLE',
      });
    }
  };
}

// ---------------------------------------------------------------------------
// requireAdminFromJWT
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler: require auth AND admin claim in the JWT.
 * Validates the admin claim cryptographically from the JWT — no DB round-trip.
 */
export async function requireAdminFromJWT(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  const claims = request.user;
  if (!claims) {
    return reply.status(401).send({ error: 'Unauthorized', code: 'HX_AUTH_REQUIRED' });
  }

  const isAdmin = Boolean(claims['admin'] || claims['role'] === 'admin');
  if (!isAdmin) {
    return reply.status(403).send({ error: 'Admin access required', code: 'HX_FORBIDDEN_ADMIN' });
  }
}

// ---------------------------------------------------------------------------
// requireFreshToken — bypass cache, force revocation check
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler: bypass token cache and call verifyIdToken with
 * checkRevoked=true.  Use on admin and financial routes where a stale cached
 * token is unacceptable.
 *
 * PERFORMANCE NOTE: This makes a network call to Firebase on every request.
 * Only apply to admin / financial endpoints.
 */
export async function requireFreshToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user?.uid) {
    return reply.status(401).send({ error: 'Unauthorized', code: 'HX_AUTH_REQUIRED' });
  }

  const token = request.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return reply.status(401).send({ error: 'No token provided', code: 'HX_AUTH_NO_TOKEN' });
  }

  const auth = ensureFirebase();
  if (!auth) {
    // Auth not configured — pass through (dev mode)
    return;
  }

  try {
    const decoded = await auth.verifyIdToken(token, true); // checkRevoked=true
    request.user = decoded;
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    logger.warn({ uid: request.user.uid, error: message }, 'Token revocation check failed');
    return reply.status(401).send({ error: 'Token revoked or expired', code: 'HX_AUTH_REVOKED' });
  }
}
