/**
 * COUNTERFACTUAL SIMULATOR (Phase 14E)
 *
 * Control Plane Component - ADVISORY ONLY
 *
 * Purpose: Answer "What would have happened if we followed this advice?"
 *
 * This service:
 * - Re-runs historical data through proposed policy changes
 * - Compares predicted outcomes vs actual outcomes
 * - Flags recommendations that would have caused harm
 * - Provides quantified impact predictions
 *
 * CONSTRAINTS:
 * - READ-ONLY: Never modifies any data
 * - HISTORICAL: Only uses past snapshots and outcomes
 * - ADVISORY: Results inform human decisions, no auto-execution
 * - NO KERNEL: Never touches money, ledger, or state machines
 */
import { AIRecommendation } from './AIRecommendationService.js';
export interface SimulationResult {
    id: string;
    recommendationId: string;
    simulatedAt: Date;
    snapshotsAnalyzed: number;
    periodStart: Date;
    periodEnd: Date;
    baseline: SimulationMetrics;
    projected: SimulationMetrics;
    impact: ImpactAnalysis;
    verdict: SimulationVerdict;
    confidence: number;
}
export interface SimulationMetrics {
    disputeRate: number;
    proofRejectionRate: number;
    escalationRate: number;
    adminOverrideRate: number;
    avgPayoutDelayHours: number;
    completionRate: number;
}
export interface ImpactAnalysis {
    disputes: {
        change: number;
        direction: 'better' | 'worse' | 'neutral';
        pctChange: number;
    };
    proofRejections: {
        change: number;
        direction: 'better' | 'worse' | 'neutral';
        pctChange: number;
    };
    escalations: {
        change: number;
        direction: 'better' | 'worse' | 'neutral';
        pctChange: number;
    };
    adminOverrides: {
        change: number;
        direction: 'better' | 'worse' | 'neutral';
        pctChange: number;
    };
    payoutDelay: {
        change: number;
        direction: 'better' | 'worse' | 'neutral';
        pctChange: number;
    };
    completions: {
        change: number;
        direction: 'better' | 'worse' | 'neutral';
        pctChange: number;
    };
    netPositiveSignals: number;
    netNegativeSignals: number;
}
export type SimulationVerdict = 'STRONGLY_POSITIVE' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'STRONGLY_NEGATIVE' | 'INSUFFICIENT_DATA';
export declare class CounterfactualSimulator {
    /**
     * SIMULATE RECOMMENDATION IMPACT
     * Re-runs historical data through proposed policy change
     */
    static simulate(recommendation: AIRecommendation, daysBack?: number): Promise<SimulationResult>;
    /**
     * GET SIMULATION RESULT
     */
    static getResult(simulationId: string): Promise<SimulationResult | null>;
    /**
     * GET SIMULATIONS FOR RECOMMENDATION
     */
    static getForRecommendation(recommendationId: string): Promise<SimulationResult[]>;
    /**
     * SHOULD ACCEPT RECOMMENDATION
     * Quick check if a recommendation's simulation supports acceptance
     */
    static shouldAccept(recommendationId: string): Promise<{
        recommend: boolean;
        reason: string;
        simulation?: SimulationResult;
    }>;
    private static loadHistoricalSnapshots;
    private static calculateBaseline;
    private static projectChange;
    private static analyzeImpact;
    private static determineVerdict;
    private static calculateConfidence;
    private static buildInsufficientDataResult;
    private static storeResult;
}
//# sourceMappingURL=CounterfactualSimulator.d.ts.map