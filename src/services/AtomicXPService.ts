/**
 * ATOMIC XP SERVICE
 *
 * Handles XP calculations and atomic XP awards.
 *
 * INVARIANTS:
 *   INV-1 / INV-XP-2: XP only awarded when escrow state = 'released'
 *   INV-5: One XP entry per escrow (UNIQUE on money_state_lock_task_id in xp_ledger)
 *
 * @version 1.0.0
 */

import { transaction } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AtomicXPService');

// ============================================================================
// DECIMAL WRAPPER (for precision-safe financial calculations)
// ============================================================================

class DecimalValue {
  private value: number;

  constructor(value: number) {
    this.value = value;
  }

  toNumber(): number {
    return this.value;
  }

  toString(): string {
    return String(this.value);
  }

  toFixed(digits: number): string {
    return this.value.toFixed(digits);
  }
}

// ============================================================================
// PURE CALCULATION FUNCTIONS
// ============================================================================

/**
 * Calculate base XP from task price (in cents). Minimum 10 XP.
 * Formula: price_cents / 100 = dollars = XP points, minimum 10.
 */
export function calculateBaseXP(priceCents: number): number {
  return Math.max(10, Math.floor(priceCents / 100));
}

/**
 * Calculate decay factor based on total XP.
 * Returns DecimalValue(1) for 0 XP, decreasing towards 0.1 as XP grows.
 */
export function calculateDecayFactor(totalXP: number): DecimalValue {
  return new DecimalValue(Math.max(0.1, 1 - totalXP / 100000));
}

/**
 * Calculate user level from total XP.
 */
export function calculateLevel(totalXP: number): number {
  if (totalXP < 100) return 1;
  if (totalXP < 300) return 2;
  if (totalXP < 600) return 3;
  if (totalXP < 1000) return 4;
  if (totalXP < 2000) return 5;
  if (totalXP < 4000) return 6;
  if (totalXP < 7000) return 7;
  if (totalXP < 12000) return 8;
  if (totalXP < 18000) return 9;
  return 10;
}

/**
 * Get streak multiplier based on consecutive days active.
 */
export function getStreakMultiplier(streak: number): number {
  if (streak < 3) return 1.0;
  if (streak < 7) return 1.1;
  if (streak < 14) return 1.2;
  if (streak < 30) return 1.3;
  return 1.5;
}

// ============================================================================
// MAIN AWARD FUNCTION
// ============================================================================

export interface AwardXPResult {
  success: boolean;
  xpAwarded: number;
  baseXP?: number;
  decayFactor?: string;
  effectiveXP?: number;
  streakMultiplier?: string;
  finalXP?: number;
  newTotalXP?: number;
  newLevel?: number;
  previousLevel?: number;
  leveledUp?: boolean;
  newStreak?: number;
  alreadyAwarded: boolean;
  error?: string;
}

/**
 * Award XP for a completed task. Enforces INV-1 (XP requires released escrow)
 * and INV-5 (idempotency via UNIQUE constraint on xp_ledger).
 *
 * Transaction steps:
 *   1. Check money_state_lock for task — must exist and be 'released'
 *   2. Fetch task details (price, etc.)
 *   3. Fetch user details (current xp, level, streak)
 *   4. INSERT into xp_ledger (UNIQUE on money_state_lock_task_id)
 *   5. UPDATE user with new XP, level, streak
 */
