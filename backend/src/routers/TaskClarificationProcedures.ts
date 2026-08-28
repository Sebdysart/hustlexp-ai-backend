import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { TaskClarificationService } from '../services/TaskClarificationService.js';
import { hustlerProcedure, posterProcedure, protectedProcedure, Schemas } from '../trpc.js';
import type { ServiceResult } from '../types.js';

function trpcCode(code: string):
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'PRECONDITION_FAILED'
  | 'CONFLICT'
  | 'INTERNAL_SERVER_ERROR' {
  if (code === 'INVALID_INPUT') return 'BAD_REQUEST';
  if (code === 'NOT_FOUND') return 'NOT_FOUND';
  if (code === 'FORBIDDEN') return 'FORBIDDEN';
  if (code === 'CONFLICT') return 'CONFLICT';
  if (code === 'INTERNAL_ERROR') return 'INTERNAL_SERVER_ERROR';
  return 'PRECONDITION_FAILED';
}

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.success) {
    throw new TRPCError({ code: trpcCode(result.error.code), message: result.error.message });
  }
  return result.data;
}

const taskInput = z.object({ taskId: Schemas.uuid }).strict();
const idempotencyKey = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const publicText = z.string().trim().min(1).max(500);
const materialRevision = z.object({
  summary: z.string().trim().min(1).max(1000),
  checklist: z.array(z.string().trim().min(1).max(200)).min(1).max(12),
  customerTotalCents: z.number().int().positive(),
  hustlerPayoutCents: z.number().int().positive(),
  platformMarginCents: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.hustlerPayoutCents + value.platformMarginCents !== value.customerTotalCents) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Revision economics must reconcile exactly.' });
  }
  if (new Set(value.checklist.map((item) => item.toLocaleLowerCase())).size !== value.checklist.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checklist'], message: 'Checklist items must be unique.' });
  }
});

export const TaskClarificationProcedures = {
  getClarificationContext: protectedProcedure
    .input(taskInput)
    .query(async ({ ctx, input }) => unwrap(await TaskClarificationService.getContext({
      taskId: input.taskId,
      viewerId: ctx.user.id,
    }))),

  askClarification: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      question: publicText,
      idempotencyKey,
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await TaskClarificationService.ask({
      taskId: input.taskId,
      workerId: ctx.user.id,
      question: input.question,
      idempotencyKey: input.idempotencyKey,
    }))),

  answerClarification: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      questionId: Schemas.uuid,
      answer: publicText,
      materialRevision: materialRevision.optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await TaskClarificationService.answer({
      taskId: input.taskId,
      questionId: input.questionId,
      posterId: ctx.user.id,
      answer: input.answer,
      materialRevision: input.materialRevision,
    }))),

  reviewClarificationRevision: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      revisionId: Schemas.uuid,
      decision: z.enum(['APPROVED', 'REJECTED']),
      reason: z.string().trim().min(10).max(1000),
    }).strict())
    .mutation(async ({ ctx, input }) => unwrap(await TaskClarificationService.reviewRevision({
      taskId: input.taskId,
      revisionId: input.revisionId,
      posterId: ctx.user.id,
      decision: input.decision,
      reason: input.reason,
    }))),
};
