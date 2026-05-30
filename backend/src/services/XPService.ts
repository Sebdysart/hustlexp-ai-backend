import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { AlphaInstrumentation } from './AlphaInstrumentation.js';
import { updateStreakOnTaskCompletion } from './StreakService.js';
import { Redis } from '@upstash/redis';
import { config } from '../config.js';

const log = logger.child({ service: 'XPService' });

let xpRedis: Redis | null = null;
function getXPRedis(): Redis | null {
  if (!xpRedis && config.redis.restUrl && config.redis.restToken) {
    xpRedis = new Redis({ url: config.redis.restUrl, token: config.redis.restToken });
  }
  return xpRedis;
}

const DAILY_XP_CAP = 10000;

export interface XPLedgerEntry {
  id: string;
  user_id: string;
  task_id: string;
  escrow_id: string;
  base_xp: number;
  streak_multiplier: number;
  trust_multiplier: number;
  live_mode_multiplier: number;
  effective_xp: number;
  reason: string;
  user_xp_before: number;
  user_xp_after: number;
  user_level_before: number;
  user_level_after: number;
  user_streak_at_award: number;
  awarded_at: Date;
}

interface AwardXPParams {
  userId: string;
  taskId: string;
  escrowId: string;
  baseXP: number;
}

interface XPCalculation {
  baseXP: number;
  streakMultiplier: number;
  trustMultiplier: number;
  liveModeMultiplier: number;
  effectiveXP: number;
}

const LEVEL_THRESHOLDS = [
  0, 100, 300, 700, 1500, 2700, 4500, 7000, 10500, 16500,
];

function getStreakMultiplier(streak: number): number {
  const multiplier = 1.0 + (streak * 0.05);
  return Math.min(multiplier, 2.0);
}

function getTrustMultiplier(trustTier: number): number {
  switch (trustTier) {
    case 1: return 1.0;
    case 2: return 1.5;
    case 3: return 2.0;
    case 4: return 2.0;
    default: return 1.0;
  }
}

function getLiveModeMultiplier(isLiveMode: boolean): number {
  return isLiveMode ? 1.25 : 1.0;
}

function calculateEffectiveXP(
  baseXP: number,
  streakMultiplier: number,
  trustMultiplier: number,
  liveModeMultiplier: number = 1.0
): number {
  return Math.floor(baseXP * streakMultiplier * trustMultiplier * liveModeMultiplier);
}

function calculateLevel(totalXP: number): number {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalXP >= LEVEL_THRESHOLDS[i]) {
      return i + 1;
    }
  }
  return 1;
}

