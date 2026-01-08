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

import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';

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
  decay_factor: number;
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
  decayFactor: number;
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
 * Streak multipliers (PRODUCT_SPEC §5.4)
 */
function getStreakMultiplier(streak: number): number {
  if (streak >= 30) return 1.5;
  if (streak >= 14) return 1.3;
  if (streak >= 7) return 1.2;
  if (streak >= 3) return 1.1;
  return 1.0;
}

/**
 * XP decay formula (PRODUCT_SPEC §5.2)
 * effectiveXP = baseXP × (1 / (1 + log₁₀(1 + totalXP / 1000)))
 */
function calculateDecayFactor(totalXP: number): number {
  // Fixed-point 4 decimal places
  const raw = 1 / (1 + Math.log10(1 + totalXP / 1000));
  return Math.floor(raw * 10000) / 10000;
}

/**
 * Calculate effective XP (PRODUCT_SPEC §5.3)
 * Rounding: truncate toward zero
 */
function calculateEffectiveXP(
  baseXP: number,
  streakMultiplier: number,
  decayFactor: number
): number {
  return Math.floor(baseXP * streakMultiplier * decayFactor);
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
   */
  calculateAward: async (
    userId: string,
    baseXP: number
  ): Promise<ServiceResult<XPCalculation>> => {
    try {
      // Get user's current XP and streak
      const userResult = await db.query<{
        xp_total: number;
        current_streak: number;
      }>(
        'SELECT xp_total, current_streak FROM users WHERE id = $1',
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
      const streakMultiplier = getStreakMultiplier(user.current_streak);
      const decayFactor = calculateDecayFactor(user.xp_total);
      const effectiveXP = calculateEffectiveXP(baseXP, streakMultiplier, decayFactor);
      
      return {
        success: true,
        data: {
          baseXP,
          streakMultiplier,
          decayFactor,
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
   * INV-1: Will fail if escrow is not RELEASED (HX101)
   * INV-5: Will fail if XP already awarded for this escrow (23505)
   */
  awardXP: async (params: AwardXPParams): Promise<ServiceResult<XPLedgerEntry>> => {
    const { userId, taskId, escrowId, baseXP } = params;
    
    try {
      return await db.serializableTransaction(async (query) => {
        // Get user's current state
        const userResult = await query<{
          xp_total: number;
          current_level: number;
          current_streak: number;
        }>(
          'SELECT xp_total, current_level, current_streak FROM users WHERE id = $1 FOR UPDATE',
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
        
        // Calculate XP
        const streakMultiplier = getStreakMultiplier(user.current_streak);
        const decayFactor = calculateDecayFactor(user.xp_total);
        const effectiveXP = calculateEffectiveXP(baseXP, streakMultiplier, decayFactor);
        
        const newXPTotal = user.xp_total + effectiveXP;
        const newLevel = calculateLevel(newXPTotal);
        
        // Insert XP ledger entry
        // INV-1: Trigger will check escrow is RELEASED
        // INV-5: UNIQUE constraint will prevent duplicates
        const ledgerResult = await query<XPLedgerEntry>(
          `INSERT INTO xp_ledger (
            user_id, task_id, escrow_id,
            base_xp, streak_multiplier, decay_factor, effective_xp,
            reason,
            user_xp_before, user_xp_after,
            user_level_before, user_level_after,
            user_streak_at_award
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING *`,
          [
            userId, taskId, escrowId,
            baseXP, streakMultiplier, decayFactor, effectiveXP,
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
        
        return { success: true, data: ledgerResult.rows[0] };
      });
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
};

export default XPService;
