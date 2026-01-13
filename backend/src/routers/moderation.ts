/**
 * Content Moderation Router v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §15, CONTENT_MODERATION_SPEC.md
 * 
 * Endpoints for content moderation: automated scanning, human review queue, user reporting, appeals.
 * 
 * Public endpoints: createReport, createAppeal, getUserAppeals
 * Admin endpoints: All review and queue management endpoints
 * 
 * @see backend/src/services/ContentModerationService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, publicProcedure, adminProcedure, Schemas } from '../trpc';
import { ContentModerationService, type ContentType, type FlaggedBy, type ModerationSeverity, type ReviewDecision, type ReportStatus, type AppealStatus } from '../services/ContentModerationService';

export const moderationRouter = router({
  // --------------------------------------------------------------------------
  // AUTOMATED CONTENT SCANNING (Admin only - for internal use)
  // --------------------------------------------------------------------------
  
  /**
   * Moderate content and add to review queue if flagged
   * 
   * CONTENT_MODERATION_SPEC.md §2: Automated scanning with AI (A2 authority)
   * 
   * This is typically called internally by the system, but exposed for admin use
   */
  moderateContent: adminProcedure
    .input(z.object({
      contentType: z.enum(['task', 'message', 'rating', 'profile', 'photo']),
      contentId: Schemas.uuid,
      userId: Schemas.uuid,
      contentText: z.string().optional(), // Snapshot at time of flag
      contentUrl: z.string().url().optional(), // For photos
      flaggedBy: z.enum(['ai', 'user_report', 'admin']),
      reporterUserId: Schemas.uuid.optional(), // If user-reported
      aiConfidence: z.number().min(0.0).max(1.0).optional(), // 0.0 to 1.0
      aiRecommendation: z.enum(['approve', 'flag', 'block']).optional(),
    }))
    .mutation(async ({ input }) => {
      const result = await ContentModerationService.moderateContent({
        contentType: input.contentType,
        contentId: input.contentId,
        userId: input.userId,
        contentText: input.contentText,
        contentUrl: input.contentUrl,
        flaggedBy: input.flaggedBy,
        reporterUserId: input.reporterUserId,
        aiConfidence: input.aiConfidence,
        aiRecommendation: input.aiRecommendation,
      });
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // REVIEW QUEUE (Admin only)
  // --------------------------------------------------------------------------
  
  /**
   * Get pending moderation queue items (for admin review)
   */
  getPendingQueue: adminProcedure
    .input(z.object({
      severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
      limit: z.number().int().min(1).max(100).default(100),
    }))
    .query(async ({ input }) => {
      const result = await ContentModerationService.getPendingQueue(
        input.severity,
        input.limit
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
   * Get queue item by ID
   */
  getQueueItemById: adminProcedure
    .input(z.object({
      queueItemId: Schemas.uuid,
    }))
    .query(async ({ input }) => {
      const result = await ContentModerationService.getQueueItemById(
        input.queueItemId
      );
      
      if (!result.success) {
        let code: 'NOT_FOUND' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Review queue item (admin action)
   */
  reviewQueueItem: adminProcedure
    .input(z.object({
      queueItemId: Schemas.uuid,
      decision: z.enum(['approve', 'reject', 'escalate', 'no_action']),
      reviewNotes: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await ContentModerationService.reviewQueueItem(
        input.queueItemId,
        ctx.user.id,
        input.decision as ReviewDecision,
        input.reviewNotes
      );
      
      if (!result.success) {
        let code: 'NOT_FOUND' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // USER REPORTING (Public - protected for authenticated users)
  // --------------------------------------------------------------------------
  
  /**
   * Create a user report
   * 
   * CONTENT_MODERATION_SPEC.md §4: User reporting system
   */
  createReport: protectedProcedure
    .input(z.object({
      contentType: z.enum(['task', 'message', 'rating', 'profile', 'photo']),
      contentId: Schemas.uuid,
      reportedContentUserId: Schemas.uuid, // Schema uses reported_content_user_id
      category: z.string().min(1).max(50), // Schema uses 'category' (not 'report_category')
      description: z.string().optional(), // Schema uses 'description' (not 'report_reason'), optional
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await ContentModerationService.createReport({
        reporterUserId: ctx.user.id,
        contentType: input.contentType,
        contentId: input.contentId,
        reportedContentUserId: input.reportedContentUserId,
        category: input.category,
        description: input.description,
      });
      
      if (!result.success) {
        let code: 'BAD_REQUEST' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'INVALID_INPUT') {
          code = 'BAD_REQUEST';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get reports for a user (admin view)
   */
  getUserReports: adminProcedure
    .input(z.object({
      userId: Schemas.uuid,
      status: z.enum(['pending', 'reviewed', 'resolved', 'dismissed']).optional(),
      limit: z.number().int().min(1).max(100).default(100),
    }))
    .query(async ({ input }) => {
      const result = await ContentModerationService.getUserReports(
        input.userId,
        input.status as ReportStatus | undefined,
        input.limit
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
   * Review content report (admin action)
   */
  reviewReport: adminProcedure
    .input(z.object({
      reportId: Schemas.uuid,
      decision: z.string(), // e.g., 'action_taken', 'no_action', 'dismissed'
      reviewNotes: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await ContentModerationService.reviewReport(
        input.reportId,
        ctx.user.id,
        input.decision,
        input.reviewNotes
      );
      
      if (!result.success) {
        let code: 'NOT_FOUND' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // APPEALS (Public + Admin)
  // --------------------------------------------------------------------------
  
  /**
   * Create an appeal for moderated content
   * 
   * CONTENT_MODERATION_SPEC.md §5: Appeal system
   */
  createAppeal: protectedProcedure
    .input(z.object({
      moderationQueueId: Schemas.uuid, // Required in schema (reference to moderation queue item)
      originalDecision: z.string().min(1).max(20), // Required in schema (e.g., 'rejected', 'suspended', 'banned')
      appealReason: z.string().min(1), // User's explanation
      deadline: z.string().datetime(), // Required in schema (7/14/30 days from original action)
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await ContentModerationService.createAppeal({
        userId: ctx.user.id,
        moderationQueueId: input.moderationQueueId,
        originalDecision: input.originalDecision,
        appealReason: input.appealReason,
        deadline: new Date(input.deadline),
      });
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get appeals for the authenticated user
   */
  getUserAppeals: protectedProcedure
    .input(z.object({
      status: z.enum(['pending', 'reviewing', 'upheld', 'overturned']).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await ContentModerationService.getUserAppeals(
        ctx.user.id,
        input.status as AppealStatus | undefined,
        input.limit
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
   * Review appeal (admin action)
   */
  reviewAppeal: adminProcedure
    .input(z.object({
      appealId: Schemas.uuid,
      decision: z.enum(['upheld', 'overturned']),
      reviewNotes: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await ContentModerationService.reviewAppeal(
        input.appealId,
        ctx.user.id,
        input.decision,
        input.reviewNotes
      );
      
      if (!result.success) {
        let code: 'NOT_FOUND' | 'INTERNAL_SERVER_ERROR' = 'INTERNAL_SERVER_ERROR';
        if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get pending appeals (for admin review)
   */
  getPendingAppeals: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(100),
    }))
    .query(async ({ input }) => {
      const result = await ContentModerationService.getPendingAppeals(
        input.limit
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});
