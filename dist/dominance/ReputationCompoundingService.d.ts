/**
 * REPUTATION COMPOUNDING SERVICE (Phase 17 - Component 3)
 *
 * Purpose: Measure how trust accumulates faster on HustleXP.
 *
 * Trust compounds when:
 * - Proof acceptance builds track record
 * - Completion streaks create momentum
 * - Dispute-free sequences build confidence
 * - Zone-specific reputation weights apply
 *
 * This creates ORGANIC lock-in through reputation portability penalty.
 *
 * CONSTRAINTS:
 * - READ-ONLY: Measurement only
 * - NO COERCION: Users can always leave
 * - NO KERNEL: Financial layer frozen
 */
export interface ReputationCompoundingSnapshot {
    id: string;
    zone: string;
    generatedAt: Date;
    avgCompoundingRate: number;
    avgTrustVelocity: number;
    avgPortabilityPenalty: number;
    trustTierDistribution: {
        minimal: number;
        low: number;
        medium: number;
        high: number;
        elite: number;
    };
    factors: {
        proofAcceptanceContribution: number;
        streakContribution: number;
        disputeFreeContribution: number;
        zoneWeightContribution: number;
    };
    competitiveAdvantage: string;
    lockInImplication: string;
}
export interface UserReputationProfile {
    userId: string;
    currentTrust: {
        score: number;
        tier: string;
        percentile: number;
    };
    compounding: {
        rate: number;
        velocity: number;
        streakBonus: number;
        zoneBonus: number;
    };
    portabilityPenalty: {
        score: number;
        lostPercentile: number;
        rebuiltTimeEstimate: string;
        primaryLoss: string;
    };
    projection: {
        nextTierIn: string;
        trustIn30Days: number;
        earningsImpact: string;
    };
}
export declare class ReputationCompoundingService {
    /**
     * GET ZONE REPUTATION METRICS
     */
    static getZoneMetrics(zone: string): Promise<ReputationCompoundingSnapshot>;
    /**
     * GET USER REPUTATION PROFILE
     */
    static getUserProfile(userId: string): Promise<UserReputationProfile>;
    /**
     * GET COMPOUNDING LEADERS
     */
    static getCompoundingLeaders(zone: string): Promise<{
        topCompounders: {
            userId: string;
            rate: number;
            tier: string;
        }[];
        avgVsTop: string;
        whatTopDoDifferently: string[];
    }>;
    private static calculateAvgCompoundingRate;
    private static calculateTrustVelocity;
    private static calculatePortabilityPenalty;
    private static getTrustDistribution;
    private static getCompoundingFactors;
    private static getUserTrustScore;
    private static classifyTier;
    private static calculatePercentile;
    private static getUserCompoundingRate;
    private static calculateUserPortabilityPenalty;
    private static projectFuture;
    private static assessCompetitiveAdvantage;
    private static assessLockInImplication;
    private static persistSnapshot;
}
//# sourceMappingURL=ReputationCompoundingService.d.ts.map