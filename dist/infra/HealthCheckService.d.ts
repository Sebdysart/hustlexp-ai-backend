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
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';
export interface ComponentHealth {
    name: string;
    status: HealthStatus;
    latencyMs?: number;
    error?: string;
    lastChecked: Date;
}
export interface SystemHealth {
    status: HealthStatus;
    components: ComponentHealth[];
    timestamp: Date;
    uptime: number;
}
declare class HealthCheckServiceClass {
    private startTime;
    /**
     * Run full health check
     */
    check(): Promise<SystemHealth>;
    /**
     * Quick liveness check (for k8s liveness probe)
     */
    liveness(): Promise<boolean>;
    /**
     * Readiness check (for k8s readiness probe)
     */
    readiness(): Promise<boolean>;
    /**
     * Check database connectivity
     */
    private checkDatabase;
    /**
     * Check Redis connectivity
     */
    private checkRedis;
    /**
     * Check job queue health
     */
    private checkJobQueue;
    /**
     * Check Stripe API connectivity
     */
    private checkStripe;
}
export declare const HealthCheckService: HealthCheckServiceClass;
export {};
//# sourceMappingURL=HealthCheckService.d.ts.map