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

/** Map ServiceResult error codes to tRPC error codes */
function mapErrorCode(code: string): 'NOT_FOUND' | 'FORBIDDEN' | 'PRECONDITION_FAILED' | 'BAD_REQUEST' {
  switch (code) {
    case 'NOT_FOUND': return 'NOT_FOUND';
    case 'NOT_ASSIGNED': return 'FORBIDDEN';
    case 'NO_LOCATION':
    case 'INVALID_STATE': return 'PRECONDITION_FAILED';
    default: return 'BAD_REQUEST';
  }
}

export const geofenceRouter = router({
  checkProximity: hustlerProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await GeofenceService.checkProximity(input.taskId, ctx.user.id, input.lat, input.lng);
      if (!result.success) {
        throw new TRPCError({ code: mapErrorCode(result.error.code), message: result.error.message });
      }
      return result.data;
    }),

  getTaskEvents: hustlerProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ input }) => {
      const result = await GeofenceService.getTaskEvents(input.taskId);
      if (!result.success) {
        throw new TRPCError({ code: mapErrorCode(result.error.code), message: result.error.message });
      }
      return result.data;
    }),

  verifyPresence: hustlerProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const result = await GeofenceService.verifyPresenceDuringTask(input.taskId, ctx.user.id);
      if (!result.success) {
        throw new TRPCError({ code: mapErrorCode(result.error.code), message: result.error.message });
      }
      return result.data;
    }),
});
