import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Schemas } from '../trpc.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const boundedJsonObject = z.record(z.unknown()).superRefine((value, context) => {
  if (Object.keys(value).length > 30) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Policy object has too many fields' });
  }
  if (JSON.stringify(value).length > 10_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Policy object is too large' });
  }
});

export const controlledTemplateInput = z.object({
  title: z.string().trim().min(3).max(255),
  description: z.string().trim().min(10).max(5000),
  category: z.string().trim().min(1).max(100),
  taskRecipe: boundedJsonObject,
  exactLocation: z.string().trim().min(3).max(500),
  roughLocation: z.string().trim().min(2).max(120),
  accessProcedure: z.string().trim().min(3).max(500),
  regionCode: z.string().regex(/^US-[A-Z]{2}$/),
  insideHome: z.boolean(),
  peoplePresent: z.boolean(),
  petsPresent: z.boolean(),
  caregiving: z.boolean(),
  pattern: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
  dayOfWeek: z.number().int().min(1).max(7).nullable(),
  dayOfMonth: z.number().int().min(1).max(28).nullable(),
  timeOfDay: hhmm,
  startDate: isoDate,
  endDate: isoDate.nullable(),
  timezone: z.string().trim().min(1).max(64),
  serviceWindowStart: hhmm,
  serviceWindowEnd: hhmm,
  expectedDurationMinutes: z.number().int().min(15).max(1440),
  customerTotalCents: z.number().int().min(500).max(99_999_900),
  corridorMinimumCents: z.number().int().min(500).max(99_999_900),
  corridorMaximumCents: z.number().int().min(500).max(99_999_900),
  maximumAdjustmentCents: z.number().int().nonnegative().max(99_999_900),
  requiredTools: z.array(z.string().trim().min(1).max(100)).max(20),
  requiredVehicle: z.string().trim().min(1).max(100).nullable(),
  completionChecklist: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  preferredWorkerId: Schemas.uuid.nullable(),
  backupWorkerIds: z.array(Schemas.uuid).max(20),
  cancellationRules: boundedJsonObject,
  holidayRules: boundedJsonObject,
  budgetCapCents: z.number().int().min(500).max(999_999_900),
  escalationRules: boundedJsonObject,
  invoiceGrouping: boundedJsonObject,
  nextReviewDate: isoDate,
}).strict();

export const recurringSeriesInput = z.object({
  title: z.string().min(3).max(255),
  description: z.string().min(10),
  payment: z.number().min(5),
  location: z.string().max(500),
  category: z.string().max(50).optional(),
  estimatedDuration: z.string().max(50),
  requiredTier: z.number().int().min(1).max(4).default(1),
  pattern: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
  dayOfWeek: z.number().int().min(1).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  startDate: z.string(),
  endDate: z.string().optional(),
  maxOccurrences: z.number().int().min(1).max(500).optional(),
});

export type ControlledTemplateInput = z.infer<typeof controlledTemplateInput>;
export type RecurringSeriesInput = z.infer<typeof recurringSeriesInput>;

export function controlledResult<T>(
  result: { success: boolean; data?: T; error?: { code: string; message: string } },
): T {
  if (result.success && result.data !== undefined) return result.data;
  const error = result.error ?? {
    code: 'RECURRING_OPERATION_FAILED',
    message: 'Recurring operation failed.',
  };
  const code = error.code === 'NOT_FOUND'
    ? 'NOT_FOUND'
    : error.code.includes('FAILED') ? 'INTERNAL_SERVER_ERROR' : 'PRECONDITION_FAILED';
  throw new TRPCError({ code, message: error.message });
}

export interface SeriesRow {
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

export interface OccurrenceRow {
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

export function mapSeriesToResponse(row: SeriesRow, workerName?: string | null) {
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

export function mapOccurrenceToResponse(row: OccurrenceRow) {
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
