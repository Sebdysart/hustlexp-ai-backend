import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CompletionRetentionService } from '../services/CompletionRetentionService.js';
import { posterProcedure, Schemas } from '../trpc.js';

function errorCode(code: string): 'NOT_FOUND' | 'FORBIDDEN' | 'PRECONDITION_FAILED' | 'CONFLICT' | 'INTERNAL_SERVER_ERROR' {
  if (code === 'NOT_FOUND') return 'NOT_FOUND';
  if (code === 'FORBIDDEN') return 'FORBIDDEN';
  if (code === 'IDEMPOTENCY_CONFLICT') return 'CONFLICT';
  if (code === 'DB_ERROR') return 'INTERNAL_SERVER_ERROR';
  return 'PRECONDITION_FAILED';
}

export const TaskRetentionProcedures = {
  rebook: posterProcedure
    .input(z.object({
      sourceTaskId: Schemas.uuid,
      scheduledFor: z.string().datetime().optional(),
      clientIdempotencyKey: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9:_-]+$/),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const result = await CompletionRetentionService.rebook({
        sourceTaskId: input.sourceTaskId,
        posterId: ctx.user.id,
        clientIdempotencyKey: input.clientIdempotencyKey,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined,
      });
      if (!result.success) {
        throw new TRPCError({ code: errorCode(result.error.code), message: result.error.message });
      }
      return result.data;
    }),
};
