/**
 * EarnedVerificationUnlockService v1.0.0
 *
 * CONSTITUTIONAL: Tracks cumulative earnings for $40 verification unlock
 *
 * Workers unlock FREE identity verification after earning platform $40 net profit.
 * Formula: $40 profit = $200 in tasks × 20% platform fee
 *
 * @see EARNED_VERIFICATION_UNLOCK_SPEC_LOCKED.md
 * @see schema.sql v1.8.0 (verification_earnings_tracking, verification_earnings_ledger)
 */

import { db } from '../db';
import { logger } from '../logger';
import type { ServiceResult } from '../types';

const log = logger.child({ service: 'EarnedVerificationUnlockService' });

// ============================================================================
// TYPES
// ============================================================================

interface VerificationEarningsTracking {
  user_id: string;
  total_net_earnings_cents: number;
  earned_unlock_threshold_cents: number;
  earned_unlock_achieved: boolean;
  earned_unlock_achieved_at: Date | null;
  completed_task_count: number;
  last_updated_at: Date;
  created_at: Date;
}

interface VerificationEarningsLedger {
  id: string;
  user_id: string;
  task_id: string;
  escrow_id: string;
  net_payout_cents: number;
  cumulative_earnings_before_cents: number;
  cumulative_earnings_after_cents: number;
  awarded_at: Date;
}

interface UnlockProgress {
  earned_cents: number;
  threshold_cents: number;
  percentage: number;
  unlocked: boolean;
  tasks_completed: number;
  remaining_cents: number;
}

// ============================================================================
// SERVICE
// ============================================================================

