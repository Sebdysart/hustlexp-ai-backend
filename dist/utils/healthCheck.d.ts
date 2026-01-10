/**
 * Enhanced Health Check Utility
 *
 * Provides comprehensive health status including database, Redis,
 * and AI service availability.
 */
interface HealthStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: string;
    version: string;
    uptime: number;
    services: {
        database: ServiceStatus;
        redis: ServiceStatus;
        ai: AIStatus;
    };
    memory: {
        heapUsed: number;
        heapTotal: number;
        external: number;
        rss: number;
    };
}
interface ServiceStatus {
    configured: boolean;
    connected: boolean;
    latencyMs?: number;
}
interface AIStatus {
    providers: {
        openai: boolean;
        deepseek: boolean;
        groq: boolean;
    };
    anyAvailable: boolean;
}
/**
 * Run comprehensive health check
 */
export declare function runHealthCheck(): Promise<HealthStatus>;
/**
 * Quick health check (for load balancers)
 */
export declare function quickHealthCheck(): {
    status: 'ok' | 'error';
    timestamp: string;
};
export {};
//# sourceMappingURL=healthCheck.d.ts.map