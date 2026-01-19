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
import { MonitoringService } from '../infra/MonitoringService.js';
import { HealthCheckService } from '../infra/HealthCheckService.js';
import { AlertingService } from '../infra/AlertingService.js';
import { createLogger } from '../utils/logger.js';
import { getSql } from '../db/index.js';
const logger = createLogger('MonitoringCron');
// ============================================================================
// INTERVALS
// ============================================================================
const HEALTH_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds
const METRICS_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const METRICS_PERSIST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// ============================================================================
// MONITORING CRON CLASS
// ============================================================================
class MonitoringCronClass {
    running = false;
    healthCheckTimer;
    metricsCheckTimer;
    metricsPersistTimer;
    /**
     * Start the monitoring cron
     */
    start() {
        if (this.running) {
            logger.warn('Monitoring cron already running');
            return;
        }
        this.running = true;
        logger.info('Starting monitoring cron...');
        // Health checks
        this.runHealthCheck();
        this.healthCheckTimer = setInterval(() => this.runHealthCheck(), HEALTH_CHECK_INTERVAL_MS);
        // Metrics checks
        this.runMetricsCheck();
        this.metricsCheckTimer = setInterval(() => this.runMetricsCheck(), METRICS_CHECK_INTERVAL_MS);
        // Metrics persistence
        this.metricsPersistTimer = setInterval(() => this.persistMetrics(), METRICS_PERSIST_INTERVAL_MS);
        logger.info({
            healthCheckInterval: HEALTH_CHECK_INTERVAL_MS,
            metricsCheckInterval: METRICS_CHECK_INTERVAL_MS,
            metricsPersistInterval: METRICS_PERSIST_INTERVAL_MS,
        }, 'Monitoring cron started');
    }
    /**
     * Stop the monitoring cron
     */
    stop() {
        this.running = false;
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = undefined;
        }
        if (this.metricsCheckTimer) {
            clearInterval(this.metricsCheckTimer);
            this.metricsCheckTimer = undefined;
        }
        if (this.metricsPersistTimer) {
            clearInterval(this.metricsPersistTimer);
            this.metricsPersistTimer = undefined;
        }
        logger.info('Monitoring cron stopped');
    }
    /**
     * Run health check
     */
    async runHealthCheck() {
        try {
            const health = await HealthCheckService.check();
            if (health.status === 'unhealthy') {
                await AlertingService.critical('system_health', 'System Health Critical', `System is unhealthy: ${health.components.filter(c => c.status === 'unhealthy').map(c => c.name).join(', ')}`, { components: health.components });
            }
        }
        catch (error) {
            logger.error({ error: error.message }, 'Health check failed');
        }
    }
    /**
     * Run metrics check
     */
    async runMetricsCheck() {
        try {
            await MonitoringService.runCheck();
        }
        catch (error) {
            logger.error({ error: error.message }, 'Metrics check failed');
        }
    }
    /**
     * Persist metrics to database
     */
    async persistMetrics() {
        try {
            const sql = getSql();
            const metrics = await MonitoringService.getMetricsSnapshot();
            await sql `
        INSERT INTO metrics_snapshots (
          timestamp,
          error_rate,
          response_time_p95,
          payment_failures_hourly,
          dispute_rate,
          invariant_violations,
          db_healthy,
          webhook_delivery_rate,
          active_tasks,
          pending_payouts,
          queue_depth
        ) VALUES (
          ${metrics.timestamp},
          ${metrics.error_rate},
          ${metrics.response_time_p95},
          ${metrics.payment_failures_per_hour},
          ${metrics.dispute_rate},
          ${metrics.invariant_violations},
          ${metrics.db_connection_healthy},
          ${metrics.webhook_delivery_rate},
          ${metrics.active_tasks},
          ${metrics.pending_payouts},
          ${metrics.queue_depth}
        )
      `;
            logger.debug('Metrics persisted');
        }
        catch (error) {
            logger.error({ error: error.message }, 'Failed to persist metrics');
        }
    }
    /**
     * Get status
     */
    getStatus() {
        return { running: this.running };
    }
}
export const MonitoringCron = new MonitoringCronClass();
// ============================================================================
// STANDALONE RUNNER
// ============================================================================
if (import.meta.url === `file://${process.argv[1]}`) {
    logger.info('Starting standalone monitoring cron...');
    MonitoringCron.start();
    // Graceful shutdown
    process.on('SIGTERM', () => {
        logger.info('SIGTERM received, shutting down...');
        MonitoringCron.stop();
        process.exit(0);
    });
    process.on('SIGINT', () => {
        logger.info('SIGINT received, shutting down...');
        MonitoringCron.stop();
        process.exit(0);
    });
}
//# sourceMappingURL=MonitoringCron.js.map