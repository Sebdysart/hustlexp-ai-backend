/**
 * TRUST TIER SERVICE (BUILD_GUIDE Aligned)
 *
 * Implements the 4-tier trust system from BUILD_GUIDE:
 * - Tier 1: Verified (default)
 * - Tier 2: Trusted (5+ tasks, no disputes)
 * - Tier 3: Proven (25+ tasks, <2% dispute rate)
 * - Tier 4: Elite (100+ tasks, <1% dispute rate, 4.8+ rating)
 *
 * INVARIANTS ENFORCED:
 * - INV-TRUST-1: No upgrade if SLA breached
 * - INV-TRUST-3: All changes logged to trust_ledger
 * - INV-TRUST-5: Trust can decrease (downgrades allowed)
 * - INV-TRUST-6: Downgrades have 30-day cooldown
 * - INV-TRUST-7: Trust floor is Tier 1
 *
 * CONSTITUTIONAL: This code enforces law. Do not modify without review.
 */
import { getSql, transaction } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
const logger = createLogger('TrustTierService');
// ============================================================================
// TIER DEFINITIONS (FROM BUILD_GUIDE)
// ============================================================================
export const TRUST_TIERS = {
    VERIFIED: 1, // Default tier
    TRUSTED: 2, // 5+ completed tasks, no disputes
    PROVEN: 3, // 25+ completed tasks, <2% dispute rate
    ELITE: 4, // 100+ completed tasks, <1% dispute rate, 4.8+ avg rating
};
export const TIER_NAMES = {
    1: 'Verified',
    2: 'Trusted',
    3: 'Proven',
    4: 'Elite',
};
export const TIER_TAKE_RATES = {
    1: 0.20, // 20%
    2: 0.15, // 15%
    3: 0.12, // 12%
    4: 0.10, // 10%
};
const TIER_REQUIREMENTS = {
    1: { minCompletedTasks: 0, maxDisputeRate: 1.0, minAvgRating: null },
    2: { minCompletedTasks: 5, maxDisputeRate: 0.0, minAvgRating: null },
    3: { minCompletedTasks: 25, maxDisputeRate: 0.02, minAvgRating: null },
    4: { minCompletedTasks: 100, maxDisputeRate: 0.01, minAvgRating: 4.8 },
};
// ============================================================================
// DOWNGRADE RULES (FROM BUILD_GUIDE)
// ============================================================================
const DOWNGRADE_COOLDOWN_DAYS = 30;
const DOWNGRADE_SEVERITY_MAP = {
    DISPUTE_LOST: 1, // Drop 1 tier
    NO_SHOW: 1, // Drop 1 tier
    SLA_BREACH: 1, // Drop 1 tier
    FRAUD: 3, // Drop to Tier 1
    ADMIN: 0, // Custom (admin decides)
};
// ============================================================================
// TRUST TIER SERVICE CLASS
// ============================================================================
class TrustTierServiceClass {
    /**
     * Get user's current trust stats
     */
    async getUserTrustStats(userId) {
        const sql = getSql();
        // Get user's current tier
        const [user] = await sql `
      SELECT id, trust_tier FROM users WHERE id = ${userId}
    `;
        if (!user) {
            throw new Error(`User not found: ${userId}`);
        }
        const currentTier = (user.trust_tier || 1);
        // Count completed tasks (as hustler)
        const [taskStats] = await sql `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'completed' AND assigned_to = ${userId})::int as completed,
        COUNT(*) FILTER (WHERE status LIKE 'disputed%' AND assigned_to = ${userId})::int as disputes
      FROM tasks
    `;
        const completedTasks = taskStats?.completed || 0;
        const totalDisputes = taskStats?.disputes || 0;
        // Count disputes lost (where hustler was at fault)
        const [disputeStats] = await sql `
      SELECT COUNT(*)::int as lost
      FROM disputes d
      JOIN tasks t ON t.id = d.task_id
      WHERE t.assigned_to = ${userId}
        AND d.resolution = 'refunded'
    `;
        const disputesLost = disputeStats?.lost || 0;
        // Calculate dispute rate
        const disputeRate = completedTasks > 0
            ? totalDisputes / completedTasks
            : 0;
        // Get average rating (from task ratings if they exist)
        // Note: Rating system may not be implemented yet
        const avgRating = null; // TODO: Implement when rating table exists
        // Get last downgrade date
        const [lastDowngrade] = await sql `
      SELECT created_at FROM trust_ledger
      WHERE user_id = ${userId} AND new_tier < old_tier
      ORDER BY created_at DESC
      LIMIT 1
    `;
        const lastDowngradeAt = lastDowngrade?.created_at
            ? new Date(lastDowngrade.created_at)
            : null;
        // Check if user can upgrade (no downgrade in last 30 days)
        const canUpgrade = !lastDowngradeAt ||
            (Date.now() - lastDowngradeAt.getTime()) > (DOWNGRADE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
        // Calculate eligible tier
        const eligibleTier = this.calculateEligibleTier(completedTasks, disputeRate, avgRating);
        return {
            userId,
            currentTier,
            completedTasks,
            totalDisputes,
            disputesLost,
            disputeRate,
            avgRating,
            lastDowngradeAt,
            canUpgrade,
            eligibleTier,
        };
    }
    /**
     * Calculate what tier a user is eligible for based on stats
     */
    calculateEligibleTier(completedTasks, disputeRate, avgRating) {
        // Check from highest tier down
        for (const tier of [4, 3, 2, 1]) {
            const req = TIER_REQUIREMENTS[tier];
            if (completedTasks < req.minCompletedTasks)
                continue;
            if (disputeRate > req.maxDisputeRate)
                continue;
            if (req.minAvgRating !== null && (avgRating === null || avgRating < req.minAvgRating))
                continue;
            return tier;
        }
        return TRUST_TIERS.VERIFIED;
    }
    /**
     * Attempt to upgrade user's trust tier
     * Returns true if upgrade happened, false if not eligible
     */
    async tryUpgrade(userId) {
        const stats = await this.getUserTrustStats(userId);
        // INV-TRUST-6: Check cooldown
        if (!stats.canUpgrade) {
            return {
                upgraded: false,
                oldTier: stats.currentTier,
                newTier: stats.currentTier,
                reason: 'Upgrade cooldown active (recent downgrade)',
            };
        }
        // Check if eligible for higher tier
        if (stats.eligibleTier <= stats.currentTier) {
            return {
                upgraded: false,
                oldTier: stats.currentTier,
                newTier: stats.currentTier,
                reason: `Already at or above eligible tier (${TIER_NAMES[stats.eligibleTier]})`,
            };
        }
        // Upgrade by 1 tier at a time (no jumping)
        const newTier = Math.min(stats.currentTier + 1, stats.eligibleTier);
        await this.setTier(userId, newTier, stats.currentTier, {
            triggeredBy: 'system',
            reason: `Auto-upgrade: ${stats.completedTasks} tasks, ${(stats.disputeRate * 100).toFixed(1)}% dispute rate`,
        });
        logger.info({
            userId,
            oldTier: stats.currentTier,
            newTier,
            completedTasks: stats.completedTasks,
            disputeRate: stats.disputeRate,
        }, 'Trust tier upgraded');
        return {
            upgraded: true,
            oldTier: stats.currentTier,
            newTier,
            reason: `Upgraded to ${TIER_NAMES[newTier]}`,
        };
    }
    /**
     * Downgrade user's trust tier
     * INV-TRUST-5: Trust can decrease
     * INV-TRUST-7: Floor is Tier 1
     */
    async downgrade(userId, reason, taskId, adminId) {
        const sql = getSql();
        const [user] = await sql `
      SELECT trust_tier FROM users WHERE id = ${userId}
    `;
        if (!user) {
            throw new Error(`User not found: ${userId}`);
        }
        const oldTier = (user.trust_tier || 1);
        // Calculate tier drop
        let tierDrop = DOWNGRADE_SEVERITY_MAP[reason.code];
        if (reason.code === 'ADMIN' && reason.severity) {
            tierDrop = reason.severity;
        }
        // INV-TRUST-7: Floor is Tier 1
        const newTier = Math.max(1, oldTier - tierDrop);
        if (newTier === oldTier) {
            return { downgraded: false, oldTier, newTier };
        }
        const triggeredBy = adminId ? `admin:${adminId}` : 'system';
        await this.setTier(userId, newTier, oldTier, {
            triggeredBy,
            reason: `${reason.code}: ${reason.description}`,
            taskId,
        });
        logger.warn({
            userId,
            oldTier,
            newTier,
            reasonCode: reason.code,
            taskId,
            adminId,
        }, 'Trust tier downgraded');
        return { downgraded: true, oldTier, newTier };
    }
    /**
     * Set user's trust tier with audit logging
     * INV-TRUST-3: All changes logged to trust_ledger
     */
    async setTier(userId, newTier, oldTier, context) {
        await transaction(async (tx) => {
            // Update user
            await tx `
        UPDATE users 
        SET trust_tier = ${newTier}, updated_at = NOW()
        WHERE id = ${userId}
      `;
            // INV-TRUST-3: Log to trust_ledger (append-only)
            await tx `
        INSERT INTO trust_ledger (user_id, old_tier, new_tier, reason, triggered_by, task_id)
        VALUES (${userId}, ${oldTier}, ${newTier}, ${context.reason}, ${context.triggeredBy}, ${context.taskId || null})
      `;
        });
    }
    /**
     * Get user's trust tier
     */
    async getTier(userId) {
        const sql = getSql();
        const [user] = await sql `
      SELECT trust_tier FROM users WHERE id = ${userId}
    `;
        return (user?.trust_tier || 1);
    }
    /**
     * Get take rate for user's tier
     */
    async getTakeRate(userId) {
        const tier = await this.getTier(userId);
        return TIER_TAKE_RATES[tier];
    }
    /**
     * Get trust tier history for user
     */
    async getTierHistory(userId, limit = 20) {
        const sql = getSql();
        const rows = await sql `
      SELECT old_tier, new_tier, reason, triggered_by, task_id, created_at
      FROM trust_ledger
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
        return rows.map((row) => ({
            oldTier: row.old_tier,
            newTier: row.new_tier,
            reason: row.reason,
            triggeredBy: row.triggered_by,
            taskId: row.task_id,
            createdAt: new Date(row.created_at),
        }));
    }
    /**
     * Check and apply upgrades after task completion
     * Called after successful payout
     */
    async checkUpgradeAfterCompletion(userId) {
        try {
            const result = await this.tryUpgrade(userId);
            if (result.upgraded) {
                logger.info({
                    userId,
                    oldTier: result.oldTier,
                    newTier: result.newTier,
                }, 'User upgraded after task completion');
            }
        }
        catch (error) {
            logger.error({ error, userId }, 'Failed to check trust upgrade');
            // Don't throw - upgrade check failure shouldn't break the flow
        }
    }
    /**
     * Check and apply trust downgrade (BUILD_GUIDE FIX 3)
     * @param userId - User to check
     * @param trigger - Downgrade trigger ('dispute_lost' | 'no_show' | 'sla_breach_pattern')
     */
    async checkDowngrade(userId, trigger) {
        const sql = getSql();
        try {
            const currentTier = await this.getTier(userId);
            // Tier 1 is the floor - can't go lower
            if (currentTier === 1) {
                return { downgraded: false };
            }
            // Determine new tier based on trigger
            let newTier;
            let cooldownDays;
            switch (trigger) {
                case 'dispute_lost':
                    // Drop one tier, 30 day cooldown
                    newTier = Math.max(1, currentTier - 1);
                    cooldownDays = 30;
                    break;
                case 'no_show':
                    // Drop to tier 1, 7 day cooldown
                    newTier = 1;
                    cooldownDays = 7;
                    break;
                case 'sla_breach_pattern':
                    // Drop one tier, 14 day cooldown
                    newTier = Math.max(1, currentTier - 1);
                    cooldownDays = 14;
                    break;
                default:
                    return { downgraded: false };
            }
            // Check cooldown - can't downgrade same user twice rapidly
            const [recentDowngrade] = await sql `
        SELECT id FROM trust_ledger
        WHERE user_id = ${userId}
          AND new_tier < old_tier
          AND created_at > NOW() - INTERVAL '${cooldownDays} days'
        LIMIT 1
      `;
            if (recentDowngrade) {
                logger.info({ userId, trigger }, 'User in cooldown, skipping downgrade');
                return { downgraded: false };
            }
            // Execute downgrade
            await this.updateTier(userId, newTier, currentTier, {
                triggeredBy: 'system',
                reason: `Downgrade: ${trigger}`,
            });
            logger.warn({
                userId,
                oldTier: currentTier,
                newTier,
                trigger,
            }, 'User trust tier downgraded');
            return {
                downgraded: true,
                oldTier: currentTier,
                newTier,
            };
        }
        catch (error) {
            logger.error({ error, userId, trigger }, 'Failed to check trust downgrade');
            return { downgraded: false };
        }
    }
    /**
     * Check for trust recovery after good behavior
     * Called periodically for users who were downgraded
     */
    async checkRecovery(userId) {
        const sql = getSql();
        try {
            // Find most recent downgrade
            const [lastDowngrade] = await sql `
        SELECT old_tier, new_tier, reason, created_at
        FROM trust_ledger
        WHERE user_id = ${userId}
          AND new_tier < old_tier
        ORDER BY created_at DESC
        LIMIT 1
      `;
            if (!lastDowngrade) {
                return { recovered: false };
            }
            // Parse trigger from reason
            const trigger = lastDowngrade.reason.replace('Downgrade: ', '');
            // Check if auto-recovery is allowed
            if (trigger === 'no_show') {
                // No auto-recovery for no-shows
                return { recovered: false };
            }
            // Check cooldown passed (minimum 14 days for any recovery)
            const cooldownMs = 14 * 24 * 60 * 60 * 1000;
            const cooldownEnd = new Date(lastDowngrade.created_at.getTime() + cooldownMs);
            if (new Date() < cooldownEnd) {
                return { recovered: false };
            }
            // Check good behavior since downgrade
            const [taskStats] = await sql `
        SELECT 
          COUNT(*) FILTER (WHERE status = 'completed')::int as completed,
          COUNT(*) FILTER (WHERE status LIKE 'disputed%')::int as disputed
        FROM tasks
        WHERE assigned_to = ${userId}
          AND created_at > ${lastDowngrade.created_at}
      `;
            // Recovery criteria: 5+ tasks, 0 disputes since downgrade
            if (taskStats.completed >= 5 && taskStats.disputed === 0) {
                const currentTier = await this.getTier(userId);
                const recoveryTier = Math.min(4, lastDowngrade.old_tier);
                await this.updateTier(userId, recoveryTier, currentTier, {
                    triggeredBy: 'system',
                    reason: 'Auto-recovery after good behavior',
                });
                logger.info({
                    userId,
                    oldTier: currentTier,
                    newTier: recoveryTier,
                }, 'User trust tier recovered');
                return {
                    recovered: true,
                    newTier: recoveryTier,
                };
            }
            return { recovered: false };
        }
        catch (error) {
            logger.error({ error, userId }, 'Failed to check trust recovery');
            return { recovered: false };
        }
    }
}
export const TrustTierService = new TrustTierServiceClass();
//# sourceMappingURL=TrustTierService.js.map