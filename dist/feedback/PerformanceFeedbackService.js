/**
 * PERFORMANCE FEEDBACK SERVICE (Phase 15C-1 - Flywheel 2)
 *
 * Purpose: Make performance benefits visible to hustlers.
 *
 * This service:
 * - Tracks completion success, proof outcomes, disputes
 * - Calculates zone/category percentile rankings
 * - Shows "what improved / what hurt"
 * - Feeds learning loop
 *
 * CONSTRAINTS:
 * - CANNOT affect payouts
 * - CANNOT prioritize tasks
 * - READ-ONLY feedback
 * - APPEND-ONLY persistence
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { BetaMetricsService } from '../services/BetaMetricsService.js';
const logger = serviceLogger.child({ module: 'PerformanceFeedback' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// PERFORMANCE FEEDBACK SERVICE
// ============================================================
export class PerformanceFeedbackService {
    /**
     * RECORD TASK PERFORMANCE
     * Called when a task completes
     */
    static async recordPerformance(params) {
        const { userId, taskId, category, zone, completed, completionTimeHours, proofAccepted, proofRejected, disputed, earnings } = params;
        // Calculate impact
        const impact = this.calculateImpact({
            completed, completionTimeHours, proofAccepted, proofRejected, disputed
        });
        const event = {
            id: ulid(),
            userId,
            taskId,
            category,
            zone,
            outcome: {
                completed,
                completionTimeHours,
                proofAccepted,
                proofRejected,
                disputed,
                earnings
            },
            impact,
            createdAt: new Date()
        };
        // Persist
        await this.persistEvent(event);
        // Emit metric
        BetaMetricsService.recordEvent('performance_feedback', {
            impact: impact.reputationImpact,
            delta: impact.opportunityScoreDelta
        });
        logger.info({
            userId,
            taskId,
            impact: impact.reputationImpact,
            delta: impact.opportunityScoreDelta
        }, 'Performance feedback recorded');
        return event;
    }
    /**
     * GET PERFORMANCE SUMMARY
     */
    static async getSummary(userId, days = 30) {
        const db = getDb();
        const defaultSummary = {
            userId,
            periodDays: days,
            stats: {
                totalTasks: 0,
                completionRate: 0,
                avgCompletionTimeHours: 0,
                proofAcceptanceRate: 0,
                disputeRate: 0,
                totalEarnings: 0
            },
            rankings: {
                zonePercentile: 50,
                categoryPercentile: 50,
                overallPercentile: 50
            },
            analysis: {
                strengths: ['Complete more tasks to see your strengths'],
                improvements: [],
                opportunities: ['Take on tasks to build your track record']
            },
            trend: 'stable',
            trendExplanation: 'Not enough data to determine trend'
        };
        if (!db)
            return defaultSummary;
        try {
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            const rows = await db `
                SELECT data FROM performance_feedback_events 
                WHERE user_id = ${userId}
                AND created_at >= ${since}
                ORDER BY created_at DESC
                LIMIT 100
            `;
            if (rows.length === 0)
                return defaultSummary;
            const events = rows.map((r) => r.data);
            // Calculate stats
            const stats = this.calculateStats(events);
            // Calculate rankings (simplified - would need zone/category aggregates in prod)
            const rankings = this.calculateRankings(stats);
            // Analyze strengths/improvements
            const analysis = this.analyzePerformance(events, stats);
            // Determine trend
            const { trend, explanation } = this.calculateTrend(events);
            return {
                userId,
                periodDays: days,
                stats,
                rankings,
                analysis,
                trend,
                trendExplanation: explanation
            };
        }
        catch (error) {
            logger.error({ error, userId }, 'Failed to get performance summary');
            return defaultSummary;
        }
    }
    /**
     * GET RECENT FEEDBACK
     */
    static async getRecentFeedback(userId, limit = 10) {
        const db = getDb();
        if (!db)
            return [];
        try {
            const rows = await db `
                SELECT data FROM performance_feedback_events 
                WHERE user_id = ${userId}
                ORDER BY created_at DESC
                LIMIT ${limit}
            `;
            return rows.map((r) => {
                const event = r.data;
                return {
                    event,
                    feedback: this.generateFeedbackMessage(event)
                };
            });
        }
        catch (error) {
            logger.error({ error, userId }, 'Failed to get recent feedback');
            return [];
        }
    }
    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------
    static calculateImpact(outcome) {
        let delta = 0;
        const reasons = [];
        // Positive factors
        if (outcome.completed) {
            delta += 5;
            reasons.push('+5 for task completion');
        }
        if (outcome.proofAccepted) {
            delta += 3;
            reasons.push('+3 for accepted proof');
        }
        if (outcome.completionTimeHours < 2) {
            delta += 2;
            reasons.push('+2 for fast completion');
        }
        // Negative factors
        if (outcome.proofRejected) {
            delta -= 5;
            reasons.push('-5 for rejected proof');
        }
        if (outcome.disputed) {
            delta -= 10;
            reasons.push('-10 for dispute involvement');
        }
        if (!outcome.completed) {
            delta -= 3;
            reasons.push('-3 for incomplete task');
        }
        const reputationImpact = delta > 3 ? 'positive'
            : delta < -3 ? 'negative'
                : 'neutral';
        return {
            opportunityScoreDelta: delta,
            reputationImpact,
            reasons
        };
    }
    static calculateStats(events) {
        const completed = events.filter(e => e.outcome.completed);
        const proofEvents = events.filter(e => e.outcome.proofAccepted || e.outcome.proofRejected);
        const disputed = events.filter(e => e.outcome.disputed);
        return {
            totalTasks: events.length,
            completionRate: events.length > 0 ? completed.length / events.length : 0,
            avgCompletionTimeHours: completed.length > 0
                ? completed.reduce((sum, e) => sum + e.outcome.completionTimeHours, 0) / completed.length
                : 0,
            proofAcceptanceRate: proofEvents.length > 0
                ? events.filter(e => e.outcome.proofAccepted).length / proofEvents.length
                : 1,
            disputeRate: events.length > 0 ? disputed.length / events.length : 0,
            totalEarnings: events.reduce((sum, e) => sum + e.outcome.earnings, 0)
        };
    }
    static calculateRankings(stats) {
        // Simplified ranking calculation
        // In production, this would compare against zone/category aggregates
        let basePercentile = 50;
        // Adjust based on performance
        if (stats.completionRate > 0.95)
            basePercentile += 20;
        else if (stats.completionRate > 0.85)
            basePercentile += 10;
        else if (stats.completionRate < 0.7)
            basePercentile -= 20;
        if (stats.disputeRate < 0.02)
            basePercentile += 10;
        else if (stats.disputeRate > 0.05)
            basePercentile -= 15;
        if (stats.proofAcceptanceRate > 0.95)
            basePercentile += 5;
        const percentile = Math.max(1, Math.min(99, basePercentile));
        return {
            zonePercentile: percentile,
            categoryPercentile: percentile,
            overallPercentile: percentile
        };
    }
    static analyzePerformance(events, stats) {
        const strengths = [];
        const improvements = [];
        const opportunities = [];
        // Strengths
        if (stats.completionRate > 0.9) {
            strengths.push('Excellent completion rate');
        }
        if (stats.proofAcceptanceRate > 0.95) {
            strengths.push('High-quality proof submissions');
        }
        if (stats.disputeRate === 0) {
            strengths.push('Zero dispute record');
        }
        if (stats.avgCompletionTimeHours < 3) {
            strengths.push('Fast task completion');
        }
        // Improvements
        if (stats.completionRate < 0.8) {
            improvements.push('Focus on completing accepted tasks');
        }
        if (stats.proofAcceptanceRate < 0.85) {
            improvements.push('Improve proof photo quality');
        }
        if (stats.disputeRate > 0.03) {
            improvements.push('Review task details more carefully before accepting');
        }
        // Opportunities
        const positiveEvents = events.filter(e => e.impact.reputationImpact === 'positive');
        if (positiveEvents.length > 0) {
            const topCategory = this.getMostFrequentCategory(positiveEvents);
            if (topCategory) {
                opportunities.push(`You excel in ${topCategory} tasks - seek more of these`);
            }
        }
        if (strengths.length === 0)
            strengths.push('Keep building your track record');
        return { strengths, improvements, opportunities };
    }
    static getMostFrequentCategory(events) {
        const counts = new Map();
        for (const e of events) {
            counts.set(e.category, (counts.get(e.category) || 0) + 1);
        }
        let maxCategory = null;
        let maxCount = 0;
        for (const [cat, count] of counts) {
            if (count > maxCount) {
                maxCount = count;
                maxCategory = cat;
            }
        }
        return maxCategory;
    }
    static calculateTrend(events) {
        if (events.length < 5) {
            return { trend: 'stable', explanation: 'Not enough data to determine trend' };
        }
        // Compare first half vs second half
        const half = Math.floor(events.length / 2);
        const recentEvents = events.slice(0, half);
        const olderEvents = events.slice(half);
        const recentPositive = recentEvents.filter(e => e.impact.reputationImpact === 'positive').length;
        const olderPositive = olderEvents.filter(e => e.impact.reputationImpact === 'positive').length;
        const recentRate = recentPositive / recentEvents.length;
        const olderRate = olderPositive / olderEvents.length;
        if (recentRate > olderRate + 0.1) {
            return { trend: 'improving', explanation: 'Your recent performance is better than before' };
        }
        if (recentRate < olderRate - 0.1) {
            return { trend: 'declining', explanation: 'Your recent performance needs attention' };
        }
        return { trend: 'stable', explanation: 'Your performance is consistent' };
    }
    static generateFeedbackMessage(event) {
        if (event.impact.reputationImpact === 'positive') {
            return `Great job! ${event.impact.reasons[0] || 'Task completed successfully'}`;
        }
        if (event.impact.reputationImpact === 'negative') {
            return `Attention needed: ${event.impact.reasons[0] || 'Review task outcome'}`;
        }
        return 'Task recorded - keep up the work!';
    }
    static async persistEvent(event) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO performance_feedback_events (
                    id, user_id, task_id, category, zone,
                    reputation_impact, data, created_at
                ) VALUES (
                    ${event.id}, ${event.userId}, ${event.taskId}, ${event.category}, ${event.zone || null},
                    ${event.impact.reputationImpact}, ${JSON.stringify(event)}, ${event.createdAt}
                )
            `;
        }
        catch (error) {
            logger.error({ error, userId: event.userId }, 'Failed to persist performance feedback');
        }
    }
}
//# sourceMappingURL=PerformanceFeedbackService.js.map