/**
 * MARKET SIGNAL ENGINE (Phase 15A)
 *
 * Dominance Layer - READ-ONLY INTELLIGENCE
 *
 * Purpose: Answer questions competitors cannot answer.
 *
 * This service:
 * - Analyzes existing Control Plane data
 * - Produces market intelligence signals
 * - Powers strategic product decisions
 * - Identifies competitive advantages
 *
 * CONSTRAINTS:
 * - READ-ONLY: Never modifies any data
 * - NO KERNEL: Never touches money/ledger
 * - OBSERVATIONAL: Patterns, not commands
 */
export interface CategoryHealth {
    category: string;
    healthScore: number;
    status: 'thriving' | 'healthy' | 'stressed' | 'critical';
    signals: {
        taskVolume: number;
        completionRate: number;
        disputeRate: number;
        avgPayoutUsd: number;
        proofRejectionRate: number;
        avgRiskScore: number;
    };
    trends: {
        volumeTrend: 'growing' | 'stable' | 'declining';
        disputeTrend: 'improving' | 'stable' | 'worsening';
    };
    alerts: string[];
    opportunity: string | null;
}
export interface GeoHealth {
    zone: string;
    healthScore: number;
    signals: {
        taskDensity: number;
        hustlerDensity: number;
        supplyDemandRatio: number;
        avgCompletionTimeHours: number;
        disputeRate: number;
    };
    supplyStatus: 'oversupplied' | 'balanced' | 'undersupplied' | 'critical_shortage';
    expansion: {
        readinessScore: number;
        blockers: string[];
    };
}
export interface PricingPressure {
    category: string;
    zone?: string;
    signals: {
        avgPostedPrice: number;
        avgCompletedPrice: number;
        priceVariance: number;
        underpricedPct: number;
        overpricedPct: number;
    };
    marketRate: {
        min: number;
        median: number;
        max: number;
        suggested: number;
    };
    guidance: string;
}
export interface TrustDistribution {
    overall: {
        minimalRiskPct: number;
        lowRiskPct: number;
        mediumRiskPct: number;
        highRiskPct: number;
        criticalRiskPct: number;
    };
    byRole: {
        poster: {
            avgRiskScore: number;
            trustedPct: number;
        };
        hustler: {
            avgRiskScore: number;
            trustedPct: number;
        };
    };
    trustVelocity: 'improving' | 'stable' | 'degrading';
    implication: string;
}
export interface ChurnSignal {
    userId: string;
    role: 'poster' | 'hustler';
    riskLevel: 'low' | 'medium' | 'high';
    signals: {
        daysSinceLastActivity: number;
        recentDeclinePct: number;
        disputeFrequency: number;
        negativeExperiences: number;
    };
    predictedChurnDays: number;
    retentionAction: string | null;
}
export interface MarketSnapshot {
    id: string;
    generatedAt: Date;
    categories: CategoryHealth[];
    zones: GeoHealth[];
    pricing: PricingPressure[];
    trust: TrustDistribution;
    churnRisk: {
        high: number;
        medium: number;
        low: number;
    };
    competitivePosition: {
        strengths: string[];
        weaknesses: string[];
        opportunities: string[];
    };
}
export declare class MarketSignalEngine {
    /**
     * GENERATE FULL MARKET SNAPSHOT
     */
    static generateSnapshot(): Promise<MarketSnapshot>;
    /**
     * GET LATEST SNAPSHOT
     */
    static getLatest(): Promise<MarketSnapshot | null>;
    /**
     * GET CATEGORY HEALTH
     */
    static getCategoryHealth(category: string): Promise<CategoryHealth | null>;
    /**
     * GET ZONE HEALTH
     */
    static getZoneHealth(zone: string): Promise<GeoHealth | null>;
    /**
     * GET PRICING GUIDANCE
     */
    static getPricingGuidance(category: string, zone?: string): Promise<PricingPressure | null>;
    /**
     * DETECT HIGH CHURN RISK USERS
     */
    static detectChurnRisk(minDaysSinceActivity?: number): Promise<ChurnSignal[]>;
    /**
     * GET EXPANSION READINESS
     */
    static getExpansionReadiness(targetZones?: string[]): Promise<{
        zone: string;
        score: number;
        recommendation: 'expand' | 'hold' | 'not_ready';
        factors: string[];
    }[]>;
    private static analyzeCategoryHealth;
    private static analyzeGeoHealth;
    private static analyzePricingPressure;
    private static analyzeTrustDistribution;
    private static getChurnRiskCounts;
    private static calculateCategoryHealthScore;
    private static calculateZoneHealthScore;
    private static calculateExpansionReadiness;
    private static getHealthStatus;
    private static getSupplyStatus;
    private static getCategoryAlerts;
    private static getCategoryOpportunity;
    private static getExpansionBlockers;
    private static getPricingGuidanceText;
    private static getTrustImplication;
    private static buildChurnSignal;
    private static assessCompetitivePosition;
    private static getDefaultCategoryHealth;
    private static getDefaultGeoHealth;
    private static storeSnapshot;
}
//# sourceMappingURL=MarketSignalEngine.d.ts.map