export async function awardXPForTask(
  taskId: string,
  hustlerId: string
): Promise<AwardXPResult> {
  try {
    return await transaction(async (tx: any) => {
      // Step 1: Check money_state_lock — INV-1 / INV-XP-2
      const [lock] = await tx`
        SELECT task_id, current_state
        FROM money_state_lock
        WHERE task_id = ${taskId}
      `;

      if (!lock) {
        return {
          success: false,
          xpAwarded: 0,
          alreadyAwarded: false,
          error: `Money state not found for task ${taskId}`,
        };
      }

      if (lock.current_state !== 'released') {
        return {
          success: false,
          xpAwarded: 0,
          alreadyAwarded: false,
          error: `INV-XP-2: Cannot award XP — escrow state is '${lock.current_state}', must be 'released'`,
        };
      }

      // Step 2: Fetch task details
      const [task] = await tx`
        SELECT id, price, instant_mode, matched_at, accepted_at, state, completed_at, surge_level
        FROM tasks
        WHERE id = ${taskId}
      `;

      if (!task) {
        return {
          success: false,
          xpAwarded: 0,
          alreadyAwarded: false,
          error: `Task not found: ${taskId}`,
        };
      }

      // Step 3: Fetch user details
      const [user] = await tx`
        SELECT id, xp, level, streak, last_active_at
        FROM users
        WHERE id = ${hustlerId}
      `;

      if (!user) {
        return {
          success: false,
          xpAwarded: 0,
          alreadyAwarded: false,
          error: `User not found: ${hustlerId}`,
        };
      }

      // Calculate XP
      const priceCents = (task.price || 0) * 100; // price is in dollars in task table
      const baseXP = calculateBaseXP(priceCents);
      const decayFactorVal = calculateDecayFactor(user.xp || 0);
      const effectiveXP = Math.round(baseXP * decayFactorVal.toNumber());
      const streakMul = getStreakMultiplier(user.streak || 0);
      const finalXP = Math.max(1, Math.round(effectiveXP * streakMul));

      const newTotalXP = (user.xp || 0) + finalXP;
      const previousLevel = user.level || 1;
      const newLevel = calculateLevel(newTotalXP);
      const leveledUp = newLevel > previousLevel;
      const newStreak = (user.streak || 0) + 1;

      // Step 4: Insert into xp_ledger (UNIQUE constraint on money_state_lock_task_id)
      try {
        await tx`
          INSERT INTO xp_ledger (
            user_id, task_id, money_state_lock_task_id,
            base_xp, decay_factor, effective_xp, streak_multiplier, final_xp,
            created_at
          ) VALUES (
            ${hustlerId}, ${taskId}, ${taskId},
            ${baseXP}, ${decayFactorVal.toNumber()}, ${effectiveXP}, ${streakMul}, ${finalXP},
            NOW()
          )
        `;
      } catch (err: unknown) {
        // INV-5: Catch 23505 UNIQUE violation — means XP already awarded
        if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
          logger.info({ taskId, hustlerId }, 'XP already awarded (idempotent)');
          return {
            success: true,
            xpAwarded: 0,
            alreadyAwarded: true,
            finalXP: 0,
            newTotalXP: user.xp || 0,
            newLevel: user.level || 1,
            newStreak: user.streak || 0,
          };
        }
        throw err;
      }

      // Step 5: Update user XP, level, streak
      await tx`
        UPDATE users
        SET xp = ${newTotalXP},
            level = ${newLevel},
            streak = ${newStreak},
            updated_at = NOW()
        WHERE id = ${hustlerId}
      `;

      logger.info({
        taskId,
        hustlerId,
        baseXP,
        decayFactor: decayFactorVal.toNumber(),
        effectiveXP,
        streakMultiplier: streakMul,
        finalXP,
        newTotalXP,
        newLevel,
        leveledUp,
      }, 'XP awarded successfully');

      return {
        success: true,
        xpAwarded: finalXP,
        baseXP,
        decayFactor: decayFactorVal.toFixed(4),
        effectiveXP,
        streakMultiplier: streakMul.toFixed(2),
        finalXP,
        newTotalXP,
        newLevel,
        previousLevel,
        leveledUp,
        newStreak,
        alreadyAwarded: false,
      };
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, taskId, hustlerId }, 'Failed to award XP');
    return {
      success: false,
      xpAwarded: 0,
      alreadyAwarded: false,
      error: message,
    };
  }
}
