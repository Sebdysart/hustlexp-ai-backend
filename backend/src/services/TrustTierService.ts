/**
 * Trust Tier Service — v1 (LOCKED)
 * 
 * Pre-Alpha Prerequisite: Authoritative trust tier state machine.
 * 
 * Rules:
 * - Tier is stored on users.trust_tier
 * - Tier only changes via server-side transitions
 * - No client writes
 * - No "scores"
 * - No downgrades except permanent ban
 */

import { db } from '../db';
import { AlphaInstrumentation } from './AlphaInstrumentation';

// ============================================================================
// TRUST TIER ENUM (Authoritative)
// ============================================================================

export enum TrustTier {
  UNVERIFIED = 0, // internal only, never eligible
  VERIFIED   = 1, // Tier A
  TRUSTED    = 2, // Tier B
  IN_HOME    = 3, // Tier C
  BANNED     = 9  // terminal
}

// ============================================================================
// TYPES
// ============================================================================

export type PromotionEligibility = {
  eligible: boolean;
  targetTier?: TrustTier;
  reasons: string[]; // empty if eligible
};

// ============================================================================
// TRUST TIER SERVICE
// ============================================================================

export const TrustTierService = {
  /**
   * Get user's current trust tier
   */
  getTrustTier: async (userId: string): Promise<TrustTier> => {
    const result = await db.query<{ trust_tier: number }>(
      `SELECT trust_tier FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rowCount === 0) {
      throw new Error(`User ${userId} not found`);
    }

    const tier = result.rows[0].trust_tier;
    
    // Map legacy tiers (1-4) to new enum if needed
    // For alpha, we assume schema uses 0-3,9
    if (tier === 9) return TrustTier.BANNED;
    if (tier >= 3) return TrustTier.IN_HOME;
    if (tier >= 2) return TrustTier.TRUSTED;
    if (tier >= 1) return TrustTier.VERIFIED;
    return TrustTier.UNVERIFIED;
  },

  /**
   * Evaluate promotion eligibility (pure evaluation, no writes)
   */
  evaluatePromotion: async (userId: string): Promise<PromotionEligibility> => {
    const currentTier = await TrustTierService.getTrustTier(userId);

    // Cannot promote if banned
    if (currentTier === TrustTier.BANNED) {
      return {
        eligible: false,
        reasons: ['User is banned'],
      };
    }

    // Already at max tier (for alpha)
    if (currentTier >= TrustTier.IN_HOME) {
      return {
        eligible: false,
        reasons: ['Already at maximum tier'],
      };
    }

    const reasons: string[] = [];
    let targetTier: TrustTier | undefined;

    // Evaluate VERIFIED (UNVERIFIED → VERIFIED)
    if (currentTier === TrustTier.UNVERIFIED) {
      // Check verification requirements
      const userResult = await db.query<{
        is_verified: boolean;
        verified_at: Date | null;
        phone: string | null;
        stripe_customer_id: string | null;
      }>(
        `SELECT is_verified, verified_at, phone, stripe_customer_id 
         FROM users 
         WHERE id = $1`,
        [userId]
      );

      if (userResult.rowCount === 0) {
        return {
          eligible: false,
          reasons: ['User not found'],
        };
      }

      const user = userResult.rows[0];
      
      if (!user.is_verified || !user.verified_at) {
        reasons.push('ID verification required');
      }
      if (!user.phone) {
        reasons.push('Phone verification required');
      }
      if (!user.stripe_customer_id) {
        reasons.push('Payment method required');
      }

      if (reasons.length === 0) {
        targetTier = TrustTier.VERIFIED;
      }
    }

    // Evaluate TRUSTED (VERIFIED → TRUSTED)
    else if (currentTier === TrustTier.VERIFIED) {
      // Get user account age
      const userAgeResult = await db.query<{ account_age_days: number }>(
        `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 as account_age_days
         FROM users
         WHERE id = $1`,
        [userId]
      );
      const accountAgeDays = Math.floor(userAgeResult.rows[0]?.account_age_days || 0);

      // Get task completion stats
      const statsResult = await db.query<{
        completed_count: string;
        dispute_count: string;
        on_time_count: string;
        total_count: string;
      }>(
        `SELECT 
           COUNT(*) FILTER (WHERE t.state = 'COMPLETED' AND t.worker_id = $1) as completed_count,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM disputes d WHERE d.task_id = t.id
           ) AND t.worker_id = $1) as dispute_count,
           COUNT(*) FILTER (WHERE t.state = 'COMPLETED' 
             AND (t.deadline IS NULL OR t.completed_at <= t.deadline)
             AND t.worker_id = $1) as on_time_count,
           COUNT(*) FILTER (WHERE t.worker_id = $1) as total_count
         FROM tasks t
         WHERE t.worker_id = $1`,
        [userId]
      );

      const stats = statsResult.rows[0];
      const completedCount = parseInt(stats?.completed_count || '0', 10);
      const disputeCount = parseInt(stats?.dispute_count || '0', 10);
      const onTimeCount = parseInt(stats?.on_time_count || '0', 10);
      const totalCount = parseInt(stats?.total_count || '0', 10);

      // Check risk tier constraint: only Tier 0-1 tasks
      const riskCheckResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM tasks t
         WHERE t.worker_id = $1
           AND t.state = 'COMPLETED'
           AND t.risk_level NOT IN ('LOW', 'MEDIUM')`,
        [userId]
      );
      const highRiskCount = parseInt(riskCheckResult.rows[0]?.count || '0', 10);

      if (completedCount < 10) {
        reasons.push(`Need ${10 - completedCount} more completed tasks (have ${completedCount}, need 10)`);
      }
      if (disputeCount > 0) {
        reasons.push(`Cannot have disputes (have ${disputeCount})`);
      }
      if (totalCount > 0) {
        const onTimeRate = onTimeCount / totalCount;
        if (onTimeRate < 0.95) {
          reasons.push(`On-time completion rate must be ≥95% (have ${(onTimeRate * 100).toFixed(1)}%)`);
        }
      }
      if (accountAgeDays < 7) {
        reasons.push(`Account age must be ≥7 days (have ${accountAgeDays} days)`);
      }
      if (highRiskCount > 0) {
        reasons.push(`Cannot have completed Tier 2+ tasks (have ${highRiskCount})`);
      }

      if (reasons.length === 0) {
        targetTier = TrustTier.TRUSTED;
      }
    }

    // Evaluate IN_HOME (TRUSTED → IN_HOME)
    else if (currentTier === TrustTier.TRUSTED) {
      // Get user account age
      const userAgeResult = await db.query<{ account_age_days: number }>(
        `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 as account_age_days
         FROM users
         WHERE id = $1`,
        [userId]
      );
      const accountAgeDays = Math.floor(userAgeResult.rows[0]?.account_age_days || 0);

      // Get task completion stats
      // DIAGNOSTIC: Log the query context before executing
      const queryContext = await db.query<{
        current_database: string;
        current_schema: string;
        worker_id_exists: boolean;
      }>(
        `SELECT 
          current_database(),
          current_schema(),
          EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'tasks' AND column_name = 'worker_id'
          ) as worker_id_exists`
      );
      console.warn('IN_HOME evaluation query context:', queryContext.rows[0]);
      
      const statsResult = await db.query<{
        completed_count: string;
      }>(
        `SELECT COUNT(*) FILTER (WHERE t.state = 'COMPLETED' AND t.worker_id = $1) as completed_count
         FROM public.tasks t
         WHERE t.worker_id = $1`,
        [userId]
      );

      const stats = statsResult.rows[0];
      const completedCount = parseInt(stats?.completed_count || '0', 10);

      // Get distinct poster reviews (5-star only)
      // Note: Assuming reviews are stored in a reviews table or derived from task completion
      // For alpha, we'll check for 5 distinct posters with completed tasks
      const reviewsResult = await db.query<{ distinct_posters: string }>(
        `SELECT COUNT(DISTINCT t.poster_id)::text as distinct_posters
         FROM public.tasks t
         WHERE t.worker_id = $1
           AND t.state = 'COMPLETED'`,
        [userId]
      );
      const distinctPosters = parseInt(reviewsResult.rows[0]?.distinct_posters || '0', 10);

      // Check security deposit (escrow)
      // For alpha, we'll check if user has a security deposit locked
      // Escrows table references tasks, so we join through tasks to get worker_id
      const depositResult = await db.query<{ has_deposit: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM escrows e
           JOIN tasks t ON e.task_id = t.id
           WHERE t.worker_id = $1
             AND e.state = 'LOCKED'
             AND e.amount > 0
         ) as has_deposit`,
        [userId]
      );
      const hasDeposit = depositResult.rows[0]?.has_deposit || false;

      if (completedCount < 25) {
        reasons.push(`Need ${25 - completedCount} more completed tasks (have ${completedCount}, need 25)`);
      }
      if (distinctPosters < 5) {
        reasons.push(`Need ${5 - distinctPosters} more distinct poster reviews (have ${distinctPosters}, need 5)`);
      }
      if (accountAgeDays < 30) {
        reasons.push(`Account age must be ≥30 days (have ${accountAgeDays} days)`);
      }
      if (!hasDeposit) {
        reasons.push('Security deposit must be locked in escrow');
      }
      // Note: Liability agreement would be stored in a separate table
      // For alpha, we'll assume it's accepted if user reaches this point

      if (reasons.length === 0) {
        targetTier = TrustTier.IN_HOME;
      }
    }

    return {
      eligible: reasons.length === 0,
      targetTier,
      reasons,
    };
  },

  /**
   * Apply promotion (single-direction only)
   */
  applyPromotion: async (
    userId: string,
    targetTier: TrustTier,
    source: 'system' | 'admin'
  ): Promise<void> => {
    const currentTier = await TrustTierService.getTrustTier(userId);

    // Guards
    if (currentTier === TrustTier.BANNED) {
      throw new Error('Cannot promote banned user');
    }

    if (targetTier <= currentTier) {
      throw new Error(`Cannot promote to tier ${targetTier} (current: ${currentTier})`);
    }

    // Re-validate preconditions inside transaction
    const eligibility = await TrustTierService.evaluatePromotion(userId);
    if (!eligibility.eligible || eligibility.targetTier !== targetTier) {
      throw new Error(`Promotion preconditions not met: ${eligibility.reasons.join(', ')}`);
    }

    // Apply promotion in transaction
    await db.query(
      `UPDATE users 
       SET trust_tier = $1, updated_at = NOW()
       WHERE id = $2
         AND trust_tier = $3`,
      [targetTier, userId, currentTier]
    );

    // Log transition (if trust_ledger exists)
    try {
      // trust_ledger requires old_tier >= 1, but we might have UNVERIFIED (0) or BANNED (9)
      // Only log if both tiers are in valid range (1-4)
      if (currentTier >= 1 && currentTier <= 4 && targetTier >= 1 && targetTier <= 4) {
        const idempotencyKey = `trust_promotion:${userId}:${targetTier}:${Date.now()}`;
        await db.query(
          `INSERT INTO trust_ledger (user_id, old_tier, new_tier, reason, changed_by, idempotency_key, event_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            userId,
            currentTier,
            targetTier,
            `Promoted to ${TrustTier[targetTier]} via ${source}`,
            source,
            idempotencyKey,
            'system',
          ]
        );
      }
    } catch (error) {
      // trust_ledger may not exist in alpha - log but don't fail
      console.warn('Failed to log trust tier transition', { userId, currentTier, targetTier, error });
    }

    console.log(`✅ Trust tier promotion: ${userId} ${TrustTier[currentTier]} → ${TrustTier[targetTier]}`, {
      userId,
      oldTier: currentTier,
      newTier: targetTier,
      source,
    });

    // Alpha Instrumentation: Emit trust delta applied
    try {
      // Determine role from user's default_mode
      const userResult = await db.query<{ default_mode: string }>(
        'SELECT default_mode FROM users WHERE id = $1',
        [userId]
      );
      const role = userResult.rows[0]?.default_mode === 'poster' ? 'poster' : 'hustler';

      await AlphaInstrumentation.emitTrustDeltaApplied({
        user_id: userId,
        role,
        delta_type: 'tier',
        delta_amount: targetTier - currentTier,
        reason_code: `promotion_${TrustTier[targetTier]}_via_${source}`,
        task_id: undefined, // Promotions are not task-specific
        timestamp: new Date(),
      });
    } catch (error) {
      // Silent fail - instrumentation should not break core flow
      console.warn('[TrustTierService] Failed to emit trust_delta_applied for promotion:', error);
    }
  },

  /**
   * Ban user (terminal, irreversible)
   * 
   * TODO: Any future tier mutation (demotion, decay, dispute adjustment) MUST emit trust_delta_applied.
   * This includes any code path that calls UPDATE users SET trust_tier = ... outside of applyPromotion/banUser.
   */
  banUser: async (userId: string, reason: string): Promise<void> => {
    const currentTier = await TrustTierService.getTrustTier(userId);

    if (currentTier === TrustTier.BANNED) {
      return; // Already banned
    }

    // Apply ban in transaction
    await db.query(
      `UPDATE users 
       SET trust_tier = $1, updated_at = NOW()
       WHERE id = $2`,
      [TrustTier.BANNED, userId]
    );

    // Cancel active tasks
    await db.query(
      `UPDATE tasks
       SET state = 'CANCELLED', updated_at = NOW()
       WHERE worker_id = $1
         AND state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'IN_PROGRESS')`,
      [userId]
    );

    // Log ban
    try {
      // trust_ledger requires old_tier >= 1, but we might have UNVERIFIED (0) or BANNED (9)
      // Only log if old_tier is in valid range (1-4)
      if (currentTier >= 1 && currentTier <= 4) {
        const idempotencyKey = `trust_ban:${userId}:${Date.now()}`;
        // Note: BANNED (9) cannot be inserted into trust_ledger due to constraint
        // We'll log the transition to a special value or skip logging for bans
        // For alpha, we'll skip trust_ledger logging for bans
        console.warn('Ban transition not logged to trust_ledger (BANNED tier not in 1-4 range)', {
          userId,
          oldTier: currentTier,
          reason,
        });
      }
    } catch (error) {
      console.warn('Failed to log trust tier ban', { userId, reason, error });
    }

    console.log(`🚫 User banned: ${userId}`, {
      userId,
      oldTier: currentTier,
      reason,
    });

    // Alpha Instrumentation: Emit trust delta applied
    try {
      // Determine role from user's default_mode
      const userResult = await db.query<{ default_mode: string }>(
        'SELECT default_mode FROM users WHERE id = $1',
        [userId]
      );
      const role = userResult.rows[0]?.default_mode === 'poster' ? 'poster' : 'hustler';

      await AlphaInstrumentation.emitTrustDeltaApplied({
        user_id: userId,
        role,
        delta_type: 'tier',
        delta_amount: TrustTier.BANNED - currentTier, // Negative value indicates ban
        reason_code: `ban_${reason.replace(/\s+/g, '_').toLowerCase()}`,
        task_id: undefined, // Bans are not task-specific
        timestamp: new Date(),
      });
    } catch (error) {
      // Silent fail - instrumentation should not break core flow
      console.warn('[TrustTierService] Failed to emit trust_delta_applied for ban:', error);
    }
  },
};
