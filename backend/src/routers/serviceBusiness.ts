import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import type { ServiceResult } from '../types.js';
import {
  acceptServiceBusinessOpportunity,
  clarifyServiceBusinessOpportunity,
  declineServiceBusinessOpportunity,
  linkServiceBusinessPayoutAccount,
  listServiceBusinessOpportunities,
  quoteServiceBusinessOpportunity,
  reviewServiceBusinessOpportunity,
} from '../services/ServiceBusinessExecutionService.js';
import { serviceBusinessRouterCode } from './ServiceBusinessRouterErrors.js';

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.success) {
    throw new TRPCError({
      code: serviceBusinessRouterCode(result.error.code),
      message: result.error.message,
    });
  }
  return result.data;
}

const uuid = z.string().uuid();
const idempotencyKey = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const organizationInput = z.object({ organizationId: uuid }).strict();
const reviewedOfferInput = z.object({
  organizationId: uuid,
  offerDecisionId: uuid,
  idempotencyKey,
}).strict();

export const serviceBusinessRouter = router({
  linkPayoutAccount: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      payoutMembershipId: uuid,
      idempotencyKey,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await linkServiceBusinessPayoutAccount({
      ...input,
      actorId: ctx.user.id,
    }))),

  listOpportunities: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => unwrap(
      await listServiceBusinessOpportunities(ctx.user.id, input.organizationId),
    )),

  reviewOpportunity: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      serviceProfileId: uuid,
      crewAssignmentId: uuid,
      taskId: uuid,
      idempotencyKey,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await reviewServiceBusinessOpportunity({
      ...input,
      actorId: ctx.user.id,
    }))),

  acceptOpportunity: protectedProcedure
    .input(z.object({
      organizationId: uuid,
      serviceProfileId: uuid,
      crewAssignmentId: uuid,
      fulfillerUserId: uuid,
      offerDecisionId: uuid,
      taskId: uuid,
      idempotencyKey,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await acceptServiceBusinessOpportunity({
      ...input,
      actorId: ctx.user.id,
    }))),

  declineOpportunity: protectedProcedure
    .input(reviewedOfferInput.extend({
      reasonCode: z.enum([
        'OUTSIDE_SERVICE_AREA', 'CAPACITY_UNAVAILABLE', 'SCHEDULE_CONFLICT',
        'SCOPE_UNSUPPORTED', 'CREDENTIAL_UNAVAILABLE', 'ECONOMICS_UNWORKABLE', 'OTHER',
      ]),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await declineServiceBusinessOpportunity({
      ...input,
      actorId: ctx.user.id,
    }))),

  requestClarification: protectedProcedure
    .input(reviewedOfferInput.extend({
      question: z.string().trim().min(5).max(500),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await clarifyServiceBusinessOpportunity({
      ...input,
      actorId: ctx.user.id,
    }))),

  quoteOpportunity: protectedProcedure
    .input(reviewedOfferInput.extend({
      proposedPayoutCents: z.number().int().positive().max(2_000_000_000),
      reason: z.string().trim().min(10).max(500),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await quoteServiceBusinessOpportunity({
      ...input,
      actorId: ctx.user.id,
    }))),
});

export type ServiceBusinessRouter = typeof serviceBusinessRouter;
