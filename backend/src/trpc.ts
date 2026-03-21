/**
 * HustleXP tRPC Router v1.0.0
 * 
 * CONSTITUTIONAL: Layer 2 API
 * 
 * Exposes services via type-safe tRPC endpoints.
 * Authentication via Firebase middleware.
 * 
 * @see ARCHITECTURE.md §1
 */

import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import { firebaseAuth } from './auth/firebase.js';
import { db } from './db.js';
import type { User } from './types.js';
import { logger } from './logger.js';
import { authCache, authCacheKey, authCacheGet, authCacheSet } from './auth-cache.js';
import { redis } from './cache/redis.js';

// Matches the revocation marker key written by invalidateAuthCacheForUser
// (auth-cache.ts) and revokeUserSessions (auth/middleware.ts).
const REDIS_REVOKED_KEY = (uid: string) => `auth:revoked:${uid}`;

// Re-export so existing callers (admin.ts etc.) don't need to change their import.
export { invalidateAuthCacheForUser } from './auth-cache.js';

const log = logger.child({ module: 'trpc' });

// ============================================================================
// FIREBASE TOKEN VERIFICATION CACHE
// ============================================================================
// The cache implementation lives in auth-cache.ts (isolated module so services
// can call invalidateAuthCacheForUser without importing Firebase/db side-effects).
// See auth-cache.ts for security properties and eviction policy.
// ============================================================================

// ============================================================================
// CONTEXT
// ============================================================================

export interface Context extends Record<string, unknown> {
  user: User | null;
  firebaseUid: string | null;
  /** Server-derived client IP — extracted from x-forwarded-for / x-real-ip headers. Never caller-supplied. */
  ip: string | null;
}

function extractIp(req: Request): string | null {
  // cf-connecting-ip: set by Cloudflare directly from the TCP connection;
  // cannot be forged by the client regardless of what they put in XFF.
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim() || null;

  // X-Forwarded-For: use the RIGHTMOST entry, which is appended by our
  // trusted reverse proxy and cannot be forged by the client.
  // A-22: NEVER use the leftmost entry — it is client-controlled and allows
  // an attacker to spoof arbitrary IPs to bypass rate limiting.
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    return parts[parts.length - 1] ?? null;
  }

  // x-real-ip: set by nginx/proxies from the connection address.
  return req.headers.get('x-real-ip') || null;
}

