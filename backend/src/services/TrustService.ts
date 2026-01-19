/**
 * TrustService v1.0.0
 * 
 * CONSTITUTIONAL: Manages trust tier promotions
 * 
 * Trust tier changes are automatically audited via database trigger.
 * This service orchestrates the promotion logic.
 * 
 * @see schema.sql §3 (trust_ledger table)
 * @see PRODUCT_SPEC.md §8.2
 * @see ARCHITECTURE.md §2.2
 */

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult, TrustLedgerEntry, User } from '../types';
import { ErrorCodes } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface PromoteTrustParams {
  userId: string;
  newTier: number; // 1-4
  reason: string;
  reasonDetails?: Record<string, unknown>;
  taskId?: string;
  disputeId?: string;
  changedBy: string; // 'system' or 'admin:usr_xxx'
}

// Trust tier requirements (PRODUCT_SPEC §8.2)
const TRUST_TIER_REQUIREMENTS = {
  1: { minTasks: 0 },      // Rookie
  2: { minTasks: 5 },      // Reliable
  3: { minTasks: 20 },     // Trusted
  4: { minTasks: 50 },     // Elite
} as const;

// ============================================================================
// SERVICE
// ============================================================================

export const TrustService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get trust ledger entries for a user
   */
  getLedger: async (userId: string): Promise<ServiceResult<TrustLedgerEntry[]>> => {
    try {
      const result = await db.query<TrustLedgerEntry>(
        'SELECT * FROM trust_ledger WHERE user_id = $1 ORDER BY changed_at DESC',
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
   * Get current trust tier for a user
   */
  getCurrentTier: async (userId: string): Promise<ServiceResult<number>> => {
    try {
      const result = await db.query<{ trust_tier: number }>(
        'SELECT trust_tier FROM users WHERE id = $1',
        [userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `User ${userId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0].trust_tier };
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
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Promote user to a new trust tier
   * Database trigger will automatically log to trust_ledger
   */
  promote: async (params: PromoteTrustParams): Promise<ServiceResult<User>> => {
    const { userId, newTier, reason, reasonDetails, taskId, disputeId, changedBy } = params;
    
    // Validate tier range
    if (newTier < 1 || newTier > 4) {
      return {
        success: false,
        error: {
          code: 'INVALID_TIER',
          message: `Trust tier must be between 1 and 4, got ${newTier}`,
        },
      };
    }
    
    try {
      // Get current tier
      const currentResult = await db.query<{ trust_tier: number }>(
        'SELECT trust_tier FROM users WHERE id = $1',
        [userId]
      );
      
      if (currentResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `User ${userId} not found`,
          },
        };
      }
      
      const currentTier = currentResult.rows[0].trust_tier;
      
      // Only allow promotion (not demotion) via this service
      if (newTier < currentTier) {
        return {
          success: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `Cannot demote trust tier from ${currentTier} to ${newTier}. Use admin override if needed.`,
          },
        };
      }
      
      if (newTier === currentTier) {
        // No change needed, but return current user
        const userResult = await db.query<User>(
          'SELECT * FROM users WHERE id = $1',
          [userId]
        );
        return { success: true, data: userResult.rows[0] };
      }
      
      // Update trust tier (trigger will log to trust_ledger)
      const updateResult = await db.query<User>(
        'UPDATE users SET trust_tier = $1 WHERE id = $2 RETURNING *',
        [newTier, userId]
      );
      
      // Manually insert ledger entry with full context (trigger only logs basic info)
      await db.query(
        `INSERT INTO trust_ledger (
          user_id, old_tier, new_tier, reason, reason_details,
          task_id, dispute_id, changed_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, currentTier, newTier, reason, reasonDetails ? JSON.stringify(reasonDetails) : null, taskId, disputeId, changedBy]
      );
      
      return { success: true, data: updateResult.rows[0] };
    } catch (error) {
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
  
  /**
   * Check if user qualifies for trust tier promotion
   * Based on completed tasks count
   */
  checkPromotionEligibility: async (userId: string): Promise<ServiceResult<{ eligible: boolean; currentTier: number; nextTier?: number }>> => {
    try {
      // Get current tier and completed tasks count
      const userResult = await db.query<{ trust_tier: number }>(
        'SELECT trust_tier FROM users WHERE id = $1',
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
      
      const currentTier = userResult.rows[0].trust_tier;
      
      // Count completed tasks
      const tasksResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM tasks 
         WHERE worker_id = $1 AND state = 'COMPLETED'`,
        [userId]
      );
      
      const completedTasks = parseInt(tasksResult.rows[0].count, 10);
      
      // Check if eligible for next tier
      const nextTier = currentTier + 1;
      if (nextTier > 4) {
        return { success: true, data: { eligible: false, currentTier } };
      }
      
      const requirement = TRUST_TIER_REQUIREMENTS[nextTier as keyof typeof TRUST_TIER_REQUIREMENTS];
      const eligible = completedTasks >= requirement.minTasks;
      
      return {
        success: true,
        data: {
          eligible,
          currentTier,
          nextTier: eligible ? nextTier : undefined,
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

export default TrustService;
