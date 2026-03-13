/**
 * StreakService – Gamified streaks (PRODUCT_SPEC §5.4, §5.5)
 *
 * Tracks consecutive calendar days with at least one completed task.
 * - One completion per UTC calendar day extends or maintains the streak.
 * - Missing a day resets streak to 1 on next completion.
 * - streak_grace_expires_at: end of the day after last completion (complete before to keep streak).
 */

import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';

const log = logger.child({ service: 'StreakService' });

/** UTC date string YYYY-MM-DD for comparison */
function toUTCDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add days to a UTC date string, return new YYYY-MM-DD */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return toUTCDate(d);
}

/** End of the given UTC date (23:59:59.999) */
function endOfUTCDate(dateStr: string): Date {
  return new Date(Date.UTC(
    parseInt(dateStr.slice(0, 4), 10),
    parseInt(dateStr.slice(5, 7), 10) - 1,
    parseInt(dateStr.slice(8, 10), 10),
    23, 59, 59, 999
  ));
}

export interface StreakUpdateResult {
  previousStreak: number;
  newStreak: number;
  streakChanged: boolean;
  wasReset: boolean;
}

export interface StreakStatus {
  current_streak: number;
  last_task_completed_at: Date | null;
  streak_grace_expires_at: Date | null;
  longest_streak: number;
  /** Human-readable hint for the UI */
  message: string;
}

/**
 * Update the user's streak when they complete a task (called after XP award on escrow release).
 * Uses task completion date in UTC for calendar-day logic.
 */
export async function updateStreakOnTaskCompletion(
  userId: string,
  completedAt: Date
): Promise<ServiceResult<StreakUpdateResult>> {
  const completionDate = toUTCDate(completedAt);

  try {
    const row = await db.query<{
      current_streak: number;
      last_task_completed_at: Date | null;
      streak_grace_expires_at: Date | null;
    }>(
      'SELECT current_streak, last_task_completed_at, streak_grace_expires_at FROM users WHERE id = $1',
      [userId]
    ).then(r => r.rows[0]);

    if (!row) {
      return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: `User ${userId} not found` } };
    }

    const previousStreak = row.current_streak ?? 0;
    const lastAt = row.last_task_completed_at;
    const lastDate = lastAt ? toUTCDate(new Date(lastAt)) : null;

    let newStreak: number;
    let streakChanged = false;
    let wasReset = false;

    if (!lastDate) {
      newStreak = 1;
      streakChanged = true;
    } else if (lastDate === completionDate) {
      newStreak = previousStreak;
    } else if (addDays(lastDate, 1) === completionDate) {
      newStreak = previousStreak + 1;
      streakChanged = true;
    } else {
      newStreak = 1;
      streakChanged = true;
      wasReset = true;
    }

    const graceEndDate = endOfUTCDate(addDays(completionDate, 1));

    // Update users; longest_streak only if column exists (migration 005)
    await db.query(
      `UPDATE users
       SET current_streak = $1, last_task_completed_at = $2, streak_grace_expires_at = $3, updated_at = NOW()
       WHERE id = $4`,
      [newStreak, completedAt, graceEndDate, userId]
    );

    try {
      await db.query(
        `UPDATE users SET longest_streak = GREATEST(COALESCE(longest_streak, 0), $1) WHERE id = $2`,
        [newStreak, userId]
      );
    } catch {
      // Ignore if longest_streak column doesn't exist yet
    }

    if (streakChanged) {
      log.info(
        { userId, previousStreak, newStreak, wasReset, completionDate },
        'Streak updated'
      );
    }

    return {
      success: true,
      data: { previousStreak, newStreak, streakChanged, wasReset },
    };
  } catch (e) {
    log.error({ err: e, userId }, 'updateStreakOnTaskCompletion failed');
    return {
      success: false,
      error: { code: 'DB_ERROR', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * Get current streak status for a user (for API / UI).
 */
export async function getStreakStatus(userId: string): Promise<ServiceResult<StreakStatus>> {
  try {
    const r = await db.query<{
      current_streak: number;
      last_task_completed_at: Date | null;
      streak_grace_expires_at: Date | null;
    }>(
      'SELECT current_streak, last_task_completed_at, streak_grace_expires_at FROM users WHERE id = $1',
      [userId]
    );

    const row = r.rows[0];
    if (!row) {
      return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: `User ${userId} not found` } };
    }

    const current_streak = row.current_streak ?? 0;
    let longest_streak = current_streak;
    try {
      const lr = await db.query<{ longest_streak: number }>(
        'SELECT longest_streak FROM users WHERE id = $1',
        [userId]
      );
      if (lr.rows[0]?.longest_streak != null) longest_streak = lr.rows[0].longest_streak;
    } catch {
      // Column may not exist (pre–migration 005)
    }
    let message: string;
    if (current_streak === 0) {
      message = 'Complete a task today to start your streak!';
    } else if (current_streak === 1) {
      message = '1 day streak! Complete a task today to keep it going.';
    } else {
      message = `${current_streak}-day streak! Complete a task today to extend it.`;
    }

    return {
      success: true,
      data: {
        current_streak,
        last_task_completed_at: row.last_task_completed_at,
        streak_grace_expires_at: row.streak_grace_expires_at,
        longest_streak,
        message,
      },
    };
  } catch (e) {
    log.error({ err: e, userId }, 'getStreakStatus failed');
    return {
      success: false,
      error: { code: 'DB_ERROR', message: e instanceof Error ? e.message : String(e) },
    };
  }
}
