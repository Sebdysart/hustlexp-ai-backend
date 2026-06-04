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

const log = logger.child({ service: 'RecurringTaskService' });

const DEFAULT_OCCURRENCES_TO_GENERATE = 30;
const MAX_OCCURRENCES_PER_CALL = 100;

/**
 * Bug BB1-1 (occurrence amplification): Hard global cap across the lifetime of a series.
 * No series may ever accumulate more than MAX_OCCURRENCES total occurrences.
 * This cap is enforced both at creation time (router Zod schema) and here at
 * generation time so that incremental calls (e.g. from a cron job) cannot bypass it.
 *
 * Bug BB1-3 (price drift): When a task instance is eventually spawned from an occurrence,
 * the spawner MUST read `payment_cents` from `recurring_task_series` (set at series creation
 * and treated as immutable). It must NOT re-query from any mutable price source.
 * The series row is the price snapshot. Any price change requires explicit cancellation
 * of the series and creation of a new one — the preferred worker (if any) must then
 * re-accept on the new series.
 */
const MAX_OCCURRENCES_LIFETIME = 500;

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
  const current = parseDate(startDate);

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

    // Bug BB1-1: Enforce the lifetime occurrence cap. If the series already has
    // MAX_OCCURRENCES_LIFETIME occurrences, refuse to generate more.
    const remainingSlots = MAX_OCCURRENCES_LIFETIME - existingResult.rows.length;
    if (remainingSlots <= 0) {
      log.warn({ seriesId, existing: existingResult.rows.length }, 'Series has reached MAX_OCCURRENCES_LIFETIME cap — no new occurrences generated');
      return { success: true, data: { generated: 0 } };
    }
    const effectiveMax = Math.min(maxOccurrences, remainingSlots);

    const toInsert = dates.filter((d) => !existingSet.has(d)).slice(0, effectiveMax);
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
