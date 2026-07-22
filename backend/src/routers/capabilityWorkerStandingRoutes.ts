import { z } from 'zod';
import { hustlerProcedure, publicProcedure, trustAdminProcedure } from '../trpc.js';
import * as WorkerStandingAppealService from '../services/WorkerStandingAppealService.js';

const idempotencyKey = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9:_-]+$/);
const appealToken = z.string().trim().min(32).max(200).regex(/^[A-Za-z0-9_-]+$/);
const narrative = z.string().trim().min(10).max(4000);

export const capabilityWorkerStandingProcedures = {
  getDeactivationAppeal: publicProcedure
    .input(z.object({ token: appealToken }))
    // POST keeps the bearer credential out of query strings and ordinary access logs.
    .mutation(({ input }) => WorkerStandingAppealService.getDeactivationAppealByToken(input.token)),

  openDeactivationAppeal: publicProcedure
    .input(z.object({ token: appealToken, reason: narrative, idempotencyKey }))
    .mutation(({ input }) => WorkerStandingAppealService.openDeactivationAppeal(input)),

  addDeactivationAppealEvidence: publicProcedure
    .input(z.object({
      token: appealToken,
      appealId: z.string().uuid(),
      statement: z.string().trim().min(3).max(4000),
      idempotencyKey,
    }))
    .mutation(({ input }) => WorkerStandingAppealService.addDeactivationAppealEvidence(input)),

  getMyWorkerStanding: hustlerProcedure
    .input(z.void())
    .query(({ ctx }) => WorkerStandingAppealService.getMyWorkerStanding(ctx.user.id)),

  openProgressionAppeal: hustlerProcedure
    .input(z.object({ reason: narrative, idempotencyKey }))
    .mutation(({ ctx, input }) => WorkerStandingAppealService.openProgressionAppeal({
      workerId: ctx.user.id,
      ...input,
    })),

  addProgressionAppealEvidence: hustlerProcedure
    .input(z.object({
      appealId: z.string().uuid(),
      statement: z.string().trim().min(3).max(4000),
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => WorkerStandingAppealService.addProgressionAppealEvidence({
      workerId: ctx.user.id,
      ...input,
    })),

  listPendingWorkerStandingAppeals: trustAdminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .query(({ input }) => WorkerStandingAppealService.listPendingWorkerStandingAppeals(input.limit)),

  resolveWorkerStandingAppeal: trustAdminProcedure
    .input(z.object({
      appealId: z.string().uuid(),
      decision: z.enum(['OVERTURNED','UPHELD']),
      resolutionNote: narrative,
      idempotencyKey,
    }))
    .mutation(({ ctx, input }) => WorkerStandingAppealService.resolveWorkerStandingAppeal({
      reviewerId: ctx.user.id,
      ...input,
    })),
};
