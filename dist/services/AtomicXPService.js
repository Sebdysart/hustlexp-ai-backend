/**
 * ATOMIC XP AWARD SERVICE (BUILD_GUIDE Aligned)
 *
 * This module enforces BUILD_GUIDE invariants:
 * - INV-5: XP idempotent per money_state_lock (one award per escrow, ever)
 * - INV-XP-2: XP requires RELEASED money state
 * - FIX 1: Escrow release + XP award in single transaction
 * - AUDIT-5: Fixed-point arithmetic via Decimal.js
 * - AUDIT-6: Streak day boundary (UTC + 2h grace)
 *
 * ALIGNS WITH REPO:
 * - Uses `users` table directly (xp, level, streak columns)
 * - Uses `money_state_lock` for escrow state
 * - Uses `xp_ledger` for audit trail
 * - Uses `tasks` for task reference
 *
 * CONSTITUTIONAL: This code enforces law. Do not modify without review.
 */
import { transaction, getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import Decimal from 'decimal.js';
const logger = createLogger('AtomicXPService');
// Configure Decimal.js for fixed-point arithmetic (AUDIT-5)
Decimal.set({
    precision: 20,
    rounding: Decimal.ROUND_DOWN // Always truncate toward zero
});
// ============================================================================
// XP FORMULAS (FROM BUILD_GUIDE)
// ============================================================================
/**
 * Level thresholds from BUILD_GUIDE
 */
export const LEVEL_THRESHOLDS = [
    { level: 1, xpRequired: 0 },
    { level: 2, xpRequired: 100 },
    { level: 3, xpRequired: 300 },
    { level: 4, xpRequired: 700 },
    { level: 5, xpRequired: 1500 },
    { level: 6, xpRequired: 2700 },
    { level: 7, xpRequired: 4500 },
    { level: 8, xpRequired: 7000 },
    { level: 9, xpRequired: 10500 },
    { level: 10, xpRequired: 18500 },
];
/**
 * Streak multipliers from BUILD_GUIDE
 */
export const STREAK_MULTIPLIERS = [
    { minDays: 0, maxDays: 2, multiplier: '1.0' },
    { minDays: 3, maxDays: 6, multiplier: '1.1' },
    { minDays: 7, maxDays: 13, multiplier: '1.2' },
    { minDays: 14, maxDays: 29, multiplier: '1.3' },
    { minDays: 30, maxDays: Infinity, multiplier: '1.5' },
];
/**
 * Calculate XP decay factor based on total XP (BUILD_GUIDE formula)
 * Formula: 1 / (1 + log₁₀(1 + totalXP/1000))
 */
export function calculateDecayFactor(totalXP) {
    if (totalXP <= 0)
        return new Decimal(1);
    const ratio = new Decimal(totalXP).div(1000);
    const logValue = Decimal.log10(ratio.plus(1));
    return new Decimal(1).div(logValue.plus(1)).toDecimalPlaces(4, Decimal.ROUND_DOWN);
}
/**
 * Calculate effective XP after decay
 */
export function calculateEffectiveXP(baseXP, totalXP) {
    const decay = calculateDecayFactor(totalXP);
    return new Decimal(baseXP).mul(decay).floor().toNumber();
}
/**
 * Get streak multiplier for given streak days
 */
export function getStreakMultiplier(streakDays) {
    const tier = STREAK_MULTIPLIERS.find(t => streakDays >= t.minDays && streakDays <= t.maxDays);
    return new Decimal(tier?.multiplier ?? '1.0');
}
/**
 * Calculate base XP from task price (cents)
 * Base: 10 XP per $10, minimum 10 XP
 */
export function calculateBaseXP(amountCents) {
    const dollars = amountCents / 100;
    return Math.max(10, Math.floor(dollars));
}
/**
 * Calculate level from total XP
 */
export function calculateLevel(totalXP) {
    for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
        if (totalXP >= LEVEL_THRESHOLDS[i].xpRequired) {
            return LEVEL_THRESHOLDS[i].level;
        }
    }
    return 1;
}
// ============================================================================
// STREAK DAY BOUNDARY (AUDIT-6)
// ============================================================================
/**
 * Check if a timestamp is within the same "streak day"
 * Streak day = UTC day with 2-hour grace period
 */
