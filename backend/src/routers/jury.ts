/**
 * Jury Pool Router v1.0.0
 *
 * tRPC router for community dispute resolution via jury voting.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc.js';
import { JuryPoolService } from '../services/JuryPoolService.js';
import { db } from '../db.js';

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
    .query(async ({ ctx, input }) => {
      const dispute = await db.query(
        'SELECT d.id, t.poster_id, t.worker_id FROM disputes d JOIN tasks t ON t.id = d.task_id WHERE d.id = $1',
        [input.disputeId]
      );
      if (!dispute.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Dispute not found' });

      const { poster_id, worker_id } = dispute.rows[0];
      if (ctx.user.id !== poster_id && ctx.user.id !== worker_id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a participant of this dispute' });
      }

      return JuryPoolService.getVoteTally(input.disputeId);
    }),
});
