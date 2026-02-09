/**
 * Geofence Router v1.0.0
 *
 * tRPC router for geofenced check-in/check-out, proximity checks,
 * and presence verification.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { GeofenceService } from '../services/GeofenceService';

export const geofenceRouter = router({
  checkProximity: protectedProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }))
    .mutation(async ({ ctx, input }) => {
      return GeofenceService.checkProximity(input.taskId, ctx.user.id, input.lat, input.lng);
    }),

  getTaskEvents: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ input }) => {
      return GeofenceService.getTaskEvents(input.taskId);
    }),

  verifyPresence: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return GeofenceService.verifyPresenceDuringTask(input.taskId, ctx.user.id);
    }),
});
