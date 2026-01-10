/**
 * PERFORMANCE FEEDBACK SERVICE (Phase 15C-1 - Flywheel 2)
 *
 * Purpose: Make performance benefits visible to hustlers.
 *
 * This service:
 * - Tracks completion success, proof outcomes, disputes
 * - Calculates zone/category percentile rankings
 * - Shows "what improved / what hurt"
 * - Feeds learning loop
 *
 * CONSTRAINTS:
 * - CANNOT affect payouts
 * - CANNOT prioritize tasks
 * - READ-ONLY feedback
 * - APPEND-ONLY persistence
 */
export interface PerformanceEvent {
    id: string;
    userId: string;
    taskId: string;
    category: string;
    zone?: string;
    outcome: {
        completed: boolean;
        completionTimeHours: number;
        proofAccepted: boolean;
        proofRejected: boolean;
        disputed: boolean;
        earnings: number;
    };
    impact: {
        opportunityScoreDelta: number;
        reputationImpact: 'positive' | 'neutral' | 'negative';
        reasons: string[];
    };
    createdAt: Date;
}
export interface PerformanceSummary {
    userId: string;
    periodDays: number;
    stats: {
        totalTasks: number;
        completionRate: number;
        avgCompletionTimeHours: number;
        proofAcceptanceRate: number;
        disputeRate: number;
        totalEarnings: number;
    };
    rankings: {
        zonePercentile: number;
        categoryPercentile: number;
        overallPercentile: number;
    };
    analysis: {
        strengths: string[];
        improvements: string[];
        opportunities: string[];
    };
    trend: 'improving' | 'stable' | 'declining';
    trendExplanation: string;
}
export declare class PerformanceFeedbackService {
    /**
     * RECORD TASK PERFORMANCE
     * Called when a task completes
     */
    static recordPerformance(params: {
        userId: string;
        taskId: string;
        category: string;
        zone?: string;
        completed: boolean;
        completionTimeHours: number;
        proofAccepted: boolean;
        proofRejected: boolean;
        disputed: boolean;
        earnings: number;
    }): Promise<PerformanceEvent>;
    /**
     * GET PERFORMANCE SUMMARY
     */
    static getSummary(userId: string, days?: number): Promise<PerformanceSummary>;
    /**
     * GET RECENT FEEDBACK
     */
    static getRecentFeedback(userId: string, limit?: number): Promise<{
        event: PerformanceEvent;
        feedback: string;
    }[]>;
    private static calculateImpact;
    private static calculateStats;
    private static calculateRankings;
    private static analyzePerformance;
    private static getMostFrequentCategory;
    private static calculateTrend;
    private static generateFeedbackMessage;
    private static persistEvent;
}
//# sourceMappingURL=PerformanceFeedbackService.d.ts.map