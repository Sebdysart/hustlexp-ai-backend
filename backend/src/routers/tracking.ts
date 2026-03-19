/**
 * Movement Tracking Router v1.0.0
 *
 * tRPC router for real-time worker movement tracking
 *
 * @see MovementTrackingService
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, hustlerProcedure } from '../trpc.js';
import { MovementTrackingService } from '../services/MovementTrackingService.js';
import { db } from '../db.js';

const GPSPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // GPS hardware cannot achieve sub-5m accuracy; cap at 100m to reject spoofed values
  accuracy: z.number().min(0).max(100).optional(),
  timestamp: z.coerce.date(),
});

export const trackingRouter = router({
  /**
   * Start movement tracking session
   */
  startSession: hustlerProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      initialLocation: GPSPointSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await MovementTrackingService.startSession(
        input.taskId,
        ctx.user.id,
        input.initialLocation
      );

      if (!result.success) {
        throw new Error(result.error.message);
      }

      return result.data;
    }),

  /**
   * Update location during tracking
   */
  updateLocation: hustlerProcedure
    .input(z.object({
      sessionId: z.string().uuid(),
      location: GPSPointSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      // Bug-AA1/1: Verify session ownership before accepting GPS updates
      const ownerCheck = await db.query<{ worker_id: string }>(
        `SELECT worker_id FROM tracking_sessions WHERE id = $1`,
        [input.sessionId]
      );
      if (ownerCheck.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Tracking session not found' });
      }
      if (ownerCheck.rows[0].worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this tracking session' });
      }

      const result = await MovementTrackingService.updateLocation({
        sessionId: input.sessionId,
        location: input.location,
      });

      if (!result.success) {
        throw new Error(result.error.message);
      }

      return { success: true };
    }),

  /**
   * Stop tracking session
   */
  stopSession: hustlerProcedure
    .input(z.object({
      sessionId: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Bug-AA1/2: Verify session ownership before stopping
      const ownerCheck = await db.query<{ worker_id: string }>(
        `SELECT worker_id FROM tracking_sessions WHERE id = $1`,
        [input.sessionId]
      );
      if (ownerCheck.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Tracking session not found' });
      }
      if (ownerCheck.rows[0].worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not own this tracking session' });
      }

      const result = await MovementTrackingService.stopSession(input.sessionId);

      if (!result.success) {
        throw new Error(result.error.message);
      }

      return result.data;
    }),

  /**
   * Get session statistics
   */
  getStats: hustlerProcedure
    .input(z.object({
      sessionId: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      // Bug-AA1/3: Only the worker OR the poster for the linked task may view stats
      const ownerCheck = await db.query<{ worker_id: string; poster_id: string }>(
        `SELECT ts.worker_id, t.poster_id
         FROM tracking_sessions ts
         JOIN tasks t ON t.id = ts.task_id
         WHERE ts.id = $1`,
        [input.sessionId]
      );
      if (ownerCheck.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Tracking session not found' });
      }
      const { worker_id, poster_id } = ownerCheck.rows[0];
      if (worker_id !== ctx.user.id && poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this tracking session' });
      }

      const result = await MovementTrackingService.getSessionStats(input.sessionId);

      if (!result.success) {
        throw new Error(result.error.message);
      }

      return result.data;
    }),
});

export default trackingRouter;
