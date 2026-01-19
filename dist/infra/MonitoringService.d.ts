/**
 * MONITORING SERVICE (BUILD_GUIDE Phase 6)
 *
 * Collects and tracks production metrics for alerting.
 *
 * Metrics Tracked (from BUILD_GUIDE):
 * - Error rate
 * - Response time (p95)
 * - Payment failures
 * - Dispute rate
 * - Database health
 * - Webhook delivery
 * - Invariant violations
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
export interface MetricsSnapshot {
    timestamp: Date;
    error_rate: number;
    response_time_p95: number;
    payment_failures_per_hour: number;
    dispute_rate: number;
    invariant_violations: number;
    db_connection_healthy: boolean;
    webhook_delivery_rate: number;
    active_tasks: number;
    pending_payouts: number;
    queue_depth: number;
}
declare class MonitoringServiceClass {
    private requestMetrics;
    private readonly MAX_METRICS_AGE_MS;
    private readonly MAX_METRICS_COUNT;
    /**
     * Record a request metric
     */
    recordRequest(endpoint: string, durationMs: number, success: boolean): void;
    /**
     * Record an invariant violation (ALWAYS CRITICAL)
     */
    recordInvariantViolation(invariantId: string, details: string): Promise<void>;
    /**
     * Record a payment failure
     */
    recordPaymentFailure(taskId: string, error: string): Promise<void>;
    /**
     * Get current metrics snapshot
     */
    getMetricsSnapshot(): Promise<MetricsSnapshot>;
    /**
     * Run monitoring check and alert if needed
     */
    runCheck(): Promise<MetricsSnapshot>;
    /**
     * Prune old metrics from memory
     */
    private pruneOldMetrics;
}
export declare const MonitoringService: MonitoringServiceClass;
export {};
//# sourceMappingURL=MonitoringService.d.ts.map