/**
 * TrustService v1.0.0
 * 
 * Compatibility facade over the canonical TrustTierService.
 * 
 * @see schema.sql §3 (trust_ledger table)
 * @see HustleXP Local Work Network blueprint §5
 * @see ARCHITECTURE.md §2.2
 */

import { db } from '../db.js';
import type { ServiceResult, TrustLedgerEntry, User } from '../types.js';
import { ErrorCodes } from '../types.js';
import { TrustTier, TrustTierService } from './TrustTierService.js';

// ============================================================================
// TYPES
// ============================================================================

interface PromoteTrustParams {
  userId: string;
  newTier: number; // 1-4; Explorer is the starting state, not a promotion target.
  reason: string;
  reasonDetails?: Record<string, unknown>;
  taskId?: string;
  disputeId?: string;
  changedBy: string; // 'system' or 'admin:usr_xxx'
}

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
   * Promote through the canonical evidence evaluator. Caller-supplied reason
   * text and task counts never authorize a tier transition.
   */
  promote: async (params: PromoteTrustParams): Promise<ServiceResult<User>> => {
    const { userId, newTier, changedBy } = params;
    
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
      await TrustTierService.applyPromotion(
        userId,
        newTier as TrustTier,
        changedBy === 'system' ? 'system' : 'admin',
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'PROMOTION_NOT_AUTHORIZED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }

    try {
      const userResult = await db.query<User>('SELECT * FROM users WHERE id = $1', [userId]);
      if (!userResult.rows[0]) {
        return {
          success: false,
          error: { code: ErrorCodes.NOT_FOUND, message: `User ${userId} not found` },
        };
      }
      return { success: true, data: userResult.rows[0] };
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
   * Read the canonical evidence decision. XP and raw task counts are never a
   * parallel promotion authority.
   */
  checkPromotionEligibility: async (userId: string): Promise<ServiceResult<{ eligible: boolean; currentTier: number; nextTier?: number }>> => {
    try {
      const currentTier = await TrustTierService.getTrustTier(userId);
      if (currentTier === TrustTier.BANNED) {
        return { success: true, data: { eligible: false, currentTier } };
      }
      const decision = await TrustTierService.evaluatePromotion(userId);
      return {
        success: true,
        data: {
          eligible: decision.eligible,
          currentTier,
          nextTier: decision.eligible ? decision.targetTier : undefined,
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
