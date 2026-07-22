import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { WorkerCounterOfferService } from '../services/WorkerCounterOfferService.js';
import { hustlerProcedure, posterProcedure, protectedProcedure, Schemas } from '../trpc.js';

function unwrap<T>(result: Awaited<ReturnType<
  | typeof WorkerCounterOfferService.submit
  | typeof WorkerCounterOfferService.review
  | typeof WorkerCounterOfferService.materialize
  | typeof WorkerCounterOfferService.getContext
>>): T {
  if (result.success) return result.data as T;
  const code = result.error.code === 'NOT_FOUND' ? 'NOT_FOUND'
    : result.error.code === 'FORBIDDEN' ? 'FORBIDDEN'
      : ['CONFLICT', 'COUNTER_ALREADY_AUTHORIZED', 'COUNTER_ALREADY_PENDING'].includes(result.error.code) ? 'CONFLICT'
        : ['INVALID_INPUT', 'COUNTER_OUT_OF_BOUNDS'].includes(result.error.code) ? 'BAD_REQUEST'
          : ['INVALID_STATE', 'REFUND_REQUIRED'].includes(result.error.code) ? 'PRECONDITION_FAILED'
            : 'INTERNAL_SERVER_ERROR';
  throw new TRPCError({ code, message: result.error.message });
}

export const TaskCounterOfferProcedures = {
  getWorkerCounterContext: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ ctx, input }) => unwrap(await WorkerCounterOfferService.getContext({
      taskId: input.taskId,
      viewerId: ctx.user.id,
    }))),

  submitWorkerCounter: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      proposedPayoutCents: z.number().int().positive(),
      reason: z.string().trim().min(10).max(500),
      idempotencyKey: z.string().trim().min(8).max(128),
    }))
    .mutation(async ({ ctx, input }) => unwrap(await WorkerCounterOfferService.submit({
      ...input,
      workerId: ctx.user.id,
    }))),

  reviewWorkerCounter: posterProcedure
    .input(z.object({
      counterOfferId: Schemas.uuid,
      decision: z.enum(['APPROVED', 'REJECTED']),
      reason: z.string().trim().min(10).max(500),
      idempotencyKey: z.string().trim().min(8).max(128),
    }))
    .mutation(async ({ ctx, input }) => unwrap(await WorkerCounterOfferService.review({
      ...input,
      posterId: ctx.user.id,
    }))),

  materializeWorkerCounter: posterProcedure
    .input(z.object({
      counterOfferId: Schemas.uuid,
      replacementLocation: z.string().trim().min(5).max(500),
      idempotencyKey: z.string().trim().min(8).max(128),
    }))
    .mutation(async ({ ctx, input }) => unwrap(await WorkerCounterOfferService.materialize({
      ...input,
      posterId: ctx.user.id,
    }))),
};
