/**
 * Feature Flags Router v1.0.0
 *
 * Endpoints for feature flag evaluation and management.
 *
 * @see backend/src/services/FlagsService.ts
 */

import { z } from 'zod';
import { router, protectedProcedure, platformAdminProcedure } from '../trpc.js';
import { FlagsService } from '../services/FlagsService.js';

export const flagsRouter = router({
  /**
   * Get evaluated flags for the authenticated user
   */
  getFlags: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const flags = await FlagsService.getUserFlags(ctx.user.id);
      return flags;
    }),

  /**
   * Set (create or update) a feature flag (admin only)
   */
  setFlag: platformAdminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      enabled: z.boolean(),
      rolloutPercentage: z.number().int().min(0).max(100).default(0),
      userAllowlist: z.array(z.string().uuid()).default([]),
      userBlocklist: z.array(z.string().uuid()).default([]),
      metadata: z.record(z.any()).default({}),
    }))
    .mutation(async ({ input }) => {
      const flag = await FlagsService.setFlag({
        name: input.name,
        enabled: input.enabled,
        rolloutPercentage: input.rolloutPercentage,
        userAllowlist: input.userAllowlist,
        userBlocklist: input.userBlocklist,
        metadata: input.metadata,
      });
      return flag;
    }),
});
