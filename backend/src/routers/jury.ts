/**
 * Jury Pool Router v1.0.0
 *
 * tRPC router for community dispute resolution via jury voting.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { JuryPoolService } from '../services/JuryPoolService';

export const juryRouter = router({
  submitVote: protectedProcedure
    .input(z.object({
      disputeId: z.string().uuid(),
      vote: z.enum(['worker_complete', 'worker_incomplete', 'inconclusive']),
      confidence: z.number().min(0).max(1),
    }))
    .mutation(async ({ ctx, input }) => {
      return JuryPoolService.submitVote(input.disputeId, ctx.user.id, input.vote, input.confidence);
    }),

  getVoteTally: protectedProcedure
    .input(z.object({ disputeId: z.string().uuid() }))
    .query(async ({ input }) => {
      return JuryPoolService.getVoteTally(input.disputeId);
    }),
});