export function isWithinStreakGrace(lastActiveAt) {
    if (!lastActiveAt)
        return false;
    const now = new Date();
    const graceHours = 2;
    // Get start of today (UTC)
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    // Yesterday start (UTC)
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    // Grace extends 2 hours into "today" for yesterday's streak
    const graceEnd = new Date(todayStart.getTime() + graceHours * 60 * 60 * 1000);
    // Last completion was yesterday and we're still in grace period
    if (lastActiveAt >= yesterdayStart && lastActiveAt < todayStart && now < graceEnd) {
        return true;
    }
    // Last completion was today
    if (lastActiveAt >= todayStart) {
        return true;
    }
    return false;
}
/**
 * Calculate new streak based on last active date
 */
export function calculateNewStreak(currentStreak, lastActiveAt) {
    if (!lastActiveAt)
        return 1;
    const now = new Date();
    // Get start of today and yesterday (UTC)
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    // Already completed today - don't increment
    if (lastActiveAt >= todayStart) {
        return currentStreak;
    }
    // Completed yesterday - increment streak
    if (lastActiveAt >= yesterdayStart) {
        return currentStreak + 1;
    }
    // Streak broken - reset to 1
    return 1;
}
// ============================================================================
// ATOMIC XP AWARD (FIX 1)
// ============================================================================
/**
 * Award XP for a released escrow — ATOMIC TRANSACTION
 *
 * INVARIANTS ENFORCED:
 * - INV-5: XP idempotent per money_state_lock (UNIQUE constraint on money_state_lock_task_id)
 * - INV-XP-2: Requires RELEASED money state (state check)
 * - FIX 1: Single transaction for all operations
 *
 * ALIGNS WITH REPO:
 * - Uses `users` table for xp, level, streak
 * - Uses `money_state_lock` for escrow state
 * - Uses `xp_ledger` for audit trail
 *
 * @param taskId - The task ID (also the key in money_state_lock)
 * @param hustlerId - The hustler's user ID (UUID)
 * @returns XPAwardResult
 */
