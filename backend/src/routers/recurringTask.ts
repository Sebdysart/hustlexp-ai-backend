/**
 * Recurring Task Router v1.0.0
 *
 * Recurring task series management for poster-side task automation.
 * Gated to Trusted trust tier (tier 3+) with subscription-based limits.
 *
 * Features:
 * - Create / pause / resume / cancel recurring series
 * - List occurrences, skip occurrences
 * - Set preferred worker for auto-assignment
 *
 * @see PRODUCT_SPEC §12 (Recurring Tasks)
 * @see add_squads_and_recurring_tasks.sql
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, Schemas } from '../trpc';
import { db } from '../db';

// Subscription limits for recurring task series
const RECURRING_TASK_LIMITS: Record<string, number> = {
  free: 0,
  premium: 5,
  pro: 999999,
};

// ── Row Types ─────────────────────────────────────────────────────────────

interface SeriesRow {
  id: string;
  poster_id: string;
  template_task_id: string | null;
  pattern: string;
  day_of_week: number | null;
  day_of_month: number | null;
  time_of_day: string | null;
  start_date: string;
  end_date: string | null;
  title: string;
  description: string;
  payment_cents: number;
  location: string;
  category: string | null;
  estimated_duration: string;
  required_tier: number;
  status: string;
  occurrence_count: number;
  completed_count: number;
  preferred_worker_id: string | null;
  next_occurrence_at: string | null;
  created_at: string;
  updated_at: string;
  worker_name: string | null;
}

interface OccurrenceRow {
  id: string;
  series_id: string;
  task_id: string | null;
  occurrence_number: number;
  scheduled_date: string;
  status: string;
  worker_id: string | null;
  worker_name: string | null;
  completed_at: string | null;
  rating: number | null;
}

// ── Response Mappers ────────────────────────────────────────────────────────

function mapSeriesToResponse(row: SeriesRow, workerName?: string | null) {
  return {
    id: row.id,
    posterId: row.poster_id,
    templateTaskId: row.template_task_id,
    pattern: row.pattern,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    timeOfDay: row.time_of_day,
    startDate: row.start_date,
    endDate: row.end_date,
    title: row.title,
    description: row.description,
    payment: row.payment_cents / 100,
    location: row.location,
    category: row.category,
    estimatedDuration: row.estimated_duration,
    requiredTier: row.required_tier,
    status: row.status,
    occurrenceCount: row.occurrence_count,
    completedCount: row.completed_count,
    preferredWorkerId: row.preferred_worker_id,
    preferredWorkerName: workerName || null,
    nextOccurrence: row.next_occurrence_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOccurrenceToResponse(row: OccurrenceRow) {
  return {
    id: row.id,
    seriesId: row.series_id,
    taskId: row.task_id,
    occurrenceNumber: row.occurrence_number,
    scheduledDate: row.scheduled_date,
    status: row.status,
    workerId: row.worker_id,
    workerName: row.worker_name || null,
    completedAt: row.completed_at,
    rating: row.rating,
  };
}

// ── Router ──────────────────────────────────────────────────────────────────

export const recurringTaskRouter = router({
  // --------------------------------------------------------------------------
  // CREATE SERIES
  // --------------------------------------------------------------------------

  create: protectedProcedure
    .input(z.object({
      title: z.string().min(3).max(255),
      description: z.string().min(10),
      payment: z.number().min(5), // iOS sends dollars, store as cents
      location: z.string().max(500),
      category: z.string().max(50).optional(),
      estimatedDuration: z.string().max(50),
      requiredTier: z.number().int().min(1).max(4).default(1),
      pattern: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
      dayOfWeek: z.number().int().min(1).max(7).optional(),
      dayOfMonth: z.number().int().min(1).max(28).optional(),
      timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      startDate: z.string(), // ISO date
      endDate: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // 1. Tier gate: Trusted (3+)
      if (ctx.user.trust_tier < 3) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Recurring tasks require Trusted tier (3). Current: ${ctx.user.trust_tier}`,
        });
      }

      // 2. Subscription limit gate
      const { rows: [{ count }] } = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM recurring_task_series
         WHERE poster_id = $1 AND status IN ('active', 'paused')`,
        [ctx.user.id]
      );
      const activeCount = parseInt(count, 10);
      const limit = RECURRING_TASK_LIMITS[ctx.user.plan ?? 'free'] ?? 0;
      if (activeCount >= limit) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Recurring task limit reached (${activeCount}/${limit}). Upgrade your plan.`,
        });
      }

      // 3. Insert series
      const paymentCents = Math.round(input.payment * 100);
      const result = await db.query<SeriesRow>(
        `INSERT INTO recurring_task_series
         (poster_id, title, description, payment_cents, location, category,
          estimated_duration, required_tier, pattern, day_of_week, day_of_month,
          time_of_day, start_date, end_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active')
         RETURNING *`,
        [ctx.user.id, input.title, input.description, paymentCents, input.location,
         input.category || null, input.estimatedDuration, input.requiredTier,
         input.pattern, input.dayOfWeek || null, input.dayOfMonth || null,
         input.timeOfDay || null, input.startDate, input.endDate || null]
      );

      return mapSeriesToResponse(result.rows[0]);
    }),

  // --------------------------------------------------------------------------
  // LIST MY SERIES
  // --------------------------------------------------------------------------

  listMine: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).default(0).optional(),
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
        [ctx.user.id, limit, offset]
      );
      return result.rows.map(r => mapSeriesToResponse(r, r.worker_name));
    }),

  // --------------------------------------------------------------------------
  // GET SERIES BY ID
  // --------------------------------------------------------------------------

  getById: protectedProcedure
    .input(z.object({ id: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const result = await db.query<SeriesRow>(
        `SELECT rts.*, u.full_name as worker_name
         FROM recurring_task_series rts
         LEFT JOIN users u ON u.id = rts.preferred_worker_id
         WHERE rts.id = $1 AND rts.poster_id = $2`,
        [input.id, ctx.user.id]
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Series not found' });
      }
      return mapSeriesToResponse(result.rows[0], result.rows[0].worker_name);
    }),

  // --------------------------------------------------------------------------
  // PAUSE SERIES
  // --------------------------------------------------------------------------

  pause: protectedProcedure
    .input(z.object({ id: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(
        `UPDATE recurring_task_series SET status = 'paused', updated_at = NOW()
         WHERE id = $1 AND poster_id = $2 AND status = 'active'
         RETURNING id`,
        [input.id, ctx.user.id]
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active series not found' });
      }
      return { success: true };
    }),

  // --------------------------------------------------------------------------
  // RESUME SERIES
  // --------------------------------------------------------------------------

  resume: protectedProcedure
    .input(z.object({ id: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(
        `UPDATE recurring_task_series SET status = 'active', updated_at = NOW()
         WHERE id = $1 AND poster_id = $2 AND status = 'paused'
         RETURNING id`,
        [input.id, ctx.user.id]
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Paused series not found' });
      }
      return { success: true };
    }),

  // --------------------------------------------------------------------------
  // CANCEL SERIES (with transactional occurrence cleanup)
  // --------------------------------------------------------------------------

  cancel: protectedProcedure
    .input(z.object({ id: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      return await db.transaction(async (query) => {
        const result = await query(
          `UPDATE recurring_task_series SET status = 'cancelled', updated_at = NOW()
           WHERE id = $1 AND poster_id = $2 AND status IN ('active', 'paused')
           RETURNING id`,
          [input.id, ctx.user.id]
        );
        if (result.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Series not found' });
        }
        // Cancel all scheduled occurrences
        await query(
          `UPDATE recurring_task_occurrences SET status = 'cancelled'
           WHERE series_id = $1 AND status = 'scheduled'`,
          [input.id]
        );
        return { success: true };
      });
    }),

  // --------------------------------------------------------------------------
  // LIST OCCURRENCES
  // --------------------------------------------------------------------------

  listOccurrences: protectedProcedure
    .input(z.object({
      seriesId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).default(0).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const limit = Math.min(input.limit ?? 50, 100);
      const offset = input.offset ?? 0;

      // Verify ownership
      const series = await db.query(
        `SELECT id FROM recurring_task_series WHERE id = $1 AND poster_id = $2`,
        [input.seriesId, ctx.user.id]
      );
      if (series.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Series not found' });
      }

      const result = await db.query(
        `SELECT rto.*, u.full_name as worker_name
         FROM recurring_task_occurrences rto
         LEFT JOIN users u ON u.id = rto.worker_id
         WHERE rto.series_id = $1
         ORDER BY rto.occurrence_number DESC
         LIMIT $2 OFFSET $3`,
        [input.seriesId, limit, offset]
      );
      return (result.rows as unknown as OccurrenceRow[]).map(mapOccurrenceToResponse);
    }),

  // --------------------------------------------------------------------------
  // SKIP OCCURRENCE
  // --------------------------------------------------------------------------

  skipOccurrence: protectedProcedure
    .input(z.object({ occurrenceId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query(
        `UPDATE recurring_task_occurrences SET status = 'skipped'
         WHERE id = $1 AND status = 'scheduled'
         AND series_id IN (SELECT id FROM recurring_task_series WHERE poster_id = $2)
         RETURNING id`,
        [input.occurrenceId, ctx.user.id]
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Scheduled occurrence not found' });
      }
      return { success: true };
    }),

  // --------------------------------------------------------------------------
  // SET PREFERRED WORKER
  // --------------------------------------------------------------------------

  setPreferredWorker: protectedProcedure
    .input(z.object({
      seriesId: Schemas.uuid,
      workerId: Schemas.uuid,
    }))
    .mutation(async ({ ctx, input }) => {
      // Verify worker exists
      const worker = await db.query(
        `SELECT id FROM users WHERE id = $1`,
        [input.workerId]
      );
      if (worker.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Worker not found' });
      }

      const result = await db.query(
        `UPDATE recurring_task_series
         SET preferred_worker_id = $1, updated_at = NOW()
         WHERE id = $2 AND poster_id = $3
         RETURNING id`,
        [input.workerId, input.seriesId, ctx.user.id]
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Series not found' });
      }
      return { success: true };
    }),
});

export type RecurringTaskRouter = typeof recurringTaskRouter;
