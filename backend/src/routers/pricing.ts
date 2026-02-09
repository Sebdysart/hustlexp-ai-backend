/**
 * Dynamic Pricing Router v1.0.0
 *
 * tRPC router for dynamic pricing, worker price modifiers,
 * and ASAP price bumps.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { DynamicPricingService } from '../services/DynamicPricingService';

export const pricingRouter = router({
  // Calculate dynamic price for a task
  calculate: protectedProcedure
    .input(z.object({
      basePriceCents: z.number().int().positive(),
      mode: z.enum(['STANDARD', 'LIVE']),
      category: z.string().optional(),
      locationLat: z.number().optional(),
      locationLng: z.number().optional(),
      isASAP: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      return DynamicPricingService.calculatePrice(input);
    }),

  // Update worker's price modifier (IC Compliance)
  updateMyModifier: protectedProcedure
    .input(z.object({
      modifierPercent: z.number().int().min(-25).max(50),
    }))
    .mutation(async ({ ctx, input }) => {
      return DynamicPricingService.updateWorkerModifier(ctx.user.id, input.modifierPercent);
    }),
});
