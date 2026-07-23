import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminOrEngineBridgeProcedure, router, Schemas } from '../trpc.js';
import { TaskReservationService } from '../services/TaskReservationService.js';

const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);

/** Engine-owned assignment contract for automation and /ops. */
export const assignmentRouter = router({
  reserve: adminOrEngineBridgeProcedure
    .input(z.object({
      engineTaskId: Schemas.uuid,
      hustlerRef: Schemas.uuid,
      idempotencyKey,
    }))
    .mutation(async ({ ctx, input }) => {
      const actorId = ctx.user?.id ?? ctx.engineBridgeActorId;
      if (!actorId) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Reservation actor missing' });
      }
      const result = await TaskReservationService.reserve({
        ...input,
        actorId,
      });
      if (!result.success) {
        const conflictCodes = ['IDEMPOTENCY_CONFLICT', 'RESERVATION_CONFLICT'];
        const forbiddenCodes = [
          'SELF_ASSIGNMENT_FORBIDDEN',
          'HUSTLER_NOT_FOUND',
          'HUSTLER_INELIGIBLE',
          'TRUST_TIER_INSUFFICIENT',
          'PLAN_REQUIRED',
          'BACKGROUND_CHECK_REQUIRED',
          'TASK_RISK_BLOCKED',
          'HUSTLER_ALREADY_COMMITTED',
        ];
        const code = result.error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : conflictCodes.includes(result.error.code)
            ? 'CONFLICT'
            : forbiddenCodes.includes(result.error.code)
              ? 'FORBIDDEN'
              : result.error.code === 'DB_ERROR'
                ? 'INTERNAL_SERVER_ERROR'
                : 'PRECONDITION_FAILED';
        throw new TRPCError({ code, message: result.error.message });
      }
      return result.data;
    }),
});

export type AssignmentRouter = typeof assignmentRouter;
