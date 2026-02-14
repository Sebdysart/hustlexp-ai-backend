/**
 * Reputation AI Router v1.0.0
 *
 * CONSTITUTIONAL: Authority Level A2 (Proposal-Only)
 *
 * Endpoints for AI-powered trust scoring, anomaly detection, and user insights.
 * Admin endpoints for moderation. User endpoint for tier promotion eligibility.
 *
 * @see ReputationAIService.ts
 * @see PRODUCT_SPEC.md §8.2 (Trust Tiers)
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { ReputationAIService } from '../services/ReputationAIService';

export const reputationRouter = router({
  // --------------------------------------------------------------------------
  // ADMIN: AI-POWERED TRUST & ANOMALY ENDPOINTS
  // --------------------------------------------------------------------------

  /**
   * Calculate AI trust score for a user
   *
   * PRODUCT_SPEC.md §8.2: Trust score computation
   */
  calculateTrustScore: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      const result = await ReputationAIService.calculateTrustScore(input.userId);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * Detect anomalies in a user's activity
   *
   * PRODUCT_SPEC.md §8.2: Anomaly detection
   */
  detectAnomalies: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      const result = await ReputationAIService.detectAnomalies(input.userId);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * Generate AI-powered insight summary for a user
   *
   * PRODUCT_SPEC.md §8.2: User insight generation
   */
  generateUserInsight: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      const result = await ReputationAIService.generateUserInsight(input.userId);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // USER: TIER PROMOTION ELIGIBILITY
  // --------------------------------------------------------------------------

  /**
   * Check if the authenticated user is eligible for tier promotion
   *
   * PRODUCT_SPEC.md §8.2: Tier promotion eligibility
   */
  checkTierEligibility: protectedProcedure
    .query(async ({ ctx }) => {
      const result = await ReputationAIService.shouldPromoteTier(ctx.user.id);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),
});

export type ReputationRouter = typeof reputationRouter;
