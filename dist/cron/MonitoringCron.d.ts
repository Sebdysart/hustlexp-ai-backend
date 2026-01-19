/**
 * MONITORING CRON (BUILD_GUIDE Phase 6)
 *
 * Periodic monitoring and alerting.
 *
 * Runs:
 * - Health checks every 30 seconds
 * - Metrics collection every 1 minute
 * - Alert threshold checks every 1 minute
 * - Metrics persistence every 5 minutes
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
declare class MonitoringCronClass {
    private running;
    private healthCheckTimer?;
    private metricsCheckTimer?;
    private metricsPersistTimer?;
    /**
     * Start the monitoring cron
     */
    start(): void;
    /**
     * Stop the monitoring cron
     */
    stop(): void;
    /**
     * Run health check
     */
    private runHealthCheck;
    /**
     * Run metrics check
     */
    private runMetricsCheck;
    /**
     * Persist metrics to database
     */
    private persistMetrics;
    /**
     * Get status
     */
    getStatus(): {
        running: boolean;
    };
}
export declare const MonitoringCron: MonitoringCronClass;
export {};
//# sourceMappingURL=MonitoringCron.d.ts.map