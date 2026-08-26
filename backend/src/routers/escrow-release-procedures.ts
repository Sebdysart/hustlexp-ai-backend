import { TRPCError } from '@trpc/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { clampFeePercent, computeFeeBreakdown } from '../lib/money.js';
import { stripeBreaker } from '../middleware/circuit-breaker.js';
import { EscrowService } from '../services/EscrowService.js';
import type { StripeTransferWitness } from '../services/EscrowReleaseTypes.js';
import { loadCurrentTaskPayoutDestination } from '../services/TaskPayoutDestinationService.js';
import { posterProcedure, protectedProcedure, Schemas } from '../trpc.js';
import { getStripe } from './escrow-common.js';

type PosterEscrow = {
  id: string;
  amount: number;
  platform_fee_cents?: number | null;
  poster_id: string;
  worker_id?: string | null;
};

type CompletedTaskPayout = {
  taskId: string;
  taskPriceCents: number;
  workerId: string;
  payoutRecipientUserId: string;
  stripeConnectId: string;
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

async function completedTaskPayout(escrowId: string): Promise<CompletedTaskPayout> {
  const result = await db.query<{
    id: string;
    state: string;
    price: number;
    worker_id: string | null;
    payout_recipient_user_id: string | null;
  }>(
    `SELECT t.id, t.state, t.price, t.worker_id, t.payout_recipient_user_id
     FROM tasks t
     JOIN escrows e ON e.task_id = t.id
     WHERE e.id = $1`,
    [escrowId]
  );
  const task = result.rows[0];
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found for this escrow' });
  if (task.state !== 'COMPLETED') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Task must be completed before releasing escrow' });
  }
  if (!task.worker_id) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Task has no assigned payout recipient' });
  }
  const taskPriceCents = Math.round(Number(task.price));
  if (!Number.isFinite(taskPriceCents) || taskPriceCents <= 0) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Task price is invalid' });
  }
  const payoutRecipientUserId = task.payout_recipient_user_id ?? task.worker_id;
  const destination = await loadCurrentTaskPayoutDestination(db.query.bind(db), {
    taskId: task.id,
    workerId: task.worker_id,
    payoutRecipientUserId,
  });
  if (!destination.ready || !destination.stripeConnectId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Payout destination is not current (${destination.reason})`,
    });
  }
  return {
    taskId: task.id,
    taskPriceCents,
    workerId: task.worker_id,
    payoutRecipientUserId,
    stripeConnectId: destination.stripeConnectId,
  };
}

function assertTransferPolicy(input: {
  transfer: Stripe.Transfer;
  transferId: string;
  escrow: PosterEscrow;
  payout: CompletedTaskPayout;
}): void {
  const expected = computeFeeBreakdown(
    input.escrow.amount,
    clampFeePercent(config.stripe.platformFeePercent),
    input.escrow.platform_fee_cents,
  );
  const destination = typeof input.transfer.destination === 'string'
    ? input.transfer.destination
    : input.transfer.destination?.id;
  if (
    input.transfer.id !== input.transferId
    || input.escrow.amount !== input.payout.taskPriceCents
    || input.transfer.amount !== expected.netPayoutCents
    || input.transfer.currency !== 'usd'
    || input.transfer.reversed === true
    || input.transfer.amount_reversed !== 0
    || destination !== input.payout.stripeConnectId
    || input.transfer.metadata?.escrow_id !== input.escrow.id
    || input.transfer.metadata?.worker_id !== input.payout.payoutRecipientUserId
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Stripe transfer does not match the canonical payout amount, destination, and task binding',
    });
  }
}

function transferWitness(transfer: Stripe.Transfer): StripeTransferWitness {
  return {
    provider: 'STRIPE',
    transferId: transfer.id,
    amountCents: transfer.amount,
    currency: transfer.currency,
    destinationAccountId: typeof transfer.destination === 'string'
      ? transfer.destination
      : transfer.destination?.id ?? null,
    reversed: transfer.reversed === true,
    amountReversedCents: transfer.amount_reversed,
    escrowId: transfer.metadata?.escrow_id ?? null,
    taskId: transfer.metadata?.task_id ?? null,
    payoutRecipientUserId: transfer.metadata?.worker_id ?? null,
  };
}

export const escrowReleaseProcedures = {
  release: posterProcedure
    .input(Schemas.releaseEscrow)
    .mutation(async ({ ctx, input }) => {
      const escrow = await loadPosterEscrow(input.escrowId, ctx.user.id, 'release funds');
      const transfer = await retrieveTransfer(input.stripeTransferId);
      const payout = await completedTaskPayout(input.escrowId);
      assertTransferPolicy({
        transfer,
        transferId: input.stripeTransferId,
        escrow,
        payout,
      });
      const result = await EscrowService.release({
        escrowId: input.escrowId,
        stripeTransferId: input.stripeTransferId,
        stripeTransferWitness: transferWitness(transfer),
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
