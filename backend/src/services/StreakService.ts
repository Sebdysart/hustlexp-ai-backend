import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';

const log = logger.child({ service: 'StreakService' });

const MIN_TASK_PRICE_FOR_STREAK = 500; // $5.00 in cents

function toUTCDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return toUTCDate(d);
}

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
  message: string;
}

// FIX: Added taskPriceCents parameter. Tasks below $5 (500 cents) still award
// XP but do not qualify for streak extension. This prevents gaming streaks
// with micro-tasks ($0.50/day) to farm the 2.0x streak multiplier.
export async function updateStreakOnTaskCompletion(
  userId: string,
  completedAt: Date,
  taskPriceCents: number = 0
): Promise<ServiceResult<StreakUpdateResult>> {
  // Tasks below minimum price don't qualify for streak advancement
  if (taskPriceCents > 0 && taskPriceCents < MIN_TASK_PRICE_FOR_STREAK) {
    log.info({ userId, taskPriceCents, min: MIN_TASK_PRICE_FOR_STREAK }, 'Task below streak minimum price — streak not updated');
    const row = await db.query<{ current_streak: number }>(
      'SELECT current_streak FROM users WHERE id = $1',
      [userId]
    );
    const currentStreak = row.rows[0]?.current_streak ?? 0;
    return {
      success: true,
      data: { previousStreak: currentStreak, newStreak: currentStreak, streakChanged: false, wasReset: false },
    };
  }

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
    } catch { /* Ignore if longest_streak column doesn't exist yet */ }

    if (streakChanged) {
      log.info({ userId, previousStreak, newStreak, wasReset, completionDate }, 'Streak updated');
    }

    return { success: true, data: { previousStreak, newStreak, streakChanged, wasReset } };
  } catch (e) {
    log.error({ err: e, userId }, 'updateStreakOnTaskCompletion failed');
    return { success: false, error: { code: 'DB_ERROR', message: e instanceof Error ? e.message : String(e) } };
  }
}

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
      const lr = await db.query<{ longest_streak: number }>('SELECT longest_streak FROM users WHERE id = $1', [userId]);
      if (lr.rows[0]?.longest_streak != null) longest_streak = lr.rows[0].longest_streak;
    } catch { /* Column may not exist */ }

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
      data: { current_streak, last_task_completed_at: row.last_task_completed_at, streak_grace_expires_at: row.streak_grace_expires_at, longest_streak, message },
    };
  } catch (e) {
    log.error({ err: e, userId }, 'getStreakStatus failed');
    return { success: false, error: { code: 'DB_ERROR', message: e instanceof Error ? e.message : String(e) } };
  }
}
