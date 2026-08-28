/**
 * Dispute AI Router v1.0.0
 *
 * CONSTITUTIONAL: Authority Level A2 (Proposal-Only)
 *
 * Admin endpoints for AI-powered dispute analysis, evidence request generation,
 * and escalation assessment. All outputs are proposals — admin makes final decision.
 *
 * @see DisputeAIService.ts
 * @see DISPUTE_SPEC.md
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, disputeAdminProcedure } from '../trpc.js';
import { DisputeAIService } from '../services/DisputeAIService.js';

export const disputeAIRouter = router({
  // --------------------------------------------------------------------------
  // DISPUTE ANALYSIS (Admin only - A2 proposal authority)
  // --------------------------------------------------------------------------

  /**
   * Analyze a dispute using AI
   *
   * Generates analysis proposal for admin review.
   */
  analyzeDispute: disputeAdminProcedure
    .input(z.object({
      disputeId: z.string().uuid(),
    }))
    .mutation(async ({ input }) => {
      const result = await DisputeAIService.analyzeDispute(input.disputeId);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // EVIDENCE REQUEST GENERATION (Admin only)
  // --------------------------------------------------------------------------

  /**
   * Generate an evidence request for a dispute
   *
   * AI proposes what evidence to request; admin decides.
   */
  generateEvidenceRequest: disputeAdminProcedure
    .input(z.object({
      disputeId: z.string().uuid(),
    }))
    .mutation(async ({ input }) => {
      const result = await DisputeAIService.generateEvidenceRequest(input.disputeId);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // ESCALATION ASSESSMENT (Admin only)
  // --------------------------------------------------------------------------

  /**
   * Assess whether a dispute should be escalated
   *
   * Returns escalation recommendation for admin review.
   */
  assessEscalation: disputeAdminProcedure
    .input(z.object({
      disputeId: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      const result = await DisputeAIService.assessEscalation(input.disputeId);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),
});

export type DisputeAIRouter = typeof disputeAIRouter;
