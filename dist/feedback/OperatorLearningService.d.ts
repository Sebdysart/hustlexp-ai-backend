/**
 * OPERATOR LEARNING SERVICE (Phase 15C-1 - Flywheel 4)
 *
 * Purpose: Learn where AI vs humans perform better.
 *
 * This service:
 * - Tracks AI recommendations vs human decisions
 * - Measures agreement/disagreement rates
 * - Identifies where humans outperform AI
 * - Identifies where AI outperforms humans
 *
 * CONSTRAINTS:
 * - READ-ONLY analysis
 * - APPEND-ONLY persistence
 * - NO auto-execution
 * - All insights are advisory
 */
export interface OperatorLearningEvent {
    id: string;
    eventType: 'recommendation_review' | 'override' | 'dispute_resolution' | 'policy_decision';
    entityId: string;
    operatorId: string;
    aiRecommendation: {
        action: string;
        confidence: number;
        reasoning: string;
    };
    humanDecision: {
        action: string;
        reasoning?: string;
    };
    agreement: 'full' | 'partial' | 'disagreement';
    outcome?: {
        result: 'success' | 'failure' | 'neutral';
        metric: string;
        whoWasRight: 'ai' | 'human' | 'unclear';
    };
    createdAt: Date;
}
export interface OperatorLearningSummary {
    periodDays: number;
    agreement: {
        fullAgreementRate: number;
        partialAgreementRate: number;
        disagreementRate: number;
        totalDecisions: number;
    };
    accuracy: {
        aiCorrectRate: number;
        humanCorrectRate: number;
        unclearRate: number;
        decisionsWithOutcome: number;
    };
    patterns: {
        aiStrengths: string[];
        humanStrengths: string[];
        recommendations: string[];
    };
    byEventType: Record<string, {
        total: number;
        agreementRate: number;
        aiAccuracy: number;
    }>;
}
export declare class OperatorLearningService {
    /**
     * RECORD DECISION
     * Called when operator makes a decision on AI recommendation
     */
    static recordDecision(params: {
        eventType: OperatorLearningEvent['eventType'];
        entityId: string;
        operatorId: string;
        aiAction: string;
        aiConfidence: number;
        aiReasoning: string;
        humanAction: string;
        humanReasoning?: string;
    }): Promise<OperatorLearningEvent>;
    /**
     * RECORD OUTCOME
     * Called when we know the result of a decision
     */
    static recordOutcome(params: {
        eventId: string;
        result: 'success' | 'failure' | 'neutral';
        metric: string;
    }): Promise<void>;
    /**
     * GET LEARNING SUMMARY
     */
    static getSummary(days?: number): Promise<OperatorLearningSummary>;
    /**
     * GET RECOMMENDATIONS FOR IMPROVEMENT
     */
    static getImprovementRecommendations(): Promise<{
        forAI: string[];
        forOperators: string[];
        calibrationNeeded: boolean;
    }>;
    private static calculateAgreement;
    private static determineWhoWasRight;
    private static calculateAgreementStats;
    private static calculateAccuracyStats;
    private static identifyPatterns;
    private static groupByEventType;
    private static persistEvent;
}
//# sourceMappingURL=OperatorLearningService.d.ts.map