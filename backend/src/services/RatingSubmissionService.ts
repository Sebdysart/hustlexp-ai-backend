import {
  db,
  getErrorMessage,
  isInvariantViolation,
  isUniqueViolation,
} from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult, TaskState } from '../types.js';
import { ErrorCodes } from '../types.js';
import {
  RATING_WINDOW_DAYS,
  validStructuredFeedback,
  type CreateRatingParams,
  type TaskRating,
} from './RatingTypes.js';

type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
const log = logger.child({ service: 'RatingService' });

interface RatingTaskRow {
  id: string;
  poster_id: string;
  worker_id: string | null;
  state: TaskState;
  completed_at: Date | null;
}

function invalidInput(message: string): ServiceResult<TaskRating> {
  return { success: false, error: { code: ErrorCodes.INVALID_INPUT, message } };
}

function validateRatingInput(params: CreateRatingParams): ServiceResult<TaskRating> | null {
  if (!Number.isInteger(params.stars) || params.stars < 1 || params.stars > 5) {
    return invalidInput('Rating stars must be between 1 and 5');
  }
  if (params.comment && params.comment.length > 500) {
    return invalidInput('Rating comment cannot exceed 500 characters');
  }
  if (params.structuredFeedback && !validStructuredFeedback(params.structuredFeedback)) {
    return invalidInput('Structured feedback requires six integer scores between 1 and 5');
  }
  return null;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function lockRatingTask(query: Query, taskId: string): Promise<RatingTaskRow> {
  await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rating:${taskId}`]);
  const result = await query<RatingTaskRow>(
    'SELECT id, poster_id, worker_id, state, completed_at FROM tasks WHERE id = $1 FOR UPDATE',
    [taskId],
  );
  if (!result.rows[0]) throw codedError(ErrorCodes.NOT_FOUND, `Task ${taskId} not found`);
  return result.rows[0];
}

function assertRateableTask(task: RatingTaskRow, raterId: string): string {
  if (task.state !== 'COMPLETED') {
    throw codedError(
      ErrorCodes.INVALID_STATE,
      `Cannot submit rating: task is in ${task.state} state. Ratings only allowed after task COMPLETED`,
    );
  }
  if (!task.completed_at) {
    throw codedError(ErrorCodes.INVALID_STATE, 'Cannot submit rating: task completion date is missing');
  }
  const windowEnd = new Date(task.completed_at.getTime() + RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (new Date() > windowEnd) {
    throw codedError(
      ErrorCodes.INVALID_STATE,
      `Cannot submit rating: rating window has expired (7 days after completion). Rating window ended on ${windowEnd.toISOString()}`,
    );
  }
  if (task.poster_id !== raterId && task.worker_id !== raterId) {
    throw codedError(ErrorCodes.FORBIDDEN, 'You are not a participant in this task');
  }
  const rateeId = task.poster_id === raterId ? task.worker_id : task.poster_id;
  if (!rateeId) {
    throw codedError(ErrorCodes.INVALID_STATE, 'Cannot submit rating: no ratee (worker not assigned)');
  }
  return rateeId;
}

async function duplicateRating(
  query: Query,
  params: CreateRatingParams,
  rateeId: string,
): Promise<boolean> {
  const result = await query<{ id: string }>(
    `SELECT id FROM task_ratings WHERE task_id = $1 AND rater_id = $2 AND ratee_id = $3`,
    [params.taskId, params.raterId, rateeId],
  );
  return result.rows.length > 0;
}

async function existingRatingCount(query: Query, task: RatingTaskRow): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM task_ratings
     WHERE task_id = $1 AND (rater_id = $2 OR rater_id = $3)`,
    [task.id, task.poster_id, task.worker_id],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function insertRating(
  query: Query,
  params: CreateRatingParams,
  rateeId: string,
  existingCount: number,
): Promise<TaskRating> {
  const result = await query<TaskRating>(
    `INSERT INTO task_ratings (
      task_id, rater_id, ratee_id, stars, comment, tags, structured_feedback,
      is_public, is_blind, is_auto_rated
    ) VALUES ($1, $2, $3, $4, $5, $6::TEXT[], $7::JSONB, $8, $9, false)
    RETURNING *`,
    [
      params.taskId,
      params.raterId,
      rateeId,
      params.stars,
      params.comment || null,
      params.tags || [],
      params.structuredFeedback ? JSON.stringify(params.structuredFeedback) : null,
      existingCount >= 1,
      existingCount === 0,
    ],
  );
  const inserted = result.rows[0];
  if (existingCount + 1 !== 2) return inserted;
  await query(
    `UPDATE task_ratings
     SET is_public = true, is_blind = false, updated_at = NOW()
     WHERE task_id = $1`,
    [params.taskId],
  );
  const updated = await query<TaskRating>('SELECT * FROM task_ratings WHERE id = $1', [inserted.id]);
  return updated.rows[0];
}

async function submitRatingTransaction(
  query: Query,
  params: CreateRatingParams,
): Promise<TaskRating | null> {
  const task = await lockRatingTask(query, params.taskId);
  const rateeId = assertRateableTask(task, params.raterId);
  if (await duplicateRating(query, params, rateeId)) return null;
  const existingCount = await existingRatingCount(query, task);
  return insertRating(query, params, rateeId, existingCount);
}

function typedRatingCode(error: unknown): string | null {
  const code = (error as { code?: string }).code;
  if (code === ErrorCodes.NOT_FOUND) return code;
  if (code === ErrorCodes.INVALID_STATE) return code;
  if (code === ErrorCodes.FORBIDDEN) return code;
  return null;
}

function submissionFailure(error: unknown): ServiceResult<TaskRating> {
  if (isUniqueViolation(error)) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVARIANT_VIOLATION,
        message: 'You have already rated this user for this task (RATE-5)',
      },
    };
  }
  if (isInvariantViolation(error)) {
    const code = error.code || 'INVARIANT_VIOLATION';
    return { success: false, error: { code, message: getErrorMessage(code) } };
  }
  const typedCode = typedRatingCode(error);
  if (typedCode) {
    return {
      success: false,
      error: { code: typedCode, message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
  log.error({ err: error instanceof Error ? error.message : String(error) }, 'RatingService DB error');
  return {
    success: false,
    error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
  };
}

export async function submitRating(params: CreateRatingParams): Promise<ServiceResult<TaskRating>> {
  const inputFailure = validateRatingInput(params);
  if (inputFailure) return inputFailure;
  try {
    const inserted = await db.transaction((query) => submitRatingTransaction(query, params));
    if (!inserted) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'You have already rated this user for this task',
        },
      };
    }
    return { success: true, data: inserted };
  } catch (error) {
    return submissionFailure(error);
  }
}
