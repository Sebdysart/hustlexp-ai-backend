import { z } from 'zod';
import { invalidateTask } from '../cache/db-cache.js';
import { TaskScopeService } from '../services/TaskScopeService.js';
import { protectedProcedure, Schemas } from '../trpc.js';

const checklist = z.array(z.string().trim().min(1).max(200)).min(1).max(12);

export const TaskScopeProcedures = {
  getExecutionScope: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(({ ctx, input }) => TaskScopeService.getForParticipant(input.taskId, ctx.user.id)),

  proposeScopeChange: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      observedScopeSummary: z.string().trim().min(1).max(1000),
      proposedChecklist: checklist,
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskScopeService.proposeChange({ ...input, userId: ctx.user.id });
      await invalidateTask(input.taskId);
      return result;
    }),

  reviewScopeChange: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      proposalId: Schemas.uuid,
      decision: z.enum(['APPROVED', 'REJECTED']),
      reason: z.string().trim().min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskScopeService.reviewChange({ ...input, posterId: ctx.user.id });
      await invalidateTask(input.taskId);
      return result;
    }),

  setScopeChecklistItem: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      versionId: Schemas.uuid,
      itemIndex: z.number().int().min(0).max(11),
      completed: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskScopeService.setChecklistItem({ ...input, workerId: ctx.user.id });
      await invalidateTask(input.taskId);
      return result;
    }),
};
