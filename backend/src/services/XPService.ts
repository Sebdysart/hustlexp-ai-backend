/**
 * XPService v1.0.0 (AtomicXPService)
 * 
 * CONSTITUTIONAL: Enforces INV-1, INV-5
 * 
 * INV-1: XP can only be awarded if escrow is RELEASED
 * INV-5: XP issuance is idempotent per escrow_id (one award per escrow)
 * 
 * The database triggers enforce these invariants. This service
 * catches the violations and returns appropriate errors.
 * 
 * @see schema.sql §2.1 (xp_ledger table)
 * @see PRODUCT_SPEC.md §5
 */

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

// ============================================================================
// TYPES
// ============================================================================

export interface XPLedgerEntry {
  id: string;
  user_id: string;
  task_id: string;
  escrow_id: string;
  base_xp: number;
  streak_multiplier: number;
  trust_multiplier: number;      // SPEC ALIGNMENT: replaced decay_factor
  live_mode_multiplier: number;  // SPEC ALIGNMENT: 1.25× for Live tasks
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
  trustMultiplier: number;       // SPEC ALIGNMENT: replaced decayFactor
  liveModeMultiplier: number;    // SPEC ALIGNMENT: 1.25× for Live tasks
  effectiveXP: number;
}

// ============================================================================
// XP MATH (PRODUCT_SPEC §5.2, §5.3)
// ============================================================================

/**
 * Level thresholds (PRODUCT_SPEC §5.1)
 */
const LEVEL_THRESHOLDS = [
  0,      // Level 1: 0 XP
  100,    // Level 2: 100 XP
  300,    // Level 3: 300 XP (100 + 200)
  700,    // Level 4: 700 XP (300 + 400)
  1500,   // Level 5: 1500 XP (700 + 800)
  2700,   // Level 6: 2700 XP (1500 + 1200)
  4500,   // Level 7: 4500 XP (2700 + 1800)
  7000,   // Level 8: 7000 XP (4500 + 2500)
  10500,  // Level 9: 10500 XP (7000 + 3500)
  16500,  // Level 10: 16500 XP (10500 + 6000)
];

/**
 * Streak multipliers (PRODUCT_SPEC §5.2)
 *
 * SPEC FORMULA: 1.0 + (streak_days × 0.05) capped at 2.0
 */
function getStreakMultiplier(streak: number): number {
  const multiplier = 1.0 + (streak * 0.05);
  return Math.min(multiplier, 2.0); // Cap at 2.0
}

/**
 * Trust multipliers (PRODUCT_SPEC §5.2)
 *
 * SPEC ALIGNMENT:
 * | Trust Tier | Multiplier |
 * |------------|------------|
 * | ROOKIE (1) | 1.0×       |
 * | VERIFIED (2) | 1.5×     |
 * | TRUSTED (3) | 2.0×      |
 * | ELITE (4) | 2.0×        |
 */
function getTrustMultiplier(trustTier: number): number {
  switch (trustTier) {
    case 1: return 1.0;  // ROOKIE
    case 2: return 1.5;  // VERIFIED
    case 3: return 2.0;  // TRUSTED
    case 4: return 2.0;  // ELITE (same as TRUSTED)
    default: return 1.0; // Default to ROOKIE multiplier
  }
}

/**
 * Live Mode XP multiplier (PRODUCT_SPEC §3.6)
 *
 * SPEC: Live tasks award 1.25× XP
 */
function getLiveModeMultiplier(isLiveMode: boolean): number {
  return isLiveMode ? 1.25 : 1.0;
}

/**
 * Calculate effective XP (PRODUCT_SPEC §5.2)
 *
 * SPEC FORMULA: effective_xp = base_xp × streak_multiplier × trust_multiplier
 * Rounding: truncate toward zero
 */
function calculateEffectiveXP(
  baseXP: number,
  streakMultiplier: number,
  trustMultiplier: number,
  liveModeMultiplier: number = 1.0
): number {
  return Math.floor(baseXP * streakMultiplier * trustMultiplier * liveModeMultiplier);
}

/**
 * Calculate level from total XP
 */
function calculateLevel(totalXP: number): number {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalXP >= LEVEL_THRESHOLDS[i]) {
      return i + 1;
    }
  }
  return 1;
}

// ============================================================================
// SERVICE
// ============================================================================

