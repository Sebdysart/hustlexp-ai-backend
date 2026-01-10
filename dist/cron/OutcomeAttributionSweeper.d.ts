/**
 * OUTCOME ATTRIBUTION SWEEPER (Phase Ω-ACT-2)
 *
 * Runs every 30 minutes.
 * Processes unanalyzed corrections.
 * Feeds results into SafeMode and Budget.
 *
 * Emits metrics:
 * - correction_positive_rate
 * - correction_negative_rate
 * - correction_confidence_avg
 */
export declare class OutcomeAttributionSweeper {
    /**
     * RUN SWEEPER
     *
     * 1. Find corrections old enough to analyze (6h+)
     * 2. Filter out already analyzed
     * 3. Analyze each
     * 4. Check SafeMode threshold
     */
    static run(): Promise<{
        analyzed: number;
        positive: number;
        neutral: number;
        negative: number;
        triggeredSafeMode: boolean;
    }>;
    /**
     * FIND CORRECTIONS TO ANALYZE
     *
     * - Applied 6h+ ago
     * - Not yet analyzed
     * - Limit 50 per sweep
     */
    private static findCorrectionsToAnalyze;
    /**
     * GET METRICS (for Prometheus export)
     */
    static getMetrics(): Promise<{
        correction_positive_rate: number;
        correction_negative_rate: number;
        correction_confidence_avg: number;
    }>;
}
//# sourceMappingURL=OutcomeAttributionSweeper.d.ts.map