export async function createContext(opts: {
  req: Request;
  resHeaders: Headers;
}): Promise<Context> {
  // @hono/trpc-server passes a Web API Request object, NOT a plain object.
  // Request.headers is a Headers instance — use .get(), not property access.
  const authHeader = opts.req.headers.get('authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, firebaseUid: null, ip: extractIp(opts.req) };
  }

  const token = authHeader.slice(7);

  // ── Cache-first: skip Firebase SDK + DB on warm requests (~93-97% hit rate) ──
  const cached = authCacheGet(token);
  if (cached) {
    // Cross-invalidation check: if a Redis revocation marker exists (written by
    // invalidateAuthCacheForUser or revokeUserSessions) the in-process cache
    // entry is stale — evict it and fall through to Firebase re-verification.
    // A-05 FIX: Wrap redis.get in try/catch so a Redis outage does not cause
    // createContext to throw a 500 on every authenticated request. On failure,
    // fall through to Firebase re-verification as a safe degraded path.
    try {
      const revokedAt = await redis.get<string>(REDIS_REVOKED_KEY(cached.firebaseUid));
      if (revokedAt) {
        log.info({ uid: cached.firebaseUid }, 'tRPC cache hit invalidated by Redis revocation marker');
        // Evict the stale in-process cache entry immediately so it cannot be
        // served again on this replica before the 5-minute TTL expires.
        authCache.delete(authCacheKey(token));
        // Fall through to Firebase re-verification below.
      } else {
        return { user: cached.user, firebaseUid: cached.firebaseUid, ip: extractIp(opts.req) };
      }
    } catch (redisErr) {
      log.warn({ err: redisErr }, 'Redis unavailable for revocation check — falling through to Firebase verify');
      // Fall through to Firebase re-verification below.
    }
  }

  try {
    const decoded = await firebaseAuth.verifyIdToken(token, true); // checkRevoked = true (explicit, not relying on default)

    // Get user from database
    const result = await db.query<User>(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [decoded.uid]
    );

    const user = result.rows[0] ?? null;

    if (user) {
      // Populate is_admin from admin_roles table so escrow and other routers can use ctx.user.is_admin.
      // A46-2 FIX: Use the same role allowlist as isAdminCheck's fallback path. The previous
      // `SELECT 1` accepted any admin_roles row regardless of role value, creating an
      // inconsistency: the fast-path (warm requests) would grant admin to any role, while
      // the fallback path (undefined is_admin) correctly filtered by VALID_ADMIN_ROLES.
      // Now both paths use identical role allowlist logic.
      const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'];
      const adminResult = await db.query(
        'SELECT 1 FROM admin_roles WHERE user_id = $1 AND role = ANY($2::text[]) LIMIT 1',
        [user.id, VALID_ADMIN_ROLES]
      );
      user.is_admin = adminResult.rows.length > 0;

      // Do NOT cache banned/suspended/deleted users. If we cache them, every subsequent
      // request hits the in-process cache instead of falling through to the revocation
      // check, which means the isAuthenticated middleware's ban guard is the only
      // protection — and the Redis revocation marker keeps triggering a full Firebase
      // round-trip on cache miss, draining Firebase quota. Skipping the cache ensures
      // the revocation marker stays effective and subsequent requests stay cheap.
      const isInactive =
        user.is_banned ||
        user.account_status === 'SUSPENDED' ||
        user.account_status === 'DELETED';

      if (!isInactive) {
        authCacheSet(token, { user, firebaseUid: decoded.uid }, decoded.exp);
      }
    }

    return { user, firebaseUid: decoded.uid, ip: extractIp(opts.req) };
  } catch (error) {
    // SECURITY FIX (v2.9.4): Firebase Admin SDK error messages sometimes embed
    // the raw JWT in their text. Strip any JWT-shaped segments before logging to
    // prevent token leakage into log streams.
    const rawMsg = (error as Error).message ?? '';
    const safeMsg = rawMsg.replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*/g, '[REDACTED_TOKEN]');
    log.error({ err: safeMsg }, 'Firebase token verification failed');
    return { user: null, firebaseUid: null, ip: extractIp(opts.req) };
  }
}

// ============================================================================
// TRPC INITIALIZATION
// ============================================================================