export const XPService = {
  /**
   * Calculate XP award (without saving)
   *
   * SPEC ALIGNMENT (PRODUCT_SPEC §5.2):
   * effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier
   */
  calculateAward: async (
    userId: string,
    baseXP: number,
    taskId?: string
  ): Promise<ServiceResult<XPCalculation>> => {
    try {
      // Get user's current streak and trust tier
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
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `User ${userId} not found`,
          },
        };
      }

      const user = userResult.rows[0];

      // Check if task is Live Mode (for 1.25× multiplier)
      let isLiveMode = false;
      if (taskId) {
        const taskResult = await db.query<{ mode: string }>(
          'SELECT mode FROM tasks WHERE id = $1',
          [taskId]
        );
        isLiveMode = taskResult.rows[0]?.mode === 'LIVE';
      }

      // SPEC FORMULA: effective_xp = base_xp × streak_multiplier × trust_multiplier
      const streakMultiplier = getStreakMultiplier(user.current_streak);
      const trustMultiplier = getTrustMultiplier(user.trust_tier);
      const liveModeMultiplier = getLiveModeMultiplier(isLiveMode);
      const effectiveXP = calculateEffectiveXP(baseXP, streakMultiplier, trustMultiplier, liveModeMultiplier);

      return {
        success: true,
        data: {
          baseXP,
          streakMultiplier,
          trustMultiplier,
          liveModeMultiplier,
          effectiveXP,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'CALCULATION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Award XP for task completion
   *
   * SPEC ALIGNMENT (PRODUCT_SPEC §5.2):
   * effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier
   *
   * INV-1: Will fail if escrow is not RELEASED (HX101)
   * INV-5: Will fail if XP already awarded for this escrow (23505)
   */
  awardXP: async (params: AwardXPParams): Promise<ServiceResult<XPLedgerEntry>> => {
    const { userId, taskId, escrowId, baseXP } = params;

    // Anti-farming: Check daily XP cap (pass xpAmount so DB-fallback cap check is accurate)
    const capCheck = await XPService.checkDailyXPCap(userId, baseXP);
    if (!capCheck.allowed) {
      return {
        success: false,
        error: {
          code: 'XP_DAILY_CAP',
          message: `Daily XP cap reached (${capCheck.cap} XP). Try again tomorrow.`,
        },
      };
    }

    // Anti-farming: Check velocity
    // FIX 2: Hard-block large awards when velocity is suspicious
    const VELOCITY_BLOCK_THRESHOLD = 1000;
    const velocityCheck = await XPService.checkVelocity(userId);
    if (velocityCheck.suspicious && baseXP > VELOCITY_BLOCK_THRESHOLD) {
      log.warn({ userId, baseXP, velocityData: velocityCheck }, 'XP velocity block triggered');
      return {
        success: false,
        error: {
          code: 'XP_VELOCITY_EXCEEDED',
          message: 'XP_VELOCITY_EXCEEDED: Award blocked due to suspicious velocity pattern',
        },
      };
    }
    if (velocityCheck.suspicious) {
      log.warn({ userId, baseXP, recentEvents: velocityCheck.recentEvents }, 'XP velocity suspicious (below block threshold) - allowing but flagging');
    }

    let effectiveXPAwarded = 0;

    try {
      const result = await db.serializableTransaction(async (query) => {
        // Get user's current state including trust tier
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
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `User ${userId} not found`,
            },
          };
        }

        const user = userResult.rows[0];

        // Check if task is Live Mode (for 1.25× multiplier)
        const taskResult = await query<{ mode: string }>(
          'SELECT mode FROM tasks WHERE id = $1',
          [taskId]
        );
        const isLiveMode = taskResult.rows[0]?.mode === 'LIVE';

        // SPEC FORMULA: effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier
        const streakMultiplier = getStreakMultiplier(user.current_streak);
        const trustMultiplier = getTrustMultiplier(user.trust_tier);
        const liveModeMultiplier = getLiveModeMultiplier(isLiveMode);
        const effectiveXP = calculateEffectiveXP(baseXP, streakMultiplier, trustMultiplier, liveModeMultiplier);

        const newXPTotal = user.xp_total + effectiveXP;
        const newLevel = calculateLevel(newXPTotal);

        // Store effectiveXP for instrumentation (outside transaction)
        effectiveXPAwarded = effectiveXP;

        // Insert XP ledger entry
        // INV-1: Trigger will check escrow is RELEASED
        // INV-5: UNIQUE constraint will prevent duplicates
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

        // Update user's XP total and level
        await query(
          `UPDATE users
           SET xp_total = $1, current_level = $2, updated_at = NOW()
           WHERE id = $3`,
          [newXPTotal, newLevel, userId]
        );

        // INSERT...RETURNING should always return a row, but verify for safety
        if (!ledgerResult.rows[0]) {
          throw new Error('Failed to create XP ledger entry - no row returned');
        }

        return { success: true as const, data: ledgerResult.rows[0] };
      });
      
      // Alpha Instrumentation: Emit trust delta applied for XP
      // Note: This happens outside the transaction to avoid blocking XP award
      // The try-catch ensures silent failure
      if (result.success && effectiveXPAwarded > 0) {
        try {
          // Determine role from user's default_mode (worker = hustler, poster = poster)
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

          // If streak changed, emit separate streak delta (outside transaction for consistency)
          // Note: We don't track streak changes in XPService currently, but we can add this later
        } catch (error) {
          // Silent fail - instrumentation should not break core flow
          log.warn({ err: error instanceof Error ? error.message : String(error), userId, taskId }, 'Failed to emit trust_delta_applied for XP award');
        }
      }

      // Track daily XP for cap enforcement
      if (result.success && result.data) {
        await XPService.trackDailyXP(userId, result.data.effective_xp);
      }

      // Gamified streaks: update streak on task completion (after XP award)
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
      // Check for INV-1 violation
      if (isInvariantViolation(error)) {
        const dbError = error as { code?: string };
        return {
          success: false,
          error: {
            code: ErrorCodes.INV_1_VIOLATION,
            message: getErrorMessage(dbError.code || 'HX101'),
          },
        };
      }
      
      // Check for INV-5 violation (duplicate)
      if (isUniqueViolation(error)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INV_5_VIOLATION,
            message: `XP already awarded for escrow ${escrowId}`,
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

  /**
   * Get XP history for user
   */
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
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get total XP awarded for a task
   */
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
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Check daily XP cap for anti-farming
   */
  checkDailyXPCap: async (userId: string, xpAmount: number = 0): Promise<{ allowed: boolean; earned: number; cap: number; remaining: number }> => {
    const redis = getXPRedis();
    if (!redis) {
      // FIX 1: Redis absent — fall back to DB query so cap is always enforced
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
        // DB fallback failed — block to be safe (fail closed)
        return { allowed: false, earned: 0, cap: DAILY_XP_CAP, remaining: 0 };
      }
    }

    const dateKey = new Date().toISOString().split('T')[0];
    const key = `xp:daily:${userId}:${dateKey}`;
    try {
      const earned = Number(await redis.get(key) ?? 0);
      return {
        allowed: earned + xpAmount <= DAILY_XP_CAP,
        earned,
        cap: DAILY_XP_CAP,
        remaining: Math.max(0, DAILY_XP_CAP - earned),
      };
    } catch {
      return { allowed: true, earned: 0, cap: DAILY_XP_CAP, remaining: DAILY_XP_CAP };
    }
  },

  /**
   * Track daily XP earned
   */
  trackDailyXP: async (userId: string, xpAmount: number): Promise<void> => {
    const redis = getXPRedis();
    if (!redis) return;

    const dateKey = new Date().toISOString().split('T')[0];
    const key = `xp:daily:${userId}:${dateKey}`;
    try {
      await redis.incrby(key, xpAmount);
      await redis.expire(key, 86400);
    } catch {
      // Non-fatal
    }
  },

  /**
   * Check XP velocity (anti-farming: flag if >5 events in 1 hour)
   */
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
      return { suspicious: false, recentEvents: 0 };
    }
  },

  /**
   * Clawback XP awarded for an escrow that was subsequently refunded or lost in dispute.
   *
   * INV-4 compliance: The xp_ledger is immutable (no UPDATE/DELETE). We insert a
   * debit entry with negative effective_xp to offset the original credit, then
   * update the user's running xp_total.
   *
   * FIX 3: Closes the dispute-then-refund free-XP exploit.
   */
  clawbackXP: async (userId: string, escrowId: string, reason: string): Promise<void> => {
    // Find the original XP award for this escrow
    const award = await db.query<{ id: string; effective_xp: number; task_id: string }>(
      `SELECT id, effective_xp, task_id FROM xp_ledger
       WHERE user_id = $1 AND escrow_id = $2
       ORDER BY awarded_at DESC LIMIT 1`,
      [userId, escrowId]
    );
    if (award.rows.length === 0) {
      // No XP was ever awarded for this escrow — nothing to clawback
      log.info({ userId, escrowId, reason }, 'XP clawback: no award found for escrow, skipping');
      return;
    }

    const xpToDeduct = award.rows[0].effective_xp;
    const taskId = award.rows[0].task_id;

    // Insert a debit entry (negative effective_xp) to preserve ledger immutability (INV-4)
    await db.query(
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
        -base_xp, streak_multiplier, trust_multiplier, live_mode_multiplier, -effective_xp,
        $4,
        user_xp_after, GREATEST(0, user_xp_after - effective_xp),
        user_level_after, user_level_before,
        user_streak_at_award
      FROM xp_ledger
      WHERE user_id = $1 AND escrow_id = $2
      ORDER BY awarded_at DESC LIMIT 1`,
      [userId, escrowId, taskId, reason]
    );

    // Update the user's running XP total (floor at 0)
    await db.query(
      `UPDATE users SET xp_total = GREATEST(0, xp_total - $1), updated_at = NOW() WHERE id = $2`,
      [xpToDeduct, userId]
    );

    log.info({ userId, xpDeducted: xpToDeduct, reason, escrowId }, 'XP clawback applied');
  },

  /**
   * Get daily XP leaderboard
   */
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
