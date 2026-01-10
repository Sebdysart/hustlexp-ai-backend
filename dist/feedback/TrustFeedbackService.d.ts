/**
 * TRUST FEEDBACK SERVICE (Phase 15C-1 - Flywheel 3)
 *
 * Purpose: Explain friction to users instead of making them resent it.
 *
 * This service:
 * - Explains why friction appeared
 * - Shows evidence-backed benefits
 * - Suggests actions to reduce future friction
 * - Feeds learning loop
 *
 * CONSTRAINTS:
 * - CANNOT block payouts
 * - CANNOT trigger KillSwitch
 * - CANNOT enforce friction (UX-only)
 * - READ-ONLY feedback
 * - APPEND-ONLY persistence
 */
import { RiskTier } from '../services/RiskScoreService.js';
export interface TrustFeedbackEvent {
    id: string;
    taskId: string;
    userId: string;
    userRole: 'poster' | 'hustler';
    frictionApplied: {
        type: 'proof_required' | 'confirmation_step' | 'visibility_delay' | 'size_limit';
        level: 'minimal' | 'standard' | 'elevated' | 'high';
        riskTier: RiskTier;
        riskScore: number;
    };
    explanation: {
        userFacing: string;
        internalReason: string;
        benefitStatement: string;
    };
    outcome?: {
        disputed: boolean;
        frictionBypass?: boolean;
        completedSuccessfully: boolean;
    };
    createdAt: Date;
}
export interface TrustFeedbackSummary {
    taskId: string;
    explanation: {
        headline: string;
        reason: string;
        benefit: string;
    };
    howToReduce: {
        actions: string[];
        currentProgress: string;
    };
    trustContext: {
        currentTier: RiskTier;
        frictionLevel: string;
        tasksUntilReview: number;
    };
}
export declare class TrustFeedbackService {
    /**
     * RECORD FRICTION APPLICATION
     * Called when friction is recommended for a task
     */
    static recordFriction(params: {
        taskId: string;
        userId: string;
        userRole: 'poster' | 'hustler';
        frictionType: 'proof_required' | 'confirmation_step' | 'visibility_delay' | 'size_limit';
        riskTier: RiskTier;
        riskScore: number;
    }): Promise<TrustFeedbackEvent>;
    /**
     * RECORD OUTCOME
     * Called when task completes
     */
    static recordOutcome(params: {
        taskId: string;
        disputed: boolean;
        completedSuccessfully: boolean;
    }): Promise<void>;
    /**
     * GET FEEDBACK FOR TASK
     */
    static getFeedback(taskId: string): Promise<TrustFeedbackSummary | null>;
    /**
     * GET USER TRUST PROFILE
     */
    static getUserTrustProfile(userId: string): Promise<{
        totalInteractions: number;
        frictionFrequency: Record<string, number>;
        disputeRate: number;
        trustTrajectory: 'improving' | 'stable' | 'declining';
        nextSteps: string[];
    }>;
    private static getFrictionLevel;
    private static generateExplanation;
    private static buildSummary;
    private static getReductionActions;
    private static getTasksUntilReview;
    private static getNextSteps;
    private static persistEvent;
}
//# sourceMappingURL=TrustFeedbackService.d.ts.map