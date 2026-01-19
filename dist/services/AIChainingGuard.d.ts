/**
 * AI CHAINING GUARD (AUDIT-14)
 *
 * Prevents AI-to-AI chaining without human intervention.
 *
 * AUDIT-14 Rule:
 * "No AI output may trigger another AI action without human review."
 *
 * Violations:
 * - AI proof assessment → automatic AI dispute resolution
 * - AI matching → automatic AI pricing
 * - AI recommendation → automatic AI action
 *
 * @version 1.0.0
 * @see ARCHITECTURE.md §3.1.1 (AUDIT-14)
 */
export type AIAction = 'proof_assessment' | 'dispute_resolution' | 'smart_match' | 'pricing_recommendation' | 'risk_score' | 'fraud_detection' | 'content_moderation' | 'task_recommendation' | 'profile_optimization' | 'coaching';
export interface AIActionRecord {
    actionId: string;
    actionType: AIAction;
    initiatedAt: Date;
    humanReviewed: boolean;
    reviewedAt?: Date;
    reviewedBy?: string;
    result?: unknown;
}
export interface ChainingViolation {
    sourceAction: AIAction;
    targetAction: AIAction;
    timestamp: Date;
    blocked: boolean;
    reason: string;
}
declare class AIChainingGuardClass {
    private recentActions;
    private violations;
    private readonly windowMs;
    /**
     * Record an AI action
     */
    recordAction(userId: string, actionType: AIAction, actionId: string): AIActionRecord;
    /**
     * Mark an action as human-reviewed
     */
    markReviewed(userId: string, actionType: AIAction, actionId: string, reviewedBy: string): void;
    /**
     * Check if an AI action can proceed (AUDIT-14 enforcement)
     * Returns true if allowed, false if blocked
     */
    canProceed(userId: string, targetAction: AIAction, _requestId?: string): {
        allowed: boolean;
        reason?: string;
        violation?: ChainingViolation;
    };
    /**
     * Get unreviewed actions for a user within the window
     */
    private getUnreviewedActions;
    /**
     * Prune old records from memory
     */
    private pruneOldRecords;
    /**
     * Get recent violations (for monitoring)
     */
    getViolations(limit?: number): ChainingViolation[];
    /**
     * Get violation count (for alerting)
     */
    getViolationCount(): number;
    /**
     * Reset (for testing)
     */
    reset(): void;
}
export declare const AIChainingGuard: AIChainingGuardClass;
/**
 * Decorator to enforce AI chaining rules
 * Use this on AI service methods that should be protected
 */
export declare function enforceNoChaining(actionType: AIAction): (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor;
export {};
//# sourceMappingURL=AIChainingGuard.d.ts.map