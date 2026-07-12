import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminOrEngineBridgeProcedure, adminProcedure, router, Schemas } from '../trpc.js';
import { AutomationLifecycleService } from '../services/AutomationLifecycleService.js';
import { VerifiedPosterCompletionService } from '../services/VerifiedPosterCompletionService.js';
import { TaskService } from '../services/TaskService.js';

const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);

function throwServiceError(error: { code: string; message: string }): never {
  const code = error.code === 'NOT_FOUND'
    ? 'NOT_FOUND'
    : error.code === 'IDEMPOTENCY_CONFLICT'
      ? 'CONFLICT'
      : error.code === 'DB_ERROR'
        ? 'INTERNAL_SERVER_ERROR'
        : error.code === 'INVALID_CURSOR'
          ? 'BAD_REQUEST'
          : 'PRECONDITION_FAILED';
  throw new TRPCError({ code, message: error.message });
}

/** Admin-gated engine lifecycle and automation scheduler contracts. */
export const automationRouter = router({
  listTasks: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().max(512).nullish(),
    }))
    .query(async ({ input }) => {
      const result = await AutomationLifecycleService.listTasks(input);
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  expireUnfilled: adminProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      idempotencyKey,
    }))
    .mutation(async ({ input }) => {
      const result = await AutomationLifecycleService.expireUnfilled(input);
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  expireDue: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .mutation(async ({ input }) => {
      const result = await AutomationLifecycleService.expireDue(input);
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  recordCompletionDelivery: adminProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      providerDeliveryId: z.string().trim().min(4).max(255),
      channel: z.enum(['SMS', 'EMAIL', 'PUSH']),
      deliveredAt: z.string().datetime(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.recordCompletionDelivery({
        taskId: input.engineTaskId,
        providerDeliveryId: input.providerDeliveryId,
        channel: input.channel,
        deliveredAt: new Date(input.deliveredAt),
        actorId: ctx.user.id,
      });
      if (!result.success) throwServiceError(result.error);
      return result.data;
    }),

  completeUnattended: adminProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      idempotencyKey,
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.complete(input.engineTaskId, undefined, {
        mode: 'UNATTENDED',
        idempotencyKey: input.idempotencyKey,
        actorId: ctx.user.id,
      });
      if (!result.success) throwServiceError(result.error);
      return {
        engineTaskId: result.data.id,
        lifecycleState: 'PAYOUT_READY' as const,
        payoutState: 'READY' as const,
        idempotencyReplayed: result.data.completion_idempotency_replayed === true,
      };
    }),

  confirmPosterCompletion: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      providerConfirmationId: z.string().trim().min(8).max(255).regex(/^[A-Za-z0-9:_-]+$/),
      score: z.union([z.literal(4), z.literal(5)]),
    }))
    .mutation(async ({ ctx, input }) => {
      const actorId = ctx.user?.id ?? ctx.engineBridgeActorId!;
      const result = await VerifiedPosterCompletionService.confirm({
        taskId: input.engineTaskId,
        providerConfirmationId: input.providerConfirmationId,
        score: input.score,
        actorId,
      });
      if (!result.success) throwServiceError(result.error);
      return {
        engineTaskId: result.data.id,
        lifecycleState: 'PAYOUT_READY' as const,
        payoutState: 'READY' as const,
        idempotencyReplayed: result.data.completion_idempotency_replayed === true,
      };
    }),

  markWorkerTraveling: adminOrEngineBridgeProcedure
    .input(z.object({ engineTaskId: Schemas.uuid }))
    .mutation(async ({ input }) => {
      const task = await TaskService.getById(input.engineTaskId);
      if (!task.success) throwServiceError(task.error);
      if (!task.data.worker_id) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Task has no engine-reserved hustler' });
      }
      const result = await TaskService.advanceProgress({
        taskId: input.engineTaskId,
        to: 'TRAVELING',
        actor: { type: 'worker', userId: task.data.worker_id },
      });
      if (!result.success) throwServiceError(result.error);
      return {
        engineTaskId: result.data.id,
        progressState: 'TRAVELING' as const,
      };
    }),
});

export type AutomationRouter = typeof automationRouter;
