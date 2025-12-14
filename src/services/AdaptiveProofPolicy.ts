/**
 * ADAPTIVE PROOF POLICY ENGINE (Phase 14D-2)
 * 
 * Control Plane Component - SHADOW MODE ONLY
 * 
 * Purpose: Learn what policy SHOULD be before enforcing it.
 * 
 * This service:
 * - Computes shadow policies based on risk
 * - Compares to enforced policies
 * - Logs all decisions for counterfactual analysis
 * - NEVER affects user experience
 * - NEVER touches payouts
 * 
 * Shadow mode means:
 * - No user impact
 * - No payout changes  
 * - No friction changes
 * - Pure signal collection
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { RiskScoreService, RiskTier, FullRiskAssessment } from './RiskScoreService.js';

const logger = serviceLogger.child({ module: 'AdaptiveProofPolicy' });

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

export type ProofRequirement =
    | 'none'
    | 'single_photo'
    | 'multi_angle'
    | 'photo_timestamp'
    | 'photo_geo'
    | 'photo_geo_delay'
    | 'pre_completion';

export interface ProofPolicy {
    requirement: ProofRequirement;
    deadlineHours: number;
    autoApproveThreshold: number;  // Forensics confidence to auto-approve
    requireGPS: boolean;
    requireTimestamp: boolean;
    maxSubmissions: number;
}

export interface PolicyComparison {
    taskId: string;
    enforcedPolicy: ProofPolicy;
    shadowPolicy: ProofPolicy;
    delta: 'SAME' | 'MORE_STRICT' | 'LESS_STRICT';
    deltaDetails: string[];
    riskAssessment: {
        taskRisk: number;
        posterRisk: number;
        hustlerRisk: number | null;
        combinedRisk: number;
        tier: RiskTier;
    };
    recommendation: string;
    confidence: number;
    evaluatedAt: Date;
    evaluationId: string;
}

export interface ShadowOutcomeLog {
    taskId: string;
    enforcedPolicy: ProofPolicy;
    shadowPolicy: ProofPolicy;
    proofOutcome: 'not_required' | 'submitted' | 'verified' | 'rejected' | 'expired';
    disputeOutcome: 'none' | 'opened' | 'refunded' | 'upheld';
    payoutDelayHours: number;
    wouldHaveDiffered: boolean;
    potentialBenefit: string | null;
}

// ============================================================
// POLICY MATRIX (Deterministic v1)
// ============================================================

const POLICY_MATRIX: Record<RiskTier, Record<'low_value' | 'medium_value' | 'high_value', ProofPolicy>> = {
    minimal: {
        low_value: {
            requirement: 'none',
            deadlineHours: 0,
            autoApproveThreshold: 0,
            requireGPS: false,
            requireTimestamp: false,
            maxSubmissions: 0
        },
        medium_value: {
            requirement: 'single_photo',
            deadlineHours: 24,
            autoApproveThreshold: 0.85,
            requireGPS: false,
            requireTimestamp: false,
            maxSubmissions: 3
        },
        high_value: {
            requirement: 'single_photo',
            deadlineHours: 12,
            autoApproveThreshold: 0.8,
            requireGPS: false,
            requireTimestamp: true,
            maxSubmissions: 3
        }
    },
    low: {
        low_value: {
            requirement: 'single_photo',
            deadlineHours: 24,
            autoApproveThreshold: 0.85,
            requireGPS: false,
            requireTimestamp: false,
            maxSubmissions: 3
        },
        medium_value: {
            requirement: 'single_photo',
            deadlineHours: 12,
            autoApproveThreshold: 0.8,
            requireGPS: false,
            requireTimestamp: true,
            maxSubmissions: 3
        },
        high_value: {
            requirement: 'multi_angle',
            deadlineHours: 12,
            autoApproveThreshold: 0.75,
            requireGPS: true,
            requireTimestamp: true,
            maxSubmissions: 3
        }
    },
    medium: {
        low_value: {
            requirement: 'single_photo',
            deadlineHours: 12,
            autoApproveThreshold: 0.75,
            requireGPS: false,
            requireTimestamp: true,
            maxSubmissions: 3
        },
        medium_value: {
            requirement: 'multi_angle',
            deadlineHours: 12,
            autoApproveThreshold: 0.7,
            requireGPS: true,
            requireTimestamp: true,
            maxSubmissions: 2
        },
        high_value: {
            requirement: 'photo_geo_delay',
            deadlineHours: 6,
            autoApproveThreshold: 0.65,
            requireGPS: true,
            requireTimestamp: true,
            maxSubmissions: 2
        }
    },
    high: {
        low_value: {
            requirement: 'multi_angle',
            deadlineHours: 12,
            autoApproveThreshold: 0.65,
            requireGPS: true,
            requireTimestamp: true,
            maxSubmissions: 2
        },
        medium_value: {
            requirement: 'photo_geo_delay',
            deadlineHours: 6,
            autoApproveThreshold: 0.6,
            requireGPS: true,
            requireTimestamp: true,
            maxSubmissions: 2
        },
        high_value: {
            requirement: 'photo_geo_delay',
            deadlineHours: 6,
            autoApproveThreshold: 0.55,
            requireGPS: true,
            requireTimestamp: true,
            maxSubmissions: 1
        }
    },
    critical: {
        low_value: {
            requirement: 'photo_geo_delay',
            deadlineHours: 6,
            autoApproveThreshold: 0.5,
            requireGPS: true,
            requireTimestamp: true,
            maxSubmissions: 2
        },
        medium_value: {
            requirement: 'pre_completion',
            deadlineHours: 4,
            autoApproveThreshold: 0,  // No auto-approve for critical
            requireGPS: true,
            requireTimestamp: true,
            maxSubmissions: 1
        },
        high_value: {
            requirement: 'pre_completion',
            deadlineHours: 4,
            autoApproveThreshold: 0,
            requireGPS: true,
            requireTimestamp: true,
            maxSubmissions: 1
        }
    }
};

// Current enforced policy (static for now - what system actually does)
const CURRENT_ENFORCED_POLICY: ProofPolicy = {
    requirement: 'single_photo',
    deadlineHours: 24,
    autoApproveThreshold: 0.8,
    requireGPS: false,
    requireTimestamp: false,
    maxSubmissions: 3
};

// ============================================================
// ADAPTIVE PROOF POLICY SERVICE
// ============================================================

export class AdaptiveProofPolicy {

    /**
     * EVALUATE SHADOW POLICY
     * Compare what we enforce vs what we SHOULD enforce
     */
    static async evaluateShadowPolicy(
        taskId: string,
        category: string,
        price: number,
        posterId: string,
        hustlerId?: string
    ): Promise<PolicyComparison> {
        const evaluationId = ulid();

        // 1. Get full risk assessment
        const assessment = await RiskScoreService.assessFullRisk({
            taskId,
            category,
            price,
            posterId,
            hustlerId,
            isFirstTimeMatch: !hustlerId  // Simplified; real impl would check history
        });

        // 2. Determine value tier
        const valueTier = this.getValueTier(price);

        // 3. Look up shadow policy from matrix
        const shadowPolicy = POLICY_MATRIX[assessment.combinedRisk.tier][valueTier];

        // 4. Compare to enforced policy
        const delta = this.comparePolicies(CURRENT_ENFORCED_POLICY, shadowPolicy);
        const deltaDetails = this.explainDelta(CURRENT_ENFORCED_POLICY, shadowPolicy);

        // 5. Generate recommendation
        const recommendation = this.generateRecommendation(
            assessment.combinedRisk.tier,
            delta,
            price
        );

        const result: PolicyComparison = {
            taskId,
            enforcedPolicy: CURRENT_ENFORCED_POLICY,
            shadowPolicy,
            delta,
            deltaDetails,
            riskAssessment: {
                taskRisk: assessment.taskRisk.score,
                posterRisk: assessment.posterRisk.score,
                hustlerRisk: assessment.hustlerRisk?.score || null,
                combinedRisk: assessment.combinedRisk.score,
                tier: assessment.combinedRisk.tier
            },
            recommendation,
            confidence: assessment.combinedRisk.confidence,
            evaluatedAt: new Date(),
            evaluationId
        };

        // 6. Log for learning
        await this.logShadowEvaluation(result);

        logger.info({
            taskId,
            riskTier: assessment.combinedRisk.tier,
            enforcedReq: CURRENT_ENFORCED_POLICY.requirement,
            shadowReq: shadowPolicy.requirement,
            delta
        }, 'Shadow policy evaluated');

        return result;
    }

    /**
     * LOG OUTCOME (Called after task completes)
     * This creates the counterfactual history
     */
    static async logOutcome(
        taskId: string,
        proofOutcome: ShadowOutcomeLog['proofOutcome'],
        disputeOutcome: ShadowOutcomeLog['disputeOutcome'],
        payoutDelayHours: number
    ): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            // Get the shadow evaluation for this task
            const [evaluation] = await db`
                SELECT enforced_policy, shadow_policy 
                FROM shadow_policy_log
                WHERE task_id = ${taskId}
                ORDER BY evaluated_at DESC
                LIMIT 1
            ` as any[];

            if (!evaluation) {
                logger.warn({ taskId }, 'No shadow evaluation found for outcome logging');
                return;
            }

            const enforcedPolicy = evaluation.enforced_policy;
            const shadowPolicy = evaluation.shadow_policy;

            // Determine if shadow policy would have differed
            const wouldHaveDiffered = this.outcomeWouldDiffer(
                enforcedPolicy,
                shadowPolicy,
                proofOutcome,
                disputeOutcome
            );

            // Calculate potential benefit
            const potentialBenefit = this.calculatePotentialBenefit(
                enforcedPolicy,
                shadowPolicy,
                proofOutcome,
                disputeOutcome,
                payoutDelayHours
            );

            await db`
                INSERT INTO shadow_outcome_log (
                    task_id, enforced_policy, shadow_policy,
                    proof_outcome, dispute_outcome, payout_delay_hours,
                    would_have_differed, potential_benefit
                ) VALUES (
                    ${taskId}, ${JSON.stringify(enforcedPolicy)}, ${JSON.stringify(shadowPolicy)},
                    ${proofOutcome}, ${disputeOutcome}, ${payoutDelayHours},
                    ${wouldHaveDiffered}, ${potentialBenefit}
                )
            `;

            logger.info({
                taskId,
                proofOutcome,
                disputeOutcome,
                wouldHaveDiffered,
                potentialBenefit
            }, 'Shadow outcome logged');

        } catch (error) {
            logger.warn({ error, taskId }, 'Failed to log shadow outcome');
        }
    }

    /**
     * GET SHADOW ANALYSIS REPORT
     * Aggregates shadow data to inform policy changes
     */
    static async getShadowAnalysis(days: number = 7): Promise<{
        totalEvaluations: number;
        byDelta: { same: number; moreStrict: number; lessStrict: number };
        byRiskTier: Record<RiskTier, number>;
        outcomeComparison: {
            enforcedDisputes: number;
            shadowWouldHavePreventedDisputes: number;
            enforcedFriction: number;
            shadowWouldHaveReducedFriction: number;
        };
        recommendations: string[];
    }> {
        const db = getDb();

        const defaultResult = {
            totalEvaluations: 0,
            byDelta: { same: 0, moreStrict: 0, lessStrict: 0 },
            byRiskTier: { minimal: 0, low: 0, medium: 0, high: 0, critical: 0 },
            outcomeComparison: {
                enforcedDisputes: 0,
                shadowWouldHavePreventedDisputes: 0,
                enforcedFriction: 0,
                shadowWouldHaveReducedFriction: 0
            },
            recommendations: []
        };

        if (!db) return defaultResult;

        try {
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            // Get evaluation stats
            const [evalStats] = await db`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE delta = 'SAME') as same,
                    COUNT(*) FILTER (WHERE delta = 'MORE_STRICT') as more_strict,
                    COUNT(*) FILTER (WHERE delta = 'LESS_STRICT') as less_strict
                FROM shadow_policy_log
                WHERE evaluated_at >= ${since}
            ` as any[];

            // Get tier distribution
            const tierStats = await db`
                SELECT risk_tier, COUNT(*) as count
                FROM shadow_policy_log
                WHERE evaluated_at >= ${since}
                GROUP BY risk_tier
            ` as any[];

            // Get outcome comparison
            const [outcomeStats] = await db`
                SELECT 
                    COUNT(*) FILTER (WHERE dispute_outcome != 'none') as disputes,
                    COUNT(*) FILTER (WHERE would_have_differed AND dispute_outcome != 'none') as prevented,
                    COUNT(*) FILTER (WHERE proof_outcome = 'submitted') as with_proof,
                    COUNT(*) FILTER (WHERE would_have_differed AND proof_outcome = 'not_required') as reduced_friction
                FROM shadow_outcome_log
                WHERE created_at >= ${since}
            ` as any[];

            // Build tier counts
            const byRiskTier: Record<RiskTier, number> = { minimal: 0, low: 0, medium: 0, high: 0, critical: 0 };
            for (const row of tierStats) {
                if (row.risk_tier in byRiskTier) {
                    byRiskTier[row.risk_tier as RiskTier] = parseInt(row.count);
                }
            }

            // Generate recommendations
            const recommendations: string[] = [];

            const lessStrictRatio = parseInt(evalStats?.less_strict || '0') / Math.max(parseInt(evalStats?.total || '1'), 1);
            if (lessStrictRatio > 0.3) {
                recommendations.push('Over 30% of tasks could use less proof friction. Consider relaxing policy for low-risk cohorts.');
            }

            const moreStrictRatio = parseInt(evalStats?.more_strict || '0') / Math.max(parseInt(evalStats?.total || '1'), 1);
            if (moreStrictRatio > 0.2 && parseInt(outcomeStats?.disputes || '0') > 5) {
                recommendations.push('High-risk tasks need stricter proof. Shadow policy would have prevented disputes.');
            }

            if (parseInt(byRiskTier.minimal.toString()) > parseInt(evalStats?.total || '1') * 0.5) {
                recommendations.push('Majority of tasks are minimal risk. Fast-track these for instant payout.');
            }

            return {
                totalEvaluations: parseInt(evalStats?.total || '0'),
                byDelta: {
                    same: parseInt(evalStats?.same || '0'),
                    moreStrict: parseInt(evalStats?.more_strict || '0'),
                    lessStrict: parseInt(evalStats?.less_strict || '0')
                },
                byRiskTier,
                outcomeComparison: {
                    enforcedDisputes: parseInt(outcomeStats?.disputes || '0'),
                    shadowWouldHavePreventedDisputes: parseInt(outcomeStats?.prevented || '0'),
                    enforcedFriction: parseInt(outcomeStats?.with_proof || '0'),
                    shadowWouldHaveReducedFriction: parseInt(outcomeStats?.reduced_friction || '0')
                },
                recommendations
            };

        } catch (error) {
            logger.error({ error }, 'Failed to generate shadow analysis');
            return defaultResult;
        }
    }

    // -----------------------------------------------------------
    // INTERNAL: Helpers
    // -----------------------------------------------------------

    private static getValueTier(price: number): 'low_value' | 'medium_value' | 'high_value' {
        if (price < 75) return 'low_value';
        if (price < 150) return 'medium_value';
        return 'high_value';
    }

    private static comparePolicies(enforced: ProofPolicy, shadow: ProofPolicy): 'SAME' | 'MORE_STRICT' | 'LESS_STRICT' {
        const enforcedScore = this.policyStrictnessScore(enforced);
        const shadowScore = this.policyStrictnessScore(shadow);

        if (Math.abs(enforcedScore - shadowScore) < 5) return 'SAME';
        return shadowScore > enforcedScore ? 'MORE_STRICT' : 'LESS_STRICT';
    }

    private static policyStrictnessScore(policy: ProofPolicy): number {
        let score = 0;

        const requirementScores: Record<ProofRequirement, number> = {
            'none': 0,
            'single_photo': 20,
            'multi_angle': 40,
            'photo_timestamp': 50,
            'photo_geo': 60,
            'photo_geo_delay': 80,
            'pre_completion': 100
        };

        score += requirementScores[policy.requirement];
        score += policy.requireGPS ? 10 : 0;
        score += policy.requireTimestamp ? 5 : 0;
        score += (24 - policy.deadlineHours) * 2;  // Shorter deadline = stricter
        score += (1 - policy.autoApproveThreshold) * 20;  // Lower threshold = stricter

        return score;
    }

    private static explainDelta(enforced: ProofPolicy, shadow: ProofPolicy): string[] {
        const details: string[] = [];

        if (enforced.requirement !== shadow.requirement) {
            details.push(`Proof requirement: ${enforced.requirement} → ${shadow.requirement}`);
        }
        if (enforced.deadlineHours !== shadow.deadlineHours) {
            details.push(`Deadline: ${enforced.deadlineHours}h → ${shadow.deadlineHours}h`);
        }
        if (enforced.requireGPS !== shadow.requireGPS) {
            details.push(`GPS required: ${enforced.requireGPS} → ${shadow.requireGPS}`);
        }
        if (enforced.requireTimestamp !== shadow.requireTimestamp) {
            details.push(`Timestamp required: ${enforced.requireTimestamp} → ${shadow.requireTimestamp}`);
        }
        if (enforced.autoApproveThreshold !== shadow.autoApproveThreshold) {
            details.push(`Auto-approve threshold: ${enforced.autoApproveThreshold} → ${shadow.autoApproveThreshold}`);
        }

        return details;
    }

    private static generateRecommendation(
        tier: RiskTier,
        delta: 'SAME' | 'MORE_STRICT' | 'LESS_STRICT',
        price: number
    ): string {
        if (delta === 'SAME') {
            return 'Current policy matches optimal for risk level';
        }

        if (delta === 'LESS_STRICT') {
            if (tier === 'minimal' && price < 50) {
                return 'CANDIDATE: Skip proof requirement entirely for this cohort';
            }
            return 'Consider reducing friction for this risk/value combination';
        }

        // MORE_STRICT
        if (tier === 'high' || tier === 'critical') {
            return 'ALERT: Current policy under-protects this high-risk scenario';
        }
        return 'Consider increasing verification for this risk/value combination';
    }

    private static outcomeWouldDiffer(
        enforced: ProofPolicy,
        shadow: ProofPolicy,
        proofOutcome: ShadowOutcomeLog['proofOutcome'],
        disputeOutcome: ShadowOutcomeLog['disputeOutcome']
    ): boolean {
        // If shadow = no proof and we required proof, friction could have been avoided
        if (shadow.requirement === 'none' && enforced.requirement !== 'none' && proofOutcome !== 'rejected') {
            return true;
        }

        // If shadow = stricter and there was a dispute, it might have been prevented
        if (this.policyStrictnessScore(shadow) > this.policyStrictnessScore(enforced) && disputeOutcome !== 'none') {
            return true;
        }

        return false;
    }

    private static calculatePotentialBenefit(
        enforced: ProofPolicy,
        shadow: ProofPolicy,
        proofOutcome: ShadowOutcomeLog['proofOutcome'],
        disputeOutcome: ShadowOutcomeLog['disputeOutcome'],
        payoutDelayHours: number
    ): string | null {
        // Less friction would have helped
        if (shadow.requirement === 'none' && enforced.requirement !== 'none' && proofOutcome === 'verified') {
            return `Unnecessary proof friction. Could have saved ~${payoutDelayHours}h delay.`;
        }

        // More friction would have helped
        if (disputeOutcome === 'refunded' && this.policyStrictnessScore(shadow) > this.policyStrictnessScore(enforced)) {
            return 'Stricter proof may have prevented dispute and refund.';
        }

        return null;
    }

    private static async logShadowEvaluation(result: PolicyComparison): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO shadow_policy_log (
                    evaluation_id, task_id, enforced_policy, shadow_policy,
                    delta, delta_details, risk_tier, combined_risk,
                    recommendation, confidence, evaluated_at
                ) VALUES (
                    ${result.evaluationId}, ${result.taskId},
                    ${JSON.stringify(result.enforcedPolicy)}, ${JSON.stringify(result.shadowPolicy)},
                    ${result.delta}, ${JSON.stringify(result.deltaDetails)},
                    ${result.riskAssessment.tier}, ${result.riskAssessment.combinedRisk},
                    ${result.recommendation}, ${result.confidence}, ${result.evaluatedAt}
                )
            `;
        } catch (error) {
            logger.warn({ error, taskId: result.taskId }, 'Failed to log shadow evaluation');
        }
    }
}
