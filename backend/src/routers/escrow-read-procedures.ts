import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { EscrowService } from '../services/EscrowService.js';
import { protectedProcedure, Schemas } from '../trpc.js';

type EscrowWithPrivateIds = Record<string, unknown>;

function redactEscrow<T extends EscrowWithPrivateIds>(escrow: T, isAdmin?: boolean): T | Record<string, unknown> {
  if (isAdmin) return escrow;
  // Allowlist avoids leaking either current provider IDs or historical columns
  // retained during the forward schema migration.
  const publicFields = new Set([
    'id', 'task_id', 'version', 'amount', 'platform_fee_cents', 'state',
    'refund_amount', 'release_amount', 'payout_provider', 'provider_transfer_status',
    'provider_transfer_paid_at', 'poster_id', 'worker_id', 'funded_at',
    'released_at', 'refunded_at', 'created_at', 'updated_at',
  ]);
  return Object.fromEntries(Object.entries(escrow).filter(([key]) => publicFields.has(key)));
}

function assertParticipant(
  escrow: { poster_id?: string | null; worker_id?: string | null },
  userId: string,
  isAdmin?: boolean
): void {
  if (escrow.poster_id !== userId && escrow.worker_id !== userId && !isAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this escrow' });
  }
}

export const escrowReadProcedures = {
  getById: protectedProcedure
    .input(z.object({ escrowId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const result = await EscrowService.getById(input.escrowId);
      if (!result.success) throw new TRPCError({ code: 'NOT_FOUND', message: result.error.message });
      assertParticipant(result.data, ctx.user.id, ctx.user.is_admin);
      return redactEscrow(result.data as unknown as EscrowWithPrivateIds, ctx.user.is_admin);
    }),

  getState: protectedProcedure
    .input(z.object({ escrowId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const result = await EscrowService.getById(input.escrowId);
      if (!result.success) throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      assertParticipant(result.data, ctx.user.id, ctx.user.is_admin);
      return { state: result.data.state };
    }),

  getByTaskId: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const result = await EscrowService.getByTaskId(input.taskId);
      if (!result.success) throw new TRPCError({ code: 'NOT_FOUND', message: result.error.message });
      assertParticipant(result.data, ctx.user.id, ctx.user.is_admin);
      return redactEscrow(result.data as unknown as EscrowWithPrivateIds, ctx.user.is_admin);
    }),

  getHistory: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().nonnegative().default(0),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;
      const totalResult = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM escrows e JOIN tasks t ON t.id = e.task_id
         WHERE t.poster_id = $1 OR t.worker_id = $1`,
        [ctx.user.id]
      );
      const result = await db.query<EscrowWithPrivateIds>(
        `SELECT e.*, t.poster_id, t.worker_id FROM escrows e JOIN tasks t ON t.id = e.task_id
         WHERE t.poster_id = $1 OR t.worker_id = $1
         ORDER BY e.created_at DESC LIMIT $2 OFFSET $3`,
        [ctx.user.id, limit, offset]
      );
      return {
        items: result.rows.map((row) => redactEscrow(row, ctx.user.is_admin)),
        total: parseInt(totalResult.rows[0]?.count ?? '0', 10),
        offset,
      };
    }),
};
