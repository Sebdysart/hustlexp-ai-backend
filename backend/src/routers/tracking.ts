/**
 * Movement Tracking Router v1.0.0
 *
 * tRPC router for real-time worker movement tracking
 *
 * @see MovementTrackingService
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { MovementTrackingService } from '../services/MovementTrackingService.js';

const GPSPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number(),
  timestamp: z.coerce.date(),
});

export const trackingRouter = router({
  /**
   * Start movement tracking session
   */
  startSession: protectedProcedure
    .input(z.object({
      taskId: z.string(),
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
  updateLocation: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      location: GPSPointSchema,
    }))
    .mutation(async ({ input }) => {
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
  stopSession: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
    }))
    .mutation(async ({ input }) => {
      const result = await MovementTrackingService.stopSession(input.sessionId);

      if (!result.success) {
        throw new Error(result.error.message);
      }

      return result.data;
    }),

  /**
   * Get session statistics
   */
  getStats: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
    }))
    .query(async ({ input }) => {
      const result = await MovementTrackingService.getSessionStats(input.sessionId);

      if (!result.success) {
        throw new Error(result.error.message);
      }

      return result.data;
    }),
});

export default trackingRouter;
