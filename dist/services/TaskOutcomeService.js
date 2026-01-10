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
import { v4 as uuidv4 } from 'uuid';
import { sql, isDatabaseAvailable } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
// ============================================
// TaskOutcome Service
// ============================================
class TaskOutcomeServiceClass {
    /**
     * Record a task outcome (immutable, append-only)
     * Will fail if outcome already exists for this task
     */
    async recordOutcome(input) {
        if (!isDatabaseAvailable() || !sql) {
            serviceLogger.warn({ taskId: input.task_id }, 'Cannot record outcome - database not available');
            return null;
        }
        try {
            // First, get the TPEE evaluation ID from the task
            const [task] = await sql `
                SELECT tpee_evaluation_id FROM tasks WHERE id = ${input.task_id}
            `;
            const outcomeId = uuidv4();
            const tpeeEvalId = task?.tpee_evaluation_id || null;
            // Insert outcome (unique constraint prevents duplicates)
            await sql `
                INSERT INTO task_outcomes (
                    id, task_id, tpee_evaluation_id, outcome_type,
                    completion_time_minutes, dispute_reason, refund_amount,
                    hustler_rating, poster_rating, earnings_actual, metadata
                ) VALUES (
                    ${outcomeId},
                    ${input.task_id},
                    ${tpeeEvalId},
                    ${input.outcome_type},
                    ${input.completion_time_minutes || null},
                    ${input.dispute_reason || null},
                    ${input.refund_amount || null},
                    ${input.hustler_rating || null},
                    ${input.poster_rating || null},
                    ${input.earnings_actual || null},
                    ${JSON.stringify(input.metadata || {})}
                )
            `;
            serviceLogger.info({
                outcomeId,
                taskId: input.task_id,
                tpeeEvalId,
                outcomeType: input.outcome_type,
            }, 'Task outcome recorded');
            return {
                id: outcomeId,
                task_id: input.task_id,
                tpee_evaluation_id: tpeeEvalId,
                outcome_type: input.outcome_type,
                completion_time_minutes: input.completion_time_minutes || null,
                dispute_reason: input.dispute_reason || null,
                refund_amount: input.refund_amount || null,
                hustler_rating: input.hustler_rating || null,
                poster_rating: input.poster_rating || null,
                earnings_actual: input.earnings_actual || null,
                metadata: input.metadata || {},
                created_at: new Date(),
            };
        }
        catch (error) {
            // Check for unique constraint violation (outcome already exists)
            if (error instanceof Error && error.message.includes('idx_task_outcomes_task_unique')) {
                serviceLogger.warn({
                    taskId: input.task_id,
                    attemptedOutcome: input.outcome_type,
                }, 'Outcome already recorded for this task (immutability enforced)');
                return null;
            }
            serviceLogger.error({ error, taskId: input.task_id }, 'Failed to record task outcome');
            throw error;
        }
    }
    /**
     * Get outcome for a task
     */
    async getOutcome(taskId) {
        if (!isDatabaseAvailable() || !sql) {
            return null;
        }
        try {
            const [outcome] = await sql `
                SELECT * FROM task_outcomes WHERE task_id = ${taskId}
            `;
            if (!outcome) {
                return null;
            }
            return {
                id: outcome.id,
                task_id: outcome.task_id,
                tpee_evaluation_id: outcome.tpee_evaluation_id,
                outcome_type: outcome.outcome_type,
                completion_time_minutes: outcome.completion_time_minutes,
                dispute_reason: outcome.dispute_reason,
                refund_amount: Number(outcome.refund_amount) || null,
                hustler_rating: outcome.hustler_rating,
                poster_rating: outcome.poster_rating,
                earnings_actual: Number(outcome.earnings_actual) || null,
                metadata: outcome.metadata || {},
                created_at: new Date(outcome.created_at),
            };
        }
        catch (error) {
            serviceLogger.error({ error, taskId }, 'Failed to get task outcome');
            return null;
        }
    }
    /**
     * Get outcomes by TPEE evaluation ID (for learning queries)
     */
    async getOutcomesByTPEEEvaluation(tpeeEvalId) {
        if (!isDatabaseAvailable() || !sql) {
            return [];
        }
        try {
            const outcomes = await sql `
                SELECT * FROM task_outcomes WHERE tpee_evaluation_id = ${tpeeEvalId}
            `;
            return outcomes.map(o => ({
                id: o.id,
                task_id: o.task_id,
                tpee_evaluation_id: o.tpee_evaluation_id,
                outcome_type: o.outcome_type,
                completion_time_minutes: o.completion_time_minutes,
                dispute_reason: o.dispute_reason,
                refund_amount: Number(o.refund_amount) || null,
                hustler_rating: o.hustler_rating,
                poster_rating: o.poster_rating,
                earnings_actual: Number(o.earnings_actual) || null,
                metadata: o.metadata || {},
                created_at: new Date(o.created_at),
            }));
        }
        catch (error) {
            serviceLogger.error({ error, tpeeEvalId }, 'Failed to get outcomes by TPEE eval');
            return [];
        }
    }
    // ============================================
    // Learning Queries (Phase 3C)
    // ============================================
    /**
     * Get decision quality metrics for TPEE decisions
     */
    async getTPEEDecisionQualityReport() {
        if (!isDatabaseAvailable() || !sql) {
            return null;
        }
        try {
            // Count outcomes by TPEE decision
            const stats = await sql `
                SELECT 
                    t.tpee_decision,
                    COUNT(o.id) as total,
                    COUNT(CASE WHEN o.outcome_type = 'completed' THEN 1 END) as completed,
                    COUNT(CASE WHEN o.outcome_type = 'disputed' THEN 1 END) as disputed,
                    COUNT(CASE WHEN o.outcome_type IN ('canceled_by_poster', 'canceled_by_hustler') THEN 1 END) as canceled,
                    AVG(o.hustler_rating) as avg_rating
                FROM tasks t
                LEFT JOIN task_outcomes o ON o.task_id = t.id
                WHERE t.tpee_decision IS NOT NULL
                GROUP BY t.tpee_decision
            `;
            const [totalRow] = await sql `
                SELECT COUNT(*) as count FROM tasks WHERE tpee_decision IS NOT NULL
            `;
            const byDecision = {};
            for (const row of stats) {
                const total = Number(row.total) || 0;
                byDecision[row.tpee_decision] = {
                    count: total,
                    completed_rate: total > 0 ? Number(row.completed) / total : 0,
                    disputed_rate: total > 0 ? Number(row.disputed) / total : 0,
                    canceled_rate: total > 0 ? Number(row.canceled) / total : 0,
                    avg_rating: row.avg_rating ? Number(row.avg_rating) : null,
                };
            }
            return {
                total_tasks: Number(totalRow?.count) || 0,
                by_decision: byDecision,
            };
        }
        catch (error) {
            serviceLogger.error({ error }, 'Failed to get TPEE decision quality report');
            return null;
        }
    }
    /**
     * Check if TPEE blocks correlate with later abuse
     * (answered via dispute rate of users who were blocked)
     */
    async getBlockedUserOutcomeAnalysis() {
        if (!isDatabaseAvailable() || !sql) {
            return null;
        }
        try {
            // Find users who had at least one BLOCK, then check their later task outcomes
            const result = await sql `
                WITH blocked_users AS (
                    SELECT DISTINCT client_id 
                    FROM tasks 
                    WHERE tpee_decision = 'BLOCK'
                ),
                subsequent_tasks AS (
                    SELECT t.id, o.outcome_type
                    FROM tasks t
                    JOIN blocked_users bu ON t.client_id = bu.client_id
                    LEFT JOIN task_outcomes o ON o.task_id = t.id
                    WHERE t.tpee_decision = 'ACCEPT'
                )
                SELECT 
                    (SELECT COUNT(*) FROM blocked_users) as users_blocked,
                    COUNT(*) as accepted_tasks,
                    COUNT(CASE WHEN outcome_type = 'disputed' THEN 1 END) as disputed
                FROM subsequent_tasks
            `;
            const row = result[0];
            const acceptedTasks = Number(row?.accepted_tasks) || 0;
            return {
                users_ever_blocked: Number(row?.users_blocked) || 0,
                subsequent_accepted_tasks: acceptedTasks,
                subsequent_dispute_rate: acceptedTasks > 0
                    ? Number(row?.disputed) / acceptedTasks
                    : 0,
            };
        }
        catch (error) {
            serviceLogger.error({ error }, 'Failed to get blocked user outcome analysis');
            return null;
        }
    }
}
export const TaskOutcomeService = new TaskOutcomeServiceClass();
//# sourceMappingURL=TaskOutcomeService.js.map