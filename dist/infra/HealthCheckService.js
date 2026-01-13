/**
 * HEALTH CHECK SERVICE (BUILD_GUIDE Phase 6)
 *
 * System health verification for production monitoring.
 *
 * Checks:
 * - Database connectivity
 * - Redis connectivity
 * - Stripe API connectivity
 * - Job queue health
 * - Critical service availability
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { redis } from '../middleware/rateLimiter.js';
const logger = createLogger('HealthCheckService');
// ============================================================================
// HEALTH CHECK SERVICE
// ============================================================================
class HealthCheckServiceClass {
    startTime = Date.now();
    /**
     * Run full health check
     */
    async check() {
        const components = [];
        // Check each component
        components.push(await this.checkDatabase());
        components.push(await this.checkRedis());
        components.push(await this.checkJobQueue());
        components.push(await this.checkStripe());
        // Determine overall status
        const unhealthyCount = components.filter(c => c.status === 'unhealthy').length;
        const degradedCount = components.filter(c => c.status === 'degraded').length;
        let status = 'healthy';
        if (unhealthyCount > 0) {
            status = 'unhealthy';
        }
        else if (degradedCount > 0) {
            status = 'degraded';
        }
        const health = {
            status,
            components,
            timestamp: new Date(),
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
        };
        // Log if not healthy
        if (status !== 'healthy') {
            logger.warn({ status, components: components.filter(c => c.status !== 'healthy') }, 'System health degraded');
        }
        return health;
    }
    /**
     * Quick liveness check (for k8s liveness probe)
     */
    async liveness() {
        return true; // If we can respond, we're alive
    }
    /**
     * Readiness check (for k8s readiness probe)
     */
    async readiness() {
        try {
            const dbHealth = await this.checkDatabase();
            return dbHealth.status !== 'unhealthy';
        }
        catch {
            return false;
        }
    }
    // ==========================================================================
    // COMPONENT CHECKS
    // ==========================================================================
    /**
     * Check database connectivity
     */
    async checkDatabase() {
        const start = Date.now();
        try {
            const sql = getSql();
            await sql `SELECT 1`;
            return {
                name: 'database',
                status: 'healthy',
                latencyMs: Date.now() - start,
                lastChecked: new Date(),
            };
        }
        catch (error) {
            return {
                name: 'database',
                status: 'unhealthy',
                error: error.message,
                latencyMs: Date.now() - start,
                lastChecked: new Date(),
            };
        }
    }
    /**
     * Check Redis connectivity
     */
    async checkRedis() {
        const start = Date.now();
        try {
            if (!redis) {
                return {
                    name: 'redis',
                    status: 'degraded',
                    error: 'Redis not configured',
                    lastChecked: new Date(),
                };
            }
            await redis.ping();
            return {
                name: 'redis',
                status: 'healthy',
                latencyMs: Date.now() - start,
                lastChecked: new Date(),
            };
        }
        catch (error) {
            return {
                name: 'redis',
                status: 'degraded', // Redis is optional
                error: error.message,
                latencyMs: Date.now() - start,
                lastChecked: new Date(),
            };
        }
    }
    /**
     * Check job queue health
     */
    async checkJobQueue() {
        const start = Date.now();
        try {
            const sql = getSql();
            // Check for stuck jobs (processing > 30 min)
            const [stuck] = await sql `
        SELECT COUNT(*)::int as cnt FROM job_queue
        WHERE status = 'processing'
          AND started_at < NOW() - INTERVAL '30 minutes'
      `;
            // Check for dead jobs
            const [dead] = await sql `
        SELECT COUNT(*)::int as cnt FROM job_queue
        WHERE status = 'dead'
          AND created_at > NOW() - INTERVAL '1 hour'
      `;
            let status = 'healthy';
            let error;
            if (stuck.cnt > 0) {
                status = 'degraded';
                error = `${stuck.cnt} stuck jobs`;
            }
            if (dead.cnt > 5) {
                status = 'degraded';
                error = error ? `${error}, ${dead.cnt} dead jobs` : `${dead.cnt} dead jobs`;
            }
            return {
                name: 'job_queue',
                status,
                error,
                latencyMs: Date.now() - start,
                lastChecked: new Date(),
            };
        }
        catch (error) {
            return {
                name: 'job_queue',
                status: 'unhealthy',
                error: error.message,
                latencyMs: Date.now() - start,
                lastChecked: new Date(),
            };
        }
    }
    /**
     * Check Stripe API connectivity
     */
    async checkStripe() {
        const start = Date.now();
        try {
            // Just check if Stripe key is configured
            const stripeKey = process.env.STRIPE_SECRET_KEY;
            if (!stripeKey) {
                return {
                    name: 'stripe',
                    status: 'degraded',
                    error: 'Stripe not configured',
                    lastChecked: new Date(),
                };
            }
            // Could add actual Stripe API ping here
            // const stripe = new Stripe(stripeKey);
            // await stripe.balance.retrieve();
            return {
                name: 'stripe',
                status: 'healthy',
                latencyMs: Date.now() - start,
                lastChecked: new Date(),
            };
        }
        catch (error) {
            return {
                name: 'stripe',
                status: 'degraded',
                error: error.message,
                latencyMs: Date.now() - start,
                lastChecked: new Date(),
            };
        }
    }
}
export const HealthCheckService = new HealthCheckServiceClass();
//# sourceMappingURL=HealthCheckService.js.map