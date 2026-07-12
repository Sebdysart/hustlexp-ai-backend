import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import { taskLogger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { RatingService, type TaskRating } from './RatingService.js';

const log = taskLogger.child({ service: 'VerifiedPosterRatingService' });

export interface VerifiedPosterRatingParams {
  taskId: string;
  providerReviewId: string;
  score: 1 | 2 | 3 | 4 | 5;
  actorId: string;
}

export interface VerifiedPosterRatingResult {
  ratingId: string;
  taskId: string;
  score: number;
  idempotencyReplayed: boolean;
}

interface TaskContext { state: string; poster_id: string; worker_id: string | null }
interface RatingEvidence { taskId: string; score: number | null }

function failure<T>(code: string, message: string): ServiceResult<T> {
  return { success: false, error: { code, message } };
}

async function taskContext(taskId: string): Promise<ServiceResult<TaskContext>> {
  const result = await db.query<TaskContext>(
    'SELECT state, poster_id, worker_id FROM tasks WHERE id = $1', [taskId],
  );
  return result.rows[0]
    ? { success: true, data: result.rows[0] }
    : failure(ErrorCodes.NOT_FOUND, `Task ${taskId} not found`);
}

async function existingRating(taskId: string, posterId: string): Promise<TaskRating | undefined> {
  const result = await db.query<TaskRating>(
    'SELECT * FROM task_ratings WHERE task_id = $1 AND rater_id = $2 LIMIT 1',
    [taskId, posterId],
  );
  return result.rows[0];
}

function output(rating: TaskRating, replayed: boolean): ServiceResult<VerifiedPosterRatingResult> {
  return {
    success: true,
    data: {
      ratingId: rating.id, taskId: rating.task_id,
      score: rating.stars, idempotencyReplayed: replayed,
    },
  };
}

async function ratingEvidence(key: string): Promise<RatingEvidence | null> {
  const existing = await db.query<{ task_id: string; score: string | null }>(
    `SELECT task_id, payload->>'score' AS score
       FROM engine_automation_events WHERE idempotency_key = $1`, [key],
  );
  const row = existing.rows[0];
  return row ? { taskId: row.task_id, score: row.score == null ? null : Number(row.score) } : null;
}

async function writeEvidence(params: VerifiedPosterRatingParams): Promise<void> {
  await db.query(
    `INSERT INTO engine_automation_events (task_id, event_type, idempotency_key, payload)
     VALUES ($1, 'POSTER_RATING_RECORDED', $2, $3::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [params.taskId, `poster-rating:${params.providerReviewId}`, JSON.stringify({
      providerReviewId: params.providerReviewId, score: params.score, actorId: params.actorId,
    })],
  );
}

async function recordInner(
  params: VerifiedPosterRatingParams,
): Promise<ServiceResult<VerifiedPosterRatingResult>> {
  const key = `poster-rating:${params.providerReviewId}`;
  const evidence = await ratingEvidence(key);
  if (evidence && (evidence.taskId !== params.taskId
      || (evidence.score !== null && evidence.score !== params.score))) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Provider review payload conflicts with canonical evidence' });
  }
  const context = await taskContext(params.taskId);
  if (!context.success) return context;
  if (context.data.state !== 'COMPLETED' || !context.data.worker_id) {
    return failure(ErrorCodes.INVALID_STATE, 'Only a completed task with a reserved hustler can be rated');
  }
  const prior = await existingRating(params.taskId, context.data.poster_id);
  if (prior) return output(prior, true);
  const created = await RatingService.submitRating({
    taskId: params.taskId, raterId: context.data.poster_id,
    stars: params.score, tags: ['verified_messaging'],
  });
  if (!created.success) return created;
  await writeEvidence(params);
  return output(created.data, Boolean(evidence));
}

async function record(params: VerifiedPosterRatingParams): Promise<ServiceResult<VerifiedPosterRatingResult>> {
  try {
    return await recordInner(params);
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'CONFLICT') {
      return failure('IDEMPOTENCY_CONFLICT', error.message);
    }
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'Verified poster rating failed');
    return failure('DB_ERROR', 'Could not record the verified poster rating safely');
  }
}

export const VerifiedPosterRatingService = { record };
