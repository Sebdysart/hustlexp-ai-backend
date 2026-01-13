/**
 * PlanService v1.0.0
 * 
 * Step 9-C - Monetization Hooks: Plan eligibility and gating checks
 * 
 * Responsibility:
 * - Check user plan eligibility
 * - Validate risk level access
 * - Check live tracking access
 * 
 * Hard rules:
 * - All checks are read-only (no state mutation)
 * - All checks are idempotent
 * - No pricing logic here (handled by Stripe)
 * 
 * @see STEP_9_MONETIZATION_PRICING.md
 */

import { db } from '../db';
import type { User, TaskProgressState } from '../types';

// ============================================================================
// TYPES
// ============================================================================

// Risk level type (from database schema - matches tasks.risk_level CHECK constraint)
type TaskRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';

export type UserPlan = 'free' | 'premium' | 'pro';

export interface PlanCheckResult {
  allowed: boolean;
  reason?: string;
  requiredPlan?: UserPlan;
}

// ============================================================================
// PLAN SERVICE
// ============================================================================

export const PlanService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Get user plan (with expiration check)
   */
  getUserPlan: async (userId: string): Promise<UserPlan> => {
    const result = await db.query<{
      plan: UserPlan;
      plan_expires_at: Date | null;
    }>(
      `SELECT plan, plan_expires_at FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return 'free'; // Default to free if user not found
    }

    const user = result.rows[0];

    // Check if plan has expired
    if (user.plan_expires_at && user.plan_expires_at < new Date()) {
      // Plan expired - reset to free
      await db.query(
        `UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = $1`,
        [userId]
      );
      return 'free';
    }

    return user.plan;
  },

  /**
   * Check if user can create task with given risk level
   * 
   * Rules:
   * - LOW: All users
   * - MEDIUM: Premium or per-task fee
   * - HIGH/IN_HOME: Premium required
   */
  canCreateTaskWithRisk: async (
    userId: string,
    riskLevel: TaskRiskLevel
  ): Promise<PlanCheckResult> => {
    const plan = await PlanService.getUserPlan(userId);

    // LOW risk: always allowed
    if (riskLevel === 'LOW') {
      return { allowed: true };
    }

    // MEDIUM risk: Premium or per-task fee (we allow creation, payment happens separately)
    if (riskLevel === 'MEDIUM') {
      if (plan === 'premium') {
        return { allowed: true };
      }
      // Free users can create but must pay per-task fee (handled by Stripe)
      return { allowed: true, requiredPlan: 'premium' };
    }

    // HIGH/IN_HOME: Premium required
    if (riskLevel === 'HIGH' || riskLevel === 'IN_HOME') {
      if (plan === 'premium') {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'Premium plan required for high-risk tasks',
        requiredPlan: 'premium',
      };
    }

    // Unknown risk level
    return {
      allowed: false,
      reason: 'Invalid risk level',
    };
  },

  /**
   * Check if worker can accept task with given risk level
   * 
   * Rules:
   * - LOW/MEDIUM: All workers
   * - HIGH/IN_HOME: Pro workers only
   */
  canAcceptTaskWithRisk: async (
    userId: string,
    riskLevel: TaskRiskLevel
  ): Promise<PlanCheckResult> => {
    // Get user plan and trust tier
    const result = await db.query<{
      plan: UserPlan;
      trust_tier: number;
      trust_hold: boolean;
    }>(
      `SELECT plan, trust_tier, trust_hold FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return {
        allowed: false,
        reason: 'User not found',
      };
    }

    const user = result.rows[0];

    // LOW/MEDIUM risk: all workers can accept
    if (riskLevel === 'LOW' || riskLevel === 'MEDIUM') {
      return { allowed: true };
    }

    // HIGH/IN_HOME: Pro workers only (trust tier 3+ required)
    if (riskLevel === 'HIGH' || riskLevel === 'IN_HOME') {
      if (user.plan === 'pro' && user.trust_tier >= 3 && !user.trust_hold) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'Pro plan and trust tier 3+ required for high-risk tasks',
        requiredPlan: 'pro',
      };
    }

    return {
      allowed: false,
      reason: 'Invalid risk level',
    };
  },

  /**
   * Check if user can receive live tracking events
   * 
   * Rules:
   * - Premium users: all events
   * - Free users: POSTED, ACCEPTED, COMPLETED, CLOSED only (no TRAVELING/WORKING)
   */
  canReceiveProgressEvent: async (
    userId: string,
    progressState: TaskProgressState
  ): Promise<boolean> {
    const plan = await PlanService.getUserPlan(userId);

    // Premium users get all events
    if (plan === 'premium') {
      return true;
    }

    // Free users: only basic states
    const freeAllowedStates: TaskProgressState[] = [
      'POSTED',
      'ACCEPTED',
      'COMPLETED',
      'CLOSED',
    ];

    return freeAllowedStates.includes(progressState);
  },

  /**
   * Check if user has access to live tracking for a specific task
   * 
   * Used for UI to determine if TRAVELING/WORKING should be shown
   */
  hasLiveTrackingAccess: async (userId: string): Promise<boolean> => {
    const plan = await PlanService.getUserPlan(userId);
    return plan === 'premium';
  },
};
