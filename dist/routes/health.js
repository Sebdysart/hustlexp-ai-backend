/**
 * HEALTH ROUTES (BUILD_GUIDE Phase 6)
 *
 * Health check endpoints for production monitoring.
 *
 * Endpoints:
 * - GET /health - Full health check
 * - GET /health/live - Liveness probe (k8s)
 * - GET /health/ready - Readiness probe (k8s)
 * - GET /metrics - Prometheus metrics
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
import { Hono } from 'hono';
import { HealthCheckService } from '../infra/HealthCheckService.js';
import { MonitoringService } from '../infra/MonitoringService.js';
import { PrometheusMetrics } from '../infra/metrics/Prometheus.js';
const healthRoutes = new Hono();
/**
 * Full health check
 */
healthRoutes.get('/health', async (c) => {
    const health = await HealthCheckService.check();
    const statusCode = health.status === 'healthy' ? 200
        : health.status === 'degraded' ? 200
            : 503;
    return c.json(health, statusCode);
});
/**
 * Liveness probe (k8s)
 * Returns 200 if the service is alive
 */
healthRoutes.get('/health/live', async (c) => {
    const isAlive = await HealthCheckService.liveness();
    if (isAlive) {
        return c.json({ status: 'ok' }, 200);
    }
    return c.json({ status: 'dead' }, 503);
});
/**
 * Readiness probe (k8s)
 * Returns 200 if the service is ready to accept traffic
 */
healthRoutes.get('/health/ready', async (c) => {
    const isReady = await HealthCheckService.readiness();
    if (isReady) {
        return c.json({ status: 'ready' }, 200);
    }
    return c.json({ status: 'not ready' }, 503);
});
/**
 * Prometheus metrics endpoint
 */
healthRoutes.get('/metrics', async (c) => {
    // Run a metrics check to update gauges
    await MonitoringService.runCheck();
    // Return Prometheus format
    const metrics = PrometheusMetrics.getMetrics();
    c.header('Content-Type', 'text/plain; version=0.0.4');
    return c.text(metrics);
});
/**
 * Metrics snapshot (JSON format)
 */
healthRoutes.get('/metrics/json', async (c) => {
    const snapshot = await MonitoringService.getMetricsSnapshot();
    return c.json(snapshot);
});
export { healthRoutes };
//# sourceMappingURL=health.js.map