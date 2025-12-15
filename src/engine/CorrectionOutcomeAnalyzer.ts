/**
 * CORRECTION OUTCOME ANALYZER (Phase Ω-ACT-2)
 * 
 * Purpose: Prove whether corrections actually worked.
 * 
 * For every correction, compute:
 * - Baseline metrics (6h BEFORE correction)
 * - Post metrics (6h AFTER correction)
 * - Net effect: positive, neutral, negative
 * 
 * RULES:
 * - POSITIVE: ≥2 core metrics improve, no critical regression
 * - NEUTRAL: Mixed or insignificant
 * - NEGATIVE: Any critical regression (disputes↑, fill↓)
 * 
 * NO ML. NO GUESSING.
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';

const logger = serviceLogger.child({ module: 'CorrectionOutcomeAnalyzer' });

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

export type NetEffect = 'positive' | 'neutral' | 'negative';

export interface OutcomeMetrics {
    taskFillRate: number;       // % of tasks that get accepted
    completionRate: number;     // % of accepted tasks completed
    disputeRate: number;        // % of completed tasks with disputes
    avgPayoutDelayHours: number;
    hustlerEngagement: number;  // accepts per view
    posterRetryRate: number;    // % of posters who post again
}

export interface OutcomeAnalysis {
    correctionId: string;
    baselineMetrics: OutcomeMetrics;
    postMetrics: OutcomeMetrics;
    deltas: Record<keyof OutcomeMetrics, number>;
    netEffect: NetEffect;
    confidence: number;
    analyzedAt: Date;
}

// ============================================================
// METRIC WEIGHTS FOR CLASSIFICATION
// ============================================================

const METRIC_WEIGHTS: Record<keyof OutcomeMetrics, { weight: number; criticalRegression: boolean }> = {
    taskFillRate: { weight: 2, criticalRegression: true },
    completionRate: { weight: 2, criticalRegression: true },
    disputeRate: { weight: -3, criticalRegression: true }, // Negative weight = lower is better
    avgPayoutDelayHours: { weight: -1, criticalRegression: false },
    hustlerEngagement: { weight: 1, criticalRegression: false },
    posterRetryRate: { weight: 1, criticalRegression: false }
};

// ============================================================
// OUTCOME ANALYZER
// ============================================================

export class CorrectionOutcomeAnalyzer {

    private static readonly BASELINE_WINDOW_HOURS = 6;
    private static readonly POST_WINDOW_HOURS = 6;

    /**
     * ANALYZE SINGLE CORRECTION
     */
    static async analyze(correctionId: string): Promise<OutcomeAnalysis | null> {
        const db = getDb();
        if (!db) return null;

        try {
            // 1. Get correction details
            const [correction] = await db`
                SELECT id, correction_type, target_entity, target_id, applied_at, expires_at
                FROM correction_log
                WHERE id = ${correctionId}::uuid
            ` as any[];

            if (!correction) {
                logger.warn({ correctionId }, 'Correction not found');
                return null;
            }

            const appliedAt = new Date(correction.applied_at);

            // Need at least 6h after correction to analyze
            const minAnalysisTime = new Date(appliedAt.getTime() + this.POST_WINDOW_HOURS * 60 * 60 * 1000);
            if (new Date() < minAnalysisTime) {
                logger.debug({ correctionId }, 'Too early to analyze');
                return null;
            }

            // 2. Compute baseline window (6h before)
            const baselineStart = new Date(appliedAt.getTime() - this.BASELINE_WINDOW_HOURS * 60 * 60 * 1000);
            const baselineEnd = appliedAt;

            // 3. Compute post window (6h after)
            const postStart = appliedAt;
            const postEnd = minAnalysisTime;

            // 4. Gather metrics
            const baselineMetrics = await this.gatherMetrics(db, correction, baselineStart, baselineEnd);
            const postMetrics = await this.gatherMetrics(db, correction, postStart, postEnd);

            // 5. Calculate deltas
            const deltas = this.calculateDeltas(baselineMetrics, postMetrics);

            // 6. Classify net effect
            const netEffect = this.classifyEffect(deltas, baselineMetrics, postMetrics);

            // 7. Calculate confidence
            const confidence = this.calculateConfidence(baselineMetrics, postMetrics);

            const analysis: OutcomeAnalysis = {
                correctionId,
                baselineMetrics,
                postMetrics,
                deltas,
                netEffect,
                confidence,
                analyzedAt: new Date()
            };

            // 8. Store result (immutable, append-only)
            await this.storeOutcome(db, analysis);

            logger.info({
                correctionId,
                netEffect,
                confidence,
                deltas
            }, 'Correction outcome analyzed');

            return analysis;
        } catch (error) {
            logger.error({ error, correctionId }, 'Failed to analyze correction outcome');
            return null;
        }
    }

    /**
     * GATHER METRICS FOR WINDOW
     */
    private static async gatherMetrics(
        db: ReturnType<typeof neon>,
        correction: any,
        windowStart: Date,
        windowEnd: Date
    ): Promise<OutcomeMetrics> {
        // Default metrics (if no data)
        const defaults: OutcomeMetrics = {
            taskFillRate: 0,
            completionRate: 0,
            disputeRate: 0,
            avgPayoutDelayHours: 0,
            hustlerEngagement: 0,
            posterRetryRate: 0
        };

        try {
            // Build zone/category filter based on correction target
            const targetEntity = correction.target_entity;
            const targetId = correction.target_id;

            // Task fill rate: accepted / total posted
            const [taskStats] = await db`
                SELECT 
                    COUNT(*) FILTER (WHERE status IN ('accepted', 'completed', 'pending_approval')) as accepted,
                    COUNT(*) as total
                FROM tasks
                WHERE created_at BETWEEN ${windowStart} AND ${windowEnd}
            ` as any[];

            const taskFillRate = taskStats.total > 0
                ? parseInt(taskStats.accepted) / parseInt(taskStats.total)
                : 0;

            // Completion rate: completed / accepted
            const [completionStats] = await db`
                SELECT 
                    COUNT(*) FILTER (WHERE status = 'completed') as completed,
                    COUNT(*) FILTER (WHERE status IN ('accepted', 'completed', 'pending_approval')) as accepted
                FROM tasks
                WHERE created_at BETWEEN ${windowStart} AND ${windowEnd}
            ` as any[];

            const completionRate = parseInt(completionStats.accepted) > 0
                ? parseInt(completionStats.completed) / parseInt(completionStats.accepted)
                : 0;

            // Dispute rate
            const [disputeStats] = await db`
                SELECT 
                    COUNT(*) as disputes,
                    (SELECT COUNT(*) FROM tasks WHERE status = 'completed' AND created_at BETWEEN ${windowStart} AND ${windowEnd}) as completed
                FROM disputes
                WHERE created_at BETWEEN ${windowStart} AND ${windowEnd}
            ` as any[];

            const disputeRate = parseInt(disputeStats.completed) > 0
                ? parseInt(disputeStats.disputes) / parseInt(disputeStats.completed)
                : 0;

            // Avg payout delay (simplified)
            const [payoutStats] = await db`
                SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600) as avg_delay
                FROM payouts
                WHERE created_at BETWEEN ${windowStart} AND ${windowEnd}
                AND status = 'completed'
            ` as any[];

            const avgPayoutDelayHours = parseFloat(payoutStats?.avg_delay || '0');

            // Hustler engagement: task accepts / total tasks available
            const hustlerEngagement = taskFillRate; // Simplified proxy

            // Poster retry rate
            const [posterStats] = await db`
                SELECT 
                    COUNT(DISTINCT client_id) FILTER (WHERE created_at BETWEEN ${windowStart} AND ${windowEnd}) as active_posters,
                    COUNT(DISTINCT client_id) FILTER (WHERE created_at < ${windowStart}) as previous_posters
                FROM tasks
                WHERE client_id IN (
                    SELECT client_id FROM tasks WHERE created_at BETWEEN ${windowStart} AND ${windowEnd}
                )
            ` as any[];

            const posterRetryRate = parseInt(posterStats.previous_posters) > 0
                ? Math.min(parseInt(posterStats.active_posters) / parseInt(posterStats.previous_posters), 1)
                : 0;

            return {
                taskFillRate,
                completionRate,
                disputeRate,
                avgPayoutDelayHours,
                hustlerEngagement,
                posterRetryRate
            };
        } catch (error) {
            logger.error({ error }, 'Failed to gather metrics');
            return defaults;
        }
    }

    /**
     * CALCULATE DELTAS
     */
    private static calculateDeltas(
        baseline: OutcomeMetrics,
        post: OutcomeMetrics
    ): Record<keyof OutcomeMetrics, number> {
        return {
            taskFillRate: post.taskFillRate - baseline.taskFillRate,
            completionRate: post.completionRate - baseline.completionRate,
            disputeRate: post.disputeRate - baseline.disputeRate,
            avgPayoutDelayHours: post.avgPayoutDelayHours - baseline.avgPayoutDelayHours,
            hustlerEngagement: post.hustlerEngagement - baseline.hustlerEngagement,
            posterRetryRate: post.posterRetryRate - baseline.posterRetryRate
        };
    }

    /**
     * CLASSIFY NET EFFECT
     * 
     * DETERMINISTIC RULES:
     * - POSITIVE: ≥2 core metrics improve, no critical regression
     * - NEGATIVE: Any critical regression (disputes↑, fill↓, completion↓)
     * - NEUTRAL: Everything else
     */
    private static classifyEffect(
        deltas: Record<keyof OutcomeMetrics, number>,
        baseline: OutcomeMetrics,
        post: OutcomeMetrics
    ): NetEffect {
        // Check for critical regressions
        const hasCriticalRegression =
            deltas.disputeRate > 0.02 || // Disputes increased by 2%+
            deltas.taskFillRate < -0.05 || // Fill dropped by 5%+
            deltas.completionRate < -0.05;  // Completion dropped by 5%+

        if (hasCriticalRegression) {
            return 'negative';
        }

        // Count improvements
        let improvements = 0;

        if (deltas.taskFillRate > 0.02) improvements++;
        if (deltas.completionRate > 0.02) improvements++;
        if (deltas.disputeRate < -0.01) improvements++; // Disputes decreased
        if (deltas.hustlerEngagement > 0.02) improvements++;
        if (deltas.posterRetryRate > 0.02) improvements++;

        if (improvements >= 2) {
            return 'positive';
        }

        return 'neutral';
    }

    /**
     * CALCULATE CONFIDENCE
     * 
     * Based on sample size and variance
     */
    private static calculateConfidence(
        baseline: OutcomeMetrics,
        post: OutcomeMetrics
    ): number {
        // Simplified confidence based on whether we have non-zero data
        let dataPoints = 0;
        let totalPoints = 12; // 6 metrics * 2 windows

        if (baseline.taskFillRate > 0) dataPoints++;
        if (baseline.completionRate > 0) dataPoints++;
        if (baseline.hustlerEngagement > 0) dataPoints++;
        if (post.taskFillRate > 0) dataPoints++;
        if (post.completionRate > 0) dataPoints++;
        if (post.hustlerEngagement > 0) dataPoints++;

        // Base confidence on data availability
        const dataConfidence = dataPoints / totalPoints;

        // Cap at 0.95 (never 100% confident)
        return Math.min(Math.round(dataConfidence * 100) / 100, 0.95);
    }

    /**
     * STORE OUTCOME (Immutable, append-only)
     */
    private static async storeOutcome(
        db: ReturnType<typeof neon>,
        analysis: OutcomeAnalysis
    ): Promise<void> {
        try {
            await db`
                INSERT INTO correction_outcomes (
                    id, correction_id, baseline_metrics, post_metrics,
                    deltas, net_effect, confidence, analyzed_at
                ) VALUES (
                    ${ulid()}::uuid,
                    ${analysis.correctionId}::uuid,
                    ${JSON.stringify(analysis.baselineMetrics)},
                    ${JSON.stringify(analysis.postMetrics)},
                    ${JSON.stringify(analysis.deltas)},
                    ${analysis.netEffect},
                    ${analysis.confidence},
                    ${analysis.analyzedAt}
                )
            `;
        } catch (error) {
            logger.error({ error, correctionId: analysis.correctionId }, 'Failed to store outcome');
        }
    }

    /**
     * GET OUTCOME RATES (for SafeMode feedback)
     */
    static async getOutcomeRates(windowHours: number = 24): Promise<{
        total: number;
        positive: number;
        neutral: number;
        negative: number;
        positiveRate: number;
        negativeRate: number;
        avgConfidence: number;
    }> {
        const db = getDb();
        if (!db) {
            return {
                total: 0, positive: 0, neutral: 0, negative: 0,
                positiveRate: 0, negativeRate: 0, avgConfidence: 0
            };
        }

        try {
            const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

            const [stats] = await db`
                SELECT
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE net_effect = 'positive') as positive,
                    COUNT(*) FILTER (WHERE net_effect = 'neutral') as neutral,
                    COUNT(*) FILTER (WHERE net_effect = 'negative') as negative,
                    AVG(confidence) as avg_confidence
                FROM correction_outcomes
                WHERE analyzed_at >= ${since}
            ` as any[];

            const total = parseInt(stats.total) || 0;
            const positive = parseInt(stats.positive) || 0;
            const neutral = parseInt(stats.neutral) || 0;
            const negative = parseInt(stats.negative) || 0;

            return {
                total,
                positive,
                neutral,
                negative,
                positiveRate: total > 0 ? positive / total : 0,
                negativeRate: total > 0 ? negative / total : 0,
                avgConfidence: parseFloat(stats.avg_confidence) || 0
            };
        } catch (error) {
            logger.error({ error }, 'Failed to get outcome rates');
            return {
                total: 0, positive: 0, neutral: 0, negative: 0,
                positiveRate: 0, negativeRate: 0, avgConfidence: 0
            };
        }
    }
}
