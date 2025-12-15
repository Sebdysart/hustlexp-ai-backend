/**
 * OUTCOME ATTRIBUTION SWEEPER (Phase Ω-ACT-2)
 * 
 * Runs every 30 minutes.
 * Processes unanalyzed corrections.
 * Feeds results into SafeMode and Budget.
 * 
 * Emits metrics:
 * - correction_positive_rate
 * - correction_negative_rate
 * - correction_confidence_avg
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { CorrectionOutcomeAnalyzer, NetEffect } from '../engine/CorrectionOutcomeAnalyzer.js';
import { CorrectionEngine } from '../engine/CorrectionEngine.js';
import { AlertService } from '../services/AlertService.js';

const logger = serviceLogger.child({ module: 'OutcomeAttributionSweeper' });

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

// ============================================================
// SAFEMODE THRESHOLD
// ============================================================

const NEGATIVE_RATE_THRESHOLD = 0.25; // >25% negative outcomes → SafeMode

// ============================================================
// SWEEPER
// ============================================================

export class OutcomeAttributionSweeper {

    /**
     * RUN SWEEPER
     * 
     * 1. Find corrections old enough to analyze (6h+)
     * 2. Filter out already analyzed
     * 3. Analyze each
     * 4. Check SafeMode threshold
     */
    static async run(): Promise<{
        analyzed: number;
        positive: number;
        neutral: number;
        negative: number;
        triggeredSafeMode: boolean;
    }> {
        const db = getDb();
        if (!db) {
            return { analyzed: 0, positive: 0, neutral: 0, negative: 0, triggeredSafeMode: false };
        }

        logger.info('Starting outcome attribution sweep');

        try {
            // 1. Find corrections ready for analysis
            const corrections = await this.findCorrectionsToAnalyze(db);

            if (corrections.length === 0) {
                logger.debug('No corrections ready for analysis');
                return { analyzed: 0, positive: 0, neutral: 0, negative: 0, triggeredSafeMode: false };
            }

            // 2. Analyze each
            let positive = 0;
            let neutral = 0;
            let negative = 0;

            for (const correction of corrections) {
                const analysis = await CorrectionOutcomeAnalyzer.analyze(correction.id);

                if (analysis) {
                    if (analysis.netEffect === 'positive') positive++;
                    else if (analysis.netEffect === 'neutral') neutral++;
                    else negative++;
                }
            }

            const analyzed = positive + neutral + negative;

            // 3. Check SafeMode threshold
            let triggeredSafeMode = false;

            if (analyzed >= 5) { // Minimum sample size
                const rates = await CorrectionOutcomeAnalyzer.getOutcomeRates(24);

                if (rates.negativeRate > NEGATIVE_RATE_THRESHOLD) {
                    logger.fatal({
                        negativeRate: rates.negativeRate,
                        threshold: NEGATIVE_RATE_THRESHOLD
                    }, 'Negative outcome rate exceeded - triggering SafeMode');

                    await CorrectionEngine.enterSafeMode(
                        `Negative outcome rate ${(rates.negativeRate * 100).toFixed(1)}% exceeds ${NEGATIVE_RATE_THRESHOLD * 100}% threshold`
                    );

                    await AlertService.fire(
                        'STUCK_SAGA',
                        `Corrections causing harm: ${(rates.negativeRate * 100).toFixed(1)}% negative outcomes in last 24h`,
                        {
                            negativeRate: rates.negativeRate,
                            positive: rates.positive,
                            negative: rates.negative,
                            total: rates.total
                        }
                    );

                    triggeredSafeMode = true;
                }
            }

            logger.info({
                analyzed,
                positive,
                neutral,
                negative,
                triggeredSafeMode
            }, 'Outcome attribution sweep complete');

            return {
                analyzed,
                positive,
                neutral,
                negative,
                triggeredSafeMode
            };

        } catch (error) {
            logger.error({ error }, 'Outcome attribution sweep failed');
            return { analyzed: 0, positive: 0, neutral: 0, negative: 0, triggeredSafeMode: false };
        }
    }

    /**
     * FIND CORRECTIONS TO ANALYZE
     * 
     * - Applied 6h+ ago
     * - Not yet analyzed
     * - Limit 50 per sweep
     */
    private static async findCorrectionsToAnalyze(db: ReturnType<typeof neon>): Promise<{ id: string }[]> {
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

        const rows = await db`
            SELECT cl.id
            FROM correction_log cl
            LEFT JOIN correction_outcomes co ON co.correction_id = cl.id
            WHERE cl.applied_at < ${sixHoursAgo}
            AND co.id IS NULL
            ORDER BY cl.applied_at ASC
            LIMIT 50
        `;

        return (rows as any[]).map(r => ({ id: r.id }));
    }

    /**
     * GET METRICS (for Prometheus export)
     */
    static async getMetrics(): Promise<{
        correction_positive_rate: number;
        correction_negative_rate: number;
        correction_confidence_avg: number;
    }> {
        const rates = await CorrectionOutcomeAnalyzer.getOutcomeRates(24);

        return {
            correction_positive_rate: rates.positiveRate,
            correction_negative_rate: rates.negativeRate,
            correction_confidence_avg: rates.avgConfidence
        };
    }
}
