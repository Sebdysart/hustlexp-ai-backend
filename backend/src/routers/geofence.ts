/**
 * Geofence Router v1.0.0
 *
 * tRPC router for geofenced check-in/check-out, proximity checks,
 * and presence verification.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, hustlerProcedure } from '../trpc.js';
import { GeofenceService } from '../services/GeofenceService.js';
import { db } from '../db.js';

export const geofenceRouter = router({
  checkProximity: hustlerProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }))
    .mutation(async ({ ctx, input }) => {
      return GeofenceService.checkProximity(input.taskId, ctx.user.id, input.lat, input.lng);
    }),

  getTaskEvents: hustlerProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const task = await db.query('SELECT poster_id, worker_id FROM tasks WHERE id = $1', [input.taskId]);
      if (!task.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });

      const { poster_id, worker_id } = task.rows[0];
      if (ctx.user.id !== poster_id && ctx.user.id !== worker_id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a participant of this task' });
      }

      return GeofenceService.getTaskEvents(input.taskId);
    }),

  verifyPresence: hustlerProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return GeofenceService.verifyPresenceDuringTask(input.taskId, ctx.user.id);
    }),
});
