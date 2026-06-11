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
    // AUDIT FIX H7 (2026-06-11): this was a read-modify-write race — SELECT
    // streak → compute in JS → UPDATE → second UPDATE for longest_streak, all
    // non-transactional. Two concurrent completions read the same previous
    // streak and double-incremented/clobbered each other, and a crash between
    // the two UPDATEs desynced longest_streak.
    //
    // Now ONE atomic statement: the new streak is computed in SQL against the
    // row's current values (SET expressions re-evaluate on the locked row, so
    // concurrent statements serialize correctly), and longest_streak updates
    // in the same statement. The CTE captures pre-update values for the
    // result/flags. UTC calendar-day semantics identical to the old JS logic.
    const grace = endOfUTCDate(addDays(completionDate, 1));

    const streakCase = `CASE
        WHEN u.last_task_completed_at IS NULL THEN 1
        WHEN (u.last_task_completed_at AT TIME ZONE 'UTC')::date = ($2::timestamptz AT TIME ZONE 'UTC')::date THEN u.current_streak
        WHEN ((u.last_task_completed_at AT TIME ZONE 'UTC')::date + 1) = ($2::timestamptz AT TIME ZONE 'UTC')::date THEN u.current_streak + 1
        ELSE 1
      END`;

    const runAtomicUpdate = (withLongest: boolean) => db.query<{
      new_streak: number;
      previous_streak: number | null;
      prev_last_at: Date | null;
    }>(
      `WITH prev AS (
         SELECT current_streak AS previous_streak, last_task_completed_at AS prev_last_at
         FROM users WHERE id = $1
       )
       UPDATE users u
       SET current_streak = ${streakCase},
           ${withLongest ? `longest_streak = GREATEST(COALESCE(u.longest_streak, 0), ${streakCase}),` : ''}
           last_task_completed_at = $2,
           streak_grace_expires_at = $3,
           updated_at = NOW()
       FROM prev
       WHERE u.id = $1
       RETURNING u.current_streak AS new_streak, prev.previous_streak, prev.prev_last_at`,
      [userId, completedAt, grace]
    );

    let result;
    try {
      result = await runAtomicUpdate(true);
    } catch (err) {
      // longest_streak column may not exist pre-migration-005 — retry without it
      if (err instanceof Error && /longest_streak/.test(err.message)) {
        result = await runAtomicUpdate(false);
      } else {
        throw err;
      }
    }

    const row = result.rows[0];
    if (!row) {
      return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: `User ${userId} not found` } };
    }

    const previousStreak = row.previous_streak ?? 0;
    const newStreak = row.new_streak;
    const lastDate = row.prev_last_at ? toUTCDate(new Date(row.prev_last_at)) : null;
    const sameDay = lastDate !== null && lastDate === completionDate;
    const streakChanged = !sameDay;
    const wasReset = !sameDay && lastDate !== null && addDays(lastDate, 1) !== completionDate;

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
