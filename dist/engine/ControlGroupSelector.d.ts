/**
 * CONTROL GROUP SELECTOR (Phase Ω-ACT-3)
 *
 * Purpose: Find matched control groups to prove causation.
 *
 * Matching dimensions:
 * - Same city
 * - Same zone OR nearest neighbor
 * - Same category
 * - Same time window
 * - Similar baseline metrics (±10%)
 *
 * Control group MUST NOT have received the correction.
 */
export interface ControlGroupMatch {
    zone: string;
    category: string;
    timeWindow: {
        start: Date;
        end: Date;
    };
    matchQuality: number;
    baselineMetricsDelta: number;
}
export interface ControlGroupResult {
    found: boolean;
    controlGroup: ControlGroupMatch | null;
    treatedZone: string;
    treatedCategory: string;
    reason?: string;
}
export declare class ControlGroupSelector {
    /**
     * SELECT CONTROL GROUP
     *
     * Find a matched zone/category that did NOT receive the correction.
     */
    static selectControlGroup(correctionId: string, treatedZone: string, treatedCategory: string, correctionAppliedAt: Date): Promise<ControlGroupResult>;
    /**
     * FIND CANDIDATE ZONES
     *
     * Zones that did NOT receive a similar correction.
     */
    private static findCandidateZones;
    /**
     * GET BASELINE METRICS
     */
    private static getBaselineMetrics;
    /**
     * COMPUTE BASELINE DELTA
     *
     * Average difference across key metrics.
     */
    private static computeBaselineDelta;
}
//# sourceMappingURL=ControlGroupSelector.d.ts.map