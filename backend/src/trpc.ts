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
import { authCacheGet, authCacheSet } from './auth-cache.js';
import { redis } from './cache/redis.js';

// Matches the revocation marker key written by invalidateAuthCacheForUser
// (auth-cache.ts) and revokeUserSessions (auth/middleware.ts).
const REDIS_REVOKED_KEY = (uid: string) => `auth:revoked:${uid}`;

// Re-export so existing callers (admin.ts etc.) don't need to change their import.
export { invalidateAuthCacheForUser } from './auth-cache.js';

const log = logger.child({ module: 'trpc' });

// ============================================================================
// CONTEXT
// ============================================================================

export interface Context extends Record<string, unknown> {
  user: User | null;
  firebaseUid: string | null;
  // Raw request — only read by procedures that need it (e.g. draftEstimate
  // derives an IP key for anonymous rate limiting). Middlewares that narrow
  // the context (isAuthenticated, isAdmin, isHustler, isPoster) drop this,
  // which is intentional: only publicProcedure paths can opt into it.
  req?: Request;
}

export async function createContext(opts: {
  req: Request;
  resHeaders: Headers;
}): Promise<Context> {
  const authHeader = opts.req.headers.get('authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, firebaseUid: null, req: opts.req };
  }

  const token = authHeader.slice(7);

  const cached = authCacheGet(token);
  if (cached) {
    const revokedAt = await redis.get<string>(REDIS_REVOKED_KEY(cached.firebaseUid));
    if (revokedAt) {
      log.info({ uid: cached.firebaseUid }, 'tRPC cache hit invalidated by Redis revocation marker');
    } else {
      return { user: cached.user, firebaseUid: cached.firebaseUid, req: opts.req };
    }
  }

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);

    const result = await db.query<User>(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [decoded.uid]
    );

    const user = result.rows[0] ?? null;

    if (user) {
      const adminResult = await db.query(
        'SELECT 1 FROM admin_roles WHERE user_id = $1 LIMIT 1',
        [user.id]
      );
      user.is_admin = adminResult.rows.length > 0;

      const isInactive =
        user.is_banned ||
        user.account_status === 'SUSPENDED' ||
        user.account_status === 'DELETED';

      if (!isInactive) {
        authCacheSet(token, { user, firebaseUid: decoded.uid }, decoded.exp);
      }
    }

    return { user, firebaseUid: decoded.uid, req: opts.req };
  } catch (error) {
    const rawMsg = (error as Error).message ?? '';
    const safeMsg = rawMsg.replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*/g, '[REDACTED_TOKEN]');
    log.error({ err: safeMsg }, 'Firebase token verification failed');
    return { user: null, firebaseUid: null, req: opts.req };
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
      stack: undefined,
    },
  }),
});

export const router = t.router;
export const publicProcedure = t.procedure;

// AUDIT FIX (P9): All four middleware functions below now pass only the
// narrowed fields to next() instead of spreading ...ctx. This allows
// TypeScript to infer ctx.user as User (non-null) in downstream procedures,
// eliminating the need for ! assertions or redundant null checks in the
// 39 router files that access ctx.user.

const isAuthenticated = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
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
  return next({ ctx: { user: ctx.user, firebaseUid: ctx.firebaseUid } });
});

export const protectedProcedure = t.procedure.use(isAuthenticated);

const isAdmin = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }

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

  return next({ ctx: { user: ctx.user, firebaseUid: ctx.firebaseUid } });
});

export const adminProcedure = t.procedure.use(isAdmin);

const isHustler = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
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
  if (ctx.user.default_mode !== 'worker') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Hustler access required',
    });
  }
  return next({ ctx: { user: ctx.user, firebaseUid: ctx.firebaseUid } });
});

export const hustlerProcedure = t.procedure.use(isHustler);

const isPoster = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
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
  if (ctx.user.default_mode !== 'poster') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Poster access required',
    });
  }
  return next({ ctx: { user: ctx.user, firebaseUid: ctx.firebaseUid } });
});

export const posterProcedure = t.procedure.use(isPoster);

// ============================================================================
// INPUT SCHEMAS (Zod validation)
// ============================================================================

export const Schemas = {
  uuid: z.string().uuid(),
  
  createTask: z.object({
    title: z.string().min(1).max(255),
    description: z.string().trim().min(10).max(5000),
    price: z.number().int().positive().max(99999900),
    requirements: z.string().max(2000).optional(),
    location: z.string().max(500).optional(),
    category: z.string().max(100).optional(),
    deadline: z.string().datetime().optional(),
    requiresProof: z.boolean().default(true),
    mode: z.enum(['STANDARD', 'LIVE']).default('STANDARD'),
    liveBroadcastRadiusMiles: z.number().positive().max(100).optional(),
    instantMode: z.boolean().default(false),
    templateSlug: z.string().max(50).optional(),
    wildcardFlags: z.array(z.string().max(100)).max(20).optional(),
    insideHome: z.boolean().optional(),
    peoplePresent: z.boolean().optional(),
    petsPresent: z.boolean().optional(),
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
    consentItems: z.array(z.string()).min(1).max(10),
  }),
  
  fundEscrow: z.object({
    escrowId: z.string().uuid(),
    stripePaymentIntentId: z.string().min(1).max(255),
  }),

  releaseEscrow: z.object({
    escrowId: z.string().uuid(),
    stripeTransferId: z.string().min(1).max(255),
  }),
  
  submitProof: z.object({
    taskId: z.string().uuid(),
    description: z.string().max(2000).optional(),
  }),

  reviewProof: z.object({
    proofId: z.string().uuid(),
    decision: z.enum(['ACCEPTED', 'REJECTED']),
    reason: z.string().max(1000).optional(),
  }),
  
  awardXP: z.object({
    taskId: z.string().uuid(),
    escrowId: z.string().uuid(),
  }),
  
  pagination: z.object({
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  }),

  cursorPagination: z.object({
    cursor: z.string().nullish(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  
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
