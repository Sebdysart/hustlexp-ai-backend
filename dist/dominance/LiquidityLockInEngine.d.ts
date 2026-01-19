/**
 * LIQUIDITY LOCK-IN ENGINE (Phase 17 - Component 1)
 *
 * Purpose: Quantify how "sticky" a zone becomes.
 *
 * Lock-in emerges organically when:
 * - Posters keep coming back
 * - Hustlers chain multiple tasks
 * - Fill times become unbeatable
 * - Cross-category engagement deepens
 * - Trust concentration builds
 *
 * CONSTRAINTS:
 * - READ-ONLY: Measurement only
 * - NO KERNEL: Financial layer frozen
 * - ADVISORY: Powers strategy, not execution
 */
export type LockInClass = 'loose' | 'forming' | 'sticky' | 'locked';
export interface LiquidityLockInSnapshot {
    id: string;
    zone: string;
    generatedAt: Date;
    repeatPosterRate: number;
    hustlerMultiTaskRate: number;
    timeToFillAdvantage: number;
    crossCategoryEngagement: number;
    trustTierConcentration: number;
    lockInScore: number;
    classification: LockInClass;
    velocity: number;
    trend: 'accelerating' | 'stable' | 'decelerating';
    drivers: {
        primary: string;
        supporting: string[];
        weaknesses: string[];
    };
    moatStrength: string;
}
export declare class LiquidityLockInEngine {
    /**
     * CALCULATE ZONE LOCK-IN
     */
    static calculateLockIn(zone: string): Promise<LiquidityLockInSnapshot>;
    /**
     * GET CITY LOCK-IN OVERVIEW
     */
    static getCityOverview(city: string): Promise<{
        avgLockIn: number;
        lockedZones: string[];
        formingZones: string[];
        looseZones: string[];
        totalVelocity: number;
    }>;
    /**
     * GET LOCK-IN RECOMMENDATIONS
     */
    static getRecommendations(zone: string): Promise<{
        zone: string;
        currentState: LockInClass;
        recommendations: string[];
        priorityAction: string;
        expectedImpact: string;
    }>;
    private static getZoneMetrics;
    private static calculateTimeAdvantage;
    private static classifyLockIn;
    private static identifyDrivers;
    private static assessMoatStrength;
    private static persistSnapshot;
}
//# sourceMappingURL=LiquidityLockInEngine.d.ts.map