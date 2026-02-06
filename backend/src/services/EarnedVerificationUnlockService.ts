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
import type { ServiceResult } from '../types';

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
      return { success: true, data: undefined };
    } catch (error) {
      console.error('[EarnedVerificationUnlockService.recordEarnings] Error:', error);
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
      console.error('[EarnedVerificationUnlockService.checkUnlockEligibility] Error:', error);
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
      console.error('[EarnedVerificationUnlockService.getUnlockProgress] Error:', error);
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
      console.error('[EarnedVerificationUnlockService.getEarningsLedger] Error:', error);
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

      // TODO: Log to audit_log table
      console.log(`[ADMIN OVERRIDE] ${adminId} granted verification unlock to ${userId}. Reason: ${reason}`);

      return { success: true, data: undefined };
    } catch (error) {
      console.error('[EarnedVerificationUnlockService.adminGrantUnlock] Error:', error);
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
