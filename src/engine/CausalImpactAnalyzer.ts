/**
 * CAUSAL IMPACT ANALYZER (Phase Ω-ACT-3)
 * 
 * Purpose: Prove causation, not correlation.
 * 
 * Compares:
 * - Treated group (with correction)
 * - Control group (without correction)
 * 
 * Computes:
 * - delta_treated
 * - delta_control
 * - net_lift = delta_treated − delta_control
 * 
 * Verdicts (DETERMINISTIC):
 * - CAUSAL: net_lift positive on ≥2 core metrics, control did not improve similarly
 * - NON_CAUSAL: control group improved equally or more
 * - INCONCLUSIVE: insufficient data or noisy signal
 * 
 * NO ML. NO PROBABILITY MAGIC.
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { CorrectionOutcomeAnalyzer, OutcomeMetrics } from './CorrectionOutcomeAnalyzer.js';
import { ControlGroupSelector, ControlGroupMatch } from './ControlGroupSelector.js';
import { CorrectionEngine } from './CorrectionEngine.js';
import { AlertService } from '../services/AlertService.js';

const logger = serviceLogger.child({ module: 'CausalImpactAnalyzer' });

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

export type CausalVerdict = 'causal' | 'inconclusive' | 'non_causal';

export interface NetLift {
    taskFillRate: number;
    completionRate: number;
    disputeRate: number;
    hustlerEngagement: number;
    posterRetryRate: number;
}

export interface CausalAnalysis {
    correctionId: string;
    treatedMetrics: {
        baseline: OutcomeMetrics;
        post: OutcomeMetrics;
        delta: Partial<OutcomeMetrics>;
    };
    controlMetrics: {
        baseline: OutcomeMetrics;
        post: OutcomeMetrics;
        delta: Partial<OutcomeMetrics>;
    };
    netLift: NetLift;
    verdict: CausalVerdict;
    confidence: number;
    controlGroupInfo: ControlGroupMatch;
    analyzedAt: Date;
}

// ============================================================
// SAFEMODE THRESHOLD
// ============================================================

const NON_CAUSAL_RATE_THRESHOLD = 0.30; // >30% non-causal → SafeMode

// ============================================================
// CAUSAL IMPACT ANALYZER
// ============================================================

export class CausalImpactAnalyzer {

    private static readonly WINDOW_HOURS = 6;

    /**
     * ANALYZE CAUSAL IMPACT
     */
    static async analyze(correctionId: string): Promise<CausalAnalysis | null> {
        const db = getDb();
        if (!db) return null;

        try {
            // 1. Get correction details
            const [correction] = await db`
                SELECT id, correction_type, target_entity, target_id, 
                       applied_at, adjustment
                FROM correction_log
                WHERE id = ${correctionId}::uuid
            ` as any[];

            if (!correction) {
                logger.warn({ correctionId }, 'Correction not found');
                return null;
            }

            const appliedAt = new Date(correction.applied_at);
            const treatedZone = correction.target_id;
            const adjustment = JSON.parse(correction.adjustment || '{}');
            const category = adjustment.category || 'all';

            // 2. Need 6h+ after correction
            const minAnalysisTime = new Date(appliedAt.getTime() + this.WINDOW_HOURS * 60 * 60 * 1000);
            if (new Date() < minAnalysisTime) {
                return null; // Too early
            }

            // 3. Select control group
            const controlResult = await ControlGroupSelector.selectControlGroup(
                correctionId,
                treatedZone,
                category,
                appliedAt
            );

            if (!controlResult.found || !controlResult.controlGroup) {
                // No control group - result is inconclusive
                const inconclusiveAnalysis = await this.storeInconclusiveResult(
                    db, correctionId, 'NO_CONTROL_GROUP'
                );
                return inconclusiveAnalysis;
            }

            const controlGroup = controlResult.controlGroup;

            // 4. Compute metrics for treated group
            const treatedBaseline = await this.gatherMetrics(
                db, treatedZone, category,
                new Date(appliedAt.getTime() - this.WINDOW_HOURS * 60 * 60 * 1000),
                appliedAt
            );
            const treatedPost = await this.gatherMetrics(
                db, treatedZone, category,
                appliedAt,
                minAnalysisTime
            );
            const treatedDelta = this.computeDelta(treatedBaseline, treatedPost);

            // 5. Compute metrics for control group
            const controlBaseline = await this.gatherMetrics(
                db, controlGroup.zone, category,
                new Date(appliedAt.getTime() - this.WINDOW_HOURS * 60 * 60 * 1000),
                appliedAt
            );
            const controlPost = await this.gatherMetrics(
                db, controlGroup.zone, category,
                appliedAt,
                minAnalysisTime
            );
            const controlDelta = this.computeDelta(controlBaseline, controlPost);

            // 6. Compute net lift
            const netLift = this.computeNetLift(treatedDelta, controlDelta);

            // 7. Determine verdict
            const verdict = this.determineVerdict(netLift, treatedDelta, controlDelta);

            // 8. Calculate confidence
            const confidence = this.calculateConfidence(treatedBaseline, controlBaseline, controlGroup.matchQuality);

            const analysis: CausalAnalysis = {
                correctionId,
                treatedMetrics: {
                    baseline: treatedBaseline,
                    post: treatedPost,
                    delta: treatedDelta
                },
                controlMetrics: {
                    baseline: controlBaseline,
                    post: controlPost,
                    delta: controlDelta
                },
                netLift,
                verdict,
                confidence,
                controlGroupInfo: controlGroup,
                analyzedAt: new Date()
            };

            // 9. Store result
            await this.storeAnalysis(db, analysis);

            logger.info({
                correctionId,
                verdict,
                confidence,
                netLift
            }, 'Causal impact analyzed');

            return analysis;

        } catch (error) {
            logger.error({ error, correctionId }, 'Failed to analyze causal impact');
            return null;
        }
    }

    /**
     * GATHER METRICS
     */
    private static async gatherMetrics(
        db: ReturnType<typeof neon>,
        zone: string,
        category: string,
        windowStart: Date,
        windowEnd: Date
    ): Promise<OutcomeMetrics> {
        const defaults: OutcomeMetrics = {
            taskFillRate: 0,
            completionRate: 0,
            disputeRate: 0,
            avgPayoutDelayHours: 0,
            hustlerEngagement: 0,
            posterRetryRate: 0
        };

        try {
            const [stats] = await db`
                SELECT 
                    COUNT(*) FILTER (WHERE status IN ('accepted', 'completed', 'pending_approval')) as accepted,
                    COUNT(*) FILTER (WHERE status = 'completed') as completed,
                    COUNT(*) as total
                FROM tasks
                WHERE (${category} = 'all' OR category = ${category})
                AND (location_text = ${zone} OR ${zone} = 'all')
                AND created_at BETWEEN ${windowStart} AND ${windowEnd}
            ` as any[];

            const total = parseInt(stats.total) || 0;
            const accepted = parseInt(stats.accepted) || 0;
            const completed = parseInt(stats.completed) || 0;

            return {
                taskFillRate: total > 0 ? accepted / total : 0,
                completionRate: accepted > 0 ? completed / accepted : 0,
                disputeRate: 0,
                avgPayoutDelayHours: 0,
                hustlerEngagement: total > 0 ? accepted / total : 0,
                posterRetryRate: 0
            };
        } catch {
            return defaults;
        }
    }

    /**
     * COMPUTE DELTA
     */
    private static computeDelta(
        baseline: OutcomeMetrics,
        post: OutcomeMetrics
    ): Partial<OutcomeMetrics> {
        return {
            taskFillRate: post.taskFillRate - baseline.taskFillRate,
            completionRate: post.completionRate - baseline.completionRate,
            disputeRate: post.disputeRate - baseline.disputeRate,
            hustlerEngagement: post.hustlerEngagement - baseline.hustlerEngagement,
            posterRetryRate: post.posterRetryRate - baseline.posterRetryRate
        };
    }

    /**
     * COMPUTE NET LIFT
     * 
     * net_lift = delta_treated − delta_control
     */
    private static computeNetLift(
        treatedDelta: Partial<OutcomeMetrics>,
        controlDelta: Partial<OutcomeMetrics>
    ): NetLift {
        return {
            taskFillRate: (treatedDelta.taskFillRate || 0) - (controlDelta.taskFillRate || 0),
            completionRate: (treatedDelta.completionRate || 0) - (controlDelta.completionRate || 0),
            disputeRate: (treatedDelta.disputeRate || 0) - (controlDelta.disputeRate || 0),
            hustlerEngagement: (treatedDelta.hustlerEngagement || 0) - (controlDelta.hustlerEngagement || 0),
            posterRetryRate: (treatedDelta.posterRetryRate || 0) - (controlDelta.posterRetryRate || 0)
        };
    }

    /**
     * DETERMINE VERDICT (DETERMINISTIC)
     * 
     * CAUSAL: net_lift positive on ≥2 core metrics, control did not improve similarly
     * NON_CAUSAL: control group improved equally or more
     * INCONCLUSIVE: insufficient signal
     */
    private static determineVerdict(
        netLift: NetLift,
        treatedDelta: Partial<OutcomeMetrics>,
        controlDelta: Partial<OutcomeMetrics>
    ): CausalVerdict {
        // Count positive net lifts on core metrics
        let positiveLifts = 0;

        if (netLift.taskFillRate > 0.02) positiveLifts++;
        if (netLift.completionRate > 0.02) positiveLifts++;
        if (netLift.disputeRate < -0.01) positiveLifts++; // Lower disputes = positive
        if (netLift.hustlerEngagement > 0.02) positiveLifts++;

        // Check if control group improved more than treated
        const controlImprovedMore =
            (controlDelta.taskFillRate || 0) >= (treatedDelta.taskFillRate || 0) &&
            (controlDelta.completionRate || 0) >= (treatedDelta.completionRate || 0);

        // CAUSAL: ≥2 positive lifts AND control did not improve similarly
        if (positiveLifts >= 2 && !controlImprovedMore) {
            return 'causal';
        }

        // NON_CAUSAL: control improved equally or more
        if (controlImprovedMore && positiveLifts < 2) {
            return 'non_causal';
        }

        // Everything else is inconclusive
        return 'inconclusive';
    }

    /**
     * CALCULATE CONFIDENCE
     */
    private static calculateConfidence(
        treatedBaseline: OutcomeMetrics,
        controlBaseline: OutcomeMetrics,
        matchQuality: number
    ): number {
        // Base confidence on data availability + match quality
        let dataScore = 0;

        if (treatedBaseline.taskFillRate > 0) dataScore += 0.2;
        if (controlBaseline.taskFillRate > 0) dataScore += 0.2;
        if (treatedBaseline.completionRate > 0) dataScore += 0.1;
        if (controlBaseline.completionRate > 0) dataScore += 0.1;

        // Weight by match quality
        const confidence = Math.min((dataScore + matchQuality * 0.4), 0.95);

        return Math.round(confidence * 100) / 100;
    }

    /**
     * STORE INCONCLUSIVE RESULT
     */
    private static async storeInconclusiveResult(
        db: ReturnType<typeof neon>,
        correctionId: string,
        reason: string
    ): Promise<CausalAnalysis | null> {
        const emptyMetrics: OutcomeMetrics = {
            taskFillRate: 0, completionRate: 0, disputeRate: 0,
            avgPayoutDelayHours: 0, hustlerEngagement: 0, posterRetryRate: 0
        };

        try {
            await db`
                INSERT INTO causal_outcomes (
                    id, correction_id, treated_metrics, control_metrics,
                    net_lift, causal_verdict, confidence, control_group_info, analyzed_at
                ) VALUES (
                    ${ulid()}::uuid,
                    ${correctionId}::uuid,
                    ${JSON.stringify({ baseline: emptyMetrics, post: emptyMetrics })},
                    ${JSON.stringify({ baseline: emptyMetrics, post: emptyMetrics })},
                    ${JSON.stringify({ reason })},
                    'inconclusive',
                    0,
                    ${JSON.stringify({ reason })},
                    NOW()
                )
            `;
        } catch (error) {
            logger.error({ error }, 'Failed to store inconclusive result');
        }

        return null;
    }

    /**
     * STORE ANALYSIS
     */
    private static async storeAnalysis(
        db: ReturnType<typeof neon>,
        analysis: CausalAnalysis
    ): Promise<void> {
        try {
            await db`
                INSERT INTO causal_outcomes (
                    id, correction_id, treated_metrics, control_metrics,
                    net_lift, causal_verdict, confidence, control_group_info, analyzed_at
                ) VALUES (
                    ${ulid()}::uuid,
                    ${analysis.correctionId}::uuid,
                    ${JSON.stringify(analysis.treatedMetrics)},
                    ${JSON.stringify(analysis.controlMetrics)},
                    ${JSON.stringify(analysis.netLift)},
                    ${analysis.verdict},
                    ${analysis.confidence},
                    ${JSON.stringify(analysis.controlGroupInfo)},
                    ${analysis.analyzedAt}
                )
            `;
        } catch (error) {
            logger.error({ error }, 'Failed to store causal analysis');
        }
    }

    /**
     * GET VERDICT RATES
     */
    static async getVerdictRates(windowHours: number = 24): Promise<{
        total: number;
        causal: number;
        inconclusive: number;
        nonCausal: number;
        causalRate: number;
        nonCausalRate: number;
    }> {
        const db = getDb();
        if (!db) {
            return { total: 0, causal: 0, inconclusive: 0, nonCausal: 0, causalRate: 0, nonCausalRate: 0 };
        }

        try {
            const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

            const [stats] = await db`
                SELECT
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE causal_verdict = 'causal') as causal,
                    COUNT(*) FILTER (WHERE causal_verdict = 'inconclusive') as inconclusive,
                    COUNT(*) FILTER (WHERE causal_verdict = 'non_causal') as non_causal
                FROM causal_outcomes
                WHERE analyzed_at >= ${since}
            ` as any[];

            const total = parseInt(stats.total) || 0;
            const causal = parseInt(stats.causal) || 0;
            const inconclusive = parseInt(stats.inconclusive) || 0;
            const nonCausal = parseInt(stats.non_causal) || 0;

            return {
                total,
                causal,
                inconclusive,
                nonCausal,
                causalRate: total > 0 ? causal / total : 0,
                nonCausalRate: total > 0 ? nonCausal / total : 0
            };
        } catch (error) {
            logger.error({ error }, 'Failed to get verdict rates');
            return { total: 0, causal: 0, inconclusive: 0, nonCausal: 0, causalRate: 0, nonCausalRate: 0 };
        }
    }

    /**
     * CHECK SAFEMODE THRESHOLD
     */
    static async checkSafeModeThreshold(): Promise<boolean> {
        const rates = await this.getVerdictRates(24);

        if (rates.total >= 5 && rates.nonCausalRate > NON_CAUSAL_RATE_THRESHOLD) {
            logger.fatal({
                nonCausalRate: rates.nonCausalRate,
                threshold: NON_CAUSAL_RATE_THRESHOLD
            }, 'Non-causal rate exceeded - triggering SafeMode');

            await CorrectionEngine.enterSafeMode(
                `Non-causal rate ${(rates.nonCausalRate * 100).toFixed(1)}% exceeds ${NON_CAUSAL_RATE_THRESHOLD * 100}% threshold`
            );

            await AlertService.fire(
                'STUCK_SAGA',
                `Corrections not causing improvements: ${(rates.nonCausalRate * 100).toFixed(1)}% non-causal in last 24h`,
                { rates }
            );

            return true;
        }

        return false;
    }
}