const t = initTRPC.context<Context>().create({
  errorFormatter: ({ shape }) => ({
    ...shape,
    data: {
      ...shape.data,
      // Strip stack traces in production to prevent information leakage
      stack: undefined,
    },
  }),
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Middleware: require authentication
const isAuthenticated = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
  // Secondary defense: check is_banned on every request even if the auth cache
  // still holds the pre-ban user row (cache TTL up to 5 min after ban is set).
  // Also block SUSPENDED accounts — FraudDetectionService sets account_status
  // before (or instead of) flipping is_banned. Both must block API access.
  // Also block DELETED accounts — GDPR erasure sets account_status='DELETED'.
  if (
    ctx.user.is_banned ||
    ctx.user.account_status === 'SUSPENDED' ||
    ctx.user.account_status === 'DELETED'
  ) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Account suspended.',
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(isAuthenticated);

// Middleware: require admin role — composed on top of isAuthenticated (via protectedProcedure).
// Ban/suspension/auth checks are already handled by isAuthenticated; this only does the role check.
const isAdminCheck = t.middleware(async ({ ctx, next }) => {
  // ctx.user is guaranteed non-null and not banned by isAuthenticated (already ran).
  // createContext already populated user.is_admin from admin_roles — use that
  // directly to avoid a redundant DB round-trip on every admin request.
  // Only fall back to a DB query if is_admin is undefined (not yet populated).
  let isAdmin = ctx.user!.is_admin;
  if (isAdmin === undefined) {
    const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'];
    const adminResult = await db.query(
      'SELECT role FROM admin_roles WHERE user_id = $1 AND role = ANY($2::text[])',
      [ctx.user!.id, VALID_ADMIN_ROLES]
    );
    isAdmin = adminResult.rows.length > 0;
  }

  if (!isAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }

  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const adminProcedure = protectedProcedure.use(isAdminCheck);

// Middleware: require Hustler role (default_mode = 'worker') — composed on top of isAuthenticated.
// Ban/suspension/auth checks are already handled by isAuthenticated; this only does the role check.
const isHustlerCheck = t.middleware(async ({ ctx, next }) => {
  if (ctx.user!.default_mode !== 'worker') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Hustler access required',
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const hustlerProcedure = protectedProcedure.use(isHustlerCheck);

// Middleware: require Poster role (default_mode = 'poster') — composed on top of isAuthenticated.
// Ban/suspension/auth checks are already handled by isAuthenticated; this only does the role check.
const isPosterCheck = t.middleware(async ({ ctx, next }) => {
  if (ctx.user!.default_mode !== 'poster') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Poster access required',
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const posterProcedure = protectedProcedure.use(isPosterCheck);

// ============================================================================
// INPUT SCHEMAS (Zod validation)
// ============================================================================

export const Schemas = {
  // IDs
  uuid: z.string().uuid(),
  
  // Task
  createTask: z.object({
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().min(10).max(5000),
    price: z.number().int().positive().max(99999900), // USD cents, max $999,999
    requirements: z.string().trim().max(2000).optional(),
    location: z.string().max(500).optional(),
    category: z.string().trim().max(100).optional(),
    deadline: z.string().datetime().optional(),
    requiresProof: z.boolean().default(true),
    // Live Mode (PRODUCT_SPEC §3.5)
    mode: z.enum(['STANDARD', 'LIVE']).default('STANDARD'),
    liveBroadcastRadiusMiles: z.number().positive().max(100).optional(),
    // Instant Execution Mode (IEM v1)
    instantMode: z.boolean().default(false),
    // Template system fields
    templateSlug: z.string().max(50).optional(),
    wildcardFlags: z.array(z.string().max(100)).max(20).optional(),
    insideHome: z.boolean().optional(),
    peoplePresent: z.boolean().optional(),
    petsPresent: z.boolean().optional(),
    // FIX 7: Accept these fields in the schema so callers can provide them,
    // but the router will immediately reject them (features not yet implemented).
    prorate_on_abort: z.boolean().optional(),
    proof_steps: z.array(z.object({ step: z.string().max(500) }).strict()).max(50).optional(),
  }),

  evaluateDraft: z.object({
    description: z.string().min(10).max(5000),
    templateSlug: z.string().max(50).optional(),
    wildcardFlags: z.array(z.string().max(100)).max(20).optional(),
  }),

  acceptWithConsent: z.object({
    taskId: z.string().uuid(),
    consentItems: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  }),
  
  // Escrow
  fundEscrow: z.object({
    escrowId: z.string().uuid(),
    stripePaymentIntentId: z.string().min(1).max(255),
  }),

  releaseEscrow: z.object({
    escrowId: z.string().uuid(),
    // stripeTransferId is required for poster-initiated releases so the caller
    // must have already created the Stripe transfer before marking escrow as
    // released.  Admin override releases use the separate adminRelease procedure
    // where this field remains optional.
    stripeTransferId: z.string().min(1).max(255),
  }),
  
  // Proof
  submitProof: z.object({
    taskId: z.string().uuid(),
    description: z.string().max(2000).optional(),
  }),

  reviewProof: z.object({
    proofId: z.string().uuid(),
    decision: z.enum(['ACCEPTED', 'REJECTED']),
    reason: z.string().max(1000).optional(),
  }),
  
  // XP
  // SECURITY FIX: baseXP removed from user-facing schema — derived server-side
  // from the escrow amount to prevent caller-controlled XP inflation.
  awardXP: z.object({
    taskId: z.string().uuid(),
    escrowId: z.string().uuid(),
  }),
  
  // Offset-based pagination (legacy — for admin/internal endpoints where drift is acceptable)
  pagination: z.object({
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  }),

  // Cursor-based pagination (preferred for iOS infinite scroll — stable across concurrent writes)
  // Cursor is an opaque base64url-encoded string pointing to the last-seen item.
  // Pass `nextCursor` from the previous response as `cursor` on the next request.
  cursorPagination: z.object({
    cursor: z.string().nullish(), // null/undefined = fetch from beginning
    limit: z.number().int().min(1).max(100).default(20),
  }),
  
  // Onboarding AI
  submitCalibration: z.object({
    calibrationPrompt: z.string().min(1).max(5000),
    onboardingVersion: z.string().max(20).default('1.0.0'),
  }),
  
  confirmRole: z.object({
    confirmedMode: z.enum(['worker', 'poster']),
    overrideAI: z.boolean().default(false),
  }),
};

export type Schemas = typeof Schemas;
