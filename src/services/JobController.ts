/**
 * Job Controller - Phase E
 * 
 * Background jobs for:
 * - Daily maintenance (streaks, quests, metrics)
 * - Weekly maintenance (recaps, weekly metrics)
 * - Hourly health checks
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { EventLogger } from '../utils/EventLogger.js';
import { MetricsService } from './MetricsService.js';
import { CityService } from './CityService.js';
import { getProviderHealth } from '../utils/reliability.js';

// ============================================
// Types
// ============================================

export interface DailyMetricsSnapshot {
    id: string;
    date: string;
    cityId: string;
    tasksCreated: number;
    tasksAccepted: number;
    tasksCompleted: number;
    tasksCancelled: number;
    disputesOpened: number;
    disputesResolved: number;
    completionRate: number;
    gmvUsd: number;
    platformRevenueUsd: number;
    aiCostUsd: number;
    activeHustlers: number;
    activePosters: number;
    createdAt: Date;
}

export interface WeeklyMetricsSnapshot {
    id: string;
    weekStartDate: string;
    cityId: string;
    tasksCreated: number;
    tasksCompleted: number;
    disputesOpened: number;
    disputesResolved: number;
    completionRate: number;
    gmvUsd: number;
    platformRevenueUsd: number;
    aiCostUsd: number;
    newUsers: number;
    activeUsers: number;
    createdAt: Date;
}

export interface JobResult {
    success: boolean;
    jobName: string;
    executedAt: Date;
    durationMs: number;
    message: string;
    details?: Record<string, unknown>;
}

// ============================================
// In-memory stores (sync to DB)
// ============================================

const dailySnapshots: DailyMetricsSnapshot[] = [];
const weeklySnapshots: WeeklyMetricsSnapshot[] = [];
const jobHistory: JobResult[] = [];

// ============================================
// Job Controller Class
// ============================================

class JobControllerClass {
    // ============================================
    // Daily Maintenance
    // ============================================

    /**
     * Run daily maintenance job
     * Called once per day (night)
     */
    async runDailyMaintenance(): Promise<JobResult> {
        const startTime = Date.now();
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().split('T')[0];

        try {
            serviceLogger.info({ date: dateStr }, 'Starting daily maintenance');

            const results: Record<string, unknown> = {};

            // 1. Snapshot daily metrics per city
            const cities = CityService.getActiveCities();
            for (const city of cities) {
                const snapshot = this.createDailySnapshot(dateStr, city.id);
                dailySnapshots.push(snapshot);
                results[`snapshot_${city.slug}`] = {
                    tasksCompleted: snapshot.tasksCompleted,
                    gmvUsd: snapshot.gmvUsd,
                };
            }

            // 2. Reset daily quests (stub - would update quests table)
            results.questsReset = true;

            // 3. Recalculate streaks (stub - would update streaks table)
            results.streaksUpdated = true;

            // 4. Log maintenance event
            EventLogger.logEvent({
                eventType: 'custom',
                source: 'backend',
                metadata: { job: 'daily_maintenance', date: dateStr },
            });

            const result: JobResult = {
                success: true,
                jobName: 'daily-maintenance',
                executedAt: new Date(),
                durationMs: Date.now() - startTime,
                message: `Daily maintenance completed for ${cities.length} cities`,
                details: results,
            };

            jobHistory.push(result);
            serviceLogger.info({ durationMs: result.durationMs }, 'Daily maintenance complete');
            return result;

        } catch (error) {
            const result: JobResult = {
                success: false,
                jobName: 'daily-maintenance',
                executedAt: new Date(),
                durationMs: Date.now() - startTime,
                message: error instanceof Error ? error.message : 'Unknown error',
            };
            jobHistory.push(result);
            serviceLogger.error({ error }, 'Daily maintenance failed');
            return result;
        }
    }

    /**
     * Create a daily metrics snapshot
     */
    private createDailySnapshot(date: string, cityId: string): DailyMetricsSnapshot {
        // Get funnel data from MetricsService
        const funnel = MetricsService.getGlobalFunnel();
        const aiSummary = MetricsService.getAIMetricsSummary();

        return {
            id: `daily_${uuidv4()}`,
            date,
            cityId,
            tasksCreated: funnel.tasksCreated,
            tasksAccepted: funnel.tasksAccepted,
            tasksCompleted: funnel.tasksCompleted,
            tasksCancelled: 0, // Would need to track this
            disputesOpened: funnel.tasksDisputed,
            disputesResolved: 0, // Would need to track this
            completionRate: funnel.completionRate,
            gmvUsd: 0, // Would aggregate from payouts
            platformRevenueUsd: 0, // Would calculate from fees
            aiCostUsd: aiSummary.reduce((sum, s) => sum + s.totalCostUsd, 0),
            activeHustlers: 0, // Would get from users
            activePosters: 0, // Would get from users
            createdAt: new Date(),
        };
    }

    // ============================================
    // Weekly Maintenance
    // ============================================

    /**
     * Run weekly maintenance job
     * Called once per week
     */
    async runWeeklyMaintenance(): Promise<JobResult> {
        const startTime = Date.now();
        const today = new Date();
        const weekStart = new Date(today);
        weekStart.setDate(weekStart.getDate() - 7);
        const weekStartStr = weekStart.toISOString().split('T')[0];

        try {
            serviceLogger.info({ weekStart: weekStartStr }, 'Starting weekly maintenance');

            const results: Record<string, unknown> = {};

            // 1. Snapshot weekly metrics per city
            const cities = CityService.getActiveCities();
            for (const city of cities) {
                const snapshot = this.createWeeklySnapshot(weekStartStr, city.id);
                weeklySnapshots.push(snapshot);
                results[`snapshot_${city.slug}`] = {
                    tasksCompleted: snapshot.tasksCompleted,
                    gmvUsd: snapshot.gmvUsd,
                };
            }

            // 2. Reset weekly quests (stub)
            results.weeklyQuestsReset = true;

            // 3. Generate weekly recaps (stub - would create recap records)
            results.recapsGenerated = true;

            // 4. Log maintenance event
            EventLogger.logEvent({
                eventType: 'custom',
                source: 'backend',
                metadata: { job: 'weekly_maintenance', weekStart: weekStartStr },
            });

            const result: JobResult = {
                success: true,
                jobName: 'weekly-maintenance',
                executedAt: new Date(),
                durationMs: Date.now() - startTime,
                message: `Weekly maintenance completed for ${cities.length} cities`,
                details: results,
            };

            jobHistory.push(result);
            serviceLogger.info({ durationMs: result.durationMs }, 'Weekly maintenance complete');
            return result;

        } catch (error) {
            const result: JobResult = {
                success: false,
                jobName: 'weekly-maintenance',
                executedAt: new Date(),
                durationMs: Date.now() - startTime,
                message: error instanceof Error ? error.message : 'Unknown error',
            };
            jobHistory.push(result);
            serviceLogger.error({ error }, 'Weekly maintenance failed');
            return result;
        }
    }

    /**
     * Create a weekly metrics snapshot
     */
    private createWeeklySnapshot(weekStartDate: string, cityId: string): WeeklyMetricsSnapshot {
        const funnel = MetricsService.getGlobalFunnel();
        const aiSummary = MetricsService.getAIMetricsSummary();

        return {
            id: `weekly_${uuidv4()}`,
            weekStartDate,
            cityId,
            tasksCreated: funnel.tasksCreated,
            tasksCompleted: funnel.tasksCompleted,
            disputesOpened: funnel.tasksDisputed,
            disputesResolved: 0,
            completionRate: funnel.completionRate,
            gmvUsd: 0,
            platformRevenueUsd: 0,
            aiCostUsd: aiSummary.reduce((sum, s) => sum + s.totalCostUsd, 0),
            newUsers: 0,
            activeUsers: 0,
            createdAt: new Date(),
        };
    }

    // ============================================
    // Hourly Health Check
    // ============================================

    /**
     * Run hourly health check
     * Called every hour
     */
    async runHourlyHealth(): Promise<JobResult> {
        const startTime = Date.now();

        try {
            serviceLogger.info('Starting hourly health check');

            // 1. Check provider health
            const health = getProviderHealth();
            const unhealthyProviders = health.filter(h => !h.healthy);

            // 2. Pre-warm caches (stub - would load rules, zones, etc.)
            const cachesWarmed = true;

            // 3. Log health event if issues
            if (unhealthyProviders.length > 0) {
                EventLogger.logEvent({
                    eventType: 'custom',
                    source: 'backend',
                    metadata: {
                        job: 'hourly_health',
                        unhealthyProviders: unhealthyProviders.map(p => p.provider),
                    },
                });
            }

            const result: JobResult = {
                success: true,
                jobName: 'hourly-health',
                executedAt: new Date(),
                durationMs: Date.now() - startTime,
                message: unhealthyProviders.length > 0
                    ? `Health check found ${unhealthyProviders.length} unhealthy providers`
                    : 'All providers healthy',
                details: {
                    providers: health,
                    cachesWarmed,
                },
            };

            jobHistory.push(result);
            return result;

        } catch (error) {
            const result: JobResult = {
                success: false,
                jobName: 'hourly-health',
                executedAt: new Date(),
                durationMs: Date.now() - startTime,
                message: error instanceof Error ? error.message : 'Unknown error',
            };
            jobHistory.push(result);
            serviceLogger.error({ error }, 'Hourly health check failed');
            return result;
        }
    }

    // ============================================
    // Queries
    // ============================================

    /**
     * Get daily metrics snapshots
     */
    getDailySnapshots(options?: { cityId?: string; limit?: number }): DailyMetricsSnapshot[] {
        let result = [...dailySnapshots];

        if (options?.cityId) {
            result = result.filter(s => s.cityId === options.cityId);
        }

        result.sort((a, b) => b.date.localeCompare(a.date));

        if (options?.limit) {
            result = result.slice(0, options.limit);
        }

        return result;
    }

    /**
     * Get weekly metrics snapshots
     */
    getWeeklySnapshots(options?: { cityId?: string; limit?: number }): WeeklyMetricsSnapshot[] {
        let result = [...weeklySnapshots];

        if (options?.cityId) {
            result = result.filter(s => s.cityId === options.cityId);
        }

        result.sort((a, b) => b.weekStartDate.localeCompare(a.weekStartDate));

        if (options?.limit) {
            result = result.slice(0, options.limit);
        }

        return result;
    }

    /**
     * Get job history
     */
    getJobHistory(limit: number = 20): JobResult[] {
        return jobHistory
            .sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime())
            .slice(0, limit);
    }

    /**
     * Get sample daily metrics row
     */
    getSampleDailyMetricsRow(): DailyMetricsSnapshot {
        return {
            id: 'daily_sample123',
            date: '2024-12-08',
            cityId: 'city_seattle',
            tasksCreated: 45,
            tasksAccepted: 38,
            tasksCompleted: 32,
            tasksCancelled: 3,
            disputesOpened: 2,
            disputesResolved: 1,
            completionRate: 0.71,
            gmvUsd: 1280.50,
            platformRevenueUsd: 192.08,
            aiCostUsd: 0.47,
            activeHustlers: 28,
            activePosters: 19,
            createdAt: new Date(),
        };
    }
}

export const JobController = new JobControllerClass();
