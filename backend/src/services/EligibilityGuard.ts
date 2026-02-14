/**
 * Eligibility Guard — v1 (CRITICAL)
 * 
 * Pre-Alpha Prerequisite: Centralized eligibility enforcement.
 * 
 * Rules:
 * - No code path accepts without assertEligibility
 * - Trust tiers change only via service
 * - Risk classification cannot be altered
 * - Tier 3 tasks never enter matching
 * - Logs reconstruct why access was allowed or denied
 */

import { db } from '../db';
import { TrustTier, TrustTierService } from './TrustTierService';
import { TaskRisk } from './TaskRiskClassifier';

// ============================================================================
// TYPES
// ============================================================================

export interface EligibilityContext {
  userId: string;
  taskId: string;
  isInstant: boolean;
}

export type EligibilityResult =
  | { allowed: true }
  | { allowed: false; code: EligibilityErrorCode; details?: any };

export enum EligibilityErrorCode {
  TRUST_TIER_INSUFFICIENT = 'TRUST_TIER_INSUFFICIENT',
  TASK_RISK_BLOCKED_ALPHA = 'TASK_RISK_BLOCKED_ALPHA',
  USER_BANNED = 'USER_BANNED',
  INSTANT_NOT_ELIGIBLE = 'INSTANT_NOT_ELIGIBLE',
}

// ============================================================================
// RISK → TRUST TIER MAPPING (Authoritative)
// ============================================================================

const REQUIRED_TIER_BY_RISK: Record<TaskRisk, TrustTier | 'BLOCKED_IN_ALPHA'> = {
  [TaskRisk.TIER_0]: TrustTier.VERIFIED,
  [TaskRisk.TIER_1]: TrustTier.VERIFIED,
  [TaskRisk.TIER_2]: TrustTier.TRUSTED,
  [TaskRisk.TIER_3]: 'BLOCKED_IN_ALPHA',
};

// ============================================================================
// ELIGIBILITY GUARD
// ============================================================================

export const EligibilityGuard = {
  /**
   * Assert eligibility (centralized guard)
   * 
   * Called by:
   * - task acceptance
   * - instant matching
   * - surge expansion
   */
  assertEligibility: async (ctx: EligibilityContext): Promise<EligibilityResult> => {
    const { userId, taskId, isInstant } = ctx;

    // Get user trust tier
    let userTier: TrustTier;
    try {
      userTier = await TrustTierService.getTrustTier(userId);
    } catch (error) {
      return {
        allowed: false,
        code: EligibilityErrorCode.USER_BANNED,
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }

    // Check if user is banned
    if (userTier === TrustTier.BANNED) {
      console.log(`🚫 Eligibility denied: User ${userId} is banned`, {
        userId,
        taskId,
        isInstant,
      });
      return {
        allowed: false,
        code: EligibilityErrorCode.USER_BANNED,
        details: { reason: 'User is permanently banned' },
      };
    }

    // Get task risk tier
    const taskResult = await db.query<{
      risk_level: string;
      instant_mode: boolean;
      sensitive: boolean | null;
    }>(
      `SELECT risk_level, instant_mode, sensitive FROM tasks WHERE id = $1`,
      [taskId]
    );

    if (taskResult.rowCount === 0) {
      return {
        allowed: false,
        code: EligibilityErrorCode.TASK_RISK_BLOCKED_ALPHA,
        details: { error: 'Task not found' },
      };
    }

    const task = taskResult.rows[0];

    // Map legacy risk_level to TaskRisk enum
    let taskRisk: TaskRisk;
    switch (task.risk_level) {
      case 'LOW':
        taskRisk = TaskRisk.TIER_0; // Conservative: LOW → TIER_0
        break;
      case 'MEDIUM':
        taskRisk = TaskRisk.TIER_1;
        break;
      case 'HIGH':
        taskRisk = TaskRisk.TIER_2;
        break;
      case 'IN_HOME':
        taskRisk = TaskRisk.TIER_3;
        break;
      default:
        taskRisk = TaskRisk.TIER_0; // Default to safest
    }

    // Check if task risk is blocked in alpha
    const requiredTier = REQUIRED_TIER_BY_RISK[taskRisk];
    if (requiredTier === 'BLOCKED_IN_ALPHA') {
      console.log(`🚫 Eligibility denied: Task ${taskId} is Tier 3 (blocked in alpha)`, {
        userId,
        taskId,
        taskRisk,
        isInstant,
      });
      return {
        allowed: false,
        code: EligibilityErrorCode.TASK_RISK_BLOCKED_ALPHA,
        details: { reason: 'Tier 3 tasks are blocked in alpha' },
      };
    }

    // Check trust tier requirement
    if (userTier < requiredTier) {
      console.log(`🚫 Eligibility denied: User ${userId} tier ${userTier} < required ${requiredTier}`, {
        userId,
        taskId,
        userTier,
        requiredTier,
        taskRisk,
        isInstant,
      });
      return {
        allowed: false,
        code: EligibilityErrorCode.TRUST_TIER_INSUFFICIENT,
        details: {
          userTier,
          requiredTier,
          taskRisk,
          reason: `Task requires trust tier ${requiredTier}, user has ${userTier}`,
        },
      };
    }

    // Instant Mode inherits all risk gates (already checked above)
    // Additional Instant Mode checks are handled separately (trust tier for sensitive, etc.)
    // This guard only enforces risk-based eligibility

    // All checks passed
    console.log(`✅ Eligibility granted: User ${userId} can access task ${taskId}`, {
      userId,
      taskId,
      userTier,
      requiredTier,
      taskRisk,
      isInstant,
    });

    return { allowed: true };
  },
};
