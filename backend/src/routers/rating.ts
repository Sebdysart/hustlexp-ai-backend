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
import { router, protectedProcedure, adminProcedure, Schemas } from '../trpc';
import { RatingService } from '../services/RatingService';
import { db } from '../db';

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
      comment: z.string().max(500).optional(), // RATE-7: Comment max 500 characters
      tags: z.array(z.string()).optional(), // Optional tags (e.g., "On Time", "Professional")
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
    .query(async ({ input }) => {
      const result = await RatingService.getRatingsForTask(input.taskId);
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      // Filter out blind ratings (RATE-8) - only return public ratings
      // The service returns all ratings, but we filter to public only for display
      return result.data.filter(rating => rating.is_public);
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
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      // Get ratings where this user is the rater (schema uses rater_id)
      const result = await db.query(
        `SELECT * FROM task_ratings
         WHERE rater_id = $1
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
      offset: z.number().int().min(0).default(0),
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
  
  // --------------------------------------------------------------------------
  // ADMIN OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Process auto-ratings (background job - admin only)
   * 
   * RATE-3: Auto-rate tasks where both parties haven't rated within 7 days
   * This should be called by a background job daily
   */
  processAutoRatings: adminProcedure
    .mutation(async () => {
      const result = await RatingService.processAutoRatings();
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});
