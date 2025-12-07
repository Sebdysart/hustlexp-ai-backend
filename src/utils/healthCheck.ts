/**
 * Enhanced Health Check Utility
 * 
 * Provides comprehensive health status including database, Redis,
 * and AI service availability.
 */

import { testConnection, isDatabaseAvailable } from '../db/index.js';
import { testRedisConnection, isRateLimitingEnabled } from '../middleware/rateLimiter.js';
import { getEnvStatus } from './envValidator.js';

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

const startTime = Date.now();

/**
 * Run comprehensive health check
 */
export async function runHealthCheck(): Promise<HealthStatus> {
    const envStatus = getEnvStatus();

    // Check database
    const dbStart = Date.now();
    let dbConnected = false;
    if (isDatabaseAvailable()) {
        dbConnected = await testConnection();
    }
    const dbLatency = Date.now() - dbStart;

    // Check Redis
    const redisStart = Date.now();
    let redisConnected = false;
    if (isRateLimitingEnabled()) {
        redisConnected = await testRedisConnection();
    }
    const redisLatency = Date.now() - redisStart;

    // Memory usage
    const memUsage = process.memoryUsage();

    // Determine overall status
    const aiAvailable = envStatus.openai || envStatus.deepseek || envStatus.groq;
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    if (!aiAvailable) {
        status = 'unhealthy';
    } else if (!dbConnected && envStatus.database) {
        status = 'degraded';
    } else if (!redisConnected && envStatus.redis) {
        status = 'degraded';
    }

    return {
        status,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        services: {
            database: {
                configured: envStatus.database,
                connected: dbConnected,
                latencyMs: envStatus.database ? dbLatency : undefined,
            },
            redis: {
                configured: envStatus.redis,
                connected: redisConnected,
                latencyMs: envStatus.redis ? redisLatency : undefined,
            },
            ai: {
                providers: {
                    openai: envStatus.openai,
                    deepseek: envStatus.deepseek,
                    groq: envStatus.groq,
                },
                anyAvailable: aiAvailable,
            },
        },
        memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024),
        },
    };
}

/**
 * Quick health check (for load balancers)
 */
export function quickHealthCheck(): { status: 'ok' | 'error'; timestamp: string } {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
    };
}
