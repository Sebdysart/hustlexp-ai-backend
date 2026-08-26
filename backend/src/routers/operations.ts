import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { operationsAdminProcedure, router } from '../trpc.js';
import { AIObservabilityService } from '../services/AIObservabilityService.js';
import {
  OperationsExceptionService,
  operationsPriorityClasses,
} from '../services/OperationsExceptionService.js';

const clusterKey = z.string().min(3).max(240);
const idempotencyKey = z.string().uuid();

export const operationsRouter = router({
  listAIActivity: operationsAdminProcedure
    .input(z.object({
      surfaceId: z.string().trim().min(3).max(100).optional(),
      executionResult: z.enum(['GENERATED', 'CACHED', 'FAILED']).optional(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(10_000).default(0),
    }))
    .query(({ input }) => AIObservabilityService.list(input)),

  getAIObservationDetail: operationsAdminProcedure
    .input(z.object({
      observationId: z.string().uuid(),
      purpose: z.string().trim().min(10).max(500),
    }))
    .query(async ({ ctx, input }) => {
      const detail = await AIObservabilityService.getDetail(
        input.observationId,
        input.purpose,
        ctx.user.id,
      );
      if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'AI observation not found.' });
      return detail;
    }),

  listExceptions: operationsAdminProcedure
    .input(z.object({
      priorityClass: z.enum(operationsPriorityClasses).optional(),
      ownership: z.enum(['ALL', 'MINE', 'UNASSIGNED']).default('ALL'),
      search: z.string().trim().min(2).max(100).optional(),
      sort: z.enum(['PRIORITY', 'OLDEST', 'NEWEST', 'SIGNAL_COUNT']).default('PRIORITY'),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(10_000).default(0),
    }))
    .query(({ ctx, input }) => OperationsExceptionService.list(input, ctx.user.id)),

  getExceptionDetail: operationsAdminProcedure
    .input(z.object({
      clusterKey,
      purpose: z.string().trim().min(10).max(500),
    }))
    .query(({ ctx, input }) => OperationsExceptionService.getDetail(
      input.clusterKey,
      input.purpose,
      ctx.user.id,
    )),

  getModelHealth: operationsAdminProcedure
    .input(z.object({}))
    .query(() => OperationsExceptionService.getModelHealth()),

  claimException: operationsAdminProcedure
    .input(z.object({ clusterKey, idempotencyKey }))
    .mutation(({ ctx, input }) => OperationsExceptionService.claim(input, ctx.user.id)),

  releaseException: operationsAdminProcedure
    .input(z.object({ clusterKey, idempotencyKey }))
    .mutation(({ ctx, input }) => OperationsExceptionService.release(input, ctx.user.id)),

  scheduleNotificationRecovery: operationsAdminProcedure
    .input(z.object({ clusterKey, deliveryId: z.string().uuid(), idempotencyKey }))
    .mutation(({ ctx, input }) => OperationsExceptionService.scheduleNotificationRecovery(
      input,
      ctx.user.id,
    )),

  cancelNotificationRecovery: operationsAdminProcedure
    .input(z.object({ clusterKey, actionEventId: z.string().uuid(), idempotencyKey }))
    .mutation(({ ctx, input }) => OperationsExceptionService.cancelNotificationRecovery(
      input,
      ctx.user.id,
    )),
});

export default operationsRouter;
