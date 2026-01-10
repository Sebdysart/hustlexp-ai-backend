/**
 * AI Router v1.0.0
 * 
 * CONSTITUTIONAL: AI infrastructure endpoints
 * 
 * @see AI_INFRASTRUCTURE.md §15
 */

import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, Schemas } from '../trpc';
import { OnboardingAIService } from '../services/OnboardingAIService';
import { z } from 'zod';

export const aiRouter = router({
  // --------------------------------------------------------------------------
  // ONBOARDING AI (A2 Authority)
  // --------------------------------------------------------------------------
  
  /**
   * Submit calibration prompt for role inference
   */
  submitCalibration: protectedProcedure
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
  getInferenceResult: protectedProcedure
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
  confirmRole: protectedProcedure
    .input(Schemas.confirmRole)
    .mutation(async ({ ctx, input }) => {
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
