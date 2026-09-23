import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import {
  BUSINESS_TASK_STATES, DEFAULT_BUSINESS_TASK_STATES,
  decodeBusinessTaskCursor, listBusinessTasks,
} from '../services/BusinessTaskReadService.js';
import { TaskReworkService } from '../services/TaskReworkService.js';

const listInput = z.object({
  organizationId: z.string().uuid(),
  states: z.array(z.enum(BUSINESS_TASK_STATES)).min(1).max(BUSINESS_TASK_STATES.length).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2048).nullish(),
}).strict();

export const businessTaskRouter = router({
  listReworks: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => TaskReworkService.history(input.taskId, ctx.user.id, 'BUSINESS')),
  respondToRework: protectedProcedure
    .input(z.object({ reworkId: z.string().uuid(), response: z.enum(['ACCEPTED', 'DECLINED']) }).strict())
    .mutation(({ ctx, input }) => TaskReworkService.respond(input.reworkId, ctx.user.id, input.response)),
  scheduleRework: protectedProcedure
    .input(z.object({ reworkId: z.string().uuid(), serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      windowStart: z.string().datetime({ offset: true }).optional(), windowEnd: z.string().datetime({ offset: true }).optional() }).strict())
    .mutation(({ ctx, input }) => TaskReworkService.schedule({ ...input, actorId: ctx.user.id })),
  startRework: protectedProcedure
    .input(z.object({ reworkId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => TaskReworkService.start(input.reworkId, ctx.user.id)),
  submitReworkProof: protectedProcedure
    .input(z.object({
      reworkId: z.string().uuid(), description: z.string().trim().max(2000).optional(),
      photoEvidence: z.array(z.object({
        uploadReceiptId: z.string().uuid(), contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        fileSizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
        checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i),
      }).strict()).max(10).default([]),
    }).strict())
    .mutation(({ ctx, input }) => TaskReworkService.submitProof({ ...input, actorId: ctx.user.id })),
  verifyReworkCompletionCode: protectedProcedure
    .input(z.object({ reworkId: z.string().uuid(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit completion code.') }).strict())
    .mutation(({ ctx, input }) => TaskReworkService.verifyCompletionCode(input.reworkId, ctx.user.id, input.code)),
  listForOrganization: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const states = input.states ?? DEFAULT_BUSINESS_TASK_STATES;
    let cursor: ReturnType<typeof decodeBusinessTaskCursor> | null = null;
    if (input.cursor) {
      try {
        cursor = decodeBusinessTaskCursor(input.cursor, input.organizationId, states);
      } catch {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid business task cursor.' });
      }
    }
    try {
      return await listBusinessTasks({
        actorId: ctx.user.id, organizationId: input.organizationId,
        states, limit: input.limit, cursor,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'BUSINESS_TASK_ACCESS_DENIED') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Business workspace access required.' });
      }
      throw error;
    }
  }),
});
