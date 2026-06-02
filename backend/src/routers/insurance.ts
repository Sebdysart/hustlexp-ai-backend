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
import { router, hustlerProcedure, adminProcedure, Schemas } from '../trpc.js';
import { SelfInsurancePoolService } from '../services/SelfInsurancePoolService.js';
import { z } from 'zod';
import { db } from '../db.js';

export const insuranceRouter = router({
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Get insurance pool status (public)
   */
  getPoolStatus: hustlerProcedure.input(z.void()).query(async () => {
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
  getMyClaims: hustlerProcedure.input(z.void()).query(async ({ ctx }) => {
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
  fileClaim: hustlerProcedure
    .input(
      z.object({
        // Accept both naming conventions for frontend compat
        task_id: Schemas.uuid.optional(),
        taskId: z.string().uuid().optional(),
        claim_amount_cents: z.number().min(1).max(500000).optional(),
        requestedAmountCents: z.number().min(1).max(500000).optional(),
        reason: z.string().min(10).max(1000).optional(),
        incidentDescription: z.string().min(10).max(1000).optional(),
        evidence_urls: z.array(z.string().url().refine(
          (url) => {
            try {
              const parsed = new URL(url);
              // Only allow HTTPS and known storage domains
              return parsed.protocol === 'https:' && (
                parsed.hostname.endsWith('.r2.cloudflarestorage.com') ||
                parsed.hostname.endsWith('.amazonaws.com') ||
                parsed.hostname.endsWith('.cloudfront.net')
              );
            } catch { return false; }
          },
          { message: 'evidence_urls must be HTTPS URLs from approved storage domains' }
        )).min(1).max(10).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const taskId = input.task_id || input.taskId;
      const amount = input.claim_amount_cents || input.requestedAmountCents;
      const reason = input.reason || input.incidentDescription;
      if (!taskId || !amount || !reason) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'taskId, amount, and reason are required' });
      }

      // IDOR check: verify the requesting user is a participant of the task
      const task = await db.query('SELECT poster_id, worker_id FROM tasks WHERE id = $1', [taskId]);
      if (!task.rows[0]) throw new TRPCError({ code: 'NOT_FOUND' });
      const { poster_id, worker_id } = task.rows[0];
      if (ctx.user.id !== poster_id && ctx.user.id !== worker_id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a participant of this task' });
      }

      if (ctx.user.id !== worker_id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the assigned worker can file an insurance claim' });
      }

      if (!input.evidence_urls || input.evidence_urls.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'At least one piece of evidence is required to file a claim' });
      }

      const result = await SelfInsurancePoolService.fileClaim(
        taskId,
        ctx.user.id,
        amount,
        reason,
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
  reviewClaim: adminProcedure
    .input(
      z.object({
        claim_id: Schemas.uuid,
        approved: z.boolean(),
        review_notes: z.string().min(10).max(1000)
      })
    )
    .mutation(async ({ ctx, input }) => {

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
  payClaim: adminProcedure
    .input(
      z.object({
        claim_id: Schemas.uuid
      })
    )
    .mutation(async ({ ctx: _ctx, input }) => {

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
