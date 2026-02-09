/**
 * Worker Skills Router v1.0.0
 *
 * tRPC router for worker skill management, catalog browsing,
 * and skill-based task eligibility.
 */

import { z } from 'zod';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import { WorkerSkillService } from '../services/WorkerSkillService';

export const skillsRouter = router({
  // Public: Browse skill catalog
  getCategories: publicProcedure.query(async () => {
    return WorkerSkillService.getCategories();
  }),

  getSkills: publicProcedure
    .input(z.object({ categoryId: z.string().uuid().optional() }).optional())
    .query(async ({ input }) => {
      return WorkerSkillService.getSkills(input?.categoryId);
    }),

  // Protected: Worker skill management
  addSkills: protectedProcedure
    .input(z.object({ skillIds: z.array(z.string().uuid()).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      return WorkerSkillService.addSkills(ctx.user.id, input.skillIds);
    }),

  removeSkill: protectedProcedure
    .input(z.object({ skillId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return WorkerSkillService.removeSkill(ctx.user.id, input.skillId);
    }),

  getMySkills: protectedProcedure.query(async ({ ctx }) => {
    return WorkerSkillService.getWorkerSkills(ctx.user.id);
  }),

  submitLicense: protectedProcedure
    .input(z.object({
      skillId: z.string().uuid(),
      licenseUrl: z.string().url(),
      licenseExpiry: z.string().datetime().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return WorkerSkillService.submitLicense(
        ctx.user.id,
        input.skillId,
        input.licenseUrl,
        input.licenseExpiry ? new Date(input.licenseExpiry) : undefined
      );
    }),

  checkTaskEligibility: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return WorkerSkillService.checkTaskEligibility(ctx.user.id, input.taskId);
    }),
});
