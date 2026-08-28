import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import { XPService } from '../services/XPService.js';
import { hustlerProcedure, Schemas } from '../trpc.js';

function xpErrorCode(code: string): 'PRECONDITION_FAILED' | 'CONFLICT' | 'BAD_REQUEST' {
  if (code === 'HX101') return 'PRECONDITION_FAILED';
  if (code === '23505') return 'CONFLICT';
  return 'BAD_REQUEST';
}

export const escrowXpProcedures = {
  awardXP: hustlerProcedure
    .input(Schemas.awardXP)
    .mutation(async ({ ctx, input }) => {
      const result = await db.query<{ amount: number; worker_id: string; task_id: string }>(
        `SELECT amount, worker_id, task_id FROM escrows WHERE id = $1 AND state = 'RELEASED'`,
        [input.escrowId]
      );
      const escrow = result.rows[0];
      if (!escrow) throw new TRPCError({ code: 'NOT_FOUND', message: 'Released escrow not found' });
      if (escrow.worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not the worker for this escrow' });
      }
      if (escrow.task_id !== input.taskId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'taskId does not match escrow' });
      }
      const awarded = await XPService.awardXP({
        userId: ctx.user.id,
        taskId: input.taskId,
        escrowId: input.escrowId,
        baseXP: Math.round(escrow.amount / 10),
      });
      if (!awarded.success) {
        throw new TRPCError({ code: xpErrorCode(awarded.error.code), message: awarded.error.message });
      }
      return awarded.data;
    }),
};
