/**
 * Worker Skills Router v1.0.0
 *
 * tRPC router for worker skill management, catalog browsing,
 * and skill-based task eligibility.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import { WorkerSkillService } from '../services/WorkerSkillService';
import { db } from '../db';

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
      // Accept both field naming conventions for frontend compat
      licenseUrl: z.string().url().optional(),
      photoUrl: z.string().url().optional(),
      licenseType: z.string().optional(),
      licenseNumber: z.string().optional(),
      licenseExpiry: z.string().datetime().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const url = input.licenseUrl || input.photoUrl;
      if (!url) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'licenseUrl or photoUrl is required' });
      }
      return WorkerSkillService.submitLicense(
        ctx.user.id,
        input.skillId,
        url,
        input.licenseExpiry ? new Date(input.licenseExpiry) : undefined
      );
    }),

  getLicenseSubmissions: protectedProcedure.query(async ({ ctx }) => {
    const result = await db.query(
      `SELECT ws.id, ws.skill_id as "skillId", s.name as "skillName",
              ws.license_url as "photoUrl", ws.verified as "licenseVerified",
              ws.verified_at as "reviewedAt", ws.created_at as "submittedAt"
       FROM worker_skills ws
       JOIN skills s ON s.id = ws.skill_id
       WHERE ws.user_id = $1 AND ws.license_url IS NOT NULL
       ORDER BY ws.created_at DESC`,
      [ctx.user.id]
    );
    return result.rows;
  }),

  checkTaskEligibility: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return WorkerSkillService.checkTaskEligibility(ctx.user.id, input.taskId);
    }),
});
