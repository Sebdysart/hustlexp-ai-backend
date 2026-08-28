import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import type {
  RatingStats,
  TaskRating,
  TextReview,
  UserRatingSummary,
} from './RatingTypes.js';

const log = logger.child({ service: 'RatingService' });

function databaseFailure<T>(error: unknown): ServiceResult<T> {
  log.error({ err: error instanceof Error ? error.message : String(error) }, 'RatingService DB error');
  return {
    success: false,
    error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
  };
}

function emptySummary(userId: string): UserRatingSummary {
  return {
    user_id: userId,
    total_ratings: 0,
    avg_rating: 0,
    five_star_count: 0,
    four_star_count: 0,
    three_star_count: 0,
    two_star_count: 0,
    one_star_count: 0,
    commented_count: 0,
    last_rating_at: null,
  };
}

export async function getRatingById(ratingId: string): Promise<ServiceResult<TaskRating>> {
  try {
    const result = await db.query<TaskRating>('SELECT * FROM task_ratings WHERE id = $1', [ratingId]);
    if (result.rows.length === 0) {
      return {
        success: false,
        error: { code: ErrorCodes.NOT_FOUND, message: `Rating ${ratingId} not found` },
      };
    }
    return { success: true, data: result.rows[0] };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function getRatingsForTask(taskId: string): Promise<ServiceResult<TaskRating[]>> {
  try {
    const result = await db.query<TaskRating>(
      `SELECT * FROM task_ratings WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId],
    );
    return { success: true, data: result.rows };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function getRatingsForUser(
  userId: string,
  limit = 50,
  offset = 0,
): Promise<ServiceResult<TaskRating[]>> {
  try {
    const result = await db.query<TaskRating>(
      `SELECT * FROM task_ratings
       WHERE ratee_id = $1 AND is_public = true
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return { success: true, data: result.rows };
  } catch (error) {
    return databaseFailure(error);
  }
}

interface TextReviewRow {
  id: string;
  task_id: string;
  stars: number;
  text: string;
  created_at: Date;
  is_auto_rated: boolean;
  task_title: string | null;
}

export async function getTextReviewsForUser(
  userId: string,
  limit = 50,
  offset = 0,
): Promise<ServiceResult<TextReview[]>> {
  try {
    const result = await db.query<TextReviewRow>(
      `SELECT r.id, r.task_id, r.stars, r.comment AS text, r.created_at, r.is_auto_rated,
              t.title AS task_title
       FROM task_ratings r
       JOIN tasks t ON t.id = r.task_id
       WHERE r.ratee_id = $1 AND r.is_public = true
         AND r.comment IS NOT NULL AND TRIM(r.comment) != ''
       ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return { success: true, data: result.rows };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function getRatingSummary(userId: string): Promise<ServiceResult<UserRatingSummary>> {
  try {
    const result = await db.query<UserRatingSummary>(
      `SELECT * FROM user_rating_summary WHERE user_id = $1`,
      [userId],
    );
    return { success: true, data: result.rows[0] ?? emptySummary(userId) };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function hasRated(
  taskId: string,
  raterId: string,
  rateeId: string,
): Promise<ServiceResult<boolean>> {
  try {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM task_ratings
       WHERE task_id = $1 AND rater_id = $2 AND ratee_id = $3`,
      [taskId, raterId, rateeId],
    );
    return { success: true, data: Number(result.rows[0]?.count ?? 0) > 0 };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function getRatingStats(userId: string): Promise<ServiceResult<RatingStats>> {
  try {
    const summaryResult = await getRatingSummary(userId);
    if (!summaryResult.success) return summaryResult;
    const recentResult = await getRatingsForUser(userId, 10, 0);
    if (!recentResult.success) return recentResult;
    const summary = summaryResult.data;
    return {
      success: true,
      data: {
        totalRatings: summary.total_ratings,
        averageRating: summary.avg_rating,
        ratingDistribution: {
          five: summary.five_star_count,
          four: summary.four_star_count,
          three: summary.three_star_count,
          two: summary.two_star_count,
          one: summary.one_star_count,
        },
        recentRatings: recentResult.data,
      },
    };
  } catch (error) {
    return databaseFailure(error);
  }
}
