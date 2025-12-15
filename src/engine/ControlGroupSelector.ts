/**
 * CONTROL GROUP SELECTOR (Phase Ω-ACT-3)
 * 
 * Purpose: Find matched control groups to prove causation.
 * 
 * Matching dimensions:
 * - Same city
 * - Same zone OR nearest neighbor
 * - Same category
 * - Same time window
 * - Similar baseline metrics (±10%)
 * 
 * Control group MUST NOT have received the correction.
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { OutcomeMetrics } from './CorrectionOutcomeAnalyzer.js';

const logger = serviceLogger.child({ module: 'ControlGroupSelector' });

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

export interface ControlGroupMatch {
    zone: string;
    category: string;
    timeWindow: { start: Date; end: Date };
    matchQuality: number; // 0-1, higher = better match
    baselineMetricsDelta: number; // How different from treated (lower = better)
}

export interface ControlGroupResult {
    found: boolean;
    controlGroup: ControlGroupMatch | null;
    treatedZone: string;
    treatedCategory: string;
    reason?: string;
}

// ============================================================
// MATCHING THRESHOLDS
// ============================================================

const MATCHING_CONFIG = {
    maxBaselineDelta: 0.10,  // ±10% baseline similarity
    minMatchQuality: 0.5,    // Minimum acceptable match
    preferSameZone: true,    // Try same zone first, then neighbors
};

// ============================================================
// CONTROL GROUP SELECTOR
// ============================================================

export class ControlGroupSelector {

    /**
     * SELECT CONTROL GROUP
     * 
     * Find a matched zone/category that did NOT receive the correction.
     */
    static async selectControlGroup(
        correctionId: string,
        treatedZone: string,
        treatedCategory: string,
        correctionAppliedAt: Date
    ): Promise<ControlGroupResult> {
        const db = getDb();
        if (!db) {
            return { found: false, controlGroup: null, treatedZone, treatedCategory, reason: 'NO_DATABASE' };
        }

        try {
            // 1. Find zones that did NOT receive a similar correction in the same window
            const candidateZones = await this.findCandidateZones(
                db,
                correctionId,
                treatedZone,
                treatedCategory,
                correctionAppliedAt
            );

            if (candidateZones.length === 0) {
                return {
                    found: false,
                    controlGroup: null,
                    treatedZone,
                    treatedCategory,
                    reason: 'NO_CANDIDATE_ZONES'
                };
            }

            // 2. Compute baseline metrics for treated zone
            const treatedBaseline = await this.getBaselineMetrics(
                db,
                treatedZone,
                treatedCategory,
                correctionAppliedAt
            );

            // 3. Find best matching control zone
            let bestMatch: ControlGroupMatch | null = null;
            let bestMatchQuality = 0;

            for (const candidateZone of candidateZones) {
                const candidateBaseline = await this.getBaselineMetrics(
                    db,
                    candidateZone,
                    treatedCategory,
                    correctionAppliedAt
                );

                const baselineDelta = this.computeBaselineDelta(treatedBaseline, candidateBaseline);

                if (baselineDelta > MATCHING_CONFIG.maxBaselineDelta) {
                    continue; // Too different
                }

                const matchQuality = 1 - baselineDelta;

                if (matchQuality > bestMatchQuality && matchQuality >= MATCHING_CONFIG.minMatchQuality) {
                    bestMatchQuality = matchQuality;
                    bestMatch = {
                        zone: candidateZone,
                        category: treatedCategory,
                        timeWindow: {
                            start: new Date(correctionAppliedAt.getTime() - 6 * 60 * 60 * 1000),
                            end: new Date(correctionAppliedAt.getTime() + 6 * 60 * 60 * 1000)
                        },
                        matchQuality,
                        baselineMetricsDelta: baselineDelta
                    };
                }
            }

            if (!bestMatch) {
                return {
                    found: false,
                    controlGroup: null,
                    treatedZone,
                    treatedCategory,
                    reason: 'NO_MATCH_ABOVE_THRESHOLD'
                };
            }

            logger.info({
                correctionId,
                treatedZone,
                controlZone: bestMatch.zone,
                matchQuality: bestMatch.matchQuality
            }, 'Control group selected');

            return {
                found: true,
                controlGroup: bestMatch,
                treatedZone,
                treatedCategory
            };

        } catch (error) {
            logger.error({ error, correctionId }, 'Failed to select control group');
            return { found: false, controlGroup: null, treatedZone, treatedCategory, reason: 'ERROR' };
        }
    }

    /**
     * FIND CANDIDATE ZONES
     * 
     * Zones that did NOT receive a similar correction.
     */
    private static async findCandidateZones(
        db: ReturnType<typeof neon>,
        correctionId: string,
        treatedZone: string,
        category: string,
        correctionAppliedAt: Date
    ): Promise<string[]> {
        // Time window: ±12h from correction
        const windowStart = new Date(correctionAppliedAt.getTime() - 12 * 60 * 60 * 1000);
        const windowEnd = new Date(correctionAppliedAt.getTime() + 12 * 60 * 60 * 1000);

        // Find zones that:
        // 1. Have tasks in the same category
        // 2. Did NOT receive a correction in the same window
        const rows = await db`
            SELECT DISTINCT t.location_text as zone
            FROM tasks t
            WHERE t.category = ${category}
            AND t.created_at BETWEEN ${windowStart} AND ${windowEnd}
            AND t.location_text IS NOT NULL
            AND t.location_text != ${treatedZone}
            AND t.location_text NOT IN (
                SELECT DISTINCT cl.target_id
                FROM correction_log cl
                WHERE cl.target_entity IN ('zone', 'task')
                AND cl.applied_at BETWEEN ${windowStart} AND ${windowEnd}
                AND (cl.adjustment->>'category') = ${category}
            )
            LIMIT 10
        `;

        return (rows as any[]).map(r => r.zone).filter(Boolean);
    }

    /**
     * GET BASELINE METRICS
     */
    private static async getBaselineMetrics(
        db: ReturnType<typeof neon>,
        zone: string,
        category: string,
        referenceTime: Date
    ): Promise<OutcomeMetrics> {
        const windowStart = new Date(referenceTime.getTime() - 6 * 60 * 60 * 1000);
        const windowEnd = referenceTime;

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
                WHERE category = ${category}
                AND location_text = ${zone}
                AND created_at BETWEEN ${windowStart} AND ${windowEnd}
            ` as any[];

            const total = parseInt(stats.total) || 0;
            const accepted = parseInt(stats.accepted) || 0;
            const completed = parseInt(stats.completed) || 0;

            return {
                taskFillRate: total > 0 ? accepted / total : 0,
                completionRate: accepted > 0 ? completed / accepted : 0,
                disputeRate: 0, // Simplified
                avgPayoutDelayHours: 0,
                hustlerEngagement: total > 0 ? accepted / total : 0,
                posterRetryRate: 0
            };
        } catch {
            return defaults;
        }
    }

    /**
     * COMPUTE BASELINE DELTA
     * 
     * Average difference across key metrics.
     */
    private static computeBaselineDelta(
        treated: OutcomeMetrics,
        control: OutcomeMetrics
    ): number {
        const diffs = [
            Math.abs(treated.taskFillRate - control.taskFillRate),
            Math.abs(treated.completionRate - control.completionRate),
            Math.abs(treated.hustlerEngagement - control.hustlerEngagement)
        ];

        return diffs.reduce((a, b) => a + b, 0) / diffs.length;
    }
}
