import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import type { TaskCreateQuery } from './TaskCreateService.js';
import {
  containRecurringUniversalV1Bridge,
} from './RecurringUniversalV1BridgeContainment.js';
import { recurringInvalid } from './RecurringWorkErrors.js';
import {
  completeAtEndDate,
  type GenerationContext,
  notDueResult,
  replayResult,
  safeguardResult,
  skipBlackout,
} from './RecurringScheduleService.js';
import type {
  ControlledOccurrenceResult,
  ControlledSeriesRow,
  GenerateControlledOccurrenceInput,
} from './RecurringWorkTypes.js';

const log = logger.child({ service: 'RecurringOccurrenceService' });

function generationContext(
  row: ControlledSeriesRow,
  input: GenerateControlledOccurrenceInput,
): GenerationContext {
  const evaluatedAt = input.evaluateAt ?? new Date();
  const scheduledStart = new Date(row.next_occurrence_at);
  const generationKey = `recurring:${row.id}:${row.current_revision_id}:${scheduledStart.toISOString().slice(0, 10)}`;
  return { row, evaluatedAt, scheduledStart, generationKey };
}

async function generateInTransaction(
  query: TaskCreateQuery,
  input: GenerateControlledOccurrenceInput,
): Promise<ServiceResult<ControlledOccurrenceResult>> {
  const locked = await query<ControlledSeriesRow>(
    'SELECT * FROM recurring_task_series WHERE id=$1 AND contract_version >= 2 FOR UPDATE',
    [input.seriesId],
  );
  const row = locked.rows[0];
  if (!row) return recurringInvalid('Controlled recurring template not found.', 'NOT_FOUND');
  const context = generationContext(row, input);
  const safeguard = await safeguardResult(query, context, input.actorId);
  if (safeguard) return safeguard;
  const replay = await replayResult(query, context.generationKey);
  if (replay) return replay;
  const notDue = notDueResult(context, input.lookaheadHours ?? 24);
  if (notDue) return notDue;
  const completed = await completeAtEndDate(query, context);
  if (completed) return completed;
  const skipped = await skipBlackout(query, context);
  if (skipped) return skipped;

  // The current recurrence schema cannot express a canonical TaskDraft link,
  // authenticated claim, or exact service-cell route. Hold the recurring
  // intent before business approval, legacy Task creation, provider selection,
  // reservations, schedule/budget advancement, or any financial effect.
  return containRecurringUniversalV1Bridge(query, context, input.actorId);
}

export async function generateControlledRecurringOccurrence(
  input: GenerateControlledOccurrenceInput,
): Promise<ServiceResult<ControlledOccurrenceResult>> {
  try {
    return await db.transaction((query) => generateInTransaction(query, input));
  } catch (error) {
    log.error({ err: error, seriesId: input.seriesId }, 'controlled recurring generation failed');
    return {
      success: false,
      error: {
        code: 'RECURRING_GENERATION_FAILED',
        message: 'No recurring occurrence was generated.',
      },
    };
  }
}
