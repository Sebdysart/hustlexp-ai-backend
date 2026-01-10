/**
 * RISK SCORE SERVICE (Phase 14D-1)
 *
 * Control Plane Component - READ ONLY
 *
 * Purpose: Score risk BEFORE money is ever at risk.
 *
 * This service:
 * - Scores tasks, posters, and hustlers
 * - Provides explainable reasons
 * - Logs all scores for learning
 * - NEVER touches payouts or ledger
 *
 * Inputs:
 * - User history (completions, disputes, cancellations)
 * - Task characteristics (category, price, time)
 * - Behavioral signals (latency, patterns)
 *
 * Outputs:
 * - Risk scores (0-100)
 * - Confidence levels
 * - Explainable reasons
 */
export interface RiskScore {
    score: number;
    tier: RiskTier;
    confidence: number;
    reasons: RiskReason[];
    evaluatedAt: Date;
    evaluationId: string;
}
export type RiskTier = 'minimal' | 'low' | 'medium' | 'high' | 'critical';
export interface RiskReason {
    factor: string;
    impact: 'positive' | 'negative' | 'neutral';
    weight: number;
    description: string;
}
export interface TaskRiskContext {
    taskId: string;
    category: string;
    price: number;
    posterId: string;
    hustlerId?: string;
    isFirstTimeMatch?: boolean;
}
export interface UserRiskProfile {
    userId: string;
    role: 'poster' | 'hustler';
    score: RiskScore;
    history: {
        totalTasks: number;
        completedTasks: number;
        disputesInvolved: number;
        disputesLost: number;
        proofRejections: number;
        cancellations: number;
        avgCompletionTimeHours: number;
        accountAgeDays: number;
        consecutiveSuccesses: number;
    };
}
export interface FullRiskAssessment {
    taskRisk: RiskScore;
    posterRisk: RiskScore;
    hustlerRisk: RiskScore | null;
    combinedRisk: RiskScore;
    recommendation: RiskRecommendation;
}
export type RiskRecommendation = 'PROCEED_NORMAL' | 'REQUIRE_PROOF' | 'REQUIRE_ENHANCED_PROOF' | 'FLAG_FOR_REVIEW' | 'HIGH_FRICTION';
export declare class RiskScoreService {
    /**
     * SCORE A USER (Poster or Hustler)
     */
    static scoreUser(userId: string, role: 'poster' | 'hustler'): Promise<UserRiskProfile>;
    /**
     * SCORE A TASK
     */
    static scoreTask(context: TaskRiskContext): Promise<RiskScore>;
    /**
     * FULL RISK ASSESSMENT (Task + Both Parties)
     */
    static assessFullRisk(context: TaskRiskContext): Promise<FullRiskAssessment>;
    private static getUserHistory;
    private static calculateUserScore;
    private static calculateCombinedRisk;
    private static buildScore;
    private static calculateConfidence;
    private static generateRecommendation;
    private static logScore;
}
//# sourceMappingURL=RiskScoreService.d.ts.map