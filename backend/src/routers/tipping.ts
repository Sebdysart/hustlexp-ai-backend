/**
 * Tipping Router v1.0.0
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { TippingService } from '../services/TippingService';
import { db } from '../db';

export const tippingRouter = router({
  createTip: protectedProcedure
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
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error?.message || 'Failed to create tip',
        });
      }
      return result.data;
    }),

  confirmTip: protectedProcedure
    .input(z.object({
      tipId: z.string().uuid(),
      stripePaymentIntentId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Auth check: verify the caller created this tip
      const tipCheck = await db.query<{ poster_id: string }>(
        `SELECT poster_id FROM tips WHERE id = $1`,
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
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error?.message || 'Failed to confirm tip',
        });
      }
      return result.data;
    }),

  getTipsForTask: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const result = await TippingService.getTipsForTask(input.taskId);
      if (!result.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: result.error?.message || 'Failed to get tips for task',
        });
      }
      return result.data;
    }),

  getMyTipsReceived: protectedProcedure
    .query(async ({ ctx }) => {
      const result = await TippingService.getTotalTipsReceived(ctx.user.id);
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error?.message || 'Failed to get tips received',
        });
      }
      return result.data;
    }),
});
