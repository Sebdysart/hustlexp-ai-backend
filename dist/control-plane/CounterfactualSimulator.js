/**
 * COUNTERFACTUAL SIMULATOR (Phase 14E)
 *
 * Control Plane Component - ADVISORY ONLY
 *
 * Purpose: Answer "What would have happened if we followed this advice?"
 *
 * This service:
 * - Re-runs historical data through proposed policy changes
 * - Compares predicted outcomes vs actual outcomes
 * - Flags recommendations that would have caused harm
 * - Provides quantified impact predictions
 *
 * CONSTRAINTS:
 * - READ-ONLY: Never modifies any data
 * - HISTORICAL: Only uses past snapshots and outcomes
 * - ADVISORY: Results inform human decisions, no auto-execution
 * - NO KERNEL: Never touches money, ledger, or state machines
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
const logger = serviceLogger.child({ module: 'CounterfactualSimulator' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
/**
 * Impact models - these are calibrated heuristics based on domain knowledge
 * In production, these would be trained on actual outcome data
 */
const IMPACT_MODELS = {
    // Risk weight changes affect escalation and admin override rates
    risk_weight_tuning: (current, proposed) => {
        const delta = proposed - current;
        const pctChange = delta / Math.max(current, 1);
        // Higher risk weights → more escalations, but fewer disputes
        return {
            escalationRate: pctChange * 0.3, // 30% of weight change
            adminOverrideRate: pctChange * 0.2, // 20% of weight change
            disputeRate: -pctChange * 0.1, // Inverse 10% (stricter = fewer disputes)
        };
    },
    // Proof threshold changes affect rejection rate and user friction
    proof_threshold_adjustment: (current, proposed) => {
        // For proof thresholds, we model based on requirement strictness
        const strictnessScores = {
            'none': 0,
            'single_photo': 20,
            'multi_angle': 40,
            'photo_timestamp': 50,
            'photo_geo': 60,
            'photo_geo_delay': 80,
            'pre_completion': 100
        };
        const currentScore = strictnessScores[current] ?? 30;
        const proposedScore = strictnessScores[proposed] ?? 30;
        const delta = proposedScore - currentScore;
        const pctChange = delta / 100;
        // Stricter proof → more rejections, fewer disputes
        return {
            proofRejectionRate: pctChange * 0.5, // 50% correlation
            disputeRate: -pctChange * 0.3, // Inverse 30%
            avgPayoutDelayHours: pctChange * 0.2, // Stricter = slower
        };
    },
    // Trust tier boundary changes affect friction and completion
    trust_tier_boundary: (current, proposed) => {
        const delta = proposed - current;
        const pctChange = delta / Math.max(current, 1);
        // Lower boundary (more people are "trusted") → less friction
        return {
            proofRejectionRate: pctChange * 0.2,
            escalationRate: -pctChange * 0.3,
            completionRate: -pctChange * 0.1, // More trust = better completion
        };
    },
    // Metrics threshold changes affect alerting behavior
    metrics_threshold_adjustment: (current, proposed) => {
        const delta = proposed - current;
        const pctChange = delta / Math.max(current, 0.01);
        // Higher threshold = fewer alerts triggered
        return {
            adminOverrideRate: -pctChange * 0.1,
        };
    },
    // UX friction changes affect completion and user behavior
    ux_friction_adjustment: (current, proposed) => {
        // Generic friction model
        const currentFriction = typeof current === 'number' ? current : 50;
        const proposedFriction = typeof proposed === 'number' ? proposed : 50;
        const delta = proposedFriction - currentFriction;
        const pctChange = delta / 100;
        // More friction → worse completion, fewer disputes
        return {
            completionRate: -pctChange * 0.15,
            disputeRate: -pctChange * 0.1,
            avgPayoutDelayHours: pctChange * 0.3,
        };
    },
};
// ============================================================
// COUNTERFACTUAL SIMULATOR
// ============================================================
export class CounterfactualSimulator {
    /**
     * SIMULATE RECOMMENDATION IMPACT
     * Re-runs historical data through proposed policy change
     */
    static async simulate(recommendation, daysBack = 7) {
        const simulationId = ulid();
        const db = getDb();
        logger.info({
            simulationId,
            recommendationId: recommendation.id,
            daysBack
        }, 'Starting counterfactual simulation');
        // 1. Load historical snapshots
        const periodEnd = new Date();
        const periodStart = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
        const snapshots = await this.loadHistoricalSnapshots(periodStart, periodEnd);
        if (snapshots.length < 3) {
            logger.warn({ count: snapshots.length }, 'Insufficient historical data for simulation');
            return this.buildInsufficientDataResult(simulationId, recommendation.id, periodStart, periodEnd);
        }
        // 2. Calculate baseline metrics (what actually happened)
        const baseline = this.calculateBaseline(snapshots);
        // 3. Project impact of proposed change
        const policyChange = {
            type: recommendation.type,
            target: recommendation.suggestedChange.target,
            currentValue: recommendation.suggestedChange.currentValue,
            proposedValue: recommendation.suggestedChange.proposedValue
        };
        const projected = this.projectChange(baseline, policyChange);
        // 4. Analyze impact
        const impact = this.analyzeImpact(baseline, projected);
        // 5. Determine verdict
        const verdict = this.determineVerdict(impact);
        const confidence = this.calculateConfidence(snapshots.length, daysBack);
        const result = {
            id: simulationId,
            recommendationId: recommendation.id,
            simulatedAt: new Date(),
            snapshotsAnalyzed: snapshots.length,
            periodStart,
            periodEnd,
            baseline,
            projected,
            impact,
            verdict,
            confidence
        };
        // 6. Store simulation result
        await this.storeResult(result);
        logger.info({
            simulationId,
            verdict,
            confidence,
            netPositive: impact.netPositiveSignals,
            netNegative: impact.netNegativeSignals
        }, 'Simulation complete');
        return result;
    }
    /**
     * GET SIMULATION RESULT
     */
    static async getResult(simulationId) {
        const db = getDb();
        if (!db)
            return null;
        try {
            const [row] = await db `
                SELECT data FROM counterfactual_simulations WHERE id = ${simulationId}
            `;
            return row ? row.data : null;
        }
        catch (error) {
            logger.error({ error, simulationId }, 'Failed to get simulation result');
            return null;
        }
    }
    /**
     * GET SIMULATIONS FOR RECOMMENDATION
     */
    static async getForRecommendation(recommendationId) {
        const db = getDb();
        if (!db)
            return [];
        try {
            const rows = await db `
                SELECT data FROM counterfactual_simulations 
                WHERE recommendation_id = ${recommendationId}
                ORDER BY simulated_at DESC
            `;
            return rows.map((r) => r.data);
        }
        catch (error) {
            logger.error({ error, recommendationId }, 'Failed to get simulations');
            return [];
        }
    }
    /**
     * SHOULD ACCEPT RECOMMENDATION
     * Quick check if a recommendation's simulation supports acceptance
     */
    static async shouldAccept(recommendationId) {
        const simulations = await this.getForRecommendation(recommendationId);
        if (simulations.length === 0) {
            return {
                recommend: false,
                reason: 'No simulation run - cannot evaluate impact'
            };
        }
        const latest = simulations[0];
        if (latest.verdict === 'INSUFFICIENT_DATA') {
            return {
                recommend: false,
                reason: 'Insufficient historical data to evaluate',
                simulation: latest
            };
        }
        if (latest.verdict === 'STRONGLY_NEGATIVE' || latest.verdict === 'NEGATIVE') {
            return {
                recommend: false,
                reason: `Simulation predicts net negative impact: ${latest.impact.netNegativeSignals} signals worse`,
                simulation: latest
            };
        }
        if (latest.confidence < 0.5) {
            return {
                recommend: false,
                reason: `Low simulation confidence (${Math.round(latest.confidence * 100)}%)`,
                simulation: latest
            };
        }
        return {
            recommend: true,
            reason: `Simulation predicts ${latest.verdict.toLowerCase().replace('_', ' ')} impact`,
            simulation: latest
        };
    }
    // -----------------------------------------------------------
    // INTERNAL: Historical Data
    // -----------------------------------------------------------
    static async loadHistoricalSnapshots(periodStart, periodEnd) {
        const db = getDb();
        if (!db)
            return [];
        try {
            const rows = await db `
                SELECT data FROM analysis_snapshots
                WHERE created_at >= ${periodStart}
                AND created_at <= ${periodEnd}
                ORDER BY created_at ASC
            `;
            return rows.map((r) => r.data);
        }
        catch (error) {
            logger.error({ error }, 'Failed to load historical snapshots');
            return [];
        }
    }
    static calculateBaseline(snapshots) {
        // Average metrics across all snapshots
        const sum = {
            disputeRate: 0,
            proofRejectionRate: 0,
            escalationRate: 0,
            adminOverrideRate: 0,
            avgPayoutDelayHours: 0,
            completionRate: 0,
        };
        for (const snapshot of snapshots) {
            sum.disputeRate += snapshot.operations.disputeRate || 0;
            sum.proofRejectionRate += snapshot.operations.proofRejectionRate || 0;
            sum.escalationRate += snapshot.operations.escalationRate || 0;
            sum.adminOverrideRate += snapshot.operations.adminOverrideRate || 0;
            sum.completionRate += snapshot.funnel.completionRate || 0;
            // Payout delay would need to be tracked separately
        }
        const count = snapshots.length;
        return {
            disputeRate: sum.disputeRate / count,
            proofRejectionRate: sum.proofRejectionRate / count,
            escalationRate: sum.escalationRate / count,
            adminOverrideRate: sum.adminOverrideRate / count,
            avgPayoutDelayHours: 6, // Default assumption
            completionRate: sum.completionRate / count,
        };
    }
    // -----------------------------------------------------------
    // INTERNAL: Projection
    // -----------------------------------------------------------
    static projectChange(baseline, change) {
        // Start with baseline
        const projected = { ...baseline };
        // Get impact model for this change type
        const model = IMPACT_MODELS[change.type];
        if (!model) {
            logger.warn({ type: change.type }, 'No impact model for change type');
            return projected;
        }
        // Calculate deltas
        const deltas = model(change.currentValue, change.proposedValue);
        // Apply deltas to baseline
        for (const [key, delta] of Object.entries(deltas)) {
            if (key in projected && typeof delta === 'number') {
                projected[key] = Math.max(0, baseline[key] + delta);
            }
        }
        return projected;
    }
    // -----------------------------------------------------------
    // INTERNAL: Impact Analysis
    // -----------------------------------------------------------
    static analyzeImpact(baseline, projected) {
        const analyze = (baseVal, projVal, lowerIsBetter) => {
            const change = projVal - baseVal;
            const pctChange = baseVal > 0 ? (change / baseVal) * 100 : 0;
            let direction;
            if (Math.abs(pctChange) < 1) {
                direction = 'neutral';
            }
            else if (lowerIsBetter) {
                direction = change < 0 ? 'better' : 'worse';
            }
            else {
                direction = change > 0 ? 'better' : 'worse';
            }
            return { change, direction, pctChange: Math.round(pctChange * 10) / 10 };
        };
        const disputes = analyze(baseline.disputeRate, projected.disputeRate, true);
        const proofRejections = analyze(baseline.proofRejectionRate, projected.proofRejectionRate, true);
        const escalations = analyze(baseline.escalationRate, projected.escalationRate, true);
        const adminOverrides = analyze(baseline.adminOverrideRate, projected.adminOverrideRate, true);
        const payoutDelay = analyze(baseline.avgPayoutDelayHours, projected.avgPayoutDelayHours, true);
        const completions = analyze(baseline.completionRate, projected.completionRate, false);
        const all = [disputes, proofRejections, escalations, adminOverrides, payoutDelay, completions];
        return {
            disputes,
            proofRejections,
            escalations,
            adminOverrides,
            payoutDelay,
            completions,
            netPositiveSignals: all.filter(a => a.direction === 'better').length,
            netNegativeSignals: all.filter(a => a.direction === 'worse').length,
        };
    }
    static determineVerdict(impact) {
        if (impact.netNegativeSignals === 0 && impact.netPositiveSignals >= 4) {
            return 'STRONGLY_POSITIVE';
        }
        if (impact.netPositiveSignals > impact.netNegativeSignals + 1) {
            return 'POSITIVE';
        }
        if (impact.netNegativeSignals > impact.netPositiveSignals + 1) {
            return 'NEGATIVE';
        }
        if (impact.netNegativeSignals >= 4 && impact.netPositiveSignals === 0) {
            return 'STRONGLY_NEGATIVE';
        }
        return 'NEUTRAL';
    }
    static calculateConfidence(snapshotCount, daysBack) {
        // More data = higher confidence
        const dataConfidence = Math.min(snapshotCount / 20, 1);
        const periodConfidence = Math.min(daysBack / 14, 1);
        return (dataConfidence * 0.6 + periodConfidence * 0.4);
    }
    static buildInsufficientDataResult(id, recommendationId, periodStart, periodEnd) {
        return {
            id,
            recommendationId,
            simulatedAt: new Date(),
            snapshotsAnalyzed: 0,
            periodStart,
            periodEnd,
            baseline: {
                disputeRate: 0,
                proofRejectionRate: 0,
                escalationRate: 0,
                adminOverrideRate: 0,
                avgPayoutDelayHours: 0,
                completionRate: 0,
            },
            projected: {
                disputeRate: 0,
                proofRejectionRate: 0,
                escalationRate: 0,
                adminOverrideRate: 0,
                avgPayoutDelayHours: 0,
                completionRate: 0,
            },
            impact: {
                disputes: { change: 0, direction: 'neutral', pctChange: 0 },
                proofRejections: { change: 0, direction: 'neutral', pctChange: 0 },
                escalations: { change: 0, direction: 'neutral', pctChange: 0 },
                adminOverrides: { change: 0, direction: 'neutral', pctChange: 0 },
                payoutDelay: { change: 0, direction: 'neutral', pctChange: 0 },
                completions: { change: 0, direction: 'neutral', pctChange: 0 },
                netPositiveSignals: 0,
                netNegativeSignals: 0,
            },
            verdict: 'INSUFFICIENT_DATA',
            confidence: 0,
        };
    }
    // -----------------------------------------------------------
    // INTERNAL: Storage
    // -----------------------------------------------------------
    static async storeResult(result) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO counterfactual_simulations (
                    id, recommendation_id, verdict, confidence, 
                    snapshots_analyzed, data, simulated_at
                ) VALUES (
                    ${result.id}, ${result.recommendationId}, ${result.verdict},
                    ${result.confidence}, ${result.snapshotsAnalyzed},
                    ${JSON.stringify(result)}, ${result.simulatedAt}
                )
            `;
        }
        catch (error) {
            logger.error({ error, id: result.id }, 'Failed to store simulation result');
        }
    }
}
//# sourceMappingURL=CounterfactualSimulator.js.map