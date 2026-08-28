/**
 * Feature Flags Router v1.0.0
 *
 * Endpoints for feature flag evaluation and management.
 *
 * @see backend/src/services/FlagsService.ts
 */

import { z } from 'zod';
import { operationsStepUpProcedure, protectedProcedure, router } from '../trpc.js';
import { FlagsService } from '../services/FlagsService.js';
import { OperatorAuthorityService } from '../services/OperatorAuthorityService.js';

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
   * Request a disable-only feature-flag command. The target mutation happens
   * only after a different, freshly stepped-up operator approves the exact
   * expected-version command through the OperatorAuthorityService rail.
   */
  requestDisable: operationsStepUpProcedure
    .input(z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]{1,99}$/),
      enabled: z.literal(false),
      expectedVersion: z.number().int().positive(),
      reason: z.string().trim().min(10).max(500),
      idempotencyKey: z.string().uuid(),
    }))
    .mutation(({ ctx, input }) => OperatorAuthorityService.request(ctx, {
      operationType: 'DISABLE_FEATURE_FLAG',
      targetId: input.name,
      targetExpectedVersion: input.expectedVersion,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    })),
});
