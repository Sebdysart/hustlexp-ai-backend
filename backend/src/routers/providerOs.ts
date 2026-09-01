import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import type { ServiceResult } from '../types.js';
import {
  getProviderOsDraft,
  listProviderOsClients,
  listProviderOsDrafts,
  onboardProviderOsClient,
} from '../services/ProviderOsService.js';

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.success) {
    const code = result.error.code;
    throw new TRPCError({
      code:
        code === 'NOT_FOUND' ? 'NOT_FOUND'
          : code === 'FORBIDDEN' ? 'FORBIDDEN'
            : code === 'INVALID_STATE' ? 'CONFLICT'
              : 'BAD_REQUEST',
      message: result.error.message,
    });
  }
  return result.data;
}

export const providerOsRouter = router({
  onboardClient: protectedProcedure
    .input(z.object({
      posterEmail: z.string().trim().email().max(255),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(
      await onboardProviderOsClient({
        actorId: ctx.user.id,
        posterEmail: input.posterEmail,
      }),
    )),

  listClients: protectedProcedure
    .query(async ({ ctx }) => unwrap(await listProviderOsClients(ctx.user.id))),

  listDrafts: protectedProcedure
    .input(z.object({
      posterUserId: z.string().uuid().optional(),
    }).strict().optional())
    .query(async ({ ctx, input }) => unwrap(
      await listProviderOsDrafts({
        actorId: ctx.user.id,
        posterUserId: input?.posterUserId,
      }),
    )),

  getDraft: protectedProcedure
    .input(z.object({
      draftId: z.string().uuid(),
    }).strict())
    .query(async ({ ctx, input }) => unwrap(
      await getProviderOsDraft({
        actorId: ctx.user.id,
        draftId: input.draftId,
      }),
    )),
});
