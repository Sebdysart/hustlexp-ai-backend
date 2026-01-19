/**
 * CAUSAL IMPACT ANALYZER (Phase Ω-ACT-3)
 *
 * Purpose: Prove causation, not correlation.
 *
 * Compares:
 * - Treated group (with correction)
 * - Control group (without correction)
 *
 * Computes:
 * - delta_treated
 * - delta_control
 * - net_lift = delta_treated − delta_control
 *
 * Verdicts (DETERMINISTIC):
 * - CAUSAL: net_lift positive on ≥2 core metrics, control did not improve similarly
 * - NON_CAUSAL: control group improved equally or more
 * - INCONCLUSIVE: insufficient data or noisy signal
 *
 * NO ML. NO PROBABILITY MAGIC.
 */
import { OutcomeMetrics } from './CorrectionOutcomeAnalyzer.js';
import { ControlGroupMatch } from './ControlGroupSelector.js';
export type CausalVerdict = 'causal' | 'inconclusive' | 'non_causal';
export interface NetLift {
    taskFillRate: number;
    completionRate: number;
    disputeRate: number;
    hustlerEngagement: number;
    posterRetryRate: number;
}
export interface CausalAnalysis {
    correctionId: string;
    treatedMetrics: {
        baseline: OutcomeMetrics;
        post: OutcomeMetrics;
        delta: Partial<OutcomeMetrics>;
    };
    controlMetrics: {
        baseline: OutcomeMetrics;
        post: OutcomeMetrics;
        delta: Partial<OutcomeMetrics>;
    };
    netLift: NetLift;
    verdict: CausalVerdict;
    confidence: number;
    controlGroupInfo: ControlGroupMatch;
    analyzedAt: Date;
}
export declare class CausalImpactAnalyzer {
    private static readonly WINDOW_HOURS;
    /**
     * ANALYZE CAUSAL IMPACT
     */
    static analyze(correctionId: string): Promise<CausalAnalysis | null>;
    /**
     * GATHER METRICS
     */
    private static gatherMetrics;
    /**
     * COMPUTE DELTA
     */
    private static computeDelta;
    /**
     * COMPUTE NET LIFT
     *
     * net_lift = delta_treated − delta_control
     */
    private static computeNetLift;
    /**
     * DETERMINE VERDICT (DETERMINISTIC)
     *
     * CAUSAL: net_lift positive on ≥2 core metrics, control did not improve similarly
     * NON_CAUSAL: control group improved equally or more
     * INCONCLUSIVE: insufficient signal
     */
    private static determineVerdict;
    /**
     * CALCULATE CONFIDENCE
     */
    private static calculateConfidence;
    /**
     * STORE INCONCLUSIVE RESULT
     */
    private static storeInconclusiveResult;
    /**
     * STORE ANALYSIS
     */
    private static storeAnalysis;
    /**
     * GET VERDICT RATES
     */
    static getVerdictRates(windowHours?: number): Promise<{
        total: number;
        causal: number;
        inconclusive: number;
        nonCausal: number;
        causalRate: number;
        nonCausalRate: number;
    }>;
    /**
     * CHECK SAFEMODE THRESHOLD
     */
    static checkSafeModeThreshold(): Promise<boolean>;
}
//# sourceMappingURL=CausalImpactAnalyzer.d.ts.map