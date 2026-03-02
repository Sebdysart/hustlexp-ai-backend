import type { FastifyInstance } from 'fastify';
import { runHealthCheck, quickHealthCheck } from '../utils/healthCheck.js';
import { getAllCircuitStates } from '../utils/reliability.js';
import { isDegradedMode } from '../ai/degradedMode.js';
import { BetaMetricsService, THRESHOLDS } from '../services/BetaMetricsService.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
    // Quick health check (for load balancers - fast response)
    fastify.get('/health', async () => {
        return quickHealthCheck();
    });

    // Detailed health check (includes service connectivity)
    fastify.get('/health/detailed', async () => {
        return await runHealthCheck();
    });

    // AI circuit breaker / degraded-mode health (TASK-13)
    // Public — no auth required (load balancer / ops dashboard)
    fastify.get('/health/ai', async () => {
        const circuits = getAllCircuitStates();
        return {
            degradedMode: isDegradedMode(), // true when env flag OR all AI circuit breakers are OPEN
            models: circuits,
            timestamp: new Date().toISOString(),
        };
    });

    // Prometheus-format metrics (for Grafana/monitoring)
    fastify.get('/metrics', async (request, reply) => {
        reply.header('Content-Type', 'text/plain');
        return BetaMetricsService.getPrometheusMetrics();
    });

    // Beta operations dashboard
    fastify.get('/api/beta/metrics', async () => {
        return {
            rates: {
                proofRejectionRate: BetaMetricsService.getProofRejectionRate(),
                escalationRate: BetaMetricsService.getEscalationRate(),
                adminOverrideRate: BetaMetricsService.getAdminOverrideRate(),
                disputeRate: BetaMetricsService.getDisputeRate()
            },
            thresholds: THRESHOLDS,
            thresholdCheck: BetaMetricsService.checkThresholds()
        };
    });

    // Daily beta report
    fastify.get('/api/beta/daily-report', async () => {
        return await BetaMetricsService.generateDailyReport();
    });
}
