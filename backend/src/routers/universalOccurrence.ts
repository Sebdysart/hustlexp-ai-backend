import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  PostgresUniversalV1OccurrenceFactReader,
  PostgresUniversalV1OperationsOccurrenceReader,
  UniversalV1OccurrenceReadApplication,
  UniversalV1OccurrenceReadError,
} from '../services/UniversalV1OccurrenceReadModel.js';
import { operationsStepUpProcedure, protectedProcedure, router } from '../trpc.js';

const occurrenceInput = z.object({
  task_draft_id: z.string().uuid(),
}).strict();

const operationsOccurrenceInput = occurrenceInput.extend({
  purpose: z.string().trim().min(10).max(500),
}).strict();

function occurrenceRouteError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof UniversalV1OccurrenceReadError) {
    if (error.code === 'OCCURRENCE_NOT_FOUND') {
      return new TRPCError({
        code: 'NOT_FOUND',
        message: 'The occurrence is unavailable.',
      });
    }
    if (error.code === 'OCCURRENCE_OPERATOR_AUTHORITY_REVOKED') {
      return new TRPCError({
        code: 'FORBIDDEN',
        message: 'Current Operations authority is required.',
      });
    }
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Unable to load the occurrence.',
    });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Unable to load the occurrence.',
  });
}

export function createUniversalOccurrenceRouter(
  application: UniversalV1OccurrenceReadApplication,
) {
  return router({
    customer: protectedProcedure
      .input(occurrenceInput)
      .query(async ({ ctx, input }) => {
        try {
          return await application.customer(input.task_draft_id, ctx.user.id);
        } catch (error) {
          throw occurrenceRouteError(error);
        }
      }),

    provider: protectedProcedure
      .input(occurrenceInput)
      .query(async ({ ctx, input }) => {
        try {
          return await application.provider(input.task_draft_id, ctx.user.id);
        } catch (error) {
          throw occurrenceRouteError(error);
        }
      }),

    operations: operationsStepUpProcedure
      .input(operationsOccurrenceInput)
      .mutation(async ({ ctx, input }) => {
        try {
          return await application.operationsAudited(
            input.task_draft_id,
            ctx.user.id,
            input.purpose,
          );
        } catch (error) {
          throw occurrenceRouteError(error);
        }
      }),
  });
}

export const universalOccurrenceRouter = createUniversalOccurrenceRouter(
  new UniversalV1OccurrenceReadApplication(
    new PostgresUniversalV1OccurrenceFactReader(),
    new PostgresUniversalV1OperationsOccurrenceReader(),
  ),
);

export type UniversalOccurrenceRouter = ReturnType<typeof createUniversalOccurrenceRouter>;
