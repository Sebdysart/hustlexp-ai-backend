/**
 * Intent Bridge Router v1.0.0
 *
 * Admin-only tRPC procedures for natural language intent analysis.
 *
 * Allows admin users to analyze proposed changes and validate
 * that PR descriptions match actual file changes.
 *
 * @see IntentParserService.ts
 */

import { router, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { IntentParserService } from '../services/IntentParserService';

export const intentRouter = router({
  /**
   * Analyze a natural language description of a proposed change.
   * Returns affected invariants, services, routers, tier, and risk assessment.
   */
  analyze: adminProcedure
    .input(z.object({
      description: z.string().min(1).max(5000),
    }))
    .mutation(async ({ input }) => {
      const result = await IntentParserService.analyzeIntent(input.description);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * Validate that a PR description aligns with changed files.
   * Returns the intent analysis plus any mismatches found.
   */
  validateChanges: adminProcedure
    .input(z.object({
      description: z.string().min(1).max(5000),
      changedFiles: z.array(z.string().max(500)).max(500),
    }))
    .mutation(async ({ input }) => {
      const result = await IntentParserService.analyzeIntent(input.description);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      const analysis = result.data;
      const mismatches: string[] = [];

      // Check: intent says service X affected but files for X not changed
      for (const svc of analysis.affectedServices) {
        const expectedPath = `backend/src/services/${svc}.ts`;
        const found = input.changedFiles.some((f) => f.includes(expectedPath));
        if (!found) {
          mismatches.push(`Description mentions ${svc} but no changes found in its files`);
        }
      }

      // Check: intent says router R affected but files for R not changed
      for (const rtr of analysis.affectedRouters) {
        const expectedPath = `backend/src/routers/${rtr}.ts`;
        const found = input.changedFiles.some((f) => f.includes(expectedPath));
        if (!found) {
          mismatches.push(`Description mentions router "${rtr}" but no changes found in ${expectedPath}`);
        }
      }

      // Check: files changed but not mentioned in intent
      for (const file of input.changedFiles) {
        const serviceMatch = file.match(/backend\/src\/services\/(\w+)\.ts$/);
        const routerMatch = file.match(/backend\/src\/routers\/(\w+)\.ts$/);

        if (serviceMatch) {
          const svc = serviceMatch[1];
          if (!analysis.affectedServices.some((s) => s.toLowerCase().includes(svc.toLowerCase()))) {
            mismatches.push(`Changed ${file} but description doesn't mention "${svc}" service`);
          }
        }

        if (routerMatch) {
          const rtr = routerMatch[1];
          if (!analysis.affectedRouters.includes(rtr)) {
            mismatches.push(`Changed ${file} but description doesn't mention "${rtr}" router`);
          }
        }
      }

      return { analysis, mismatches };
    }),
});

export type IntentRouter = typeof intentRouter;