export const XPService = {
  calculateAward: async (
    userId: string,
    baseXP: number,
    taskId?: string
  ): Promise<ServiceResult<XPCalculation>> => {
    try {
      const userResult = await db.query<{
        current_streak: number;
        trust_tier: number;
      }>(
        'SELECT current_streak, trust_tier FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        return {
          success: false,
          error: { code: ErrorCodes.NOT_FOUND, message: `User ${userId} not found` },
        };
      }

      const user = userResult.rows[0];

      let isLiveMode = false;
      if (taskId) {
        const taskResult = await db.query<{ mode: string }>(
          'SELECT mode FROM tasks WHERE id = $1',
          [taskId]
        );
        isLiveMode = taskResult.rows[0]?.mode === 'LIVE';
      }

      const streakMultiplier = getStreakMultiplier(user.current_streak);
      const trustMultiplier = getTrustMultiplier(user.trust_tier);
      const liveModeMultiplier = getLiveModeMultiplier(isLiveMode);
      const effectiveXP = calculateEffectiveXP(baseXP, streakMultiplier, trustMultiplier, liveModeMultiplier);

      return {
        success: true,
        data: { baseXP, streakMultiplier, trustMultiplier, liveModeMultiplier, effectiveXP },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'CALCULATION_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  awardXP: async (params: AwardXPParams): Promise<ServiceResult<XPLedgerEntry>> => {
    const { userId, taskId, escrowId, baseXP } = params;

    const VELOCITY_BLOCK_THRESHOLD = 3000;
    const velocityCheck = await XPService.checkVelocity(userId);
    if (velocityCheck.suspicious && baseXP > VELOCITY_BLOCK_THRESHOLD) {
      log.warn({ userId, baseXP, velocityData: velocityCheck }, 'XP velocity block triggered');
      return {
        success: false,
        error: { code: 'XP_VELOCITY_EXCEEDED', message: 'XP_VELOCITY_EXCEEDED: Award blocked due to suspicious velocity pattern' },
      };
    }
    if (velocityCheck.suspicious) {
      log.warn({ userId, baseXP, recentEvents: velocityCheck.recentEvents }, 'XP velocity suspicious (below block threshold) - allowing but flagging');
    }

    let effectiveXPAwarded = 0;

    try {
      const result = await db.serializableTransaction(async (query) => {
        const userResult = await query<{
          xp_total: number;
          current_level: number;
          current_streak: number;
          trust_tier: number;
        }>(
          'SELECT xp_total, current_level, current_streak, trust_tier FROM users WHERE id = $1 FOR UPDATE',
          [userId]
        );

        if (userResult.rows.length === 0) {
          return {
            success: false as const,
            error: { code: ErrorCodes.NOT_FOUND, message: `User ${userId} not found` },
          };
        }

        const user = userResult.rows[0];

        const taskResult = await query<{ mode: string }>(
          'SELECT mode FROM tasks WHERE id = $1',
          [taskId]
        );
        const isLiveMode = taskResult.rows[0]?.mode === 'LIVE';

        const streakMultiplier = getStreakMultiplier(user.current_streak);
        const trustMultiplier = getTrustMultiplier(user.trust_tier);
        const liveModeMultiplier = getLiveModeMultiplier(isLiveMode);
        const effectiveXP = calculateEffectiveXP(baseXP, streakMultiplier, trustMultiplier, liveModeMultiplier);

        const capCheck = await XPService.checkDailyXPCap(userId, effectiveXP);
        if (!capCheck.allowed) {
          return {
            success: false as const,
            error: { code: 'XP_DAILY_CAP', message: `Daily XP cap reached (${capCheck.cap} XP). Try again tomorrow.` },
          };
        }

        const newXPTotal = user.xp_total + effectiveXP;
        const newLevel = calculateLevel(newXPTotal);

        effectiveXPAwarded = effectiveXP;

        const ledgerResult = await query<XPLedgerEntry>(
          `INSERT INTO xp_ledger (
            user_id, task_id, escrow_id,
            base_xp, streak_multiplier, trust_multiplier, live_mode_multiplier, effective_xp,
            reason,
            user_xp_before, user_xp_after,
            user_level_before, user_level_after,
            user_streak_at_award
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING *`,
          [
            userId, taskId, escrowId,
            baseXP, streakMultiplier, trustMultiplier, liveModeMultiplier, effectiveXP,
            'task_completion',
            user.xp_total, newXPTotal,
            user.current_level, newLevel,
            user.current_streak,
          ]
        );

        await query(
          `UPDATE users SET xp_total = $1, current_level = $2, updated_at = NOW() WHERE id = $3`,
          [newXPTotal, newLevel, userId]
        );

        if (!ledgerResult.rows[0]) {
          throw new Error('Failed to create XP ledger entry - no row returned');
        }

        return { success: true as const, data: ledgerResult.rows[0] };
      });

      if (result.success && effectiveXPAwarded > 0) {
        try {
          const userRoleResult = await db.query<{ default_mode: string }>(
            'SELECT default_mode FROM users WHERE id = $1',
            [userId]
          );
          const role = userRoleResult.rows[0]?.default_mode === 'poster' ? 'poster' : 'hustler';

          await AlphaInstrumentation.emitTrustDeltaApplied({
            user_id: userId,
            role,
            delta_type: 'xp',
            delta_amount: effectiveXPAwarded,
            reason_code: 'task_completion',
            task_id: taskId,
            timestamp: new Date(),
          });
        } catch (error) {
          log.warn({ err: error instanceof Error ? error.message : String(error), userId, taskId }, 'Failed to emit trust_delta_applied for XP award');
        }
      }

      if (result.success) {
        try {
          const taskRow = await db.query<{ completed_at: Date | null }>(
            'SELECT completed_at FROM tasks WHERE id = $1',
            [taskId]
          );
          const completedAt = taskRow.rows[0]?.completed_at ? new Date(taskRow.rows[0].completed_at) : new Date();
          const streakResult = await updateStreakOnTaskCompletion(userId, completedAt);
          if (streakResult.success && streakResult.data.streakChanged) {
            const userRoleResult = await db.query<{ default_mode: string }>(
              'SELECT default_mode FROM users WHERE id = $1',
              [userId]
            );
            const role = userRoleResult.rows[0]?.default_mode === 'poster' ? 'poster' : 'hustler';
            await AlphaInstrumentation.emitTrustDeltaApplied({
              user_id: userId,
              role,
              delta_type: 'streak',
              delta_amount: streakResult.data.newStreak,
              reason_code: 'task_completion',
              task_id: taskId,
              timestamp: new Date(),
            });
          }
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err), userId, taskId }, 'Streak update failed');
        }
      }

      return result;
    } catch (error) {
      if (isInvariantViolation(error)) {
        const dbError = error as { code?: string };
        return {
          success: false,
          error: { code: ErrorCodes.INV_1_VIOLATION, message: getErrorMessage(dbError.code || 'HX101') },
        };
      }

      if (isUniqueViolation(error)) {
        return {
          success: false,
          error: { code: ErrorCodes.INV_5_VIOLATION, message: `XP already awarded for escrow ${escrowId}` },
        };
      }

      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  getHistory: async (userId: string): Promise<ServiceResult<XPLedgerEntry[]>> => {
    try {
      const result = await db.query<XPLedgerEntry>(
        'SELECT * FROM xp_ledger WHERE user_id = $1 ORDER BY awarded_at DESC',
        [userId]
      );
      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  getByTask: async (taskId: string): Promise<ServiceResult<XPLedgerEntry | null>> => {
    try {
      const result = await db.query<XPLedgerEntry>(
        'SELECT * FROM xp_ledger WHERE task_id = $1',
        [taskId]
      );
      return { success: true, data: result.rows[0] || null };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  checkDailyXPCap: async (userId: string, xpAmount: number = 0): Promise<{ allowed: boolean; earned: number; cap: number; remaining: number }> => {
    const redis = getXPRedis();
    if (!redis) {
      try {
        const result = await db.query<{ total: string }>(
          `SELECT COALESCE(SUM(effective_xp), 0) as total
           FROM xp_ledger
           WHERE user_id = $1 AND awarded_at::date = CURRENT_DATE`,
          [userId]
        );
        const totalToday = parseInt(result.rows[0]?.total ?? '0', 10);
        return {
          allowed: totalToday + xpAmount <= DAILY_XP_CAP,
          earned: totalToday,
          cap: DAILY_XP_CAP,
          remaining: Math.max(0, DAILY_XP_CAP - totalToday),
        };
      } catch {
        return { allowed: false, earned: 0, cap: DAILY_XP_CAP, remaining: 0 };
      }
    }

    const dateKey = new Date().toISOString().split('T')[0];
    const key = `xp:daily:${userId}:${dateKey}`;
    try {
      if (xpAmount === 0) {
        const earned = Number(await redis.get(key) ?? 0);
        return {
          allowed: earned < DAILY_XP_CAP,
          earned,
          cap: DAILY_XP_CAP,
          remaining: Math.max(0, DAILY_XP_CAP - earned),
        };
      }

      const newTotal = Number(await redis.incrby(key, xpAmount));
      await redis.expire(key, 86400);

      if (newTotal > DAILY_XP_CAP) {
        await redis.decrby(key, xpAmount);
        const earnedBeforeAward = newTotal - xpAmount;
        return {
          allowed: false,
          earned: earnedBeforeAward,
          cap: DAILY_XP_CAP,
          remaining: Math.max(0, DAILY_XP_CAP - earnedBeforeAward),
        };
      }

      const earnedBeforeAward = newTotal - xpAmount;
      return {
        allowed: true,
        earned: earnedBeforeAward,
        cap: DAILY_XP_CAP,
        remaining: Math.max(0, DAILY_XP_CAP - newTotal),
      };
    } catch {
      return { allowed: false, earned: 0, cap: DAILY_XP_CAP, remaining: 0 };
    }
  },

  /** @deprecated Tracking is now atomic inside checkDailyXPCap. */
  trackDailyXP: async (_userId: string, _xpAmount: number): Promise<void> => {},

  // STOP-011 FIX: catch block now returns suspicious: true (fail CLOSED).
  // Previously returned suspicious: false on DB error, allowing unlimited
  // XP farming during database outages.
  checkVelocity: async (userId: string): Promise<{ suspicious: boolean; recentEvents: number }> => {
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM xp_ledger
         WHERE user_id = $1 AND awarded_at > NOW() - INTERVAL '1 hour'`,
        [userId]
      );
      const recentEvents = parseInt(result.rows[0]?.count || '0', 10);
      return { suspicious: recentEvents > 5, recentEvents };
    } catch {
      log.error({ userId }, 'checkVelocity DB query failed — failing closed');
      return { suspicious: true, recentEvents: -1 };
    }
  },

  clawbackXP: async (userId: string, escrowId: string, reason: string, fraction = 1.0): Promise<void> => {
    const award = await db.query<{ id: string; base_xp: number; effective_xp: number; task_id: string }>(
      `SELECT id, base_xp, effective_xp, task_id FROM xp_ledger
       WHERE user_id = $1 AND escrow_id = $2
       ORDER BY awarded_at DESC LIMIT 1`,
      [userId, escrowId]
    );
    if (award.rows.length === 0) {
      log.info({ userId, escrowId, reason }, 'XP clawback: no award found for escrow, skipping');
      return;
    }

    const clampedFraction = Math.min(1, Math.max(0, fraction));
    const xpToDeduct = Math.round(award.rows[0].effective_xp * clampedFraction);
    if (xpToDeduct === 0) return;
    const taskId = award.rows[0].task_id;

    const adjustedBaseXP = -Math.round(award.rows[0].base_xp * clampedFraction);
    const adjustedEffectiveXP = -xpToDeduct;

    const clawbackInsert = await db.query<{ id: string }>(
      `INSERT INTO xp_ledger (
        user_id, task_id, escrow_id,
        base_xp, streak_multiplier, trust_multiplier, live_mode_multiplier, effective_xp,
        reason,
        user_xp_before, user_xp_after,
        user_level_before, user_level_after,
        user_streak_at_award
      )
      SELECT
        $1, $3, $2,
        $5, streak_multiplier, trust_multiplier, live_mode_multiplier, $6,
        $4,
        user_xp_after, GREATEST(0, user_xp_after - $7),
        user_level_after, user_level_before,
        user_streak_at_award
      FROM xp_ledger
      WHERE user_id = $1 AND escrow_id = $2
      ORDER BY awarded_at DESC LIMIT 1
      ON CONFLICT ON CONSTRAINT xp_ledger_escrow_reason_unique DO NOTHING
      RETURNING id`,
      [userId, escrowId, taskId, reason, adjustedBaseXP, adjustedEffectiveXP, xpToDeduct]
    );

    if (clawbackInsert.rowCount === 0) {
      log.info({ userId, escrowId, reason }, 'XP clawback: already applied (idempotent), skipping deduction');
      return;
    }

    const afterResult = await db.query<{ xp_total: number; current_level: number }>(
      `UPDATE users SET xp_total = GREATEST(0, xp_total - $1), updated_at = NOW() WHERE id = $2
       RETURNING xp_total, current_level`,
      [xpToDeduct, userId]
    );

    if (afterResult.rows.length > 0) {
      const newXPTotal = afterResult.rows[0].xp_total;
      const newLevel = calculateLevel(newXPTotal);
      if (newLevel !== afterResult.rows[0].current_level) {
        await db.query(
          `UPDATE users SET current_level = $1, updated_at = NOW() WHERE id = $2`,
          [newLevel, userId]
        );
      }
    }

    log.info({ userId, xpDeducted: xpToDeduct, reason, escrowId }, 'XP clawback applied');
  },

  getDailyLeaderboard: async (limit: number = 25): Promise<ServiceResult<Array<{ userId: string; name: string; xpEarned: number; rank: number }>>> => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await db.query<{ user_id: string; name: string; xp_earned: string }>(
        `SELECT xl.user_id, u.full_name as name, SUM(xl.effective_xp)::INTEGER as xp_earned
         FROM xp_ledger xl
         JOIN users u ON u.id = xl.user_id
         WHERE xl.awarded_at::DATE = $1::DATE
         GROUP BY xl.user_id, u.full_name
         ORDER BY xp_earned DESC
         LIMIT $2`,
        [today, limit]
      );

      return {
        success: true,
        data: result.rows.map((row, idx) => ({
          userId: row.user_id,
          name: row.name || 'Anonymous',
          xpEarned: parseInt(row.xp_earned, 10),
          rank: idx + 1,
        })),
      };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },
};

export default XPService;
