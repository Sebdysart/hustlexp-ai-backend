/**
 * AI Router v1.0.0
 * 
 * CONSTITUTIONAL: AI infrastructure endpoints
 * 
 * @see AI_INFRASTRUCTURE.md §15
 */

import { TRPCError } from '@trpc/server';
import { router, hustlerProcedure, Schemas } from '../trpc.js';
import { OnboardingAIService } from '../services/OnboardingAIService.js';
import { db } from '../db.js';
import { z } from 'zod';

export const aiRouter = router({
  // --------------------------------------------------------------------------
  // ONBOARDING AI (A2 Authority)
  // --------------------------------------------------------------------------
  
  /**
   * Submit calibration prompt for role inference
   */
  submitCalibration: hustlerProcedure
    .input(Schemas.submitCalibration)
    .mutation(async ({ ctx, input }) => {
      const result = await OnboardingAIService.submitCalibration({
        userId: ctx.user.id,
        calibrationPrompt: input.calibrationPrompt,
        onboardingVersion: input.onboardingVersion,
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
   * Get inference result
   */
  getInferenceResult: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const result = await OnboardingAIService.getInferenceResult(ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Confirm role and complete onboarding
   */
  confirmRole: hustlerProcedure
    .input(Schemas.confirmRole)
    .mutation(async ({ ctx, input }) => {
      // Guard: ai.confirmRole is an onboarding-only path.
      // Block role change if the user has any task history (ever participated as poster or worker).
      const taskCount = await db.query(
        `SELECT COUNT(*) FROM tasks WHERE poster_id = $1 OR worker_id = $1`,
        [ctx.user.id]
      );
      if (parseInt(taskCount.rows[0].count as string) > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Role cannot be changed after completing tasks.',
        });
      }

      const result = await OnboardingAIService.confirmRole({
        userId: ctx.user.id,
        confirmedMode: input.confirmedMode,
        overrideAI: input.overrideAI,
      });
      
      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});

export type AIRouter = typeof aiRouter;
