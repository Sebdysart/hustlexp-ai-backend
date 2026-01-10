/**
 * AI Monitoring Layer
 *
 * Production-grade monitoring for AI system health, cost, and anomalies.
 * This is the observability layer that keeps AI operations safe.
 */
interface AIMetrics {
    provider: string;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    success: boolean;
    fallbackUsed: boolean;
    userId: string;
    taskType: string;
}
interface AnomalyAlert {
    type: 'latency' | 'cost' | 'error_rate' | 'fallback_rate';
    severity: 'warning' | 'critical';
    value: number;
    threshold: number;
    message: string;
    timestamp: Date;
}
interface ProviderHealth {
    provider: string;
    available: boolean;
    avgLatencyMs: number;
    errorRate: number;
    lastError?: string;
    lastChecked: Date;
}
declare class AIMonitoringService {
    /**
     * Record an AI call for monitoring
     */
    recordCall(metrics: AIMetrics): void;
    /**
     * Update provider health status
     */
    private updateProviderHealth;
    /**
     * Check for anomalies and create alerts
     */
    private checkAnomalies;
    /**
     * Check a metric against thresholds
     */
    private checkThreshold;
    /**
     * Create an alert
     */
    private createAlert;
    /**
     * Persist metrics to database
     */
    private persistMetrics;
    /**
     * Get current health status
     */
    getHealthStatus(): {
        providers: ProviderHealth[];
        recentAlerts: AnomalyAlert[];
        metrics: {
            totalCalls: number;
            successRate: number;
            avgLatencyMs: number;
            hourlyCostUsd: number;
        };
    };
    /**
     * Get provider recommendation
     */
    getRecommendedProvider(taskType: string): string;
    /**
     * Check if system is degraded
     */
    isDegraded(): boolean;
    /**
     * Get cost report
     */
    getCostReport(): {
        lastHour: number;
        last24Hours: number;
        byProvider: Record<string, number>;
        byUser: Array<{
            userId: string;
            cost: number;
        }>;
    };
}
export declare const AIMonitoring: AIMonitoringService;
export type { AIMetrics, AnomalyAlert, ProviderHealth };
//# sourceMappingURL=AIMonitoringService.d.ts.map