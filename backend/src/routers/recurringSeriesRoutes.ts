import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { posterProcedure, Schemas } from '../trpc.js';
import { generateOccurrencesForSeries } from '../services/RecurringTaskService.js';
import {
  cancelRecurringSeries,
  createRecurringSeries,
} from '../services/RecurringSeriesMutationService.js';
import {
  mapOccurrenceToResponse,
  mapSeriesToResponse,
  recurringSeriesInput,
  type OccurrenceRow,
  type SeriesRow,
} from './recurringTaskSchemas.js';

async function ownedSeries(seriesId: string, posterId: string): Promise<void> {
  const result = await db.query(
    'SELECT id FROM recurring_task_series WHERE id = $1 AND poster_id = $2',
    [seriesId, posterId],
  );
  if (result.rows.length > 0) return;
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Series not found' });
}

export const recurringSeriesProcedures = {
  create: posterProcedure
    .input(recurringSeriesInput)
    .mutation(({ ctx, input }) => createRecurringSeries(input, {
      id: ctx.user.id,
      trustTier: ctx.user.trust_tier,
      plan: ctx.user.plan,
    })),

  listMine: posterProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).max(500).default(0).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = Math.min(input?.limit ?? 50, 100);
      const offset = input?.offset ?? 0;
      const result = await db.query<SeriesRow>(
        `SELECT rts.*, u.full_name as worker_name
         FROM recurring_task_series rts
         LEFT JOIN users u ON u.id = rts.preferred_worker_id
         WHERE rts.poster_id = $1
         ORDER BY rts.created_at DESC
         LIMIT $2 OFFSET $3`,
        [ctx.user.id, limit, offset],
      );
      return result.rows.map((row) => mapSeriesToResponse(row, row.worker_name));
    }),

  getById: posterProcedure
    .input(z.object({ id: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const result = await db.query<SeriesRow>(
        `SELECT rts.*, u.full_name as worker_name
         FROM recurring_task_series rts
         LEFT JOIN users u ON u.id = rts.preferred_worker_id
         WHERE rts.id = $1 AND rts.poster_id = $2`,
        [input.id, ctx.user.id],
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Series not found' });
      }
      return mapSeriesToResponse(result.rows[0], result.rows[0].worker_name);
    }),

  pause: posterProcedure
    .input(z.object({ id: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(
        `UPDATE recurring_task_series SET status = 'paused', updated_at = NOW()
         WHERE id = $1 AND poster_id = $2 AND status = 'active'
         RETURNING id`,
        [input.id, ctx.user.id],
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active series not found' });
      }
      return { success: true };
    }),

  resume: posterProcedure
    .input(z.object({ id: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(
        `UPDATE recurring_task_series SET status = 'active', updated_at = NOW()
         WHERE id = $1 AND poster_id = $2 AND status = 'paused'
         RETURNING id`,
        [input.id, ctx.user.id],
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Paused series not found' });
      }
      return { success: true };
    }),

  cancel: posterProcedure
    .input(z.object({ id: Schemas.uuid }))
    .mutation(({ ctx, input }) => cancelRecurringSeries(input.id, ctx.user.id)),

  listOccurrences: posterProcedure
    .input(z.object({
      seriesId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).max(500).default(0).optional(),
    }))
    .query(async ({ ctx, input }) => {
      await ownedSeries(input.seriesId, ctx.user.id);
      const limit = Math.min(input.limit ?? 50, 100);
      const result = await db.query(
        `SELECT rto.*, u.full_name as worker_name
         FROM recurring_task_occurrences rto
         LEFT JOIN users u ON u.id = rto.worker_id
         WHERE rto.series_id = $1
         ORDER BY rto.occurrence_number DESC
         LIMIT $2 OFFSET $3`,
        [input.seriesId, limit, input.offset ?? 0],
      );
      return (result.rows as unknown as OccurrenceRow[]).map(mapOccurrenceToResponse);
    }),

  skipOccurrence: posterProcedure
    .input(z.object({ occurrenceId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(
        `UPDATE recurring_task_occurrences SET status = 'skipped'
         WHERE id = $1 AND status = 'scheduled'
         AND series_id IN (SELECT id FROM recurring_task_series WHERE poster_id = $2)
         RETURNING id`,
        [input.occurrenceId, ctx.user.id],
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Scheduled occurrence not found' });
      }
      return { success: true };
    }),

  generateOccurrences: posterProcedure
    .input(z.object({
      seriesId: Schemas.uuid,
      maxOccurrences: z.number().int().min(1).max(100).default(30).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await ownedSeries(input.seriesId, ctx.user.id);
      const result = await generateOccurrencesForSeries(input.seriesId, {
        maxOccurrences: input.maxOccurrences ?? 30,
      });
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }
      return result.data;
    }),

  setPreferredWorker: posterProcedure
    .input(z.object({ seriesId: Schemas.uuid, workerId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      if (input.workerId === ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Cannot set yourself as preferred worker',
        });
      }
      const worker = await db.query<{ id: string; account_status: string }>(
        'SELECT id, account_status FROM users WHERE id = $1',
        [input.workerId],
      );
      if (worker.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Worker not found' });
      }
      if (worker.rows[0].account_status !== 'ACTIVE') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Worker account is not active and cannot be set as preferred worker',
        });
      }
      const result = await db.query(
        `UPDATE recurring_task_series
         SET preferred_worker_id = $1, updated_at = NOW()
         WHERE id = $2 AND poster_id = $3
         RETURNING id`,
        [input.workerId, input.seriesId, ctx.user.id],
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Series not found' });
      }
      return { success: true };
    }),
};
