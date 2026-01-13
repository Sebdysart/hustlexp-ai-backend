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
export declare const TRUST_TIERS: {
    readonly VERIFIED: 1;
    readonly TRUSTED: 2;
    readonly PROVEN: 3;
    readonly ELITE: 4;
};
export type TrustTier = typeof TRUST_TIERS[keyof typeof TRUST_TIERS];
export declare const TIER_NAMES: Record<TrustTier, string>;
export declare const TIER_TAKE_RATES: Record<TrustTier, number>;
export interface DowngradeReason {
    code: 'DISPUTE_LOST' | 'NO_SHOW' | 'SLA_BREACH' | 'FRAUD' | 'ADMIN';
    description: string;
    severity: 1 | 2 | 3;
}
interface UserTrustStats {
    userId: string;
    currentTier: TrustTier;
    completedTasks: number;
    totalDisputes: number;
    disputesLost: number;
    disputeRate: number;
    avgRating: number | null;
    lastDowngradeAt: Date | null;
    canUpgrade: boolean;
    eligibleTier: TrustTier;
}
declare class TrustTierServiceClass {
    /**
     * Get user's current trust stats
     */
    getUserTrustStats(userId: string): Promise<UserTrustStats>;
    /**
     * Calculate what tier a user is eligible for based on stats
     */
    private calculateEligibleTier;
    /**
     * Attempt to upgrade user's trust tier
     * Returns true if upgrade happened, false if not eligible
     */
    tryUpgrade(userId: string): Promise<{
        upgraded: boolean;
        oldTier: TrustTier;
        newTier: TrustTier;
        reason: string;
    }>;
    /**
     * Downgrade user's trust tier
     * INV-TRUST-5: Trust can decrease
     * INV-TRUST-7: Floor is Tier 1
     */
    downgrade(userId: string, reason: DowngradeReason, taskId?: string, adminId?: string): Promise<{
        downgraded: boolean;
        oldTier: TrustTier;
        newTier: TrustTier;
    }>;
    /**
     * Set user's trust tier with audit logging
     * INV-TRUST-3: All changes logged to trust_ledger
     */
    private setTier;
    /**
     * Get user's trust tier
     */
    getTier(userId: string): Promise<TrustTier>;
    /**
     * Get take rate for user's tier
     */
    getTakeRate(userId: string): Promise<number>;
    /**
     * Get trust tier history for user
     */
    getTierHistory(userId: string, limit?: number): Promise<Array<{
        oldTier: TrustTier;
        newTier: TrustTier;
        reason: string;
        triggeredBy: string;
        taskId: string | null;
        createdAt: Date;
    }>>;
    /**
     * Check and apply upgrades after task completion
     * Called after successful payout
     */
    checkUpgradeAfterCompletion(userId: string): Promise<void>;
    /**
     * Check and apply trust downgrade (BUILD_GUIDE FIX 3)
     * @param userId - User to check
     * @param trigger - Downgrade trigger ('dispute_lost' | 'no_show' | 'sla_breach_pattern')
     */
    checkDowngrade(userId: string, trigger: 'dispute_lost' | 'no_show' | 'sla_breach_pattern'): Promise<{
        downgraded: boolean;
        oldTier?: TrustTier;
        newTier?: TrustTier;
    }>;
    /**
     * Check for trust recovery after good behavior
     * Called periodically for users who were downgraded
     */
    checkRecovery(userId: string): Promise<{
        recovered: boolean;
        newTier?: TrustTier;
    }>;
}
export declare const TrustTierService: TrustTierServiceClass;
export {};
//# sourceMappingURL=TrustTierService.d.ts.map