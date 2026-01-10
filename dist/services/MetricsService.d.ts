/**
 * Metrics Service - Phase D
 *
 * Marketplace health metrics:
 * - Global funnel (post → accept → complete → payout)
 * - Zone health (per Seattle neighborhood)
 * - User earnings summary
 * - AI usage and cost summary
 */
export interface DateRange {
    since?: Date;
    until?: Date;
}
export interface FunnelMetrics {
    tasksCreated: number;
    tasksAccepted: number;
    tasksCompleted: number;
    tasksDisputed: number;
    tasksRefunded: number;
    completionRate: number;
    disputeRate: number;
    refundRate: number;
    acceptanceRate: number;
    avgTimeToAcceptMs?: number;
    avgTimeToCompleteMs?: number;
}
export interface ZoneMetrics {
    zone: string;
    tasksCreated: number;
    tasksCompleted: number;
    avgTimeToAcceptSeconds: number;
    avgTimeToCompleteSeconds: number;
    avgPayoutUsd: number;
    completionRate: number;
    disputeRate: number;
}
export interface UserEarningsSummary {
    userId: string;
    totalTasks: number;
    completedTasks: number;
    totalEarningsUsd: number;
    avgPerTask: number;
    disputesInvolved: number;
    refundsInvolved: number;
    xpEarned: number;
    streakDays: number;
    rating?: number;
}
export interface AIMetricsSummary {
    provider: string;
    routeType: string;
    calls: number;
    avgLatencyMs: number;
    totalCostUsd: number;
    avgCostPerCallUsd: number;
    errorRate: number;
    successCount: number;
    errorCount: number;
}
export interface AIMetricRecord {
    id: string;
    provider: 'openai' | 'deepseek' | 'groq';
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    routeType: string;
    success: boolean;
    errorCode?: string;
    userId?: string;
    taskId?: string;
    createdAt: Date;
}
export declare function logAIUsage(details: {
    provider: 'openai' | 'deepseek' | 'groq';
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    routeType: string;
    success: boolean;
    errorCode?: string;
    userId?: string;
    taskId?: string;
}): AIMetricRecord;
declare class MetricsServiceClass {
    getGlobalFunnel(range?: DateRange): FunnelMetrics;
    getZoneHealth(range?: DateRange): ZoneMetrics[];
    getUserEarningsSummary(userId: string, range?: DateRange): UserEarningsSummary;
    getAIMetricsSummary(range?: DateRange): AIMetricsSummary[];
    getAIMetrics(range?: DateRange): AIMetricRecord[];
    /**
     * Get sample AI metric for documentation
     */
    getSampleAIMetric(): AIMetricRecord | null;
    getOverallStats(): {
        events: {
            total: number;
            byType: Record<string, number>;
        };
        ai: {
            totalCalls: number;
            totalCostUsd: number;
            avgLatencyMs: number;
        };
        funnel: FunnelMetrics;
    };
}
export declare const MetricsService: MetricsServiceClass;
export {};
//# sourceMappingURL=MetricsService.d.ts.map