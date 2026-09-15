import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import { CompletionVerificationService } from '../services/CompletionVerificationService.js';

function toError(error: { code: string; message: string }): TRPCError {
  const forbidden = new Set(['TASK_POSTER_MISMATCH', 'BUSINESS_NOT_AUTHORIZED', 'COMPLETION_BUSINESS_MISMATCH', 'COMPLETION_POSTER_MISMATCH']);
  const notFound = new Set(['TASK_NOT_FOUND', 'PROOF_NOT_FOUND']);
  return new TRPCError({ code: forbidden.has(error.code) ? 'FORBIDDEN' : notFound.has(error.code) ? 'NOT_FOUND' : 'PRECONDITION_FAILED', message: error.message });
}

export const completionVerificationRouter = router({
  generateForPoster: protectedProcedure.input(z.object({ taskId: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => {
    const result = await CompletionVerificationService.generateForPoster(input.taskId, ctx.user.id);
    if (!result.success) throw toError(result.error);
    return result.data;
  }),
  verifyForBusiness: protectedProcedure.input(z.object({ taskId: z.string().uuid(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit completion code.') }).strict()).mutation(async ({ ctx, input }) => {
    const result = await CompletionVerificationService.verifyForBusiness(input.taskId, ctx.user.id, input.code);
    if (!result.success) throw toError(result.error);
    return result.data;
  }),
});

export type CompletionVerificationRouter = typeof completionVerificationRouter;
