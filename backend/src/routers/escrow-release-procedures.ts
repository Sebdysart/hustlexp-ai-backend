import { TRPCError } from '@trpc/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { db } from '../db.js';
import { stripeBreaker } from '../middleware/circuit-breaker.js';
import { EscrowService } from '../services/EscrowService.js';
import { posterProcedure, protectedProcedure, Schemas } from '../trpc.js';
import { getStripe } from './escrow-common.js';

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

async function retrieveTransfer(transferId: string): Promise<Stripe.Transfer> {
  try {
    return await stripeBreaker.execute(() => getStripe().transfers.retrieve(transferId));
  } catch {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Stripe transfer not found or could not be verified' });
  }
}

async function completedTaskPrice(escrowId: string): Promise<number> {
  const result = await db.query<{ state: string; price: number }>(
    'SELECT t.state, t.price FROM tasks t JOIN escrows e ON e.task_id = t.id WHERE e.id = $1',
    [escrowId]
  );
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found for this escrow' });
  if (result.rows[0].state !== 'COMPLETED') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Task must be completed before releasing escrow' });
  }
  const price = Number(result.rows[0].price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Task price is invalid — cannot compute release floor' });
  }
  return Math.round(price);
}

function assertTransferAmount(transfer: Stripe.Transfer, escrowAmount: number): void {
  if (transfer.amount <= 0 || transfer.amount > escrowAmount) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Stripe transfer amount is not consistent with escrow amount' });
  }
}

function assertTransferPolicy(transfer: Stripe.Transfer, taskPrice: number, escrowId: string): void {
  if (transfer.amount < Math.floor(taskPrice * 0.8)) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Transfer amount must be at least 80% of task base price' });
  }
  if (transfer.metadata?.escrow_id !== escrowId) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Stripe transfer was not created for this escrow' });
  }
}

export const escrowReleaseProcedures = {
  release: posterProcedure
    .input(Schemas.releaseEscrow)
    .mutation(async ({ ctx, input }) => {
      const escrow = await loadPosterEscrow(input.escrowId, ctx.user.id, 'release funds');
      const transfer = await retrieveTransfer(input.stripeTransferId);
      assertTransferAmount(transfer, escrow.amount);
      const taskPrice = await completedTaskPrice(input.escrowId);
      assertTransferPolicy(transfer, taskPrice, input.escrowId);
      const result = await EscrowService.release({
        escrowId: input.escrowId,
        stripeTransferId: input.stripeTransferId,
      });
      if (!result.success) {
        const code = result.error.code === 'HX201' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
        throw new TRPCError({ code, message: result.error.message });
      }
      return result.data;
    }),

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
