/**
 * BadgeService v1.0.0
 * 
 * CONSTITUTIONAL: Manages badge awards
 * 
 * Badges are append-only (INV-BADGE-2). Once awarded, they cannot be revoked.
 * Animation tracking is server-side (INV-BADGE-3).
 * 
 * @see schema.sql §4 (badges table)
 * @see ARCHITECTURE.md §2.3
 */

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult, Badge } from '../types';
import { ErrorCodes } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface AwardBadgeParams {
  userId: string;
  badgeType: string;
  badgeTier: number; // 1-4
  awardedFor?: string;
  taskId?: string;
}

interface MarkAnimationShownParams {
  badgeId: string;
}

// ============================================================================
// SERVICE
// ============================================================================

export const BadgeService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get badges for a user
   */
  getByUserId: async (userId: string): Promise<ServiceResult<Badge[]>> => {
    try {
      const result = await db.query<Badge>(
        'SELECT * FROM badges WHERE user_id = $1 ORDER BY awarded_at DESC',
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
   * Get badge by ID
   */
  getById: async (badgeId: string): Promise<ServiceResult<Badge>> => {
    try {
      const result = await db.query<Badge>(
        'SELECT * FROM badges WHERE id = $1',
        [badgeId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Badge ${badgeId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
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
   * Check if user has a specific badge type
   */
  hasBadge: async (userId: string, badgeType: string): Promise<ServiceResult<boolean>> => {
    try {
      const result = await db.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM badges WHERE user_id = $1 AND badge_type = $2',
        [userId, badgeType]
      );
      
      return { success: true, data: parseInt(result.rows[0].count, 10) > 0 };
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
   * Award a badge to a user
   * Badges are append-only - once awarded, they cannot be revoked (INV-BADGE-2)
   * 
   * If user already has this badge type, the award will fail due to unique constraint.
   */
  award: async (params: AwardBadgeParams): Promise<ServiceResult<Badge>> => {
    const { userId, badgeType, badgeTier, awardedFor, taskId } = params;
    
    // Validate tier range
    if (badgeTier < 1 || badgeTier > 4) {
      return {
        success: false,
        error: {
          code: 'INVALID_TIER',
          message: `Badge tier must be between 1 and 4, got ${badgeTier}`,
        },
      };
    }
    
    try {
      const result = await db.query<Badge>(
        `INSERT INTO badges (
          user_id, badge_type, badge_tier, awarded_for, task_id
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [userId, badgeType, badgeTier, awardedFor, taskId]
      );
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      // Check for unique constraint violation (user already has this badge)
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        return {
          success: false,
          error: {
            code: ErrorCodes.INV_5_VIOLATION,
            message: `User already has badge type ${badgeType}`,
          },
        };
      }
      
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
   * Mark badge animation as shown (INV-BADGE-3)
   * This is server-side tracking - animations play exactly once
   */
  markAnimationShown: async (params: MarkAnimationShownParams): Promise<ServiceResult<Badge>> => {
    const { badgeId } = params;
    
    try {
      const result = await db.query<Badge>(
        `UPDATE badges
         SET animation_shown_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [badgeId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Badge ${badgeId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
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
};

export default BadgeService;
