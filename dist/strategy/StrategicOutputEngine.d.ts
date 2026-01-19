/**
 * STRATEGIC OUTPUT ENGINE (Phase 15B)
 *
 * Dominance Layer - ASYMMETRIC MARKET ADVANTAGE
 *
 * Purpose: Convert intelligence into non-destructive leverage.
 *
 * Four Strategic Outputs:
 * 1. Poster Pricing Guidance - Help posters price correctly
 * 2. Hustler Opportunity Routing - Surface best opportunities
 * 3. Adaptive Trust Friction - UX-only friction adjustments
 * 4. Growth & Expansion Targeting - Ops-facing expansion intel
 *
 * CONSTRAINTS:
 * - READ-ONLY: Never modifies task/money state
 * - NO KERNEL: Never touches ledger/payout/disputes
 * - ADVISORY: All outputs are suggestions, not commands
 * - DETERMINISTIC: No AI in request path
 * - REVERSIBLE: Zero system risk
 */
import { RiskTier } from '../services/RiskScoreService.js';
export interface PricingGuidanceOutput {
    category: string;
    zone?: string;
    marketRate: {
        min: number;
        median: number;
        max: number;
        suggested: number;
    };
    guidance: {
        message: string;
        confidence: 'high' | 'medium' | 'low';
        dataPoints: number;
    };
    riskSignals: {
        underpricedRisk: string | null;
        overpricedRisk: string | null;
        categoryNote: string | null;
    };
    competitiveAdvantage: string;
}
export interface HustlerOpportunityOutput {
    userId: string;
    zone: string;
    opportunities: {
        category: string;
        opportunityScore: number;
        reason: string;
        avgPayout: number;
        completionRate: number;
        disputeRate: number;
    }[];
    zoneHealth: {
        status: string;
        demand: 'high' | 'medium' | 'low';
        avgCompletionTime: string;
    };
    retentionAdvice: string | null;
    competitiveAdvantage: string;
}
export interface TrustFrictionOutput {
    taskId: string;
    riskProfile: {
        taskRisk: number;
        posterRisk: number;
        hustlerRisk: number | null;
        combinedRisk: number;
        tier: RiskTier;
    };
    recommendedFriction: {
        proofTiming: 'before_completion' | 'after_completion' | 'not_required';
        confirmationStep: boolean;
        visibilityDelay: number;
        taskSizeLimit?: number;
        additionalInstructions: string[];
    };
    explanation: {
        whyThisFriction: string;
        userFacingMessage: string;
        internalNote: string;
    };
    constraints: {
        cannotBlockPayout: true;
        cannotModifyLedger: true;
        cannotTriggerKillSwitch: true;
        isAdvisoryOnly: true;
    };
}
export interface GrowthTargetOutput {
    zones: {
        zone: string;
        recommendation: 'expand' | 'hold' | 'reduce_spend' | 'monitor';
        priority: number;
        signals: {
            healthScore: number;
            supplyStatus: string;
            demandTrend: string;
            disputeRisk: string;
        };
        action: string;
        blockers: string[];
    }[];
    categoryOpportunities: {
        category: string;
        opportunity: string;
        zones: string[];
        investmentRecommendation: 'high' | 'medium' | 'low' | 'avoid';
    }[];
    marketPosition: {
        strengths: string[];
        weaknesses: string[];
        nextMoves: string[];
    };
    competitiveAdvantage: string;
}
export declare class StrategicOutputEngine {
    /**
     * 1. POSTER PRICING GUIDANCE
     *
     * Why it outperforms competitors:
     * - Competitors give static price suggestions
     * - We give zone-aware, risk-adjusted, data-backed guidance
     *
     * Failure mode prevented:
     * - Underpricing → disputes → churn
     * - Overpricing → low acceptance → poster frustration
     */
    static getPricingGuidance(category: string, zone?: string): Promise<PricingGuidanceOutput>;
    /**
     * 2. HUSTLER OPPORTUNITY ROUTING
     *
     * Why it outperforms competitors:
     * - Competitors show all tasks equally
     * - We surface high-quality, low-dispute opportunities
     *
     * Failure mode prevented:
     * - Hustlers take bad tasks → disputes → churn
     * - Hustlers miss good opportunities → lower earnings → churn
     */
    static getHustlerOpportunities(userId: string, zone: string): Promise<HustlerOpportunityOutput>;
    /**
     * 3. ADAPTIVE TRUST FRICTION
     *
     * Why it outperforms competitors:
     * - Competitors apply same friction to everyone
     * - We apply risk-proportional friction
     *
     * Failure mode prevented:
     * - Low-risk users frustrated by unnecessary friction
     * - High-risk scenarios slip through without checks
     *
     * CRITICAL: This is UX-only. Cannot block payouts.
     */
    static getTrustFriction(taskId: string, category: string, price: number, posterId: string, hustlerId?: string): Promise<TrustFrictionOutput>;
    /**
     * 4. GROWTH & EXPANSION TARGETING
     *
     * Why it outperforms competitors:
     * - Competitors expand by gut feel
     * - We expand by supply/demand data + health metrics
     *
     * Failure mode prevented:
     * - Expanding into zones without hustler supply
     * - Ignoring high-potential zones
     */
    static getGrowthTargets(): Promise<GrowthTargetOutput>;
    private static getOpportunityReason;
    private static calculateFriction;
    private static explainFriction;
    private static getZoneRecommendation;
    private static calculateZonePriority;
    private static getZoneAction;
    private static getCategoryInvestment;
    private static getNextMoves;
    private static getDefaultGrowthTargets;
}
//# sourceMappingURL=StrategicOutputEngine.d.ts.map