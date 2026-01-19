/**
 * CORRECTION OUTCOME ANALYZER (Phase Ω-ACT-2)
 *
 * Purpose: Prove whether corrections actually worked.
 *
 * For every correction, compute:
 * - Baseline metrics (6h BEFORE correction)
 * - Post metrics (6h AFTER correction)
 * - Net effect: positive, neutral, negative
 *
 * RULES:
 * - POSITIVE: ≥2 core metrics improve, no critical regression
 * - NEUTRAL: Mixed or insignificant
 * - NEGATIVE: Any critical regression (disputes↑, fill↓)
 *
 * NO ML. NO GUESSING.
 */
export type NetEffect = 'positive' | 'neutral' | 'negative';
export interface OutcomeMetrics {
    taskFillRate: number;
    completionRate: number;
    disputeRate: number;
    avgPayoutDelayHours: number;
    hustlerEngagement: number;
    posterRetryRate: number;
}
export interface OutcomeAnalysis {
    correctionId: string;
    baselineMetrics: OutcomeMetrics;
    postMetrics: OutcomeMetrics;
    deltas: Record<keyof OutcomeMetrics, number>;
    netEffect: NetEffect;
    confidence: number;
    analyzedAt: Date;
}
export declare class CorrectionOutcomeAnalyzer {
    private static readonly BASELINE_WINDOW_HOURS;
    private static readonly POST_WINDOW_HOURS;
    /**
     * ANALYZE SINGLE CORRECTION
     */
    static analyze(correctionId: string): Promise<OutcomeAnalysis | null>;
    /**
     * GATHER METRICS FOR WINDOW
     */
    private static gatherMetrics;
    /**
     * CALCULATE DELTAS
     */
    private static calculateDeltas;
    /**
     * CLASSIFY NET EFFECT
     *
     * DETERMINISTIC RULES:
     * - POSITIVE: ≥2 core metrics improve, no critical regression
     * - NEGATIVE: Any critical regression (disputes↑, fill↓, completion↓)
     * - NEUTRAL: Everything else
     */
    private static classifyEffect;
    /**
     * CALCULATE CONFIDENCE
     *
     * Based on sample size and variance
     */
    private static calculateConfidence;
    /**
     * STORE OUTCOME (Immutable, append-only)
     */
    private static storeOutcome;
    /**
     * GET OUTCOME RATES (for SafeMode feedback)
     */
    static getOutcomeRates(windowHours?: number): Promise<{
        total: number;
        positive: number;
        neutral: number;
        negative: number;
        positiveRate: number;
        negativeRate: number;
        avgConfidence: number;
    }>;
}
//# sourceMappingURL=CorrectionOutcomeAnalyzer.d.ts.map