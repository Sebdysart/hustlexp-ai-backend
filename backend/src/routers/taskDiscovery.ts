/**
 * Task Discovery Router v1.1.0
 *
 * CONSTITUTIONAL: PRODUCT_SPEC §9, TASK_DISCOVERY_SPEC.md
 *
 * Endpoints for task discovery, matching, filtering, sorting, and search.
 *
 * PROGRESSIVE VERIFICATION (AUDIT FIX):
 * - `browseTasks` (publicProcedure): Any authenticated user can browse ALL open
 *   tasks in read-only mode, regardless of trust tier. Each task includes a
 *   `canAccept` flag and `requiredTrustTier` so the frontend can show
 *   "Verify to Accept" CTAs. This solves the marketplace cold-start problem.
 * - `getFeed` (hustlerProcedure): Personalized feed with matching scores.
 *   Now includes `canAccept` based on user trust tier vs task requirements.
 *
 * @see backend/src/services/TaskDiscoveryService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, hustlerProcedure, publicProcedure, Schemas } from '../trpc.js';
import { TaskDiscoveryService } from '../services/TaskDiscoveryService.js';
import { TaskSuggestionAIService } from '../services/TaskSuggestionAIService.js';

// --------------------------------------------------------------------------
// TRUST TIER THRESHOLDS (Progressive Verification)
// Level 0 (New): Browse only, can accept tasks < $20
// Level 1 (Basic): Can accept tasks < $50 (phone + email verified)
// Level 2 (Verified): Can accept tasks < $200 (ID verified)
// Level 3 (Trusted): Can accept all tasks (background check)
// Level 4 (Elite): Priority access (proven track record)
// --------------------------------------------------------------------------
const TIER_PRICE_LIMITS: Record<number, number> = {
  0: 2000,    // $20 in cents
  1: 5000,    // $50 in cents
  2: 20000,   // $200 in cents
  3: 9999900, // Effectively unlimited
  4: 9999900, // Effectively unlimited
};

function canUserAcceptTask(userTrustTier: number, taskPrice: number): boolean {
  const priceLimit = TIER_PRICE_LIMITS[userTrustTier] ?? TIER_PRICE_LIMITS[0];
  return taskPrice <= priceLimit;
}

function getRequiredTierForTask(taskPrice: number): number {
  if (taskPrice <= 2000) return 0;
  if (taskPrice <= 5000) return 1;
  if (taskPrice <= 20000) return 2;
  return 3;
}

export const taskDiscoveryRouter = router({
  // --------------------------------------------------------------------------
  // PROGRESSIVE VERIFICATION: PUBLIC TASK BROWSING (AUDIT FIX #1)
  // --------------------------------------------------------------------------

  /**
   * Browse all open tasks (read-only, any authenticated user)
   *
   * CRITICAL: This endpoint solves the marketplace cold-start death spiral.
   * Workers can see ALL tasks immediately after signup, even before verification.
   * Each task includes `canAccept` (boolean) and `requiredTrustTier` so the
   * frontend can display "Complete verification to accept this task" CTAs.
   *
   * Workers don't verify without visible tasks; this makes tasks visible FIRST.
   */
  browseTasks: publicProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).max(10000).default(0),
      category: z.string().optional(),
      min_price: z.number().int().nonnegative().optional(),
      max_price: z.number().int().positive().optional(),
      sort_by: z.enum(['newest', 'price_high', 'price_low', 'deadline']).default('newest'),
    }))
    .query(async ({ input, ctx }) => {
      // User may or may not be authenticated
      const userTrustTier = ctx.user?.trust_tier ?? 0;

      const result = await TaskDiscoveryService.browsePublicFeed(
        input,
        input.limit,
        input.offset
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      // Annotate each task with progressive verification info.
      // poster_id is intentionally stripped from public browse results to
      // prevent poster identity enumeration by unauthenticated callers.
      const annotatedTasks = result.data.map(({ poster_id: _posterId, ...task }) => ({
        ...task,
        canAccept: canUserAcceptTask(userTrustTier, task.price as number),
        requiredTrustTier: getRequiredTierForTask(task.price as number),
        userTrustTier,
        verificationCTA: canUserAcceptTask(userTrustTier, task.price as number)
          ? null
          : `Complete Level ${getRequiredTierForTask(task.price as number)} verification to accept this task`,
      }));

      return {
        tasks: annotatedTasks,
        totalAvailable: result.data.length,
        userTrustTier,
        isReadOnly: !ctx.user,
      };
    }),

  // --------------------------------------------------------------------------
  // TASK FEED (Matching & Relevance)
  // --------------------------------------------------------------------------

  /**
   * Get task feed with matching scores (for hustler feed)
   *
   * PRODUCT_SPEC §9: Task Discovery & Matching Algorithm
   * Now includes progressive verification: canAccept flag per task.
   */
  getFeed: hustlerProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      // Structured filters (original)
      filters: z.object({
        category: z.string().optional(),
        min_price: z.number().int().nonnegative().optional(),
        max_price: z.number().int().positive().optional(),
        max_distance_miles: z.number().positive().optional(),
        min_matching_score: z.number().min(0).max(1).optional(),
        sort_by: z.enum(['relevance', 'price', 'distance', 'deadline']).optional(),
      }).optional(),
      // Flat params from iOS frontend (merged into filters)
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      radiusMeters: z.number().positive().optional(),
      skills: z.array(z.string()).optional(),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      // Merge flat iOS params into filters object
      const filters = {
        ...input.filters,
        ...(input.radiusMeters ? { max_distance_miles: input.radiusMeters / 1609.34 } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
      };

      const result = await TaskDiscoveryService.getFeed(
        ctx.user.id,
        filters,
        input.limit,
        input.offset
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      // Annotate with progressive verification (canAccept per task)
      const userTrustTier = ctx.user.trust_tier ?? 0;
      const annotatedData = result.data.map((item) => ({
        ...item,
        canAccept: canUserAcceptTask(userTrustTier, item.task.price as number),
        requiredTrustTier: getRequiredTierForTask(item.task.price as number),
        verificationCTA: canUserAcceptTask(userTrustTier, item.task.price as number)
          ? null
          : `Complete Level ${getRequiredTierForTask(item.task.price as number)} verification to accept this task`,
      }));

      return annotatedData;
    }),
  
  /**
   * Calculate matching scores for feed (batch calculation)
   * 
   * Call this periodically to pre-calculate scores for better feed performance
   */
  calculateFeedScores: hustlerProcedure
    .input(z.object({
      maxDistanceMiles: z.number().positive().default(10.0),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.calculateFeedScores(
        ctx.user.id,
        input.maxDistanceMiles
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Calculate matching score for a specific task
   */
  calculateMatchingScore: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.calculateMatchingScore(
        input.taskId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get "Why this task?" explanation for a task
   * 
   * PRODUCT_SPEC §9.4: Explains why a task matches the hustler
   */
  getExplanation: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.getExplanation(
        input.taskId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return {
        explanation: result.data,
      };
    }),

  // --------------------------------------------------------------------------
  // AI TASK SUGGESTIONS
  // --------------------------------------------------------------------------

  /**
   * Get AI-powered task suggestions for the current worker.
   * Returns top N open tasks with a short AI-generated reason per task (why it fits the worker).
   */
  getAISuggestions: hustlerProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(20).default(10),
      max_distance_miles: z.number().positive().optional(),
      category: z.string().optional(),
      min_price: z.number().int().nonnegative().optional(),
      max_price: z.number().int().positive().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      const result = await TaskSuggestionAIService.getSuggestions(ctx.user.id, {
        limit: input?.limit,
        max_distance_miles: input?.max_distance_miles,
        category: input?.category,
        min_price: input?.min_price,
        max_price: input?.max_price,
      });
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return { suggestions: result.data };
    }),

  // --------------------------------------------------------------------------
  // SEARCH
  // --------------------------------------------------------------------------

  /**
   * Search tasks by query (full-text search)
   */
  search: hustlerProcedure
    .input(z.object({
      query: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      filters: z.object({
        category: z.string().optional(),
        min_price: z.number().int().nonnegative().optional(),
        max_price: z.number().int().positive().optional(),
        max_distance_miles: z.number().positive().optional(),
        min_matching_score: z.number().min(0).max(1).optional(),
        sort_by: z.enum(['relevance', 'price', 'distance', 'deadline']).optional(),
      }).optional(),
      // Flat params from iOS frontend (merged into filters)
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      category: z.string().optional(),
      minPaymentCents: z.number().int().nonnegative().optional(),
      maxPaymentCents: z.number().int().positive().optional(),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      const searchFilters: Record<string, unknown> = {
        ...input.filters,
        query: input.query,
        // Merge flat iOS params
        ...(input.category && !input.filters?.category ? { category: input.category } : {}),
        ...(input.minPaymentCents && !input.filters?.min_price ? { min_price: input.minPaymentCents } : {}),
        ...(input.maxPaymentCents && !input.filters?.max_price ? { max_price: input.maxPaymentCents } : {}),
      };
      
      const result = await TaskDiscoveryService.search(
        ctx.user.id,
        searchFilters,
        input.limit,
        input.offset
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // SAVED SEARCHES (PRODUCT_SPEC §9.4)
  // --------------------------------------------------------------------------
  
  /**
   * Save a search query for quick access
   */
  saveSearch: hustlerProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      query: z.string().max(200).optional(),
      filters: z.record(z.any()).optional().default({}),
      sortBy: z.enum(['relevance', 'price', 'distance', 'deadline']).default('relevance'),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.saveSearch(
        ctx.user.id,
        input.name,
        input.query,
        input.filters || {},
        input.sortBy
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get all saved searches for the authenticated user
   */
  getSavedSearches: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.getSavedSearches(ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Delete a saved search
   */
  deleteSavedSearch: hustlerProcedure
    .input(z.object({
      searchId: Schemas.uuid,
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.deleteSavedSearch(
        input.searchId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return { success: true };
    }),
  
  /**
   * Execute a saved search (run search with saved filters)
   */
  executeSavedSearch: hustlerProcedure
    .input(z.object({
      searchId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await TaskDiscoveryService.executeSavedSearch(
        input.searchId,
        ctx.user.id,
        input.limit,
        input.offset
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});
