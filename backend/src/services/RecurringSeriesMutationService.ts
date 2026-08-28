import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import { logger } from '../logger.js';
import type {
  RecurringSeriesInput,
  SeriesRow,
} from '../routers/recurringTaskSchemas.js';
import { mapSeriesToResponse } from '../routers/recurringTaskSchemas.js';
import { EscrowService } from './EscrowService.js';
import {
  generateOccurrencesForSeries,
  getNextOccurrenceDates,
} from './RecurringTaskService.js';

const log = logger.child({ router: 'recurringTask' });
const RECURRING_TASK_LIMITS: Record<string, number> = { free: 0, premium: 5, pro: 999999 };

interface PosterContext {
  id: string;
  trustTier: number;
  plan?: string;
}

function assertTrusted(poster: PosterContext): void {
  if (poster.trustTier >= 3) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `Recurring tasks require Trusted tier (3). Current: ${poster.trustTier}`,
  });
}

async function assertSubscriptionCapacity(poster: PosterContext): Promise<void> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM recurring_task_series
     WHERE poster_id = $1 AND status IN ('active', 'paused')`,
    [poster.id],
  );
  const activeCount = parseInt(result.rows[0].count, 10);
  const limit = RECURRING_TASK_LIMITS[poster.plan ?? 'free'] ?? 0;
  if (activeCount < limit) return;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `Recurring task limit reached (${activeCount}/${limit}). Upgrade your plan.`,
  });
}

function assertOccurrenceCap(input: RecurringSeriesInput): void {
  if (!input.endDate) return;
  const maxOccurrences = 500;
  const projected = getNextOccurrenceDates(
    input.pattern,
    input.startDate,
    input.endDate,
    input.dayOfWeek ?? null,
    input.dayOfMonth ?? null,
    maxOccurrences + 1,
  );
  if (projected.length <= maxOccurrences) return;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `Recurring series would generate more than ${maxOccurrences} occurrences. Shorten the date range or reduce frequency.`,
  });
}

async function insertSeries(input: RecurringSeriesInput, posterId: string): Promise<SeriesRow> {
  const result = await db.query<SeriesRow>(
    `INSERT INTO recurring_task_series
     (poster_id, title, description, payment_cents, location, category,
      estimated_duration, required_tier, pattern, day_of_week, day_of_month,
      time_of_day, start_date, end_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active')
     RETURNING *`,
    [
      posterId,
      input.title,
      input.description,
      Math.round(input.payment * 100),
      input.location,
      input.category || null,
      input.estimatedDuration,
      input.requiredTier,
      input.pattern,
      input.dayOfWeek || null,
      input.dayOfMonth || null,
      input.timeOfDay || null,
      input.startDate,
      input.endDate || null,
    ],
  );
  return result.rows[0];
}

export async function createRecurringSeries(
  input: RecurringSeriesInput,
  poster: PosterContext,
) {
  assertTrusted(poster);
  await assertSubscriptionCapacity(poster);
  assertOccurrenceCap(input);
  const series = await insertSeries(input, poster.id);
  const generated = await generateOccurrencesForSeries(series.id, { maxOccurrences: 30 });
  if (!generated.success) {
    log.warn(
      { seriesId: series.id, err: generated.error },
      'Initial occurrence generation failed',
    );
  }
  return mapSeriesToResponse(series);
}

async function cancelSeriesTransaction(seriesId: string, posterId: string): Promise<string[]> {
  return db.transaction(async (query) => {
    const result = await query(
      `UPDATE recurring_task_series SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND poster_id = $2 AND status IN ('active', 'paused')
       RETURNING id`,
      [seriesId, posterId],
    );
    if (result.rows.length === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Series not found' });
    }
    await query(
      `UPDATE recurring_task_occurrences SET status = 'cancelled'
       WHERE series_id = $1 AND status = 'scheduled'`,
      [seriesId],
    );
    const active = await query<{ task_id: string }>(
      `SELECT task_id FROM recurring_task_occurrences
       WHERE series_id = $1
         AND status IN ('active', 'in_progress')
         AND task_id IS NOT NULL`,
      [seriesId],
    );
    if (active.rows.length === 0) return [];
    const taskIds = active.rows.map((row) => row.task_id);
    await query(
      `UPDATE tasks
       SET state = 'CANCELLED', cancelled_at = NOW()
       WHERE id = ANY($1::uuid[])
         AND state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')`,
      [taskIds],
    );
    await query(
      `UPDATE recurring_task_occurrences SET status = 'cancelled'
       WHERE series_id = $1 AND status IN ('active', 'in_progress')`,
      [seriesId],
    );
    const escrows = await query<{ id: string }>(
      `SELECT id FROM escrows
       WHERE task_id = ANY($1::uuid[])
         AND state = 'FUNDED'`,
      [taskIds],
    );
    return escrows.rows.map((row) => row.id);
  });
}

export async function cancelRecurringSeries(seriesId: string, posterId: string) {
  const escrowIds = await cancelSeriesTransaction(seriesId, posterId);
  for (const escrowId of escrowIds) {
    const result = await EscrowService.refund({ escrowId });
    if (!result.success) {
      log.warn(
        { escrowId, error: result.error },
        'Failed to refund escrow during recurring task series cancel',
      );
    }
  }
  return { success: true };
}
