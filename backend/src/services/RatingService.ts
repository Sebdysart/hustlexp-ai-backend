/**
 * RatingService v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §12, RATING_SYSTEM_SPEC.md
 * 
 * Implements bidirectional rating system: both worker and poster rate each other.
 * Core Principle: Ratings are mutual, mandatory, and immutable.
 * 
 * @see schema.sql §11.5 (task_ratings table, user_rating_summary view)
 * @see PRODUCT_SPEC.md §12
 * @see staging/RATING_SYSTEM_SPEC.md
 */

import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../db';
import type { ServiceResult, TaskState } from '../types';
import { ErrorCodes } from '../types';

// ============================================================================
// TYPES
// ============================================================================

export interface TaskRating {
  id: string;
  task_id: string;
  rater_id: string; // Who gave the rating
  ratee_id: string; // Who received the rating
  stars: number; // 1-5
  comment?: string; // Max 500 chars, optional
  tags?: string[]; // Array of tag strings
  is_public: boolean; // Visible to ratee (after both submitted)
  is_blind: boolean; // Hidden until both parties rate
  is_auto_rated: boolean; // True if auto-rated after 7 days
  created_at: Date;
  updated_at: Date;
}

export interface UserRatingSummary {
  user_id: string;
  total_ratings: number;
  avg_rating: number; // Decimal(3,2)
  five_star_count: number;
  four_star_count: number;
  three_star_count: number;
  two_star_count: number;
  one_star_count: number;
  commented_count: number;
  last_rating_at: Date | null;
}

export interface CreateRatingParams {
  taskId: string;
  raterId: string;
  stars: number; // 1-5
  comment?: string; // Max 500 chars
  tags?: string[]; // Optional tags
}

export interface RatingStats {
  totalRatings: number;
  averageRating: number;
  ratingDistribution: {
    five: number;
    four: number;
    three: number;
    two: number;
    one: number;
  };
  recentRatings: TaskRating[]; // Last 10 ratings
}

// Rating window: 7 days after task completion (RATING_SYSTEM_SPEC.md §1.1)
const RATING_WINDOW_DAYS = 7;

// ============================================================================
// SERVICE
// ============================================================================

