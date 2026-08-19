import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { posterProcedure, router } from '../trpc.js';
import { finalizePaidQuote } from '../services/QuotePaymentFinalizationService.js';

export const quotePaymentRouter = router({
  finalize: posterProcedure
    .input(
      z.object({
        quoteId: z.string().uuid(),
        quoteVersionId: z.string().uuid(),
        paymentIntentId: z.string().min(10).max(255),
      }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await finalizePaidQuote({
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        posterId: ctx.user.id,
        paymentIntentId: input.paymentIntentId,
      });

      if (!result.success) {
        throw new TRPCError({
          code:
            result.error.code === 'QUOTE_NOT_FOUND'
              ? 'NOT_FOUND'
              : result.error.code.includes('MISMATCH')
                ? 'FORBIDDEN'
                : 'PRECONDITION_FAILED',
          message: result.error.message,
        });
      }

      return result.data;
    }),
});

export type QuotePaymentRouter = typeof quotePaymentRouter;