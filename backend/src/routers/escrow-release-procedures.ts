import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { EscrowService } from '../services/EscrowService.js';
import { posterProcedure, protectedProcedure, Schemas } from '../trpc.js';

type PosterEscrow = {
  id: string;
  amount: number;
  poster_id: string;
  worker_id?: string | null;
};

async function loadPosterEscrow(
  escrowId: string,
  posterId: string,
  action: 'release funds' | 'request a refund',
): Promise<PosterEscrow> {
  const result = await EscrowService.getById(escrowId);
  if (!result.success) throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
  if (result.data.poster_id !== posterId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `Only the escrow creator can ${action}` });
  }
  return result.data as unknown as PosterEscrow;
}

export const escrowReleaseProcedures = {
  refund: posterProcedure
    .input(z.object({ escrowId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      await loadPosterEscrow(input.escrowId, ctx.user.id, 'request a refund');
      const result = await EscrowService.refund({ escrowId: input.escrowId });
      if (!result.success) throw new TRPCError({ code: 'BAD_REQUEST', message: result.error.message });
      return result.data;
    }),

  lockForDispute: protectedProcedure
    .input(z.object({ escrowId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const escrow = await EscrowService.getById(input.escrowId);
      if (!escrow.success) throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      if (escrow.data.poster_id !== ctx.user.id && escrow.data.worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only task participants can file a dispute' });
      }
      const result = await EscrowService.lockForDispute(input.escrowId, {
        adminOverride: false,
        initiatedBy: ctx.user.id,
        allowedTaskStates: ['ACCEPTED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'DISPUTED', 'COMPLETED'],
      });
      if (!result.success) throw new TRPCError({ code: 'BAD_REQUEST', message: result.error.message });
      return result.data;
    }),
};
