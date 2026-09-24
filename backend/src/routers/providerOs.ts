import { writeProviderOsEntitlement } from '../services/ProviderOsEntitlementService.js';
import { createProviderOsPurchase, getProviderOsPurchaseState, refreshProviderOsPurchase, inspectProviderOsPurchases, completeControlledProviderOsPurchase } from '../services/ProviderOsPurchaseService.js';
import { listProviderOsQuotes, getProviderOsQuote } from '../services/ProviderOsQuoteHistory.js';
import { db } from '../db.js';
import { getProviderOsAccessStatus } from '../services/ProviderOsAccess.js';
import { requestProviderOsAssessment } from '../services/BusinessAssessmentService.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, operationsAdminProcedure, router } from '../trpc.js';
import type { ServiceResult } from '../types.js';
import {
  acceptProviderOsInvite,
  createProviderOsInvite,
  getProviderOsDraft,
  listProviderOsClients,
  listProviderOsDrafts,
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
      cause: { applicationCode: result.error.code },
    });
  }
  return result.data;
}

export const providerOsRouter = router({
  purchaseStatus: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => getProviderOsPurchaseState(input.organizationId, ctx.user.id)),
  createPurchase: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => createProviderOsPurchase(input.organizationId, ctx.user.id)),
  refreshPurchase: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid(), purchaseId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => refreshProviderOsPurchase(input.organizationId, ctx.user.id, input.purchaseId)),
  completeControlledPurchase: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid(), purchaseId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => completeControlledProviderOsPurchase(input.organizationId, ctx.user.id, input.purchaseId)),
  inspectPurchases: operationsAdminProcedure
    .input(z.object({ organizationId: z.string().uuid() }).strict())
    .query(({ input }) => inspectProviderOsPurchases(input.organizationId)),

  accessStatus: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => getProviderOsAccessStatus({ ...input, actorId: ctx.user.id })),

  inspectEntitlement: operationsAdminProcedure
    .input(z.object({ organizationId: z.string().uuid() }).strict())
    .query(async ({ input }) => {
      const result = await db.query(`SELECT * FROM provider_os_entitlements WHERE organization_id = $1`, [input.organizationId]);
      return { entitlement: result.rows[0] ?? null };
    }),

  setEntitlement: operationsAdminProcedure
    .input(z.object({
      organizationId: z.string().uuid(),
      status: z.enum(['active', 'suspended', 'revoked']),
      expiresAt: z.string().datetime().nullable().optional(),
      reason: z.string().trim().min(1).max(2000),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      if (input.status === 'active' && input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Expiry must be in the future.' });
      }
      return db.transaction(async (query) => {
        // Serialize grants/revocation with premium acquisition transactions.
        const org = await query<{ status: string; provider_enabled: boolean }>(
          `SELECT status, provider_enabled FROM business_organizations WHERE id = $1 FOR UPDATE`, [input.organizationId]);
        if (!org.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Business not found.' });
        if (input.status === 'active' && (org.rows[0].status !== 'ACTIVE' || !org.rows[0].provider_enabled)) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Business must be active and provider-enabled.' });
        }
        return writeProviderOsEntitlement(query, { ...input, actorId: ctx.user.id });
      });
    }),

  createInvite: protectedProcedure
    .input(z.object({
      organizationId: z.string().uuid(),
      intendedEmail: z.string().trim().email().max(255).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(
      await createProviderOsInvite({
        actorId: ctx.user.id,
        organizationId: input.organizationId,
        intendedEmail: input.intendedEmail ?? null,
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
      proposedCustomerTotalCents: z.number().int().positive(),
      proposedPayoutCents: z.number().int().positive(),
      arrivalWindowStart: z.string().datetime(),
      arrivalWindowEnd: z.string().datetime(),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(
      await setProviderOsDraftQuote({
        actorId: ctx.user.id,
        draftId: input.draftId,
        organizationId: input.organizationId,
        proposedCustomerTotalCents: input.proposedCustomerTotalCents,
        proposedPayoutCents: input.proposedPayoutCents,
        arrivalWindowStart: input.arrivalWindowStart,
        arrivalWindowEnd: input.arrivalWindowEnd,
      }),
    )),

  requestAssessment: protectedProcedure
    .input(z.object({
      organizationId: z.string().uuid(), draftId: z.string().uuid(),
      businessMessage: z.string().trim().min(1).max(4000),
      proposedWindowStart: z.string().datetime(),
      proposedWindowEnd: z.string().datetime(),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await requestProviderOsAssessment({ ...input, actorId: ctx.user.id }))),

  listQuotes: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid(),
      cursor: z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).strict().optional(),
    }).strict())
    .query(({ ctx, input }) => listProviderOsQuotes({ ...input, actorId: ctx.user.id })),

  getQuote: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid(), quoteId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => getProviderOsQuote({ ...input, actorId: ctx.user.id })),

  listClients: protectedProcedure
    .input(z.object({ organizationId: z.string().uuid() }).strict())
    .query(async ({ ctx, input }) => unwrap(await listProviderOsClients({ ...input, actorId: ctx.user.id }))),

  listDrafts: protectedProcedure
    .input(z.object({
      organizationId: z.string().uuid(),
      posterUserId: z.string().uuid().optional(),
    }).strict())
    .query(async ({ ctx, input }) => unwrap(
      await listProviderOsDrafts({
        actorId: ctx.user.id,
        organizationId: input.organizationId,
        posterUserId: input.posterUserId,
      }),
    )),

  getDraft: protectedProcedure
    .input(z.object({
      draftId: z.string().uuid(),
      organizationId: z.string().uuid(),
    }).strict())
    .query(async ({ ctx, input }) => unwrap(
      await getProviderOsDraft({
        actorId: ctx.user.id,
        draftId: input.draftId,
        organizationId: input.organizationId,
      }),
    )),
});
