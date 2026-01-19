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
declare const healthRoutes: Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
export { healthRoutes };
//# sourceMappingURL=health.d.ts.map