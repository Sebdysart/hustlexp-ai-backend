import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, hustlerProcedure, posterProcedure, protectedProcedure } from '../trpc.js';
import { TippingService } from '../services/TippingService.js';
import { db } from '../db.js';

export const tippingRouter = router({
  // FIX: createTip and confirmTip changed from hustlerProcedure to posterProcedure.
  // Posters tip workers, not the other way around.
  createTip: posterProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      amountCents: z.number().min(100).max(50000),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TippingService.createTip({
        taskId: input.taskId,
        posterId: ctx.user.id,
        amountCents: input.amountCents,
      });
      if (!result.success) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: result.error?.message || 'Failed to create tip' });
      }
      return result.data;
    }),

  confirmTip: posterProcedure
    .input(z.object({
      tipId: z.string().uuid(),
      stripePaymentIntentId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const tipCheck = await db.query<{ poster_id: string }>(
        'SELECT poster_id FROM tips WHERE id = $1',
        [input.tipId]
      );
      if (tipCheck.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Tip not found' });
      }
      if (tipCheck.rows[0].poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not authorized to confirm this tip' });
      }

      const result = await TippingService.confirmTip(input.tipId, input.stripePaymentIntentId);
      if (!result.success) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: result.error?.message || 'Failed to confirm tip' });
      }
      return result.data;
    }),

  // Read-only endpoints: protectedProcedure allows both roles to view tips
  getTipsForTask: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx: _ctx, input }) => {
      const result = await TippingService.getTipsForTask(input.taskId);
      if (!result.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: result.error?.message || 'Failed to get tips' });
      }
      return result.data;
    }),

  getMyTipsReceived: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const result = await TippingService.getTotalTipsReceived(ctx.user.id);
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error?.message || 'Failed to get tips received' });
      }
      return result.data;
    }),

  getMyTipsSent: posterProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }).default({ limit: 50, offset: 0 }))
    .query(async ({ ctx, input }) => {
      const result = await TippingService.getTipsSentByUser(ctx.user.id, input.limit, input.offset);
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error?.message || 'Failed to get tips sent' });
      }
      return result.data;
    }),
});
