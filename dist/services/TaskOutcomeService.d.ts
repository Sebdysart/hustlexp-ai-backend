/**
 * TaskOutcomeService - Phase 3 TPEE Learning Infrastructure
 *
 * IMMUTABLE, APPEND-ONLY outcome records that enable AI learning.
 *
 * Every task outcome must:
 * 1. Link to tpee_evaluation_id (if task was TPEEd)
 * 2. Be recorded exactly once (enforced by unique constraint)
 * 3. Never be updated after creation
 *
 * Outcome Types:
 * - completed: Task successfully finished
 * - canceled_by_poster: Poster canceled before completion
 * - canceled_by_hustler: Hustler canceled before completion
 * - disputed: Task entered dispute resolution
 * - refunded: Full refund issued
 * - expired_unaccepted: Task expired with no hustler assigned
 * - expired_incomplete: Task expired after assignment but before completion
 */
export type OutcomeType = 'completed' | 'canceled_by_poster' | 'canceled_by_hustler' | 'disputed' | 'refunded' | 'expired_unaccepted' | 'expired_incomplete';
export interface TaskOutcome {
    id: string;
    task_id: string;
    tpee_evaluation_id: string | null;
    outcome_type: OutcomeType;
    completion_time_minutes: number | null;
    dispute_reason: string | null;
    refund_amount: number | null;
    hustler_rating: number | null;
    poster_rating: number | null;
    earnings_actual: number | null;
    metadata: Record<string, unknown>;
    created_at: Date;
}
export interface RecordOutcomeInput {
    task_id: string;
    outcome_type: OutcomeType;
    completion_time_minutes?: number;
    dispute_reason?: string;
    refund_amount?: number;
    hustler_rating?: number;
    poster_rating?: number;
    earnings_actual?: number;
    metadata?: Record<string, unknown>;
}
declare class TaskOutcomeServiceClass {
    /**
     * Record a task outcome (immutable, append-only)
     * Will fail if outcome already exists for this task
     */
    recordOutcome(input: RecordOutcomeInput): Promise<TaskOutcome | null>;
    /**
     * Get outcome for a task
     */
    getOutcome(taskId: string): Promise<TaskOutcome | null>;
    /**
     * Get outcomes by TPEE evaluation ID (for learning queries)
     */
    getOutcomesByTPEEEvaluation(tpeeEvalId: string): Promise<TaskOutcome[]>;
    /**
     * Get decision quality metrics for TPEE decisions
     */
    getTPEEDecisionQualityReport(): Promise<{
        total_tasks: number;
        by_decision: Record<string, {
            count: number;
            completed_rate: number;
            disputed_rate: number;
            canceled_rate: number;
            avg_rating: number | null;
        }>;
    } | null>;
    /**
     * Check if TPEE blocks correlate with later abuse
     * (answered via dispute rate of users who were blocked)
     */
    getBlockedUserOutcomeAnalysis(): Promise<{
        users_ever_blocked: number;
        subsequent_accepted_tasks: number;
        subsequent_dispute_rate: number;
    } | null>;
}
export declare const TaskOutcomeService: TaskOutcomeServiceClass;
export {};
//# sourceMappingURL=TaskOutcomeService.d.ts.map