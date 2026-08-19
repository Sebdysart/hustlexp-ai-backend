import { router, hustlerProcedure } from '../trpc.js';
import { z } from 'zod';
import { getHustlerOnboardingStatus } from '../services/HustlerOnboardingService.js';
import { TRPCError } from '@trpc/server';

export const hustlerOnboardingRouter = router({
  getStatus: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const result = await getHustlerOnboardingStatus(ctx.user.id);

      if (!result.success) {
        throw new TRPCError({
          code:
            result.error.code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : result.error.code === 'NOT_HUSTLER'
                ? 'FORBIDDEN'
                : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),
});