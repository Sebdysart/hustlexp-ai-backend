import type { ServiceResult } from '../types.js';
import type { TaskCreateQuery } from './TaskCreateService.js';
import type {
  ControlledOccurrenceResult,
  ControlledSeriesRow,
} from './RecurringWorkTypes.js';

export type GenerationContext = {
  row: ControlledSeriesRow;
  evaluatedAt: Date;
  scheduledStart: Date;
  generationKey: string;
};

export async function safeguardResult(
  query: TaskCreateQuery,
  context: GenerationContext,
  actorId: string | null,
): Promise<ServiceResult<ControlledOccurrenceResult> | null> {
  const safeguard = await query<{ reason: string | null }>(
    `SELECT evaluate_recurring_template_safeguards($1,$2,$3) AS reason`,
    [context.row.id, context.row.payment_cents, context.evaluatedAt],
  );
  const pauseCode = safeguard.rows[0]?.reason ?? null;
  if (!pauseCode) return null;
  if (pauseCode !== 'TEMPLATE_NOT_ACTIVE') {
    await query(
      `SELECT pause_recurring_template($1,$2,$3::jsonb,$4) AS paused`,
      [context.row.id, pauseCode,
        JSON.stringify({ evaluatedAt: context.evaluatedAt.toISOString() }), actorId],
    );
  }
  return { success: true, data: { outcome: 'paused', pauseCode } };
}

export async function replayResult(
  query: TaskCreateQuery,
  generationKey: string,
): Promise<ServiceResult<ControlledOccurrenceResult> | null> {
  const existing = await query<{ task_id: string; occurrence_number: number; id?: string }>(
    `SELECT id,task_id,occurrence_number FROM recurring_task_occurrences WHERE generation_key=$1`,
    [generationKey],
  );
  const occurrence = existing.rows[0];
  if (!occurrence) return null;
  return {
    success: true,
    data: {
      outcome: 'replayed',
      taskId: occurrence.task_id,
      occurrenceId: occurrence.id,
      occurrenceNumber: occurrence.occurrence_number,
    },
  };
}

export function notDueResult(
  context: GenerationContext,
  lookaheadHours: number,
): ServiceResult<ControlledOccurrenceResult> | null {
  const lookaheadMs = lookaheadHours * 60 * 60 * 1000;
  const invalidStart = !Number.isFinite(context.scheduledStart.getTime());
  const beyondLookahead = context.scheduledStart.getTime()
    > context.evaluatedAt.getTime() + lookaheadMs;
  return invalidStart || beyondLookahead
    ? { success: true, data: { outcome: 'not_due' } }
    : null;
}

async function insertScheduleException(
  query: TaskCreateQuery,
  context: GenerationContext,
  reason: 'END_DATE_REACHED' | 'BLACKOUT_DATE',
  evidence: Record<string, unknown>,
): Promise<string | undefined> {
  const exception = await query<{ id: string }>(
    `WITH inserted AS (
       INSERT INTO recurring_schedule_exceptions(
         template_id,template_revision_id,scheduled_start,reason,generation_key,evidence
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (generation_key) DO NOTHING RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL SELECT id FROM recurring_schedule_exceptions WHERE generation_key=$5
     LIMIT 1`,
    [context.row.id, context.row.current_revision_id, context.scheduledStart,
      reason, context.generationKey, JSON.stringify(evidence)],
  );
  return exception.rows[0]?.id;
}

export async function completeAtEndDate(
  query: TaskCreateQuery,
  context: GenerationContext,
): Promise<ServiceResult<ControlledOccurrenceResult> | null> {
  const scheduledDate = context.scheduledStart.toISOString().slice(0, 10);
  const endDate = context.row.end_date ? String(context.row.end_date).slice(0, 10) : null;
  if (!endDate || scheduledDate <= endDate) return null;
  const scheduleExceptionId = await insertScheduleException(
    query, context, 'END_DATE_REACHED', { endDate },
  );
  await query(
    `UPDATE recurring_task_series SET status='completed',updated_at=NOW()
     WHERE id=$1 AND status='active'`,
    [context.row.id],
  );
  return { success: true, data: { outcome: 'completed', scheduleExceptionId } };
}

function blackoutDates(row: ControlledSeriesRow): string[] {
  const dates = row.holiday_rules?.blackoutDates;
  return Array.isArray(dates)
    ? dates.filter((value): value is string => typeof value === 'string')
    : [];
}

async function advanceSchedule(query: TaskCreateQuery, seriesId: string): Promise<void> {
  await query(
    `UPDATE recurring_task_series SET
       next_occurrence_at=(CASE pattern
         WHEN 'daily' THEN (next_occurrence_at AT TIME ZONE timezone + INTERVAL '1 day') AT TIME ZONE timezone
         WHEN 'weekly' THEN (next_occurrence_at AT TIME ZONE timezone + INTERVAL '7 days') AT TIME ZONE timezone
         WHEN 'biweekly' THEN (next_occurrence_at AT TIME ZONE timezone + INTERVAL '14 days') AT TIME ZONE timezone
         WHEN 'monthly' THEN (next_occurrence_at AT TIME ZONE timezone + INTERVAL '1 month') AT TIME ZONE timezone
       END),updated_at=NOW() WHERE id=$1`,
    [seriesId],
  );
}

export async function skipBlackout(
  query: TaskCreateQuery,
  context: GenerationContext,
): Promise<ServiceResult<ControlledOccurrenceResult> | null> {
  const scheduledDate = context.scheduledStart.toISOString().slice(0, 10);
  if (!blackoutDates(context.row).includes(scheduledDate)) return null;
  const scheduleExceptionId = await insertScheduleException(
    query, context, 'BLACKOUT_DATE', { blackoutDate: scheduledDate },
  );
  await advanceSchedule(query, context.row.id);
  return { success: true, data: { outcome: 'skipped', scheduleExceptionId } };
}
