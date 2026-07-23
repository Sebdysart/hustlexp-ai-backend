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
import { PAYMENT_CREATION_FROZEN_CODE } from './services/NewPaymentCreationGuard.js';
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

function publicApplicationCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || Array.isArray(cause)) return undefined;
  const code = (cause as { applicationCode?: unknown }).applicationCode;
  return code === PAYMENT_CREATION_FROZEN_CODE ? code : undefined;
}

export function publicTRPCErrorShape<T extends { message: string; data: { code?: string; stack?: string } }>(
  shape: T,
  error?: { cause?: unknown },
): T & { data: T['data'] & { applicationCode?: string } } {
  const applicationCode = publicApplicationCode(error?.cause);
  return {
    ...shape,
    message: shape.data.code === 'INTERNAL_SERVER_ERROR' ? 'Internal server error' : shape.message,
    data: {
      ...shape.data,
      stack: undefined,
      ...(applicationCode ? { applicationCode } : {}),
    },
  };
}

const t = initTRPC.context<Context>().create({
  // Never expose raw database/provider exception messages or stack traces on
  // INTERNAL_SERVER_ERROR responses. Safe 4xx messages remain actionable.
  errorFormatter: ({ shape, error }) => publicTRPCErrorShape(shape, error),
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

/** @deprecated Use a consequence-specific capability procedure below. */
export const adminProcedure = protectedProcedure.use(isAdminCheck);

type AdminCapability =
  | 'can_access_financials'
  | 'can_ban_users'
  | 'can_manage_incidents'
  | 'can_manage_operations'
  | 'can_modify_trust'
  | 'can_override_escrow'
  | 'can_resolve_disputes';

const PRIVILEGED_ADMIN_ROLES = ['admin', 'founder'] as const;
const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'] as const;

/**
 * Require a current administrator role plus an explicit capability for
 * high-impact Operations actions. Admin and founder retain break-glass access;
 * support, finance, and moderator identities receive only the capabilities
 * persisted on their admin_roles row. The capability identifier is selected
 * exclusively from the closed union above, so it is safe to interpolate as a
 * SQL column name.
 */
function capabilityAdminMiddleware(capability: AdminCapability | null) {
  return t.middleware(async ({ ctx, next }) => {
    // createContext sets this to false after a role-table lookup. Fail before
    // any secondary query so ordinary authenticated users cannot exercise or
    // time capability-specific database paths.
    if (ctx.user!.is_admin === false) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator access required' });
    }
    const capabilitySelection = capability
      ? `, COALESCE(${capability}, false) AS capability_granted`
      : '';
    const result = await db.query<{ role: string; capability_granted?: boolean }>(
      `SELECT role${capabilitySelection}
       FROM admin_roles
       WHERE user_id = $1 AND role = ANY($2::text[])
       LIMIT 1`,
      [ctx.user!.id, [...VALID_ADMIN_ROLES]],
    );
    const row = result.rows[0];
    const privileged = Boolean(row && PRIVILEGED_ADMIN_ROLES.includes(
      row.role as (typeof PRIVILEGED_ADMIN_ROLES)[number],
    ));
    if (!row || (!privileged && capability !== null && row.capability_granted !== true)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: capability ? 'Required administrator capability missing' : 'Platform administrator access required',
      });
    }
    if (capability === null && !privileged) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Platform administrator access required' });
    }
    return next({ ctx: { ...ctx, user: ctx.user } as AuthedContext });
  });
}

export const platformAdminProcedure = protectedProcedure.use(capabilityAdminMiddleware(null));
export const financialAdminProcedure = protectedProcedure.use(capabilityAdminMiddleware('can_access_financials'));
export const escrowAdminProcedure = protectedProcedure.use(capabilityAdminMiddleware('can_override_escrow'));
export const userManagementAdminProcedure = protectedProcedure.use(capabilityAdminMiddleware('can_ban_users'));
export const disputeAdminProcedure = protectedProcedure.use(capabilityAdminMiddleware('can_resolve_disputes'));
export const trustAdminProcedure = protectedProcedure.use(capabilityAdminMiddleware('can_modify_trust'));
export const safetyAdminProcedure = protectedProcedure.use(capabilityAdminMiddleware('can_manage_incidents'));
export const operationsAdminProcedure = protectedProcedure.use(capabilityAdminMiddleware('can_manage_operations'));

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
  if (ctx.user.is_admin === false) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Platform administrator or engine bridge access required' });
  }
  // Human callers on engine-equivalent procedures require a fresh platform
  // role check. A cached generic staff flag must never grant assignment,
  // recurring-recovery, or unattended-completion authority.
  const result = await db.query(
    'SELECT role FROM admin_roles WHERE user_id = $1 AND role = ANY($2::text[]) LIMIT 1',
    [ctx.user.id, [...PRIVILEGED_ADMIN_ROLES]],
  );
  if (result.rows.length === 0) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Platform administrator or engine bridge access required' });
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
  if (ctx.user!.is_minor === true) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Hustlers must be at least 18 years old.',
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
    /** ISO country-subdivision policy key. The engine resolves the version; clients cannot choose it. */
    regionCode: z.string().trim().regex(/^US-[A-Z]{2}$/),
    clientIdempotencyKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/).optional(),
    isTest: z.boolean().optional(),
    category: z.string().trim().min(1).max(100),
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
    // Partial payout is still rejected by the router. Checklist steps are
    // canonical scope inputs and are persisted in immutable scope version 1.
    prorate_on_abort: z.boolean().optional(),
    proof_steps: z.array(z.object({ step: z.string().trim().min(1).max(200) }).strict()).min(1).max(12).optional(),
    estimatedDurationMinutes: z.number().int().min(15).max(1440).optional(),
    requiredTools: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    aiScopeObservationId: z.string().uuid().optional(),
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
