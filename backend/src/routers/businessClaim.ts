// backend/src/routers/businessClaim.ts
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import { claimBusinessTask } from '../services/BusinessClaimService.js';

export const businessClaimRouter = router({
  claim: protectedProcedure
    .input(
      z.object({
        token: z.string().regex(/^[0-9a-f]{64}$/i),
        organizationId: z.string().uuid(),
        serviceProfileId: z.string().uuid(),
        businessLocationId: z.string().uuid(),
        proposedCustomerTotalCents: z.number().int().positive(),
        proposedPayoutCents: z.number().int().positive(),
      }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await claimBusinessTask({
        ...input,
        actorId: ctx.user.id,
      });

      if (!result.success) {
        const code =
          result.error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : result.error.code.includes('CONFLICT')
              ? 'CONFLICT'
              : 'PRECONDITION_FAILED';

        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }

      return result.data;
    }),
});
