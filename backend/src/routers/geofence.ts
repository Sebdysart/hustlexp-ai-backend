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
      clientEventId: z.string().uuid(),
      clientSequence: z.number().int().positive(),
      priorTaskVersion: z.number().int().nonnegative(),
      localOccurredAt: z.string().datetime(),
      deviceVersion: z.string().min(1).max(100),
      appVersion: z.string().min(1).max(100),
      payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const taskResult = await db.query('SELECT poster_id, worker_id FROM tasks WHERE id = $1', [input.taskId]);
      if (!taskResult.rows.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      const task = taskResult.rows[0];
      if (task.poster_id !== ctx.user.id && task.worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
      }
      return GeofenceService.checkProximity(input.taskId, ctx.user.id, input.lat, input.lng, {
        clientEventId: input.clientEventId,
        clientSequence: input.clientSequence,
        priorTaskVersion: input.priorTaskVersion,
        localOccurredAt: input.localOccurredAt,
        deviceVersion: input.deviceVersion,
        appVersion: input.appVersion,
        payloadHash: input.payloadHash,
      });
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
      const taskResult = await db.query('SELECT poster_id, worker_id FROM tasks WHERE id = $1', [input.taskId]);
      if (!taskResult.rows.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      const task = taskResult.rows[0];
      if (task.poster_id !== ctx.user.id && task.worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
      }
      return GeofenceService.verifyPresenceDuringTask(input.taskId, ctx.user.id);
    }),
});
