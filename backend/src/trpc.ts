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
import { firebaseAuth } from './auth/firebase';
import { db } from './db';
import type { User } from './types';
import { logger } from './logger';

const log = logger.child({ module: 'trpc' });

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
  
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    
    // Get user from database
    const result = await db.query<User>(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [decoded.uid]
    );
    
    return {
      user: result.rows[0] || null,
      firebaseUid: decoded.uid,
    };
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
  
  // Pagination
  pagination: z.object({
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
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