export const EarnedVerificationUnlockService = {
  /**
   * Record net earnings from task completion
   * Idempotent via escrow_id unique constraint
   *
   * Trigger: update_verification_earnings_tracking() auto-updates tracking table
   */
  recordEarnings: async (
    userId: string,
    taskId: string,
    escrowId: string,
    netPayoutCents: number
  ): Promise<ServiceResult<void>> => {
    try {
      // Get current cumulative earnings
      const trackingResult = await db.query<Pick<VerificationEarningsTracking, 'total_net_earnings_cents'>>(
        'SELECT total_net_earnings_cents FROM verification_earnings_tracking WHERE user_id = $1',
        [userId]
      );

      const cumulativeBefore = trackingResult.rows[0]?.total_net_earnings_cents || 0;
      const cumulativeAfter = cumulativeBefore + netPayoutCents;

      // Insert into ledger (idempotent via UNIQUE constraint on escrow_id)
      await db.query(
        `INSERT INTO verification_earnings_ledger (
          user_id, task_id, escrow_id, net_payout_cents,
          cumulative_earnings_before_cents, cumulative_earnings_after_cents
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (escrow_id) DO NOTHING`,
        [userId, taskId, escrowId, netPayoutCents, cumulativeBefore, cumulativeAfter]
      );

      // Trigger handles updating verification_earnings_tracking
      // Gap 12: Check if threshold just crossed → send $1 upgrade push notification
      if (cumulativeBefore < 4000 && cumulativeAfter >= 4000) {
        log.info({ userId, cumulativeBefore, cumulativeAfter }, 'User crossed $40 threshold, triggering $1 verification offer');
        // Fire-and-forget notification (don't block earnings recording)
        db.query(
          `INSERT INTO notifications (user_id, type, title, body, data, created_at)
           VALUES ($1, 'EARNED_VERIFICATION_UNLOCKED',
                   '🎉 Free Verification Unlocked!',
                   'You''ve earned enough to unlock identity verification for just $1. Tap to upgrade and access premium tasks!',
                   $2, NOW())`,
          [userId, JSON.stringify({ action: 'OPEN_VERIFICATION', fee_cents: 100 })]
        ).catch(err => log.error({ err: err instanceof Error ? err.message : String(err), userId }, 'Notification insert failed'));
      }

      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId, taskId, escrowId }, 'recordEarnings failed');
      return {
        success: false,
        error: {
          code: 'RECORD_EARNINGS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to record earnings'
        }
      };
    }
  },

  /**
   * Check if user has unlocked verification
   */
  checkUnlockEligibility: async (userId: string): Promise<ServiceResult<boolean>> => {
    try {
      const result = await db.query<Pick<VerificationEarningsTracking, 'earned_unlock_achieved'>>(
        'SELECT earned_unlock_achieved FROM verification_earnings_tracking WHERE user_id = $1',
        [userId]
      );

      const unlocked = result.rows[0]?.earned_unlock_achieved || false;
      return { success: true, data: unlocked };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'checkUnlockEligibility failed');
      return {
        success: false,
        error: {
          code: 'CHECK_ELIGIBILITY_FAILED',
          message: error instanceof Error ? error.message : 'Failed to check eligibility'
        }
      };
    }
  },

  /**
   * Get unlock progress for UI display
   */
  getUnlockProgress: async (userId: string): Promise<ServiceResult<UnlockProgress>> => {
    try {
      const result = await db.query<Pick<
        VerificationEarningsTracking,
        'total_net_earnings_cents' | 'earned_unlock_threshold_cents' | 'earned_unlock_achieved' | 'completed_task_count'
      >>(
        `SELECT
          total_net_earnings_cents,
          earned_unlock_threshold_cents,
          earned_unlock_achieved,
          completed_task_count
        FROM verification_earnings_tracking
        WHERE user_id = $1`,
        [userId]
      );

      if (!result.rows[0]) {
        // No earnings yet
        return {
          success: true,
          data: {
            earned_cents: 0,
            threshold_cents: 4000, // Default $40
            percentage: 0,
            unlocked: false,
            tasks_completed: 0,
            remaining_cents: 4000
          }
        };
      }

      const row = result.rows[0];
      const percentage = Math.min(
        (row.total_net_earnings_cents / row.earned_unlock_threshold_cents) * 100,
        100
      );
      const remaining = Math.max(row.earned_unlock_threshold_cents - row.total_net_earnings_cents, 0);

      return {
        success: true,
        data: {
          earned_cents: row.total_net_earnings_cents,
          threshold_cents: row.earned_unlock_threshold_cents,
          percentage,
          unlocked: row.earned_unlock_achieved,
          tasks_completed: row.completed_task_count,
          remaining_cents: remaining
        }
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'getUnlockProgress failed');
      return {
        success: false,
        error: {
          code: 'GET_PROGRESS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get progress'
        }
      };
    }
  },

  /**
   * Get earnings ledger for user (audit trail)
   */
  getEarningsLedger: async (userId: string, limit = 20): Promise<ServiceResult<VerificationEarningsLedger[]>> => {
    try {
      const result = await db.query<VerificationEarningsLedger>(
        `SELECT * FROM verification_earnings_ledger
         WHERE user_id = $1
         ORDER BY awarded_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      return { success: true, data: result.rows };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'getEarningsLedger failed');
      return {
        success: false,
        error: {
          code: 'GET_LEDGER_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get ledger'
        }
      };
    }
  },

  /**
   * Admin: Manually grant unlock (emergency override)
   */
  adminGrantUnlock: async (userId: string, adminId: string, reason: string): Promise<ServiceResult<void>> => {
    try {
      await db.query(
        `UPDATE verification_earnings_tracking
         SET earned_unlock_achieved = TRUE,
             earned_unlock_achieved_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );

      // Log to admin_actions audit table
      await db.query(
        `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, reason, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          adminId,
          'verification_unlock_granted',
          'user',
          userId,
          reason,
          JSON.stringify({ action: 'admin_grant_verification_unlock', timestamp: new Date().toISOString() }),
        ]
      );
      log.info({ adminId, userId, reason }, 'Admin granted verification unlock');

      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), adminId, userId }, 'adminGrantUnlock failed');
      return {
        success: false,
        error: {
          code: 'ADMIN_GRANT_FAILED',
          message: error instanceof Error ? error.message : 'Failed to grant unlock'
        }
      };
    }
  }
};
