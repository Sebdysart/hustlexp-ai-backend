/**
 * Insurance Router v1.0.0
 *
 * Self-insurance pool management
 *
 * Contributions: 2% of task price deducted at escrow setup
 * Claims: Filed by hustlers for damages/disputes
 * Coverage: 80% of claim amount (default), max $5000
 *
 * @see schema.sql v1.8.0 (self_insurance_pool, insurance_contributions, insurance_claims)
 * @see SelfInsurancePoolService.ts
 */

import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, Schemas } from '../trpc';
import { SelfInsurancePoolService } from '../services/SelfInsurancePoolService';
import { z } from 'zod';

export const insuranceRouter = router({
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Get insurance pool status (public)
   */
  getPoolStatus: protectedProcedure.query(async () => {
    const result = await SelfInsurancePoolService.getPoolStatus();

    if (!result.success) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: result.error?.message || 'Failed to get pool status'
      });
    }

    return result.data;
  }),

  /**
   * Get my claims (hustler view)
   */
  getMyClaims: protectedProcedure.query(async ({ ctx }) => {
    const result = await SelfInsurancePoolService.getMyClaims(ctx.user.id);

    if (!result.success) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: result.error?.message || 'Failed to get claims'
      });
    }

    return result.data;
  }),

  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * File a claim against insurance pool
   */
  fileClaim: protectedProcedure
    .input(
      z.object({
        task_id: Schemas.uuid,
        claim_amount_cents: z.number().min(1).max(500000), // Max $5000
        reason: z.string().min(10).max(1000),
        evidence_urls: z.array(z.string().url()).min(1).max(10)
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await SelfInsurancePoolService.fileClaim(
        input.task_id,
        ctx.user.id,
        input.claim_amount_cents,
        input.reason,
        input.evidence_urls
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error?.message || 'Failed to file claim'
        });
      }

      return {
        success: true,
        claim_id: result.data,
        message: 'Claim filed successfully. Awaiting admin review.'
      };
    }),

  // --------------------------------------------------------------------------
  // ADMIN OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Review a claim (admin only)
   */
  reviewClaim: protectedProcedure
    .input(
      z.object({
        claim_id: Schemas.uuid,
        approved: z.boolean(),
        review_notes: z.string().min(10).max(1000)
      })
    )
    .mutation(async ({ ctx, input }) => {
      // TODO: Check if user is admin
      // if (!ctx.user.is_admin) {
      //   throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      // }

      const result = await SelfInsurancePoolService.reviewClaim(
        input.claim_id,
        ctx.user.id,
        input.approved,
        input.review_notes
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error?.message || 'Failed to review claim'
        });
      }

      return {
        success: true,
        message: input.approved ? 'Claim approved' : 'Claim denied'
      };
    }),

  /**
   * Pay an approved claim (admin only)
   */
  payClaim: protectedProcedure
    .input(
      z.object({
        claim_id: Schemas.uuid
      })
    )
    .mutation(async ({ ctx, input }) => {
      // TODO: Check if user is admin
      // if (!ctx.user.is_admin) {
      //   throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
      // }

      const result = await SelfInsurancePoolService.payClaim(input.claim_id);

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error?.message || 'Failed to pay claim'
        });
      }

      return {
        success: true,
        message: 'Claim paid successfully'
      };
    })
});
