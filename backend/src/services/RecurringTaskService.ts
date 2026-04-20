/**
 * RecurringTaskService - occurrence generation and task creation from recurring series.
 *
 * Generates recurring_task_occurrences from recurring_task_series (daily, weekly, biweekly, monthly).
 * Can create a task from an occurrence (post to feed) and update next_occurrence_at.
 *
 * @see add_squads_and_recurring_tasks.sql, recurringTask router
 */

import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { TaskService } from './TaskService.js';
import { EscrowService } from './EscrowService.js';

const log = logger.child({ service: 'RecurringTaskService' });

const DEFAULT_OCCURRENCES_TO_GENERATE = 30;
const MAX_OCCURRENCES_PER_CALL = 100;

type Pattern = 'daily' | 'weekly' | 'biweekly' | 'monthly';

/** YYYY-MM-DD string from Date */
function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse YYYY-MM-DD to Date at noon UTC */
function parseDate(s: string): Date {
  return new Date(s + 'T12:00:00.000Z');
}

/**
 * Compute the next occurrence dates for a pattern from startDate.
 * Returns array of YYYY-MM-DD strings, at most maxCount, not after endDate.
 */
export function getNextOccurrenceDates(
  pattern: Pattern,
  startDate: string,
  endDate: string | null,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  maxCount: number = DEFAULT_OCCURRENCES_TO_GENERATE
): string[] {
  const out: string[] = [];
  const end = endDate ? parseDate(endDate).getTime() : null;
  let current = parseDate(startDate);

  if (pattern === 'daily') {
    for (let i = 0; i < maxCount; i++) {
      const t = current.getTime();
      if (end !== null && t > end) break;
      out.push(toDateString(current));
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return out;
  }

  if (pattern === 'weekly' && dayOfWeek != null) {
    // 1 = Monday .. 7 = Sunday in DB; JS getUTCDay() 0 = Sunday, 1 = Monday
    const targetJsDay = dayOfWeek === 7 ? 0 : dayOfWeek;
    while (current.getUTCDay() !== targetJsDay) {
      current.setUTCDate(current.getUTCDate() + 1);
    }
    for (let i = 0; i < maxCount; i++) {
      const t = current.getTime();
      if (end !== null && t > end) break;
      out.push(toDateString(current));
      current.setUTCDate(current.getUTCDate() + 7);
    }
    return out;
  }

  if (pattern === 'biweekly' && dayOfWeek != null) {
    const targetJsDay = dayOfWeek === 7 ? 0 : dayOfWeek;
    while (current.getUTCDay() !== targetJsDay) {
      current.setUTCDate(current.getUTCDate() + 1);
    }
    for (let i = 0; i < maxCount; i++) {
      const t = current.getTime();
      if (end !== null && t > end) break;
      out.push(toDateString(current));
      current.setUTCDate(current.getUTCDate() + 14);
    }
    return out;
  }

  if (pattern === 'monthly' && dayOfMonth != null) {
    const day = Math.min(dayOfMonth, 28);
    if (current.getUTCDate() !== day) {
      current.setUTCDate(day);
      if (parseDate(startDate).getTime() > current.getTime()) {
        current.setUTCMonth(current.getUTCMonth() + 1);
        current.setUTCDate(day);
      }
    }
    for (let i = 0; i < maxCount; i++) {
      const t = current.getTime();
      if (end !== null && t > end) break;
      out.push(toDateString(current));
      current.setUTCMonth(current.getUTCMonth() + 1);
      current.setUTCDate(Math.min(day, 28));
    }
    return out;
  }

  return out;
}

export interface SeriesRow {
  id: string;
  poster_id: string;
  pattern: string;
  day_of_week: number | null;
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  status: string;
  occurrence_count: number;
}

/**
 * Generate upcoming occurrence rows for a series and insert them.
 * Skips dates that already have an occurrence. Updates series occurrence_count and next_occurrence_at.
 */
export async function generateOccurrencesForSeries(
  seriesId: string,
  options: { maxOccurrences?: number; fromDate?: string } = {}
): Promise<ServiceResult<{ generated: number }>> {
  const maxOccurrences = Math.min(options.maxOccurrences ?? DEFAULT_OCCURRENCES_TO_GENERATE, MAX_OCCURRENCES_PER_CALL);

  try {
    const seriesResult = await db.query<SeriesRow>(
      `SELECT id, poster_id, pattern, day_of_week, day_of_month, start_date, end_date, status, occurrence_count
       FROM recurring_task_series WHERE id = $1`,
      [seriesId]
    );
    if (seriesResult.rows.length === 0) {
      return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: 'Series not found' } };
    }
    const series = seriesResult.rows[0];
    if (series.status !== 'active' && series.status !== 'paused') {
      return { success: true, data: { generated: 0 } };
    }

    const fromDate = options.fromDate ?? series.start_date;
    const dates = getNextOccurrenceDates(
      series.pattern as Pattern,
      fromDate,
      series.end_date,
      series.day_of_week,
      series.day_of_month,
      maxOccurrences + 50
    );

    const existingResult = await db.query<{ scheduled_date: string; occurrence_number: number }>(
      `SELECT scheduled_date, occurrence_number FROM recurring_task_occurrences WHERE series_id = $1`,
      [seriesId]
    );
    const existingSet = new Set(existingResult.rows.map((r) => r.scheduled_date));
    const maxNum = existingResult.rows.length
      ? Math.max(...existingResult.rows.map((r) => r.occurrence_number))
      : 0;
    const toInsert = dates.filter((d) => !existingSet.has(d)).slice(0, maxOccurrences);
    if (toInsert.length === 0) {
      return { success: true, data: { generated: 0 } };
    }

    const nextOccurrenceNum = maxNum + 1;
    const params: unknown[] = [];
    const placeholders: string[] = [];
    toInsert.forEach((scheduledDate, i) => {
      const base = 1 + i * 3;
      placeholders.push(`($${base}, $${base + 1}, $${base + 2}, 'scheduled')`);
      params.push(seriesId, nextOccurrenceNum + i, scheduledDate);
    });
    await db.query(
      `INSERT INTO recurring_task_occurrences (series_id, occurrence_number, scheduled_date, status)
       VALUES ${placeholders.join(', ')}`,
      params
    );

    const nextAt = toInsert[0] + 'T12:00:00.000Z';
    await db.query(
      `UPDATE recurring_task_series SET occurrence_count = occurrence_count + $1, next_occurrence_at = $2, updated_at = NOW() WHERE id = $3`,
      [toInsert.length, nextAt, seriesId]
    );

    log.info({ seriesId, generated: toInsert.length, first: toInsert[0] }, 'Generated recurring occurrences');
    return { success: true, data: { generated: toInsert.length } };
  } catch (e) {
    log.error({ err: e, seriesId }, 'generateOccurrencesForSeries failed');
    return {
      success: false,
      error: { code: 'DB_ERROR', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

// --------------------------------------------------------------------------
// SPAWN TASK FROM OCCURRENCE
// --------------------------------------------------------------------------

interface FullSeriesRow extends SeriesRow {
  title: string;
  description: string;
  payment_cents: number;
  location: string | null;
  category: string | null;
  estimated_duration: string | null;
  required_tier: number;
  preferred_worker_id: string | null;
  risk_level: string | null;
  template_slug: string | null;
  requires_proof: boolean;
  requirements: string | null;
}

/**
 * Spawn a real HXTask + Escrow from a scheduled occurrence.
 * Called by the recurring-task-worker cron job or manually via spawnOccurrenceNow.
 */
export async function spawnTaskForOccurrence(
  occurrenceId: string
): Promise<ServiceResult<{ taskId: string; escrowId: string }>> {
  try {
    // 1. Load occurrence + series in one query
    const occResult = await db.query<{
      id: string;
      series_id: string;
      occurrence_number: number;
      status: string;
      task_id: string | null;
    }>(
      `SELECT id, series_id, occurrence_number, status, task_id
       FROM recurring_task_occurrences WHERE id = $1 FOR UPDATE`,
      [occurrenceId]
    );

    if (occResult.rows.length === 0) {
      return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: 'Occurrence not found' } };
    }

    const occ = occResult.rows[0];

    // Idempotency: already spawned
    if (occ.status !== 'scheduled') {
      if (occ.task_id) {
        return { success: true, data: { taskId: occ.task_id, escrowId: '' } };
      }
      return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Occurrence status is ${occ.status}, expected scheduled` } };
    }

    // 2. Load series
    const seriesResult = await db.query<FullSeriesRow>(
      `SELECT * FROM recurring_task_series WHERE id = $1`,
      [occ.series_id]
    );
    if (seriesResult.rows.length === 0) {
      return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: 'Series not found' } };
    }
    const series = seriesResult.rows[0];

    if (series.status !== 'active') {
      await db.query(
        `UPDATE recurring_task_occurrences SET status = 'cancelled', spawn_error = 'Series not active' WHERE id = $1`,
        [occurrenceId]
      );
      return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: 'Series is not active' } };
    }

    // 3. Create the task via TaskService (runs full compliance/template pipeline)
    const taskResult = await TaskService.create({
      posterId: series.poster_id,
      title: series.title,
      description: series.description,
      price: series.payment_cents,
      requirements: series.requirements || undefined,
      location: series.location || undefined,
      category: series.category || undefined,
      estimatedDuration: series.estimated_duration || undefined,
      requiresProof: series.requires_proof,
      riskLevel: (series.risk_level as 'LOW' | 'MEDIUM' | 'HIGH') || undefined,
      templateSlug: series.template_slug || undefined,
      parentSeriesId: series.id,
      occurrenceNumber: occ.occurrence_number,
    });

    if (!taskResult.success) {
      await db.query(
        `UPDATE recurring_task_occurrences SET spawn_error = $1 WHERE id = $2`,
        [taskResult.error.message, occurrenceId]
      );
      log.error({ occurrenceId, error: taskResult.error }, 'Failed to spawn task for occurrence');
      return { success: false, error: taskResult.error };
    }

    const taskId = taskResult.data.id;

    // 4. Create escrow for the task
    const escrowResult = await EscrowService.create({
      taskId,
      amount: series.payment_cents,
    });

    const escrowId = escrowResult.success ? escrowResult.data.id : '';

    // 5. Auto-assign preferred worker if set
    if (series.preferred_worker_id) {
      try {
        await TaskService.accept({
          taskId,
          workerId: series.preferred_worker_id,
        });
        log.info({ taskId, workerId: series.preferred_worker_id }, 'Auto-assigned preferred worker');
      } catch (acceptErr) {
        // Non-fatal: task stays OPEN for anyone to claim
        log.warn({ taskId, workerId: series.preferred_worker_id, err: acceptErr }, 'Failed to auto-assign preferred worker');
      }
    }

    // 6. Update occurrence
    await db.query(
      `UPDATE recurring_task_occurrences
       SET status = 'posted', task_id = $1, escrow_id = $2, spawned_at = NOW(), spawn_error = NULL
       WHERE id = $3`,
      [taskId, escrowId || null, occurrenceId]
    );

    // 7. Update series next_occurrence_at
    const nextOcc = await db.query<{ scheduled_date: string }>(
      `SELECT scheduled_date FROM recurring_task_occurrences
       WHERE series_id = $1 AND status = 'scheduled'
       ORDER BY scheduled_date ASC LIMIT 1`,
      [series.id]
    );
    if (nextOcc.rows.length > 0) {
      await db.query(
        `UPDATE recurring_task_series SET next_occurrence_at = $1, updated_at = NOW() WHERE id = $2`,
        [nextOcc.rows[0].scheduled_date + 'T12:00:00.000Z', series.id]
      );
    }

    log.info({ seriesId: series.id, occurrenceId, taskId, escrowId }, 'Spawned task from recurring occurrence');
    return { success: true, data: { taskId, escrowId } };
  } catch (e) {
    log.error({ err: e, occurrenceId }, 'spawnTaskForOccurrence failed');
    await db.query(
      `UPDATE recurring_task_occurrences SET spawn_error = $1 WHERE id = $2`,
      [e instanceof Error ? e.message : String(e), occurrenceId]
    ).catch(() => {});
    return {
      success: false,
      error: { code: 'DB_ERROR', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * Spawn all due occurrences (scheduled_date <= today, status = 'scheduled', series active).
 * Called by the recurring-task-worker cron job.
 */
export async function spawnDueOccurrences(): Promise<{ spawned: number; failed: number }> {
  const dueResult = await db.query<{ id: string; series_id: string }>(
    `SELECT o.id, o.series_id
     FROM recurring_task_occurrences o
     JOIN recurring_task_series s ON s.id = o.series_id
     WHERE o.status = 'scheduled'
       AND o.scheduled_date <= CURRENT_DATE
       AND s.status = 'active'
     ORDER BY o.scheduled_date ASC
     LIMIT 50`,
    []
  );

  let spawned = 0;
  let failed = 0;

  for (const row of dueResult.rows) {
    const result = await spawnTaskForOccurrence(row.id);
    if (result.success) {
      spawned++;
      // Replenish future occurrences for this series
      await generateOccurrencesForSeries(row.series_id);
    } else {
      failed++;
    }
  }

  log.info({ spawned, failed, total: dueResult.rows.length }, 'spawnDueOccurrences completed');
  return { spawned, failed };
}
