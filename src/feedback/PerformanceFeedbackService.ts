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

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

// ============================================================
// TYPES
// ============================================================

export interface PerformanceEvent {
    id: string;
    userId: string;
    taskId: string;
    category: string;
    zone?: string;

    // Task outcome
    outcome: {
        completed: boolean;
        completionTimeHours: number;
        proofAccepted: boolean;
        proofRejected: boolean;
        disputed: boolean;
        earnings: number;
    };

    // Scoring impact
    impact: {
        opportunityScoreDelta: number;    // How this task affected their score
        reputationImpact: 'positive' | 'neutral' | 'negative';
        reasons: string[];
    };

    createdAt: Date;
}

export interface PerformanceSummary {
    userId: string;
    periodDays: number;

    // Performance stats
    stats: {
        totalTasks: number;
        completionRate: number;
        avgCompletionTimeHours: number;
        proofAcceptanceRate: number;
        disputeRate: number;
        totalEarnings: number;
    };

    // Rankings
    rankings: {
        zonePercentile: number;           // Top X% in their zone
        categoryPercentile: number;       // Top X% in their categories
        overallPercentile: number;
    };

    // What's helping / hurting
    analysis: {
        strengths: string[];
        improvements: string[];
        opportunities: string[];
    };

    // Trend
    trend: 'improving' | 'stable' | 'declining';
    trendExplanation: string;
}

// ============================================================
// PERFORMANCE FEEDBACK SERVICE
// ============================================================

export class PerformanceFeedbackService {

    /**
     * RECORD TASK PERFORMANCE
     * Called when a task completes
     */
    static async recordPerformance(params: {
        userId: string;
        taskId: string;
        category: string;
        zone?: string;
        completed: boolean;
        completionTimeHours: number;
        proofAccepted: boolean;
        proofRejected: boolean;
        disputed: boolean;
        earnings: number;
    }): Promise<PerformanceEvent> {
        const {
            userId, taskId, category, zone,
            completed, completionTimeHours, proofAccepted, proofRejected, disputed, earnings
        } = params;

        // Calculate impact
        const impact = this.calculateImpact({
            completed, completionTimeHours, proofAccepted, proofRejected, disputed
        });

        const event: PerformanceEvent = {
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
    static async getSummary(userId: string, days: number = 30): Promise<PerformanceSummary> {
        const db = getDb();

        const defaultSummary: PerformanceSummary = {
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

        if (!db) return defaultSummary;

        try {
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            const rows = await db`
                SELECT data FROM performance_feedback_events 
                WHERE user_id = ${userId}
                AND created_at >= ${since}
                ORDER BY created_at DESC
                LIMIT 100
            ` as any[];

            if (rows.length === 0) return defaultSummary;

            const events: PerformanceEvent[] = rows.map((r: any) => r.data);

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

        } catch (error) {
            logger.error({ error, userId }, 'Failed to get performance summary');
            return defaultSummary;
        }
    }

    /**
     * GET RECENT FEEDBACK
     */
    static async getRecentFeedback(userId: string, limit: number = 10): Promise<{
        event: PerformanceEvent;
        feedback: string;
    }[]> {
        const db = getDb();
        if (!db) return [];

        try {
            const rows = await db`
                SELECT data FROM performance_feedback_events 
                WHERE user_id = ${userId}
                ORDER BY created_at DESC
                LIMIT ${limit}
            ` as any[];

            return rows.map((r: any) => {
                const event: PerformanceEvent = r.data;
                return {
                    event,
                    feedback: this.generateFeedbackMessage(event)
                };
            });

        } catch (error) {
            logger.error({ error, userId }, 'Failed to get recent feedback');
            return [];
        }
    }

    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------

    private static calculateImpact(outcome: {
        completed: boolean;
        completionTimeHours: number;
        proofAccepted: boolean;
        proofRejected: boolean;
        disputed: boolean;
    }): PerformanceEvent['impact'] {
        let delta = 0;
        const reasons: string[] = [];

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

        const reputationImpact = delta > 3 ? 'positive' as const
            : delta < -3 ? 'negative' as const
                : 'neutral' as const;

        return {
            opportunityScoreDelta: delta,
            reputationImpact,
            reasons
        };
    }

    private static calculateStats(events: PerformanceEvent[]): PerformanceSummary['stats'] {
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

    private static calculateRankings(stats: PerformanceSummary['stats']): PerformanceSummary['rankings'] {
        // Simplified ranking calculation
        // In production, this would compare against zone/category aggregates

        let basePercentile = 50;

        // Adjust based on performance
        if (stats.completionRate > 0.95) basePercentile += 20;
        else if (stats.completionRate > 0.85) basePercentile += 10;
        else if (stats.completionRate < 0.7) basePercentile -= 20;

        if (stats.disputeRate < 0.02) basePercentile += 10;
        else if (stats.disputeRate > 0.05) basePercentile -= 15;

        if (stats.proofAcceptanceRate > 0.95) basePercentile += 5;

        const percentile = Math.max(1, Math.min(99, basePercentile));

        return {
            zonePercentile: percentile,
            categoryPercentile: percentile,
            overallPercentile: percentile
        };
    }

    private static analyzePerformance(
        events: PerformanceEvent[],
        stats: PerformanceSummary['stats']
    ): PerformanceSummary['analysis'] {
        const strengths: string[] = [];
        const improvements: string[] = [];
        const opportunities: string[] = [];

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

        if (strengths.length === 0) strengths.push('Keep building your track record');

        return { strengths, improvements, opportunities };
    }

    private static getMostFrequentCategory(events: PerformanceEvent[]): string | null {
        const counts = new Map<string, number>();
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

    private static calculateTrend(events: PerformanceEvent[]): {
        trend: PerformanceSummary['trend'];
        explanation: string
    } {
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

    private static generateFeedbackMessage(event: PerformanceEvent): string {
        if (event.impact.reputationImpact === 'positive') {
            return `Great job! ${event.impact.reasons[0] || 'Task completed successfully'}`;
        }
        if (event.impact.reputationImpact === 'negative') {
            return `Attention needed: ${event.impact.reasons[0] || 'Review task outcome'}`;
        }
        return 'Task recorded - keep up the work!';
    }

    private static async persistEvent(event: PerformanceEvent): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO performance_feedback_events (
                    id, user_id, task_id, category, zone,
                    reputation_impact, data, created_at
                ) VALUES (
                    ${event.id}, ${event.userId}, ${event.taskId}, ${event.category}, ${event.zone || null},
                    ${event.impact.reputationImpact}, ${JSON.stringify(event)}, ${event.createdAt}
                )
            `;
        } catch (error) {
            logger.error({ error, userId: event.userId }, 'Failed to persist performance feedback');
        }
    }
}
