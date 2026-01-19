/**
 * Metrics Service - Phase D
 *
 * Marketplace health metrics:
 * - Global funnel (post → accept → complete → payout)
 * - Zone health (per Seattle neighborhood)
 * - User earnings summary
 * - AI usage and cost summary
 */
import { v4 as uuidv4 } from 'uuid';
import { EventLogger } from '../utils/EventLogger.js';
// ============================================
// In-memory stores
// ============================================
const aiMetrics = [];
const MAX_AI_METRICS = 50000;
// Seattle neighborhoods for zone aggregation
const SEATTLE_ZONES = [
    'Capitol Hill',
    'Ballard',
    'Fremont',
    'University District',
    'Queen Anne',
    'Downtown',
    'South Lake Union',
    'Beacon Hill',
    'Columbia City',
    'West Seattle',
    'Greenwood',
    'Wallingford',
    'Greater Seattle',
];
// ============================================
// AI Usage Logger (called from router)
// ============================================
export function logAIUsage(details) {
    const record = {
        id: uuidv4(),
        ...details,
        createdAt: new Date(),
    };
    aiMetrics.push(record);
    if (aiMetrics.length > MAX_AI_METRICS) {
        aiMetrics.shift();
    }
    // Also log as event for unified view
    EventLogger.aiCall(details.routeType, details.provider, details.latencyMs, details.success, {
        model: details.model,
        tokensIn: details.tokensIn,
        tokensOut: details.tokensOut,
        costUsd: details.costUsd,
    });
    return record;
}
// ============================================
// Metrics Service Class
// ============================================
class MetricsServiceClass {
    // ============================================
    // Global Funnel Metrics
    // ============================================
    getGlobalFunnel(range) {
        const events = EventLogger.getEvents({
            since: range?.since,
            until: range?.until,
        });
        const counts = {};
        for (const event of events) {
            counts[event.eventType] = (counts[event.eventType] || 0) + 1;
        }
        const tasksCreated = counts['task_created'] || 0;
        const tasksAccepted = counts['task_accepted'] || 0;
        const tasksCompleted = counts['task_completed'] || 0;
        const tasksDisputed = counts['dispute_opened'] || 0;
        const tasksRefunded = counts['payout_refunded'] || 0;
        return {
            tasksCreated,
            tasksAccepted,
            tasksCompleted,
            tasksDisputed,
            tasksRefunded,
            completionRate: tasksCreated > 0 ? tasksCompleted / tasksCreated : 0,
            acceptanceRate: tasksCreated > 0 ? tasksAccepted / tasksCreated : 0,
            disputeRate: tasksCompleted > 0 ? tasksDisputed / tasksCompleted : 0,
            refundRate: tasksCompleted > 0 ? tasksRefunded / tasksCompleted : 0,
        };
    }
    // ============================================
    // Zone Health Metrics
    // ============================================
    getZoneHealth(range) {
        const events = EventLogger.getEvents({
            since: range?.since,
            until: range?.until,
        });
        // Group events by zone from metadata
        const zoneData = {};
        // Initialize all zones
        for (const zone of SEATTLE_ZONES) {
            zoneData[zone] = {
                created: 0,
                completed: 0,
                disputed: 0,
                payouts: [],
                acceptTimes: [],
                completeTimes: [],
            };
        }
        // Aggregate by zone
        for (const event of events) {
            const zone = event.metadata?.zone ||
                event.metadata?.neighborhood ||
                'Greater Seattle';
            if (!zoneData[zone]) {
                zoneData[zone] = {
                    created: 0,
                    completed: 0,
                    disputed: 0,
                    payouts: [],
                    acceptTimes: [],
                    completeTimes: [],
                };
            }
            switch (event.eventType) {
                case 'task_created':
                    zoneData[zone].created++;
                    break;
                case 'task_completed':
                    zoneData[zone].completed++;
                    break;
                case 'dispute_opened':
                    zoneData[zone].disputed++;
                    break;
                case 'payout_released':
                    if (typeof event.metadata?.amount === 'number') {
                        zoneData[zone].payouts.push(event.metadata.amount);
                    }
                    break;
            }
        }
        return Object.entries(zoneData)
            .filter(([_, data]) => data.created > 0 || data.completed > 0)
            .map(([zone, data]) => ({
            zone,
            tasksCreated: data.created,
            tasksCompleted: data.completed,
            avgTimeToAcceptSeconds: data.acceptTimes.length > 0
                ? data.acceptTimes.reduce((a, b) => a + b, 0) / data.acceptTimes.length / 1000
                : 0,
            avgTimeToCompleteSeconds: data.completeTimes.length > 0
                ? data.completeTimes.reduce((a, b) => a + b, 0) / data.completeTimes.length / 1000
                : 0,
            avgPayoutUsd: data.payouts.length > 0
                ? data.payouts.reduce((a, b) => a + b, 0) / data.payouts.length
                : 0,
            completionRate: data.created > 0 ? data.completed / data.created : 0,
            disputeRate: data.completed > 0 ? data.disputed / data.completed : 0,
        }))
            .sort((a, b) => b.tasksCompleted - a.tasksCompleted);
    }
    // ============================================
    // User Earnings Summary
    // ============================================
    getUserEarningsSummary(userId, range) {
        const events = EventLogger.getEvents({
            userId,
            since: range?.since,
            until: range?.until,
        });
        let totalTasks = 0;
        let completedTasks = 0;
        let totalEarningsUsd = 0;
        let disputesInvolved = 0;
        let refundsInvolved = 0;
        let xpEarned = 0;
        let streakDays = 0;
        for (const event of events) {
            switch (event.eventType) {
                case 'task_accepted':
                    totalTasks++;
                    break;
                case 'task_completed':
                    completedTasks++;
                    break;
                case 'payout_released':
                    if (typeof event.metadata?.amount === 'number') {
                        totalEarningsUsd += event.metadata.amount;
                    }
                    break;
                case 'dispute_opened':
                case 'dispute_resolved':
                    disputesInvolved++;
                    break;
                case 'payout_refunded':
                    refundsInvolved++;
                    break;
                case 'xp_earned':
                    if (typeof event.metadata?.amount === 'number') {
                        xpEarned += event.metadata.amount;
                    }
                    break;
                case 'streak_updated':
                    if (typeof event.metadata?.days === 'number') {
                        streakDays = Math.max(streakDays, event.metadata.days);
                    }
                    break;
            }
        }
        return {
            userId,
            totalTasks,
            completedTasks,
            totalEarningsUsd,
            avgPerTask: completedTasks > 0 ? totalEarningsUsd / completedTasks : 0,
            disputesInvolved,
            refundsInvolved,
            xpEarned,
            streakDays,
        };
    }
    // ============================================
    // AI Metrics Summary
    // ============================================
    getAIMetricsSummary(range) {
        let metrics = [...aiMetrics];
        if (range?.since) {
            metrics = metrics.filter(m => m.createdAt >= range.since);
        }
        if (range?.until) {
            metrics = metrics.filter(m => m.createdAt <= range.until);
        }
        // Group by provider + routeType
        const grouped = {};
        for (const m of metrics) {
            const key = `${m.provider}|${m.routeType}`;
            if (!grouped[key]) {
                grouped[key] = [];
            }
            grouped[key].push(m);
        }
        return Object.entries(grouped).map(([key, records]) => {
            const [provider, routeType] = key.split('|');
            const successRecords = records.filter(r => r.success);
            const errorRecords = records.filter(r => !r.success);
            const totalCost = records.reduce((sum, r) => sum + r.costUsd, 0);
            const totalLatency = records.reduce((sum, r) => sum + r.latencyMs, 0);
            return {
                provider,
                routeType,
                calls: records.length,
                avgLatencyMs: records.length > 0 ? totalLatency / records.length : 0,
                totalCostUsd: totalCost,
                avgCostPerCallUsd: records.length > 0 ? totalCost / records.length : 0,
                errorRate: records.length > 0 ? errorRecords.length / records.length : 0,
                successCount: successRecords.length,
                errorCount: errorRecords.length,
            };
        }).sort((a, b) => b.calls - a.calls);
    }
    // ============================================
    // Raw Data Access
    // ============================================
    getAIMetrics(range) {
        let metrics = [...aiMetrics];
        if (range?.since) {
            metrics = metrics.filter(m => m.createdAt >= range.since);
        }
        if (range?.until) {
            metrics = metrics.filter(m => m.createdAt <= range.until);
        }
        return metrics.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    /**
     * Get sample AI metric for documentation
     */
    getSampleAIMetric() {
        return aiMetrics[aiMetrics.length - 1] || null;
    }
    // ============================================
    // Overall Stats
    // ============================================
    getOverallStats() {
        const eventCounts = EventLogger.countByType();
        const aiSummary = this.getAIMetricsSummary();
        return {
            events: {
                total: Object.values(eventCounts).reduce((a, b) => a + b, 0),
                byType: eventCounts,
            },
            ai: {
                totalCalls: aiSummary.reduce((sum, s) => sum + s.calls, 0),
                totalCostUsd: aiSummary.reduce((sum, s) => sum + s.totalCostUsd, 0),
                avgLatencyMs: aiSummary.length > 0
                    ? aiSummary.reduce((sum, s) => sum + s.avgLatencyMs * s.calls, 0) /
                        aiSummary.reduce((sum, s) => sum + s.calls, 0)
                    : 0,
            },
            funnel: this.getGlobalFunnel(),
        };
    }
}
export const MetricsService = new MetricsServiceClass();
//# sourceMappingURL=MetricsService.js.map