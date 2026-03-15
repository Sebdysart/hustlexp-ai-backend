/**
 * Intent Router v1.0.0
 *
 * Admin-only tRPC procedures for intent analysis:
 * - intent.analyze: Analyze natural language description
 * - intent.validateChanges: Compare intent against actual file changes
 *
 * @see backend/src/services/IntentParserService.ts
 */

import { z } from 'zod';
import { router, hustlerProcedure } from '../trpc.js';
import { IntentParserService } from '../services/IntentParserService.js';

export const intentRouter = router({
  /**
   * Analyze natural language description
   */
  analyze: hustlerProcedure
    .input(z.object({
      description: z.string().min(10),
    }))
    .query(async ({ input }) => {
      const result = await IntentParserService.analyzeIntent(input.description);

      if (!result.success) {
        throw new Error(result.error?.message || 'Intent analysis failed');
      }

      return result.data;
    }),

  /**
   * Validate intent against actual changes
   */
  validateChanges: hustlerProcedure
    .input(z.object({
      description: z.string(),
      changedFiles: z.array(z.string()),
    }))
    .query(async ({ input }) => {
      const intentResult = await IntentParserService.analyzeIntent(input.description);

      if (!intentResult.success) {
        throw new Error('Intent analysis failed');
      }

      const intent = intentResult.data!;
      const mismatches: string[] = [];

      // Check if mentioned services were changed
      intent.affectedServices.forEach((service: string) => {
        const serviceFile = `backend/src/services/${service}.ts`;
        if (!input.changedFiles.includes(serviceFile)) {
          mismatches.push(`Description mentions ${service} but ${serviceFile} was not changed`);
        }
      });

      // Check if mentioned routers were changed
      intent.affectedRouters.forEach((router: string) => {
        const routerFile = `backend/src/routers/${router}.ts`;
        if (!input.changedFiles.includes(routerFile)) {
          mismatches.push(`Description mentions ${router} router but ${routerFile} was not changed`);
        }
      });

      return {
        intent,
        mismatches,
        valid: mismatches.length === 0,
      };
    }),
});

export default intentRouter;
