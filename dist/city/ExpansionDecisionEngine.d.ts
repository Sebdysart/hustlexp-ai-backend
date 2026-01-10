/**
 * EXPANSION DECISION ENGINE (Phase 16 - Component 5)
 *
 * Purpose: Determine where to push, hold, or retreat.
 *
 * Answers:
 * - Where to push marketing
 * - Where NOT to expand
 * - Where to slow growth
 *
 * CONSTRAINTS:
 * - READ-ONLY: Intelligence only
 * - NO AUTOMATION: Human operators decide
 * - NO KERNEL: Financial layer frozen
 */
export type ExpansionAction = 'expand' | 'hold' | 'retreat' | 'fortify';
export interface ZoneExpansionDecision {
    zone: string;
    action: ExpansionAction;
    confidence: number;
    reasoning: {
        primaryFactor: string;
        supportingFactors: string[];
        risks: string[];
        opportunities: string[];
    };
    signals: {
        defensibility: number;
        liquidityHeat: number;
        supplyDemandRatio: number;
        churnRisk: number;
        competitionLevel: 'low' | 'medium' | 'high';
    };
    recommendedActions: string[];
    budgetRecommendation: 'increase' | 'maintain' | 'reduce' | 'pause';
}
export interface CityExpansionPlan {
    id: string;
    city: string;
    generatedAt: Date;
    decisions: ZoneExpansionDecision[];
    strategy: {
        phase: 'launch' | 'growth' | 'consolidation' | 'defense';
        primaryFocus: string;
        weeklyBudgetAllocation: Record<string, number>;
    };
    summary: {
        expandZones: string[];
        holdZones: string[];
        retreatZones: string[];
        fortifyZones: string[];
    };
    metrics: {
        totalZones: number;
        avgDefensibility: number;
        avgLiquidity: number;
        projectedGrowth: string;
    };
}
export declare class ExpansionDecisionEngine {
    /**
     * GET EXPANSION PLAN FOR CITY
     */
    static getExpansionPlan(city: string): Promise<CityExpansionPlan>;
    /**
     * GET ZONE DECISION DETAIL
     */
    static getZoneDecision(zone: string): Promise<ZoneExpansionDecision>;
    /**
     * GET PRIORITY ACTIONS
     */
    static getPriorityActions(city: string): Promise<{
        immediate: {
            zone: string;
            action: string;
            reason: string;
        }[];
        thisWeek: {
            zone: string;
            action: string;
            reason: string;
        }[];
        monitor: {
            zone: string;
            action: string;
            reason: string;
        }[];
    }>;
    private static generateZoneDecision;
    private static decideAction;
    private static getRecommendedActions;
    private static getBudgetRecommendation;
    private static determineStrategy;
    private static projectGrowth;
    private static persistPlan;
}
//# sourceMappingURL=ExpansionDecisionEngine.d.ts.map