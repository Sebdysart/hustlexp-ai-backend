/**
 * PRICING FEEDBACK SERVICE (Phase 15C-1 - Flywheel 1)
 *
 * Purpose: Make pricing consequences visible to posters.
 *
 * This service:
 * - Compares actual price vs recommended guidance
 * - Tracks outcome delta (completion speed, disputes)
 * - Produces explainable verdicts
 * - Feeds learning loop
 *
 * CONSTRAINTS:
 * - CANNOT block posting
 * - CANNOT auto-adjust price
 * - READ-ONLY feedback
 * - APPEND-ONLY persistence
 */
export type PricingVerdict = 'underpriced' | 'optimal' | 'overpriced';
export interface PricingFeedbackEvent {
    id: string;
    taskId: string;
    category: string;
    zone?: string;
    recommendedMin: number;
    recommendedMax: number;
    recommendedSuggested: number;
    actualPrice: number;
    pricePercentile: number;
    verdict: PricingVerdict;
    deltaFromOptimal: number;
    deltaPercent: number;
    outcome?: {
        completed: boolean;
        completionTimeHours?: number;
        avgCompletionTimeHours?: number;
        disputed: boolean;
        acceptanceTimeMinutes?: number;
    };
    outcomeDelta?: {
        fasterThanAvg: boolean;
        disputeRiskElevated: boolean;
        explanation: string;
    };
    createdAt: Date;
    updatedAt?: Date;
}
export interface PricingFeedbackSummary {
    taskId: string;
    verdict: PricingVerdict;
    feedback: {
        headline: string;
        detail: string;
        recommendation?: string;
    };
    stats: {
        pricePercentile: number;
        vsMarketMedian: string;
        vsRecommended: string;
    };
    outcomeImpact?: {
        completionSpeed: string;
        disputeRisk: string;
    };
}
export declare class PricingFeedbackService {
    /**
     * RECORD PRICING DECISION
     * Called when a task is posted
     */
    static recordPricingDecision(params: {
        taskId: string;
        category: string;
        zone?: string;
        actualPrice: number;
    }): Promise<PricingFeedbackEvent>;
    /**
     * UPDATE WITH OUTCOME
     * Called when task completes or disputes
     */
    static recordOutcome(params: {
        taskId: string;
        completed: boolean;
        completionTimeHours?: number;
        disputed: boolean;
        acceptanceTimeMinutes?: number;
    }): Promise<void>;
    /**
     * GET FEEDBACK FOR TASK
     */
    static getFeedback(taskId: string): Promise<PricingFeedbackSummary | null>;
    /**
     * GET POSTER ANALYTICS
     * Shows patterns across poster's tasks
     */
    static getPosterAnalytics(posterId: string): Promise<{
        totalTasks: number;
        verdictBreakdown: Record<PricingVerdict, number>;
        avgDeltaPercent: number;
        disputeCorrelation: string;
        recommendation: string;
    }>;
    private static calculateVerdict;
    private static estimatePercentile;
    private static calculateOutcomeDelta;
    private static buildSummary;
    private static emitMetric;
    private static persistEvent;
}
//# sourceMappingURL=PricingFeedbackService.d.ts.map