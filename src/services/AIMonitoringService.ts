/**
 * AI Monitoring Layer
 * 
 * Production-grade monitoring for AI system health, cost, and anomalies.
 * This is the observability layer that keeps AI operations safe.
 */

import { serviceLogger } from '../utils/logger.js';
import { sql, isDatabaseAvailable } from '../db/index.js';

// ============================================
// TYPES
// ============================================

interface AIMetrics {
    provider: string;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    success: boolean;
    fallbackUsed: boolean;
    userId: string;
    taskType: string;
}

interface AnomalyAlert {
    type: 'latency' | 'cost' | 'error_rate' | 'fallback_rate';
    severity: 'warning' | 'critical';
    value: number;
    threshold: number;
    message: string;
    timestamp: Date;
}

interface ProviderHealth {
    provider: string;
    available: boolean;
    avgLatencyMs: number;
    errorRate: number;
    lastError?: string;
    lastChecked: Date;
}

// ============================================
// THRESHOLDS
// ============================================

const THRESHOLDS = {
    latency: {
        warning: 5000,   // 5 seconds
        critical: 15000, // 15 seconds
    },
    costPerHour: {
        warning: 5.00,   // $5/hour
        critical: 20.00, // $20/hour
    },
    errorRate: {
        warning: 0.05,   // 5%
        critical: 0.15,  // 15%
    },
    fallbackRate: {
        warning: 0.10,   // 10%
        critical: 0.30,  // 30%
    },
};

// ============================================
// IN-MEMORY TRACKING (Real-time)
// ============================================

const recentMetrics: AIMetrics[] = [];
const MAX_RECENT_METRICS = 1000;

const providerHealth: Map<string, ProviderHealth> = new Map();
const alerts: AnomalyAlert[] = [];

// ============================================
// CORE MONITORING CLASS
// ============================================

class AIMonitoringService {
    /**
     * Record an AI call for monitoring
     */
    recordCall(metrics: AIMetrics): void {
        // Add to recent metrics (ring buffer)
        recentMetrics.push(metrics);
        if (recentMetrics.length > MAX_RECENT_METRICS) {
            recentMetrics.shift();
        }

        // Update provider health
        this.updateProviderHealth(metrics);

        // Check for anomalies
        this.checkAnomalies();

        // Persist to DB if available
        this.persistMetrics(metrics);

        serviceLogger.debug({
            provider: metrics.provider,
            latencyMs: metrics.latencyMs,
            success: metrics.success,
        }, 'AI call recorded');
    }

    /**
     * Update provider health status
     */
    private updateProviderHealth(metrics: AIMetrics): void {
        const existing = providerHealth.get(metrics.provider) || {
            provider: metrics.provider,
            available: true,
            avgLatencyMs: 0,
            errorRate: 0,
            lastChecked: new Date(),
        };

        // Calculate rolling averages
        const providerCalls = recentMetrics.filter(m => m.provider === metrics.provider);
        const recentCalls = providerCalls.slice(-100);

        if (recentCalls.length > 0) {
            existing.avgLatencyMs = recentCalls.reduce((sum, m) => sum + m.latencyMs, 0) / recentCalls.length;
            existing.errorRate = recentCalls.filter(m => !m.success).length / recentCalls.length;
        }

        if (!metrics.success) {
            existing.lastError = `Failed at ${new Date().toISOString()}`;
        }

        existing.available = existing.errorRate < 0.5;
        existing.lastChecked = new Date();

        providerHealth.set(metrics.provider, existing);
    }

    /**
     * Check for anomalies and create alerts
     */
    private checkAnomalies(): void {
        const last100 = recentMetrics.slice(-100);
        if (last100.length < 10) return;

        // Latency check
        const avgLatency = last100.reduce((sum, m) => sum + m.latencyMs, 0) / last100.length;
        this.checkThreshold('latency', avgLatency, THRESHOLDS.latency, 'Average latency');

        // Error rate check
        const errorRate = last100.filter(m => !m.success).length / last100.length;
        this.checkThreshold('error_rate', errorRate, THRESHOLDS.errorRate, 'Error rate');

        // Fallback rate check
        const fallbackRate = last100.filter(m => m.fallbackUsed).length / last100.length;
        this.checkThreshold('fallback_rate', fallbackRate, THRESHOLDS.fallbackRate, 'Fallback rate');

        // Cost check (last hour)
        const lastHour = recentMetrics.filter(m => {
            const hourAgo = Date.now() - 60 * 60 * 1000;
            return new Date().getTime() > hourAgo;
        });
        const hourlyCost = lastHour.reduce((sum, m) => sum + m.costUsd, 0);
        this.checkThreshold('cost', hourlyCost, THRESHOLDS.costPerHour, 'Hourly cost');
    }

    /**
     * Check a metric against thresholds
     */
    private checkThreshold(
        type: AnomalyAlert['type'],
        value: number,
        thresholds: { warning: number; critical: number },
        label: string
    ): void {
        if (value >= thresholds.critical) {
            this.createAlert(type, 'critical', value, thresholds.critical, `${label} is critical: ${value}`);
        } else if (value >= thresholds.warning) {
            this.createAlert(type, 'warning', value, thresholds.warning, `${label} is elevated: ${value}`);
        }
    }

