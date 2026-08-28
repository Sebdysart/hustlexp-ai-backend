/**
 * Rating Router v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §12, RATING_SYSTEM_SPEC.md
 * 
 * Endpoints for bidirectional rating system (poster rates worker, worker rates poster).
 * 
 * @see backend/src/services/RatingService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, trustAdminProcedure, Schemas } from '../trpc.js';
import { RatingService } from '../services/RatingService.js';
import { db } from '../db.js';
import { logger } from '../logger.js';

const structuredFeedbackSchema = z.object({
  communication: z.number().int().min(1).max(5),
  scopeAccuracy: z.number().int().min(1).max(5),
  punctuality: z.number().int().min(1).max(5),
  care: z.number().int().min(1).max(5),
  resultQuality: z.number().int().min(1).max(5),
  value: z.number().int().min(1).max(5),
}).strict();

const log = logger.child({ router: 'rating' });

export const ratingRouter = router({
  // --------------------------------------------------------------------------
  // SUBMIT RATINGS
  // --------------------------------------------------------------------------
  
  /**
   * Submit rating (poster rates worker or worker rates poster)
   * 
   * PRODUCT_SPEC §12: Bidirectional Rating System
   * RATE-1: Rating only allowed after task COMPLETED
   * RATE-2: Rating window: 7 days after completion
   * RATE-4: Ratings are immutable (cannot edit/delete)
   * RATE-5: One rating per pair per task
   * RATE-6: Stars must be 1-5
   * RATE-7: Comment max 500 characters
   * 
   * Note: The service automatically determines the ratee (other participant) from the task
   */
  submitRating: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      stars: z.number().int().min(1).max(5), // RATE-6: Stars must be 1-5
      comment: z.string().trim().max(500).optional(), // RATE-7: Comment max 500 characters
      tags: z.array(z.string().trim().max(50)).max(20).optional(), // Optional tags (e.g., "On Time", "Professional")
      structuredFeedback: structuredFeedbackSchema.optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await RatingService.submitRating({
        taskId: input.taskId,
        raterId: ctx.user.id, // Current user is the rater
        stars: input.stars,
        comment: input.comment,
        tags: input.tags,
        structuredFeedback: input.structuredFeedback,
      });
      
      if (!result.success) {
        // Map service errors to tRPC errors
        let code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'PRECONDITION_FAILED' = 'BAD_REQUEST';
        if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        } else if (result.error.code === 'FORBIDDEN') {
          code = 'FORBIDDEN';
        } else if (result.error.code === 'INVALID_STATE' || result.error.code === 'INVALID_INPUT') {
          code = 'PRECONDITION_FAILED';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get ratings for a task (visible after both parties rate or 7 days expire)
   * 
   * RATE-8: Ratings are blind until both parties rate (or 7 days expire)
   */
  getTaskRatings: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
    }))
    .query(async ({ input, ctx }) => {
      // IDOR fix: only task participants (poster/worker) or admins may view ratings
      const taskCheck = await db.query<{ poster_id: string; worker_id: string | null }>(
        'SELECT poster_id, worker_id FROM tasks WHERE id = $1',
        [input.taskId],
      );
      if (taskCheck.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      const { poster_id, worker_id } = taskCheck.rows[0];
      if (
        ctx.user.id !== poster_id &&
        ctx.user.id !== worker_id &&
        !ctx.user.is_admin
      ) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not authorized to view ratings for this task' });
      }

      const result = await RatingService.getRatingsForTask(input.taskId);
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      // Filter out blind ratings (RATE-8) — only return public, non-blind ratings.
      // Checking BOTH flags closes a race condition where is_public=true and is_blind=true
      // can coexist transiently (e.g. auto-reveal hasn't run yet), which would otherwise
      // leak blind ratings early. This matches the getMyRatings SQL: AND is_blind = false.
      return result.data.filter(rating => rating.is_public && !rating.is_blind);
    }),
  
  /**
   * Get rating summary for a user (aggregated stats from view)
   * 
   * PRODUCT_SPEC §12.4: Rating Display
   */
  getUserRatingSummary: protectedProcedure
    .input(z.object({
      userId: Schemas.uuid,
    }))
    .query(async ({ input }) => {
      const result = await RatingService.getRatingSummary(input.userId);
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get my ratings (ratings I've given to others)
   */
  getMyRatings: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(500).default(0),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      // Get ratings where this user is the rater (schema uses rater_id)
      // RATE-8: Exclude blind/pending-reveal ratings — only return rows where
      // is_blind = false so the rater cannot see their own rating before both
      // parties have submitted (or the 7-day window has expired and auto-reveal
      // has run).
      const result = await db.query(
        `SELECT id, task_id, ratee_id, stars, comment, tags, created_at FROM task_ratings
         WHERE rater_id = $1
           AND is_blind = false
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [ctx.user.id, input.limit, input.offset]
      );
      
      return result.rows;
    }),
  
  /**
   * Get ratings I've received (ratings others have given me)
   * 
   * Only returns public ratings (is_public = true)
   */
  getRatingsReceived: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(500).default(0),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      // Use service method for consistency
      const result = await RatingService.getRatingsForUser(
        ctx.user.id,
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

  /**
   * Get text reviews for a user: ratings that include a written comment.
   * Use for profile "Reviews" / "What people say". Own user or any user (public reviews only).
   */
  getTextReviews: protectedProcedure
    .input(z.object({
      userId: Schemas.uuid.optional(), // If omitted, current user
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(500).default(0),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      const userId = input.userId ?? ctx.user.id;
      const result = await RatingService.getTextReviewsForUser(
        userId,
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
  
  // --------------------------------------------------------------------------
  // ADMIN OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Process auto-ratings (background job - admin only)
   * 
   * RATE-3: Auto-rate tasks where both parties haven't rated within 7 days
   * This should be called by a background job daily
   */
  processAutoRatings: trustAdminProcedure
    .input(z.void())
    .mutation(async () => {
      // BUG FIX: A single call to processAutoRatings processes at most 500
      // tasks (LIMIT 500 is intentional to bound per-batch DB load). A backlog
      // of >500 would drain only one page per scheduled run, taking multiple
      // days instead of one. Drain in a loop until a batch returns autoRated=0.
      // BUG FIX: Cap iterations to prevent an infinite loop under a data anomaly
      // where every batch re-selects the same rows (e.g. ON CONFLICT fails silently
      // but the SELECT keeps returning the same unrated tasks).
      const MAX_DRAIN_ITERATIONS = 200;
      let iterations = 0;
      let result;
      let totalAutoRated = 0;
      do {
        result = await RatingService.processAutoRatings();

        if (!result.success) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: result.error.message,
          });
        }

        totalAutoRated += result.data.autoRated ?? 0;
        iterations++;
        if (iterations >= MAX_DRAIN_ITERATIONS) {
          log.error({ iterations }, 'processAutoRatings drain loop hit max iterations — aborting to prevent runaway');
          break;
        }
      } while ((result.data?.autoRated ?? 0) > 0);

      log.info({ totalAutoRated }, 'processAutoRatings drain complete');

      return { autoRated: totalAutoRated };
    }),
});
