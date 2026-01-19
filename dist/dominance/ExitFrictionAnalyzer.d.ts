/**
 * EXIT FRICTION ANALYZER (Phase 17 - Component 4)
 *
 * Purpose: Quantify NATURAL exit costs (non-coercive).
 *
 * This engine NEVER blocks exits.
 * It only quantifies what users would organically give up:
 * - Lost income velocity
 * - Lost reputation momentum
 * - Increased task acquisition time elsewhere
 *
 * CONSTRAINTS:
 * - NEVER blocks exits
 * - READ-ONLY: Analysis only
 * - NO COERCION: Information, not barriers
 * - NO KERNEL: Financial layer frozen
 */
export interface ExitFrictionAnalysis {
    id: string;
    zone: string;
    generatedAt: Date;
    avgExitCostIndex: number;
    primaryLossFactor: string;
    components: {
        incomeVelocityLoss: number;
        reputationMomentumLoss: number;
        acquisitionTimeIncrease: number;
        networkEffectLoss: number;
    };
    exitRiskDistribution: {
        highStickiness: number;
        moderate: number;
        atRisk: number;
    };
    implications: {
        retention: string;
        vulnerability: string;
        recommendation: string;
    };
}
export interface UserExitCostProfile {
    userId: string;
    exitCostIndex: number;
    classification: 'low' | 'moderate' | 'high' | 'prohibitive';
    losses: {
        weeklyIncomeReduction: number;
        reputationPercentileDrop: number;
        taskAcquisitionSlowdown: string;
        chainedWorkLoss: string;
    };
    primaryBindingFactor: string;
    secondaryFactors: string[];
    rebuildEstimate: {
        incomeRecovery: string;
        reputationRecovery: string;
        networkRecovery: string;
    };
    disclaimer: string;
}
export declare class ExitFrictionAnalyzer {
    /**
     * ANALYZE ZONE EXIT FRICTION
     */
    static analyzeZone(zone: string): Promise<ExitFrictionAnalysis>;
    /**
     * ANALYZE USER EXIT COST
     */
    static analyzeUserExitCost(userId: string): Promise<UserExitCostProfile>;
    /**
     * GET ZONE RETENTION LEVERAGE
     */
    static getRetentionLeverage(zone: string): Promise<{
        highValueAtRisk: number;
        retentionOpportunities: string[];
        vulnerabilities: string[];
    }>;
    private static calculateIncomeVelocityLoss;
    private static calculateAcquisitionTimeIncrease;
    private static calculateNetworkEffectLoss;
    private static identifyPrimaryLoss;
    private static getExitRiskDistribution;
    private static deriveImplications;
    private static classifyExitCost;
    private static getUserIncomeData;
    private static identifyBindingFactors;
    private static persistAnalysis;
}
//# sourceMappingURL=ExitFrictionAnalyzer.d.ts.map