export const RatingService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get rating by ID
   */
  getRatingById: async (
    ratingId: string
  ): Promise<ServiceResult<TaskRating>> => {
    try {
      const result = await db.query<TaskRating>(
        'SELECT * FROM task_ratings WHERE id = $1',
        [ratingId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Rating ${ratingId} not found`,
          },
        };
      }
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get ratings for a task
   */
  getRatingsForTask: async (
    taskId: string
  ): Promise<ServiceResult<TaskRating[]>> => {
    try {
      const result = await db.query<TaskRating>(
        `SELECT * FROM task_ratings
         WHERE task_id = $1
         ORDER BY created_at ASC`,
        [taskId]
      );
      
      return {
        success: true,
        data: result.rows,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get ratings received by a user (public ratings only)
   */
  getRatingsForUser: async (
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<ServiceResult<TaskRating[]>> => {
    try {
      const result = await db.query<TaskRating>(
        `SELECT * FROM task_ratings
         WHERE ratee_id = $1 AND is_public = true
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );
      
      return {
        success: true,
        data: result.rows,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get rating summary for a user (aggregated stats)
   * 
   * Uses user_rating_summary view (schema.sql §11.5)
   */
  getRatingSummary: async (
    userId: string
  ): Promise<ServiceResult<UserRatingSummary>> => {
    try {
      const result = await db.query<UserRatingSummary>(
        `SELECT * FROM user_rating_summary WHERE user_id = $1`,
        [userId]
      );
      
      if (result.rows.length === 0) {
        // User has no ratings yet - return default summary
        return {
          success: true,
          data: {
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
          },
        };
      }
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Check if user has already rated for a task
   */
  hasRated: async (
    taskId: string,
    raterId: string,
    rateeId: string
  ): Promise<ServiceResult<boolean>> => {
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM task_ratings
         WHERE task_id = $1 AND rater_id = $2 AND ratee_id = $3`,
        [taskId, raterId, rateeId]
      );
      
      return {
        success: true,
        data: parseInt(result.rows[0]?.count || '0', 10) > 0,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // CREATE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Submit a rating (poster rates worker, or worker rates poster)
   * 
   * RATING_SYSTEM_SPEC.md §1.1: Rating only allowed after task COMPLETED, within 7-day window
   */
  submitRating: async (
    params: CreateRatingParams
  ): Promise<ServiceResult<TaskRating>> => {
    const { taskId, raterId, stars, comment, tags } = params;
    
    try {
      // Validate stars (1-5)
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'Rating stars must be between 1 and 5',
          },
        };
      }
      
      // Validate comment length (max 500 chars)
      if (comment && comment.length > 500) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'Rating comment cannot exceed 500 characters',
          },
        };
      }
      
      // Get task details
      const taskResult = await db.query<{
        id: string;
        poster_id: string;
        worker_id: string | null;
        state: TaskState;
        completed_at: Date | null;
      }>(
        'SELECT id, poster_id, worker_id, state, completed_at FROM tasks WHERE id = $1',
        [taskId]
      );
      
      if (taskResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${taskId} not found`,
          },
        };
      }
      
      const task = taskResult.rows[0];
      
      // RATE-1: Rating only allowed after task COMPLETED (RATING_SYSTEM_SPEC.md §6)
      if (task.state !== 'COMPLETED') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot submit rating: task is in ${task.state} state. Ratings only allowed after task COMPLETED`,
          },
        };
      }
      
      // RATE-2: Rating window: 7 days after completion (RATING_SYSTEM_SPEC.md §6)
      if (!task.completed_at) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Cannot submit rating: task completion date is missing',
          },
        };
      }
      
      const completedAt = new Date(task.completed_at);
      const ratingWindowEnd = new Date(completedAt.getTime() + RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const now = new Date();
      
      if (now > ratingWindowEnd) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot submit rating: rating window has expired (7 days after completion). Rating window ended on ${ratingWindowEnd.toISOString()}`,
          },
        };
      }
      
      // Verify rater is a participant (poster or worker)
      if (task.poster_id !== raterId && task.worker_id !== raterId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.FORBIDDEN,
            message: 'You are not a participant in this task',
          },
        };
      }
      
      // Determine ratee (the other party)
      const rateeId = task.poster_id === raterId ? task.worker_id : task.poster_id;
      
      if (!rateeId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Cannot submit rating: no ratee (worker not assigned)',
          },
        };
      }
      
      // RATE-5: One rating per pair per task (DB UNIQUE constraint will enforce)
      // Check if rating already exists
      const existingResult = await this.hasRated(taskId, raterId, rateeId);
      if (existingResult.success && existingResult.data) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'You have already rated this user for this task',
          },
        };
      }
      
      // Check if both parties have rated (to determine if rating should be blind)
      const bothRatingsResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM task_ratings
         WHERE task_id = $1 AND (rater_id = $2 OR rater_id = $3)`,
        [taskId, task.poster_id, task.worker_id]
      );
      
      const existingRatingsCount = parseInt(bothRatingsResult.rows[0]?.count || '0', 10);
      const isBlind = existingRatingsCount === 0; // Blind until both parties rate
      const isPublic = existingRatingsCount >= 1; // Public after at least one rating (will become public after both)
      
      // Create rating
      const ratingResult = await db.query<TaskRating>(
        `INSERT INTO task_ratings (
          task_id, rater_id, ratee_id, stars, comment, tags, is_public, is_blind, is_auto_rated
        )
        VALUES ($1, $2, $3, $4, $5, $6::TEXT[], $7, $8, false)
        RETURNING *`,
        [taskId, raterId, rateeId, stars, comment || null, tags || [], isPublic, isBlind]
      );
      
      // Check if both parties have now rated (update is_public and is_blind)
      const updatedRatingsCount = existingRatingsCount + 1;
      if (updatedRatingsCount === 2) {
        // Both parties have rated - make all ratings public and not blind
        await db.query(
          `UPDATE task_ratings
           SET is_public = true, is_blind = false, updated_at = NOW()
           WHERE task_id = $1`,
          [taskId]
        );
        
        // Re-fetch rating to get updated values
        const updatedResult = await db.query<TaskRating>(
          'SELECT * FROM task_ratings WHERE id = $1',
          [ratingResult.rows[0].id]
        );
        
        return {
          success: true,
          data: updatedResult.rows[0],
        };
      }
      
      return {
        success: true,
        data: ratingResult.rows[0],
      };
    } catch (error) {
      // Check for RATE-5 violation (duplicate rating)
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
        return {
          success: false,
          error: {
            code: error.code || 'INVARIANT_VIOLATION',
            message: getErrorMessage(error.code || ''),
          },
        };
      }
      
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // AUTO-RATING (Background Job)
  // --------------------------------------------------------------------------
  
  /**
   * Auto-rate tasks completed 7+ days ago without ratings
   * 
   * RATING_SYSTEM_SPEC.md §7: Auto-rates with 5 stars if no rating submitted within 7 days
   * 
   * This should be called by a background job daily
   */
  processAutoRatings: async (): Promise<ServiceResult<{ autoRated: number }>> => {
    try {
      // Find tasks completed 7+ days ago without ratings
      const incompleteTasksResult = await db.query<{
        id: string;
        poster_id: string;
        worker_id: string | null;
        completed_at: Date;
      }>(
        `SELECT t.id, t.poster_id, t.worker_id, t.completed_at
         FROM tasks t
         WHERE t.state = 'COMPLETED'
           AND t.completed_at < NOW() - INTERVAL '${RATING_WINDOW_DAYS} days'
           AND t.worker_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM task_ratings r1
             WHERE r1.task_id = t.id AND r1.rater_id = t.poster_id AND r1.ratee_id = t.worker_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_ratings r2
             WHERE r2.task_id = t.id AND r2.rater_id = t.worker_id AND r2.ratee_id = t.poster_id
           )`,
        []
      );
      
      let autoRated = 0;
      
      for (const task of incompleteTasksResult.rows) {
        if (!task.worker_id) {
          continue;
        }
        
        try {
          // Auto-rate poster → worker (5 stars)
          await db.query(
            `INSERT INTO task_ratings (
              task_id, rater_id, ratee_id, stars, comment, tags, is_public, is_blind, is_auto_rated
            )
            VALUES ($1, $2, $3, 5, 'No rating submitted (auto-rated)', ARRAY[]::TEXT[], true, false, true)`,
            [task.id, task.poster_id, task.worker_id]
          );
          
          // Auto-rate worker → poster (5 stars)
          await db.query(
            `INSERT INTO task_ratings (
              task_id, rater_id, ratee_id, stars, comment, tags, is_public, is_blind, is_auto_rated
            )
            VALUES ($1, $2, $3, 5, 'No rating submitted (auto-rated)', ARRAY[]::TEXT[], true, false, true)`,
            [task.id, task.worker_id, task.poster_id]
          );
          
          autoRated += 2; // 2 ratings per task (bidirectional)
        } catch (error) {
          // Skip if auto-rating fails (e.g., duplicate constraint)
          continue;
        }
      }
      
      return {
        success: true,
        data: { autoRated },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // RATING STATS
  // --------------------------------------------------------------------------
  
  /**
   * Get rating statistics for a user
   */
  getRatingStats: async (
    userId: string
  ): Promise<ServiceResult<RatingStats>> => {
    try {
      // Get summary from view
      const summaryResult = await this.getRatingSummary(userId);
      if (!summaryResult.success) {
        return summaryResult;
      }
      
      const summary = summaryResult.data;
      
      // Get recent ratings
      const recentResult = await this.getRatingsForUser(userId, 10, 0);
      if (!recentResult.success) {
        return recentResult;
      }
      
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
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};
