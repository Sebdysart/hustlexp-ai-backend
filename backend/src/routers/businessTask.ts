import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import {
  BUSINESS_TASK_STATES, DEFAULT_BUSINESS_TASK_STATES,
  decodeBusinessTaskCursor, listBusinessTasks,
} from '../services/BusinessTaskReadService.js';

const listInput = z.object({
  organizationId: z.string().uuid(),
  states: z.array(z.enum(BUSINESS_TASK_STATES)).min(1).max(BUSINESS_TASK_STATES.length).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2048).nullish(),
}).strict();

export const businessTaskRouter = router({
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
