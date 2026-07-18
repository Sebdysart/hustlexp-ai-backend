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
import { db } from './db.js';
import { type AuthedContext, type Context } from './trpc-context.js';

// Re-export so existing callers (admin.ts etc.) don't need to change their import.
export { invalidateAuthCacheForUser } from './auth-cache.js';
export { createContext } from './trpc-context.js';
export type { AuthedContext, Context } from './trpc-context.js';

// ============================================================================
// FIREBASE TOKEN VERIFICATION CACHE
// ============================================================================
// The cache implementation lives in auth-cache.ts (isolated module so services
// can call invalidateAuthCacheForUser without importing Firebase/db side-effects).
// See auth-cache.ts for security properties and eviction policy.
// ============================================================================

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
  return next({ ctx: { ...ctx, user: ctx.user } as AuthedContext });
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

  return next({ ctx: { ...ctx, user: ctx.user } as AuthedContext });
});

export const adminProcedure = protectedProcedure.use(isAdminCheck);

const isAdminOrEngineBridge = t.middleware(async ({ ctx, next }) => {
  if (ctx.engineBridgeAuthorized === true && ctx.engineBridgeActorId) {
    return next({ ctx });
  }
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  if (ctx.user.is_banned || ['SUSPENDED', 'DELETED'].includes(ctx.user.account_status)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Account suspended.' });
  }
  let isAdmin = ctx.user.is_admin;
  if (isAdmin === undefined) {
    const result = await db.query(
      'SELECT role FROM admin_roles WHERE user_id = $1 AND role = ANY($2::text[])',
      [ctx.user.id, ['admin', 'support', 'finance', 'moderator', 'founder']],
    );
    isAdmin = result.rows.length > 0;
  }
  if (!isAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin or engine bridge access required' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } as AuthedContext });
});

export const adminOrEngineBridgeProcedure = t.procedure.use(isAdminOrEngineBridge);

// Middleware: require Hustler role (default_mode = 'worker') — composed on top of isAuthenticated.
// Ban/suspension/auth checks are already handled by isAuthenticated; this only does the role check.
const isHustlerCheck = t.middleware(async ({ ctx, next }) => {
  if (ctx.user!.default_mode !== 'worker') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Hustler access required',
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } as AuthedContext });
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
  return next({ ctx: { ...ctx, user: ctx.user } as AuthedContext });
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
    hustlerPayoutCents: z.number().int().positive().max(99999900).optional(),
    platformMarginCents: z.number().int().nonnegative().max(99999900).optional(),
    requirements: z.string().trim().max(2000).optional(),
    /** Exact address. Stored in the location vault and never returned in public task feeds. */
    location: z.string().max(500).optional(),
    /** City/region label safe to expose before a reservation exists. */
    roughArea: z.string().trim().min(2).max(120).optional(),
    clientIdempotencyKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/).optional(),
    isTest: z.boolean().optional(),
    category: z.string().trim().max(100).optional(),
    deadline: z.string().datetime().optional(),
    dispatchExpiresAt: z.string().datetime().optional(),
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