export async function awardXPForTask(taskId, hustlerId) {
    const sql = getSql();
    try {
        // ATOMIC: All operations in single transaction
        const result = await transaction(async (tx) => {
            // 1. Fetch money state lock
            const [moneyState] = await tx `
        SELECT task_id, current_state
        FROM money_state_lock
        WHERE task_id = ${taskId}
        LIMIT 1
      `;
            if (!moneyState) {
                throw new Error(`Money state not found for task: ${taskId}`);
            }
            // 2. INV-XP-2: Verify money state is RELEASED
            if (moneyState.current_state !== 'released') {
                throw new Error(`INV-XP-2: Cannot award XP for money state: ${moneyState.current_state}. Must be 'released'.`);
            }
            // 3. Get task price for base XP calculation
            const [task] = await tx `
        SELECT id, price FROM tasks WHERE id = ${taskId}
      `;
            const taskPriceCents = task?.price ? Math.round(Number(task.price) * 100) : 1000;
            // 4. Get hustler's current XP and streak
            const [user] = await tx `
        SELECT id, xp, level, streak, last_active_at
        FROM users
        WHERE id = ${hustlerId}
        LIMIT 1
      `;
            if (!user) {
                throw new Error(`User not found: ${hustlerId}`);
            }
            const currentXP = user.xp || 0;
            const currentStreak = user.streak || 0;
            const previousLevel = user.level || 1;
            const lastActiveAt = user.last_active_at ? new Date(user.last_active_at) : null;
            // 5. Calculate XP (BUILD_GUIDE formulas)
            const baseXP = calculateBaseXP(taskPriceCents);
            const decayFactor = calculateDecayFactor(currentXP);
            const effectiveXP = calculateEffectiveXP(baseXP, currentXP);
            const newStreak = calculateNewStreak(currentStreak, lastActiveAt);
            const streakMultiplier = getStreakMultiplier(newStreak);
            const finalXP = new Decimal(effectiveXP).mul(streakMultiplier).floor().toNumber();
            // 6. INV-5: Insert XP event (UNIQUE constraint on money_state_lock_task_id prevents duplicates)
            try {
                await tx `
          INSERT INTO xp_ledger (
            user_id,
            task_id,
            money_state_lock_task_id,
            base_xp,
            decay_factor,
            effective_xp,
            streak_multiplier,
            final_xp,
            reason
          ) VALUES (
            ${hustlerId},
            ${taskId},
            ${taskId},
            ${baseXP},
            ${decayFactor.toFixed(4)},
            ${effectiveXP},
            ${streakMultiplier.toFixed(2)},
            ${finalXP},
            ${'Task completion (money released)'}
          )
        `;
            }
            catch (e) {
                // UNIQUE constraint violation = already awarded
                if (e.code === '23505' || e.message?.includes('unique') || e.message?.includes('duplicate')) {
                    logger.info({ taskId, hustlerId }, 'XP already awarded for task (idempotent skip)');
                    return {
                        success: true,
                        xpAwarded: 0,
                        baseXP: 0,
                        decayFactor: '1.0000',
                        effectiveXP: 0,
                        streakMultiplier: '1.00',
                        finalXP: 0,
                        newTotalXP: currentXP,
                        newLevel: previousLevel,
                        previousLevel,
                        leveledUp: false,
                        newStreak: currentStreak,
                        alreadyAwarded: true,
                    };
                }
                throw e;
            }
            // 7. Update user's XP, level, streak
            const newTotalXP = currentXP + finalXP;
            const newLevel = calculateLevel(newTotalXP);
            const leveledUp = newLevel > previousLevel;
            await tx `
        UPDATE users
        SET 
          xp = ${newTotalXP},
          level = ${newLevel},
          streak = ${newStreak},
          last_active_at = NOW(),
          updated_at = NOW()
        WHERE id = ${hustlerId}
      `;
            logger.info({
                taskId,
                hustlerId,
                baseXP,
                decayFactor: decayFactor.toString(),
                effectiveXP,
                streakMultiplier: streakMultiplier.toString(),
                finalXP,
                newTotalXP,
                newLevel,
                leveledUp,
                newStreak,
            }, 'XP awarded successfully');
            return {
                success: true,
                xpAwarded: finalXP,
                baseXP,
                decayFactor: decayFactor.toFixed(4),
                effectiveXP,
                streakMultiplier: streakMultiplier.toFixed(2),
                finalXP,
                newTotalXP,
                newLevel,
                previousLevel,
                leveledUp,
                newStreak,
                alreadyAwarded: false,
            };
        });
        return result;
    }
    catch (error) {
        logger.error({ error, taskId, hustlerId }, 'Failed to award XP');
        return {
            success: false,
            xpAwarded: 0,
            baseXP: 0,
            decayFactor: '1.0000',
            effectiveXP: 0,
            streakMultiplier: '1.00',
            finalXP: 0,
            newTotalXP: 0,
            newLevel: 0,
            previousLevel: 0,
            leveledUp: false,
            newStreak: 0,
            alreadyAwarded: false,
            error: error.message,
        };
    }
}
/**
 * Get XP ledger history for a user
 */
export async function getXPHistory(userId, limit = 20) {
    const sql = getSql();
    const rows = await sql `
    SELECT task_id, base_xp, final_xp, reason, created_at
    FROM xp_ledger
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
    return rows.map((row) => ({
        taskId: row.task_id,
        baseXP: row.base_xp,
        finalXP: row.final_xp,
        reason: row.reason,
        createdAt: new Date(row.created_at),
    }));
}
// Export for testing
export const __test__ = {
    calculateDecayFactor,
    calculateEffectiveXP,
    getStreakMultiplier,
    calculateBaseXP,
    calculateLevel,
    isWithinStreakGrace,
    calculateNewStreak,
};
//# sourceMappingURL=AtomicXPService.js.map