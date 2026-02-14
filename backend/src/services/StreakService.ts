/**
 * StreakService v1.0.0
 *
 * Manages daily task completion streaks.
 * Called after task completion to increment or reset streak counter.
 *
 * Streak Rules:
 * - Completing at least 1 task per calendar day maintains the streak
 * - Missing a full calendar day resets streak to 0
 * - Streak multiplier tiers: 3d=1.10x, 7d=1.20x, 14d=1.30x, 30d=1.50x (cap)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

export const StreakService = {
  /**
   * Increment streak after task completion.
   * If user already completed a task today, streak stays the same.
   * If last completion was yesterday, streak increments by 1.
   * If last completion was >1 day ago, streak resets to 1.
   */
  recordTaskCompletion: async (userId: string): Promise<ServiceResult<{ streak: number; streakChanged: boolean }>> => {
    try {
      const result = await db.query<{
        current_streak: number;
        last_task_completed_at: Date | null;
      }>(
        'SELECT current_streak, last_task_completed_at FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );

      if (result.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'User not found' } };
      }

      const user = result.rows[0];
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      let newStreak = user.current_streak;
      let streakChanged = false;

      if (!user.last_task_completed_at) {
        // First ever task completion
        newStreak = 1;
        streakChanged = true;
      } else {
        const lastDate = new Date(user.last_task_completed_at);
        const lastDay = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
        const diffDays = Math.floor((today.getTime() - lastDay.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
          // Already completed a task today — no change
          streakChanged = false;
        } else if (diffDays === 1) {
          // Consecutive day — increment
          newStreak = user.current_streak + 1;
          streakChanged = true;
        } else {
          // Missed a day — reset to 1
          newStreak = 1;
          streakChanged = true;
        }
      }

      if (streakChanged) {
        await db.query(
          `UPDATE users
           SET current_streak = $1, last_task_completed_at = NOW(), updated_at = NOW()
           WHERE id = $2`,
          [newStreak, userId]
        );
      } else {
        // Update last_task_completed_at even if streak didn't change
        await db.query(
          `UPDATE users SET last_task_completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [userId]
        );
      }

      return { success: true, data: { streak: newStreak, streakChanged } };
    } catch (error) {
      console.error('[StreakService.recordTaskCompletion] Error:', error);
      return {
        success: false,
        error: {
          code: 'STREAK_UPDATE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to update streak'
        }
      };
    }
  },

  /**
   * Reset streak for users who missed a day.
   * Should be called by a daily cron job.
   */
  resetExpiredStreaks: async (): Promise<ServiceResult<{ resetCount: number }>> => {
    try {
      const result = await db.query(
        `UPDATE users
         SET current_streak = 0, updated_at = NOW()
         WHERE current_streak > 0
           AND last_task_completed_at < NOW() - INTERVAL '1 day'
           AND last_task_completed_at IS NOT NULL
         RETURNING id`
      );

      const resetCount = result.rowCount || 0;
      if (resetCount > 0) {
        console.log(`[StreakService] Reset ${resetCount} expired streaks`);
      }

      return { success: true, data: { resetCount } };
    } catch (error) {
      console.error('[StreakService.resetExpiredStreaks] Error:', error);
      return {
        success: false,
        error: {
          code: 'STREAK_RESET_FAILED',
          message: error instanceof Error ? error.message : 'Failed to reset streaks'
        }
      };
    }
  },

  /**
   * Get streak info for a user
   */
  getStreak: async (userId: string): Promise<ServiceResult<{ streak: number; lastCompletedAt: Date | null }>> => {
    try {
      const result = await db.query<{ current_streak: number; last_task_completed_at: Date | null }>(
        'SELECT current_streak, last_task_completed_at FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'User not found' } };
      }

      return {
        success: true,
        data: {
          streak: result.rows[0].current_streak,
          lastCompletedAt: result.rows[0].last_task_completed_at,
        }
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GET_STREAK_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get streak'
        }
      };
    }
  },
};

export default StreakService;
