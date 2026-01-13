/**
 * PRIORITY SCORE SERVICE (staging/PRIORITY_MATH.md)
 *
 * Constitutional priority scoring for hustler task visibility.
 *
 * Formula:
 * priority_score = (xp_component × 0.5) + (trust_component × 0.3) + (streak_component × 0.2)
 *
 * Components:
 * - XP: min(100, sqrt(total_xp) × 2)
 * - Trust: trust_tier × 25
 * - Streak: min(100, current_streak × 3)
 *
 * @version 1.0.0 (PRIORITY_MATH.md aligned)
 */
export interface PriorityScore {
    userId: string;
    score: number;
    xpComponent: number;
    trustComponent: number;
    streakComponent: number;
    decayApplied: boolean;
    decayedScore?: number;
    penalties: number;
    bonuses: number;
    effectiveScore: number;
    calculatedAt: Date;
}
export interface FeedbackImpact {
    type: 'positive' | 'negative' | 'neutral';
    event: string;
    priorityChange: number;
    recoveryTasks: number;
}
declare class PriorityScoreServiceClass {
    /**
     * Calculate priority score for a user
     */
    calculateScore(userId: string): Promise<PriorityScore>;
    /**
     * Get feedback-based modifiers
     */
    getFeedbackModifiers(userId: string): Promise<{
        penalties: number;
        bonuses: number;
    }>;
    /**
     * Compare two users for task visibility order
     * Returns -1 if userA should see task first, 1 if userB should
     */
    compareUsers(userAId: string, userBId: string): Promise<number>;
    /**
     * Record task completion and update decay recovery
     */
    recordTaskCompletion(userId: string): Promise<{
        restored: boolean;
        newScore: number;
    }>;
    /**
     * Get feedback impact description
     */
    getFeedbackImpact(event: string): FeedbackImpact;
}
export declare const PriorityScoreService: PriorityScoreServiceClass;
export {};
//# sourceMappingURL=PriorityScoreService.d.ts.map