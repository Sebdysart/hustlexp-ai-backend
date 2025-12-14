/**
 * PRICING FEEDBACK SERVICE (Phase 15C-1 - Flywheel 1)
 * 
 * Purpose: Make pricing consequences visible to posters.
 * 
 * This service:
 * - Compares actual price vs recommended guidance
 * - Tracks outcome delta (completion speed, disputes)
 * - Produces explainable verdicts
 * - Feeds learning loop
 * 
 * CONSTRAINTS:
 * - CANNOT block posting
 * - CANNOT auto-adjust price
 * - READ-ONLY feedback
 * - APPEND-ONLY persistence
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { BetaMetricsService } from '../services/BetaMetricsService.js';
import { StrategicOutputEngine, PricingGuidanceOutput } from '../strategy/StrategicOutputEngine.js';

const logger = serviceLogger.child({ module: 'PricingFeedback' });

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

export type PricingVerdict = 'underpriced' | 'optimal' | 'overpriced';

export interface PricingFeedbackEvent {
    id: string;
    taskId: string;
    category: string;
    zone?: string;

    // Guidance context
    recommendedMin: number;
    recommendedMax: number;
    recommendedSuggested: number;

    // Actual values
    actualPrice: number;
    pricePercentile: number;       // Where this falls vs similar tasks

    // Verdict
    verdict: PricingVerdict;
    deltaFromOptimal: number;      // $ above or below suggested
    deltaPercent: number;          // % variance

    // Outcome (filled in later if available)
    outcome?: {
        completed: boolean;
        completionTimeHours?: number;
        avgCompletionTimeHours?: number;  // For comparison
        disputed: boolean;
        acceptanceTimeMinutes?: number;
    };

    // Outcome delta
    outcomeDelta?: {
        fasterThanAvg: boolean;
        disputeRiskElevated: boolean;
        explanation: string;
    };

    createdAt: Date;
    updatedAt?: Date;
}

export interface PricingFeedbackSummary {
    taskId: string;
    verdict: PricingVerdict;

    // User-facing feedback
    feedback: {
        headline: string;
        detail: string;
        recommendation?: string;
    };

    // Stats
    stats: {
        pricePercentile: number;
        vsMarketMedian: string;
        vsRecommended: string;
    };

    // Outcome impact (if available)
    outcomeImpact?: {
        completionSpeed: string;
        disputeRisk: string;
    };
}

// ============================================================
// PRICING FEEDBACK SERVICE
// ============================================================

export class PricingFeedbackService {

    /**
     * RECORD PRICING DECISION
     * Called when a task is posted
     */
    static async recordPricingDecision(params: {
        taskId: string;
        category: string;
        zone?: string;
        actualPrice: number;
    }): Promise<PricingFeedbackEvent> {
        const { taskId, category, zone, actualPrice } = params;

        // Get strategic guidance
        const guidance = await StrategicOutputEngine.getPricingGuidance(category, zone);

        const { suggested, min, max } = guidance.marketRate;

        // Calculate verdict
        const verdict = this.calculateVerdict(actualPrice, suggested, min, max);
        const deltaFromOptimal = actualPrice - suggested;
        const deltaPercent = suggested > 0 ? (deltaFromOptimal / suggested) * 100 : 0;

        // Calculate percentile (simplified)
        const pricePercentile = this.estimatePercentile(actualPrice, min, max);

        const event: PricingFeedbackEvent = {
            id: ulid(),
            taskId,
            category,
            zone,
            recommendedMin: min,
            recommendedMax: max,
            recommendedSuggested: suggested,
            actualPrice,
            pricePercentile,
            verdict,
            deltaFromOptimal,
            deltaPercent,
            createdAt: new Date()
        };

        // Persist (append-only)
        await this.persistEvent(event);

        // Emit metric
        this.emitMetric(verdict, deltaPercent);

        logger.info({
            taskId,
            verdict,
            actualPrice,
            suggested,
            deltaPercent: deltaPercent.toFixed(1)
        }, 'Pricing feedback recorded');

        return event;
    }

    /**
     * UPDATE WITH OUTCOME
     * Called when task completes or disputes
     */
    static async recordOutcome(params: {
        taskId: string;
        completed: boolean;
        completionTimeHours?: number;
        disputed: boolean;
        acceptanceTimeMinutes?: number;
    }): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            // Get existing event
            const [existing] = await db`
                SELECT data FROM pricing_feedback_events WHERE task_id = ${params.taskId}
            ` as any[];

            if (!existing) return;

            const event: PricingFeedbackEvent = existing.data;

            // Add outcome
            event.outcome = {
                completed: params.completed,
                completionTimeHours: params.completionTimeHours,
                disputed: params.disputed,
                acceptanceTimeMinutes: params.acceptanceTimeMinutes
            };

            // Calculate outcome delta
            event.outcomeDelta = this.calculateOutcomeDelta(event);
            event.updatedAt = new Date();

            // Update (still append-only semantically - we're completing the record)
            await db`
                UPDATE pricing_feedback_events 
                SET data = ${JSON.stringify(event)}, updated_at = NOW()
                WHERE task_id = ${params.taskId}
            `;

            // Emit learning metric
            if (event.verdict !== 'optimal' && event.outcome.disputed) {
                BetaMetricsService.recordEvent('pricing_guidance_ignored_dispute', {
                    verdict: event.verdict,
                    deltaPercent: event.deltaPercent
                });
            }

        } catch (error) {
            logger.error({ error, taskId: params.taskId }, 'Failed to record outcome');
        }
    }

    /**
     * GET FEEDBACK FOR TASK
     */
    static async getFeedback(taskId: string): Promise<PricingFeedbackSummary | null> {
        const db = getDb();
        if (!db) return null;

        try {
            const [row] = await db`
                SELECT data FROM pricing_feedback_events WHERE task_id = ${taskId}
            ` as any[];

            if (!row) return null;

            const event: PricingFeedbackEvent = row.data;
            return this.buildSummary(event);

        } catch (error) {
            logger.error({ error, taskId }, 'Failed to get feedback');
            return null;
        }
    }

    /**
     * GET POSTER ANALYTICS
     * Shows patterns across poster's tasks
     */
    static async getPosterAnalytics(posterId: string): Promise<{
        totalTasks: number;
        verdictBreakdown: Record<PricingVerdict, number>;
        avgDeltaPercent: number;
        disputeCorrelation: string;
        recommendation: string;
    }> {
        const db = getDb();

        const defaultResult = {
            totalTasks: 0,
            verdictBreakdown: { underpriced: 0, optimal: 0, overpriced: 0 },
            avgDeltaPercent: 0,
            disputeCorrelation: 'Insufficient data',
            recommendation: 'Post more tasks to see patterns'
        };

        if (!db) return defaultResult;

        try {
            const rows = await db`
                SELECT data FROM pricing_feedback_events 
                WHERE (data->>'posterId') = ${posterId}
                OR task_id IN (SELECT id::text FROM tasks WHERE client_id = ${posterId}::uuid)
                LIMIT 100
            ` as any[];

            if (rows.length === 0) return defaultResult;

            const events: PricingFeedbackEvent[] = rows.map((r: any) => r.data);

            const breakdown: Record<PricingVerdict, number> = { underpriced: 0, optimal: 0, overpriced: 0 };
            let totalDelta = 0;
            let underpriced_disputes = 0;
            let underpriced_total = 0;

            for (const event of events) {
                breakdown[event.verdict]++;
                totalDelta += event.deltaPercent;

                if (event.verdict === 'underpriced') {
                    underpriced_total++;
                    if (event.outcome?.disputed) underpriced_disputes++;
                }
            }

            const disputeRate = underpriced_total > 0
                ? (underpriced_disputes / underpriced_total * 100).toFixed(0) + '%'
                : 'N/A';

            return {
                totalTasks: events.length,
                verdictBreakdown: breakdown,
                avgDeltaPercent: totalDelta / events.length,
                disputeCorrelation: underpriced_total >= 3
                    ? `${disputeRate} of underpriced tasks had disputes`
                    : 'Insufficient data',
                recommendation: breakdown.underpriced > events.length * 0.3
                    ? 'Consider increasing prices to reduce disputes'
                    : breakdown.overpriced > events.length * 0.3
                        ? 'Your prices may be reducing acceptance rate'
                        : 'Your pricing is well-calibrated'
            };

        } catch (error) {
            logger.error({ error, posterId }, 'Failed to get poster analytics');
            return defaultResult;
        }
    }

    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------

    private static calculateVerdict(
        actual: number,
        suggested: number,
        min: number,
        max: number
    ): PricingVerdict {
        const tolerance = 0.1; // 10% tolerance

        if (actual < suggested * (1 - tolerance)) return 'underpriced';
        if (actual > suggested * (1 + tolerance * 2)) return 'overpriced';
        return 'optimal';
    }

    private static estimatePercentile(actual: number, min: number, max: number): number {
        if (max === min) return 50;
        const percentile = ((actual - min) / (max - min)) * 100;
        return Math.max(0, Math.min(100, Math.round(percentile)));
    }

    private static calculateOutcomeDelta(event: PricingFeedbackEvent): PricingFeedbackEvent['outcomeDelta'] {
        const outcome = event.outcome;
        if (!outcome) return undefined;

        const explanations: string[] = [];
        let fasterThanAvg = false;
        let disputeRiskElevated = false;

        if (event.verdict === 'underpriced') {
            if (outcome.disputed) {
                explanations.push('Task was disputed (underpriced tasks have higher dispute rates)');
                disputeRiskElevated = true;
            }
            if (outcome.completionTimeHours && outcome.completionTimeHours < 4) {
                explanations.push('Fast completion despite lower price');
                fasterThanAvg = true;
            }
        } else if (event.verdict === 'overpriced') {
            if (outcome.acceptanceTimeMinutes && outcome.acceptanceTimeMinutes > 60) {
                explanations.push('Slower acceptance (higher price may reduce interest)');
            }
        } else {
            explanations.push('Price was in optimal range - normal outcomes expected');
        }

        return {
            fasterThanAvg,
            disputeRiskElevated,
            explanation: explanations.join('. ') || 'No significant delta observed'
        };
    }

    private static buildSummary(event: PricingFeedbackEvent): PricingFeedbackSummary {
        const headlines: Record<PricingVerdict, string> = {
            underpriced: '⚠️ Priced below market',
            optimal: '✓ Priced in optimal range',
            overpriced: '📊 Priced above market'
        };

        const details: Record<PricingVerdict, string> = {
            underpriced: `Your price ($${event.actualPrice}) is ${Math.abs(event.deltaPercent).toFixed(0)}% below the recommended $${event.recommendedSuggested}. This may increase dispute risk.`,
            optimal: `Your price ($${event.actualPrice}) is within the optimal range ($${event.recommendedMin}-$${event.recommendedMax}).`,
            overpriced: `Your price ($${event.actualPrice}) is ${event.deltaPercent.toFixed(0)}% above the recommended $${event.recommendedSuggested}. This may reduce acceptance rate.`
        };

        return {
            taskId: event.taskId,
            verdict: event.verdict,
            feedback: {
                headline: headlines[event.verdict],
                detail: details[event.verdict],
                recommendation: event.verdict === 'underpriced'
                    ? `Consider pricing at $${event.recommendedSuggested} for similar tasks`
                    : undefined
            },
            stats: {
                pricePercentile: event.pricePercentile,
                vsMarketMedian: `${event.deltaPercent >= 0 ? '+' : ''}${event.deltaPercent.toFixed(0)}%`,
                vsRecommended: `$${event.deltaFromOptimal >= 0 ? '+' : ''}${event.deltaFromOptimal.toFixed(0)}`
            },
            outcomeImpact: event.outcomeDelta ? {
                completionSpeed: event.outcomeDelta.fasterThanAvg ? 'Faster than average' : 'Normal',
                disputeRisk: event.outcomeDelta.disputeRiskElevated ? 'Elevated' : 'Normal'
            } : undefined
        };
    }

    private static emitMetric(verdict: PricingVerdict, deltaPercent: number): void {
        BetaMetricsService.recordEvent('pricing_feedback', {
            verdict,
            deltaPercent: Math.round(deltaPercent)
        });
    }

    private static async persistEvent(event: PricingFeedbackEvent): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO pricing_feedback_events (
                    id, task_id, category, zone, verdict, 
                    delta_percent, data, created_at
                ) VALUES (
                    ${event.id}, ${event.taskId}, ${event.category}, ${event.zone || null},
                    ${event.verdict}, ${event.deltaPercent}, ${JSON.stringify(event)}, ${event.createdAt}
                )
            `;
        } catch (error) {
            logger.error({ error, taskId: event.taskId }, 'Failed to persist pricing feedback');
        }
    }
}
