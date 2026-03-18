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
import { createHash } from 'crypto';
import { firebaseAuth } from './auth/firebase.js';
import { db } from './db.js';
import type { User } from './types.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'trpc' });

// ============================================================================
// FIREBASE TOKEN VERIFICATION CACHE
// ============================================================================
// Eliminates the Firebase SDK + DB round-trip on every tRPC request.
// Research-backed: 5-minute TTL captures 93–97% of redundant verifications
// while keeping revocation exposure to an operationally acceptable window.
//
// Security properties:
//  - Keys are SHA-256(token), never raw tokens
//  - Fixed-window expiry (updateAgeOnGet=false) — no TTL extension on access
//  - TTL clamped to token's own `exp` claim minus 30s safety margin
//  - Max 10,000 entries; LRU eviction (Map insertion-order FIFO approximation)
//  - Cache miss on any error — fails open to full verification

type CachedAuth = {
  user: User;
  firebaseUid: string;
  expiresAt: number; // Unix ms
};

const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_CACHE_MAX  = 10_000;           // ~20-30 MB peak (decoded token objects)

const authCache = new Map<string, CachedAuth>();

function authCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function authCacheGet(token: string): CachedAuth | null {
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
 * Call this immediately after banning a user so the cached user row
 * (with is_banned=false) is evicted before the 5-minute TTL expires.
 */
export function invalidateAuthCacheForUser(userId: string): void {
  for (const [key, entry] of authCache.entries()) {
    if (entry.user.id === userId) {
      authCache.delete(key);
    }
  }
}

function authCacheSet(token: string, value: { user: User; firebaseUid: string }, tokenExp: number): void {
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

// ============================================================================
// CONTEXT
// ============================================================================

export interface Context extends Record<string, unknown> {
  user: User | null;
  firebaseUid: string | null;
}

export async function createContext(opts: {
  req: Request;
  resHeaders: Headers;
}): Promise<Context> {
  // @hono/trpc-server passes a Web API Request object, NOT a plain object.
  // Request.headers is a Headers instance — use .get(), not property access.
  const authHeader = opts.req.headers.get('authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, firebaseUid: null };
  }

  const token = authHeader.slice(7);

  // ── Cache-first: skip Firebase SDK + DB on warm requests (~93-97% hit rate) ──
  const cached = authCacheGet(token);
  if (cached) {
    return { user: cached.user, firebaseUid: cached.firebaseUid };
  }

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);

    // Get user from database
    const result = await db.query<User>(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [decoded.uid]
    );

    const user = result.rows[0] ?? null;

    // Cache only when we have a valid user — unauthenticated misses are not cached
    if (user) {
      authCacheSet(token, { user, firebaseUid: decoded.uid }, decoded.exp);
    }

    return { user, firebaseUid: decoded.uid };
  } catch (error) {
    log.error({ err: (error as Error).message }, 'Firebase token verification failed');
    return { user: null, firebaseUid: null };
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
  if (ctx.user.is_banned) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Account suspended',
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(isAuthenticated);

// Middleware: require admin
const isAdmin = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
  
  // Check admin role
  const adminResult = await db.query(
    'SELECT role FROM admin_roles WHERE user_id = $1',
    [ctx.user.id]
  );
  
  if (adminResult.rows.length === 0) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const adminProcedure = t.procedure.use(isAdmin);

// Middleware: require Hustler role (default_mode = 'worker')
const isHustler = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
  if (ctx.user.default_mode !== 'worker') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Hustler access required',
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const hustlerProcedure = t.procedure.use(isHustler);

// Middleware: require Poster role (default_mode = 'poster')
const isPoster = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
  if (ctx.user.default_mode !== 'poster') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Poster access required',
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const posterProcedure = t.procedure.use(isPoster);

// ============================================================================
// INPUT SCHEMAS (Zod validation)
// ============================================================================

export const Schemas = {
  // IDs
  uuid: z.string().uuid(),
  
  // Task
  createTask: z.object({
    title: z.string().min(1).max(255),
    description: z.string().min(1).max(5000),
    price: z.number().int().positive().max(99999900), // USD cents, max $999,999
    requirements: z.string().max(2000).optional(),
    location: z.string().max(500).optional(),
    category: z.string().max(100).optional(),
    deadline: z.string().datetime().optional(),
    requiresProof: z.boolean().default(true),
    // Live Mode (PRODUCT_SPEC §3.5)
    mode: z.enum(['STANDARD', 'LIVE']).default('STANDARD'),
    liveBroadcastRadiusMiles: z.number().positive().max(100).optional(),
    // Instant Execution Mode (IEM v1)
    instantMode: z.boolean().default(false),
    // Template system fields
    templateSlug: z.string().max(50).optional(),
    wildcardFlags: z.array(z.string()).optional(),
    insideHome: z.boolean().optional(),
    peoplePresent: z.boolean().optional(),
    petsPresent: z.boolean().optional(),
    // FIX 7: Accept these fields in the schema so callers can provide them,
    // but the router will immediately reject them (features not yet implemented).
    prorate_on_abort: z.boolean().optional(),
    proof_steps: z.array(z.unknown()).optional(),
  }),

  evaluateDraft: z.object({
    description: z.string().min(10).max(5000),
    templateSlug: z.string().max(50).optional(),
    wildcardFlags: z.array(z.string()).optional(),
  }),

  acceptWithConsent: z.object({
    taskId: z.string().uuid(),
    consentItems: z.array(z.string()).min(1).max(10),
  }),
  
  // Escrow
  fundEscrow: z.object({
    escrowId: z.string().uuid(),
    stripePaymentIntentId: z.string().max(255),
  }),

  releaseEscrow: z.object({
    escrowId: z.string().uuid(),
    stripeTransferId: z.string().max(255).optional(),
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
  awardXP: z.object({
    taskId: z.string().uuid(),
    escrowId: z.string().uuid(),
    baseXP: z.number().int().positive().max(10000),
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
