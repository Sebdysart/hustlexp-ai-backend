import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';
import type { ServiceResult } from '../types.js';
import {
  acceptProviderOsInvite,
  createProviderOsInvite,
  getProviderOsDraft,
  listProviderOsClients,
  listProviderOsDrafts,
  onboardProviderOsClient,
  previewProviderOsInvite,
  setProviderOsDraftQuote,
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
  /** Prefer createInvite for new customers. Kept for existing-account email link. */
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

  createInvite: protectedProcedure
    .input(z.object({
      intendedEmail: z.string().trim().email().max(255).optional(),
    }).strict().optional())
    .mutation(async ({ ctx, input }) => unwrap(
      await createProviderOsInvite({
        actorId: ctx.user.id,
        intendedEmail: input?.intendedEmail ?? null,
      }),
    )),

  previewInvite: publicProcedure
    .input(z.object({
      token: z.string().trim().min(16).max(128),
    }).strict())
    .query(async ({ input }) => unwrap(
      await previewProviderOsInvite(input.token),
    )),

  acceptInvite: protectedProcedure
    .input(z.object({
      token: z.string().trim().min(16).max(128),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(
      await acceptProviderOsInvite({
        actorId: ctx.user.id,
        actorEmail: ctx.user.email,
        token: input.token,
      }),
    )),

  setQuote: protectedProcedure
    .input(z.object({
      draftId: z.string().uuid(),
      organizationId: z.string().uuid(),
      serviceProfileId: z.string().uuid(),
      businessLocationId: z.string().uuid(),
      proposedCustomerTotalCents: z.number().int().positive(),
      proposedPayoutCents: z.number().int().positive(),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(
      await setProviderOsDraftQuote({
        actorId: ctx.user.id,
        draftId: input.draftId,
        organizationId: input.organizationId,
        serviceProfileId: input.serviceProfileId,
        businessLocationId: input.businessLocationId,
        proposedCustomerTotalCents: input.proposedCustomerTotalCents,
        proposedPayoutCents: input.proposedPayoutCents,
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
