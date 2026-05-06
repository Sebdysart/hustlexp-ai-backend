/**
 * Worker Skills Router v1.0.0
 *
 * tRPC router for worker skill management, catalog browsing,
 * and skill-based task eligibility.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, hustlerProcedure } from '../trpc.js';
import { WorkerSkillService } from '../services/WorkerSkillService.js';
import { db } from '../db.js';
import { cachedDbQuery, invalidateSkills, CACHE_TTL, CACHE_TAGS } from '../cache/db-cache.js';
import type { ServiceResult } from '../types.js';

/** WorkerSkillService returns ServiceResult; tRPC clients expect the payload only. */
function unwrapServiceResult<T>(result: ServiceResult<T>): T {
  if (result.success) return result.data;
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: result.error.message,
  });
}

export const skillsRouter = router({
  // Public: Browse skill catalog (cached)
  getCategories: publicProcedure.input(z.void()).query(async () => {
    return cachedDbQuery(
      // v2: cache stored bare arrays (unwrap ServiceResult); bump key to avoid stale wrapped JSON
      'skills:categories:v2',
      async () => unwrapServiceResult(await WorkerSkillService.getCategories()),
      { tags: [CACHE_TAGS.SKILLS], ttl: CACHE_TTL.userStats }
    );
  }),

  getSkills: publicProcedure
    .input(z.object({ categoryId: z.string().uuid().optional() }).optional())
    .query(async ({ input }) => {
      const key = `skills:list:v2:${input?.categoryId ?? 'all'}`;
      return cachedDbQuery(
        key,
        async () => unwrapServiceResult(await WorkerSkillService.getSkills(input?.categoryId)),
        { tags: [CACHE_TAGS.SKILLS], ttl: CACHE_TTL.userStats }
      );
    }),

  // Protected: Worker skill management
  addSkills: hustlerProcedure
    .input(z.object({ skillIds: z.array(z.string().uuid()).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const out = await WorkerSkillService.addSkills(ctx.user.id, input.skillIds);
      await invalidateSkills();
      return out;
    }),

  removeSkill: hustlerProcedure
    .input(z.object({ skillId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const out = await WorkerSkillService.removeSkill(ctx.user.id, input.skillId);
      await invalidateSkills();
      return out;
    }),

  getMySkills: hustlerProcedure.input(z.void()).query(async ({ ctx }) => {
    return WorkerSkillService.getWorkerSkills(ctx.user.id);
  }),

  submitLicense: hustlerProcedure
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

  getLicenseSubmissions: hustlerProcedure.input(z.void()).query(async ({ ctx }) => {
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

  checkTaskEligibility: hustlerProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return WorkerSkillService.checkTaskEligibility(ctx.user.id, input.taskId);
    }),
});