    /**
     * Create an alert
     */
    private createAlert(
        type: AnomalyAlert['type'],
        severity: AnomalyAlert['severity'],
        value: number,
        threshold: number,
        message: string
    ): void {
        // Dedupe: don't alert same thing within 5 minutes
        const recentSame = alerts.find(a =>
            a.type === type &&
            a.severity === severity &&
            (Date.now() - a.timestamp.getTime()) < 5 * 60 * 1000
        );

        if (recentSame) return;

        const alert: AnomalyAlert = {
            type,
            severity,
            value,
            threshold,
            message,
            timestamp: new Date(),
        };

        alerts.push(alert);

        // Keep only last 100 alerts
        if (alerts.length > 100) {
            alerts.shift();
        }

        // Log alert
        if (severity === 'critical') {
            serviceLogger.error({ alert }, 'AI CRITICAL ALERT');
        } else {
            serviceLogger.warn({ alert }, 'AI WARNING ALERT');
        }
    }

    /**
     * Persist metrics to database
     */
    private async persistMetrics(metrics: AIMetrics): Promise<void> {
        if (!isDatabaseAvailable() || !sql) return;

        try {
            await sql`
                INSERT INTO ai_metrics (
                    provider, latency_ms, tokens_in, tokens_out, 
                    cost_usd, success, fallback_used, user_id, task_type
                ) VALUES (
                    ${metrics.provider}, ${metrics.latencyMs}, ${metrics.tokensIn},
                    ${metrics.tokensOut}, ${metrics.costUsd}, ${metrics.success},
                    ${metrics.fallbackUsed}, ${metrics.userId}, ${metrics.taskType}
                )
            `;
        } catch (error) {
            serviceLogger.error({ error }, 'Failed to persist AI metrics');
        }
    }

    /**
     * Get current health status
     */
    getHealthStatus(): {
        providers: ProviderHealth[];
        recentAlerts: AnomalyAlert[];
        metrics: {
            totalCalls: number;
            successRate: number;
            avgLatencyMs: number;
            hourlyCostUsd: number;
        };
    } {
        const last100 = recentMetrics.slice(-100);
        const lastHour = recentMetrics.filter(m => {
            const hourAgo = Date.now() - 60 * 60 * 1000;
            return new Date().getTime() > hourAgo;
        });

        return {
            providers: Array.from(providerHealth.values()),
            recentAlerts: alerts.slice(-10),
            metrics: {
                totalCalls: recentMetrics.length,
                successRate: last100.length > 0
                    ? last100.filter(m => m.success).length / last100.length
                    : 1,
                avgLatencyMs: last100.length > 0
                    ? last100.reduce((sum, m) => sum + m.latencyMs, 0) / last100.length
                    : 0,
                hourlyCostUsd: lastHour.reduce((sum, m) => sum + m.costUsd, 0),
            },
        };
    }

    /**
     * Get provider recommendation
     */
    getRecommendedProvider(taskType: string): string {
        const healthy = Array.from(providerHealth.values())
            .filter(p => p.available && p.errorRate < 0.1)
            .sort((a, b) => a.avgLatencyMs - b.avgLatencyMs);

        if (healthy.length === 0) {
            return 'qwen'; // Fallback to cheapest
        }

        // Route based on task type
        switch (taskType) {
            case 'safety':
                return 'openai'; // Always use OpenAI for safety
            case 'planning':
                return healthy.find(p => p.provider === 'deepseek')?.provider || healthy[0].provider;
            default:
                return healthy[0].provider; // Fastest available
        }
    }

    /**
     * Check if system is degraded
     */
    isDegraded(): boolean {
        const criticalAlerts = alerts.filter(a =>
            a.severity === 'critical' &&
            (Date.now() - a.timestamp.getTime()) < 15 * 60 * 1000
        );

        return criticalAlerts.length > 0;
    }

    /**
     * Get cost report
     */
    getCostReport(): {
        lastHour: number;
        last24Hours: number;
        byProvider: Record<string, number>;
        byUser: Array<{ userId: string; cost: number }>;
    } {
        const now = Date.now();
        const hourAgo = now - 60 * 60 * 1000;
        const dayAgo = now - 24 * 60 * 60 * 1000;

        const lastHourMetrics = recentMetrics.filter(m => new Date().getTime() > hourAgo);
        const lastDayMetrics = recentMetrics.filter(m => new Date().getTime() > dayAgo);

        const byProvider: Record<string, number> = {};
        const byUser: Record<string, number> = {};

        lastDayMetrics.forEach(m => {
            byProvider[m.provider] = (byProvider[m.provider] || 0) + m.costUsd;
            byUser[m.userId] = (byUser[m.userId] || 0) + m.costUsd;
        });

        const topUsers = Object.entries(byUser)
            .map(([userId, cost]) => ({ userId, cost }))
            .sort((a, b) => b.cost - a.cost)
            .slice(0, 10);

        return {
            lastHour: lastHourMetrics.reduce((sum, m) => sum + m.costUsd, 0),
            last24Hours: lastDayMetrics.reduce((sum, m) => sum + m.costUsd, 0),
            byProvider,
            byUser: topUsers,
        };
    }
}

// Export singleton
export const AIMonitoring = new AIMonitoringService();
export type { AIMetrics, AnomalyAlert, ProviderHealth };
