/**
 * ShadowBanService v1.0.0
 *
 * CONSTITUTIONAL: Shadow ban system (Gap 6 fix)
 *
 * Soft degradation instead of hard bans. Toxic users see lower-quality tasks
 * and are matched with other low-score users. Avoids the legal risk of
 * outright bans while protecting the "good" economy.
 *
 * Score range: 0-100 (100 = perfect standing)
 * - 100-75: Full access
 * - 74-50: Limited to tasks < $50, slower matching priority
 * - 49-25: Only see tasks from other low-score users, no ASAP
 * - 24-0: Effectively invisible. Only custom/misc tasks visible
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface ShadowScoreDetails {
  user_id: string;
  shadow_score: number;
  tier: 'FULL' | 'LIMITED' | 'DEGRADED' | 'INVISIBLE';
  restrictions: string[];
  recent_events: ShadowScoreEvent[];
}

interface ShadowScoreEvent {
  id: string;
  delta: number;
  reason: string;
  source: string;
  score_before: number;
  score_after: number;
  created_at: Date;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PENALTIES = {
  dispute_lost: -15,
  cancellation_after_accept: -10,
  no_show: -20,
  bad_rating_1star: -8,
  bad_rating_2star: -5,
  fraud_flag: -25,
  gps_spoof_detected: -30,
  photo_fraud: -20,
  rude_behavior_report: -10,
  repeated_late: -5,
};

const BONUSES = {
  task_completed_5star: +3,
  task_completed_4star: +2,
  task_completed_generic: +1,
  streak_7_days: +5,
  streak_30_days: +10,
  dispute_won: +5,
  time_decay_daily: +0.5, // slowly recover 0.5 points per day
};

// ============================================================================
// SERVICE
// ============================================================================

export const ShadowBanService = {
  /**
   * Apply a shadow score penalty
   */
  applyPenalty: async (
    userId: string,
    reason: keyof typeof PENALTIES,
    source: 'system' | 'admin' | 'fraud_detection' | 'rating' | 'dispute' | 'cancellation'
  ): Promise<ServiceResult<number>> => {
    const delta = PENALTIES[reason];
    if (delta === undefined) {
      return { success: false, error: { code: 'INVALID_REASON', message: `Unknown penalty: ${reason}` } };
    }

    return ShadowBanService._adjustScore(userId, delta, reason, source);
  },

  /**
   * Apply a shadow score bonus
   */
  applyBonus: async (
    userId: string,
    reason: keyof typeof BONUSES,
    source: 'system' | 'admin' | 'rating' | 'dispute'
  ): Promise<ServiceResult<number>> => {
    const delta = BONUSES[reason];
    if (delta === undefined) {
      return { success: false, error: { code: 'INVALID_REASON', message: `Unknown bonus: ${reason}` } };
    }

    return ShadowBanService._adjustScore(userId, delta, reason, source);
  },

  /**
   * Get user's shadow score details
   */
  getDetails: async (userId: string): Promise<ServiceResult<ShadowScoreDetails>> => {
    try {
      const userResult = await db.query<{ shadow_score: number }>(
        `SELECT shadow_score FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'User not found' } };
      }

      const score = userResult.rows[0].shadow_score;

      // Get recent events
      const eventsResult = await db.query<ShadowScoreEvent>(
        `SELECT * FROM shadow_score_events
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [userId]
      );

      // Determine tier and restrictions
      let tier: 'FULL' | 'LIMITED' | 'DEGRADED' | 'INVISIBLE';
      const restrictions: string[] = [];

      if (score >= 75) {
        tier = 'FULL';
      } else if (score >= 50) {
        tier = 'LIMITED';
        restrictions.push('Tasks limited to < $50');
        restrictions.push('Lower matching priority');
      } else if (score >= 25) {
        tier = 'DEGRADED';
        restrictions.push('Matched with similar-score users only');
        restrictions.push('No ASAP/Live tasks');
        restrictions.push('Tasks limited to < $25');
      } else {
        tier = 'INVISIBLE';
        restrictions.push('Only misc/custom tasks visible');
        restrictions.push('No instant mode');
        restrictions.push('No ASAP/Live tasks');
        restrictions.push('Severely limited feed');
      }

      return {
        success: true,
        data: {
          user_id: userId,
          shadow_score: score,
          tier,
          restrictions,
          recent_events: eventsResult.rows,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Get SQL filter for shadow-ban-aware task feed
   * Integrates into TaskDiscoveryService feed query
   */
  getFeedFilter: async (userId: string): Promise<ServiceResult<string>> => {
    try {
      const userResult = await db.query<{ shadow_score: number }>(
        `SELECT shadow_score FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'User not found' } };
      }

      const score = userResult.rows[0].shadow_score;

      let filterSQL = 'TRUE'; // full access by default

      if (score < 75 && score >= 50) {
        // LIMITED: cap price
        filterSQL = `t.price <= 5000`; // $50 max
      } else if (score < 50 && score >= 25) {
        // DEGRADED: low price + match with similar users
        filterSQL = `t.price <= 2500 AND t.mode = 'STANDARD'`;
      } else if (score < 25) {
        // INVISIBLE: misc only
        filterSQL = `t.category = 'misc' AND t.price <= 1500 AND t.mode = 'STANDARD'`;
      }

      return { success: true, data: filterSQL };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Daily time decay: slowly restore shadow scores
   * Called by cron job
   */
  applyDailyDecay: async (): Promise<ServiceResult<number>> => {
    try {
      const result = await db.query(
        `UPDATE users
         SET shadow_score = LEAST(shadow_score + 0.5, 100),
             shadow_score_updated_at = NOW()
         WHERE shadow_score < 100`
      );

      return { success: true, data: result.rowCount || 0 };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  // --------------------------------------------------------------------------
  // PRIVATE
  // --------------------------------------------------------------------------

  _adjustScore: async (
    userId: string,
    delta: number,
    reason: string,
    source: string
  ): Promise<ServiceResult<number>> => {
    try {
      // Get current score
      const current = await db.query<{ shadow_score: number }>(
        `SELECT shadow_score FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );

      if (current.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'User not found' } };
      }

      const scoreBefore = current.rows[0].shadow_score;
      const scoreAfter = Math.max(0, Math.min(100, scoreBefore + delta));

      // Update user score
      await db.query(
        `UPDATE users
         SET shadow_score = $1, shadow_score_updated_at = NOW()
         WHERE id = $2`,
        [scoreAfter, userId]
      );

      // Log event
      await db.query(
        `INSERT INTO shadow_score_events (user_id, delta, reason, source, score_before, score_after)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, delta, reason, source, scoreBefore, scoreAfter]
      );

      return { success: true, data: scoreAfter };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },
};

export default ShadowBanService;
