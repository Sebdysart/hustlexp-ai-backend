/**
 * Tutorial Quest Router v1.0.0
 *
 * tRPC router for onboarding tutorial quest and equipment scan.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TutorialQuestService } from '../services/TutorialQuestService';

export const tutorialRouter = router({
  getScenarios: protectedProcedure.query(async () => {
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
    .mutation(async ({ input }) => {
      return TutorialQuestService.scanEquipment(input.photoUrl);
    }),
});
