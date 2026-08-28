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
import { router, publicProcedure, protectedProcedure, trustAdminProcedure } from '../trpc.js';
import { ReputationAIService } from '../services/ReputationAIService.js';
import { MarketplaceReputationService } from '../services/MarketplaceReputationService.js';
import type { ServiceResult } from '../types.js';

function marketplaceCode(code: string):
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL_SERVER_ERROR' {
  if (code === 'NOT_FOUND') return 'NOT_FOUND';
  if (code === 'FORBIDDEN') return 'FORBIDDEN';
  if (code === 'IDEMPOTENCY_CONFLICT') return 'CONFLICT';
  if (['LOCALITY_NOT_VERIFIED', 'INVALID_STATE'].includes(code)) return 'PRECONDITION_FAILED';
  if (code === 'DB_ERROR') return 'INTERNAL_SERVER_ERROR';
  return 'BAD_REQUEST';
}

function unwrapMarketplace<T>(result: ServiceResult<T>): T {
  if (!result.success) {
    throw new TRPCError({ code: marketplaceCode(result.error.code), message: result.error.message });
  }
  return result.data;
}

const category = z.string().trim().min(1).max(100).regex(/^[a-z0-9_-]+$/);
const regionCode = z.string().trim().regex(/^US-[A-Z]{2}$/);
const reviewReason = z.string().trim().min(20).max(1000);

export const reputationRouter = router({
  // Marketplace reputation keeps verified performance, transaction reviews,
  // local recommendations, and credentials explicitly separate.
  getProviderSummary: publicProcedure
    .input(z.object({ providerUserId: z.string().uuid(), category, regionCode }).strict())
    .query(async ({ input }) => unwrapMarketplace(
      await MarketplaceReputationService.getPublicSummary(input.providerUserId, input.category, input.regionCode),
    )),

  submitLocalRecommendation: protectedProcedure
    .input(z.object({
      providerUserId: z.string().uuid(),
      category,
      regionCode,
      body: z.string().trim().min(10).max(500),
      relationship: z.enum(['NEIGHBOR', 'CUSTOMER', 'COMMUNITY_MEMBER']),
      idempotencyKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapMarketplace(
      await MarketplaceReputationService.submitLocalRecommendation({
        ...input,
        recommenderId: ctx.user.id,
      }),
    )),

  appealSignal: protectedProcedure
    .input(z.object({ signalId: z.string().uuid(), reason: reviewReason }).strict())
    .mutation(async ({ ctx, input }) => unwrapMarketplace(
      await MarketplaceReputationService.appealSignal({
        ...input,
        providerUserId: ctx.user.id,
      }),
    )),

  verifyRegionMembership: trustAdminProcedure
    .input(z.object({
      userId: z.string().uuid(),
      regionCode,
      verificationMethod: z.enum(['ADDRESS_PROVIDER', 'DOCUMENT_REVIEW']),
      verificationRefHash: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: z.string().datetime().optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapMarketplace(
      await MarketplaceReputationService.verifyRegionMembership({
        ...input,
        verifiedBy: ctx.user.id,
      }),
    )),

  moderateLocalRecommendation: trustAdminProcedure
    .input(z.object({
      recommendationId: z.string().uuid(),
      decision: z.enum(['PUBLISHED', 'REJECTED', 'REMOVED']),
      reason: reviewReason,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapMarketplace(
      await MarketplaceReputationService.moderateRecommendation({
        ...input,
        moderatorId: ctx.user.id,
      }),
    )),

  resolveSignalAppeal: trustAdminProcedure
    .input(z.object({
      appealId: z.string().uuid(),
      decision: z.enum(['UPHELD', 'OVERTURNED']),
      reason: reviewReason,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrapMarketplace(
      await MarketplaceReputationService.resolveAppeal({
        ...input,
        reviewerId: ctx.user.id,
      }),
    )),

  // --------------------------------------------------------------------------
  // ADMIN: AI-POWERED TRUST & ANOMALY ENDPOINTS
  // --------------------------------------------------------------------------

  /**
   * Calculate AI trust score for a user
   *
   * PRODUCT_SPEC.md §8.2: Trust score computation
   */
  calculateTrustScore: trustAdminProcedure
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
  detectAnomalies: trustAdminProcedure
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
  generateUserInsight: trustAdminProcedure
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
    .input(z.void())
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
