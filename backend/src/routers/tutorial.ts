/**
 * Tutorial Quest Router v1.0.0
 *
 * tRPC router for onboarding tutorial quest and equipment scan.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc.js';
import { TutorialQuestService } from '../services/TutorialQuestService.js';

export const tutorialRouter = router({
  getScenarios: protectedProcedure.input(z.void()).query(async () => {
    return TutorialQuestService.getScenarios();
  }),

  submitAnswers: protectedProcedure
    .input(z.object({
      answers: z.array(z.object({
        scenarioId: z.string(),
        action: z.enum(['flag_risk', 'decline_task', 'request_details', 'accept_task']),
      })).min(1).max(5),
    }))
    .mutation(async ({ ctx, input }) => {
      return TutorialQuestService.submitAnswers(ctx.user.id, input.answers);
    }),

  scanEquipment: protectedProcedure
    .input(z.object({ photoUrl: z.string().url() }))
    .mutation(async () => {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Equipment photo scanning is unavailable until receipt-backed metadata stripping is implemented.',
      });
    }),
});
