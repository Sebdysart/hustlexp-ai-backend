import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import { TaskReworkService } from '../services/TaskReworkService.js';

export const taskReworkRouter = router({
  listForCustomer: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => TaskReworkService.history(input.taskId, ctx.user.id, 'CUSTOMER')),
  getProof: protectedProcedure
    .input(z.object({ reworkId: z.string().uuid() }).strict())
    .query(({ ctx, input }) => TaskReworkService.proofForCustomer(input.reworkId, ctx.user.id)),
  confirm: protectedProcedure
    .input(z.object({ reworkId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => TaskReworkService.confirm(input.reworkId, ctx.user.id)),
});
