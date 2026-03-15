/**
 * Dynamic Pricing Router v1.0.0
 *
 * tRPC router for dynamic pricing, worker price modifiers,
 * ASAP price bumps, and smart pricing (AI + dynamic).
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, posterProcedure } from '../trpc.js';
import { DynamicPricingService } from '../services/DynamicPricingService.js';
import { SmartPricingService } from '../services/SmartPricingService.js';

export const pricingRouter = router({
  // Calculate dynamic price for a task (from existing base price)
  calculate: posterProcedure
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

  /**
   * Smart pricing: AI/heuristic base suggestion + surge + ASAP + worker modifier.
   * Use when creating a task to get a recommended price from title, description, category, and location.
   */
  getSmartPrice: posterProcedure
    .input(z.object({
      title: z.string().min(1).max(500),
      description: z.string().max(5000).optional(),
      category: z.string().max(100).optional(),
      location: z.string().max(500).optional(),
      locationLat: z.number().optional(),
      locationLng: z.number().optional(),
      mode: z.enum(['STANDARD', 'LIVE']).default('STANDARD'),
      isASAP: z.boolean().optional(),
      workerId: z.string().uuid().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const result = await SmartPricingService.getSmartPrice({
        title: input.title,
        description: input.description ?? '',
        category: input.category,
        location: input.location,
        locationLat: input.locationLat,
        locationLng: input.locationLng,
        mode: input.mode,
        isASAP: input.isASAP,
        workerId: input.workerId,
      });
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  // Update worker's price modifier (IC Compliance)
  updateMyModifier: posterProcedure
    .input(z.object({
      modifierPercent: z.number().int().min(-25).max(50),
    }))
    .mutation(async ({ ctx, input }) => {
      return DynamicPricingService.updateWorkerModifier(ctx.user.id, input.modifierPercent);
    }),
});
