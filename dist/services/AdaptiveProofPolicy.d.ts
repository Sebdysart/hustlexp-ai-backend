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
import { RiskTier } from './RiskScoreService.js';
export type ProofRequirement = 'none' | 'single_photo' | 'multi_angle' | 'photo_timestamp' | 'photo_geo' | 'photo_geo_delay' | 'pre_completion';
export interface ProofPolicy {
    requirement: ProofRequirement;
    deadlineHours: number;
    autoApproveThreshold: number;
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
/**
 * Ω-OPS ENFORCEMENT MODE (Phase Ω-OPS-6)
 *
 * HARD LIMITS (CORRECTION #3):
 * ✅ May require proof at task creation
 * ✅ May specify proof type (photo/video)
 * ❌ May NOT block task creation
 * ❌ May NOT delay payouts
 * ❌ May NOT affect disputes
 */
export type PolicyMode = 'shadow' | 'enforcing';
export declare class AdaptiveProofPolicy {
    /**
     * GET CURRENT MODE
     */
    static getMode(): PolicyMode;
    /**
     * GET REQUIREMENTS FOR TASK (ENFORCEMENT MODE)
     *
     * Returns proof requirements for a task AT CREATION TIME ONLY.
     *
     * HARD LIMITS:
     * - May NOT block task creation
     * - May NOT delay payouts
     * - May NOT affect disputes
     */
    static getRequirements(taskId: string, category: string, price: number, posterId: string): Promise<{
        proofRequired: boolean;
        proofType: ProofRequirement;
        requireGPS: boolean;
        requireTimestamp: boolean;
        maxSubmissions: number;
        deadlineHours: number;
        policyMode: PolicyMode;
        isEnforced: boolean;
    }>;
    /**
     * EVALUATE SHADOW POLICY
     * Compare what we enforce vs what we SHOULD enforce
     */
    static evaluateShadowPolicy(taskId: string, category: string, price: number, posterId: string, hustlerId?: string): Promise<PolicyComparison>;
    /**
     * LOG OUTCOME (Called after task completes)
     * This creates the counterfactual history
     */
    static logOutcome(taskId: string, proofOutcome: ShadowOutcomeLog['proofOutcome'], disputeOutcome: ShadowOutcomeLog['disputeOutcome'], payoutDelayHours: number): Promise<void>;
    /**
     * GET SHADOW ANALYSIS REPORT
     * Aggregates shadow data to inform policy changes
     */
    static getShadowAnalysis(days?: number): Promise<{
        totalEvaluations: number;
        byDelta: {
            same: number;
            moreStrict: number;
            lessStrict: number;
        };
        byRiskTier: Record<RiskTier, number>;
        outcomeComparison: {
            enforcedDisputes: number;
            shadowWouldHavePreventedDisputes: number;
            enforcedFriction: number;
            shadowWouldHaveReducedFriction: number;
        };
        recommendations: string[];
    }>;
    private static getValueTier;
    private static comparePolicies;
    private static policyStrictnessScore;
    private static explainDelta;
    private static generateRecommendation;
    private static outcomeWouldDiffer;
    private static calculatePotentialBenefit;
    private static logShadowEvaluation;
}
//# sourceMappingURL=AdaptiveProofPolicy.d.ts.map