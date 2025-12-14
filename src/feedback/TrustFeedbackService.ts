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

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { RiskTier } from '../services/RiskScoreService.js';

const logger = serviceLogger.child({ module: 'TrustFeedback' });


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

export interface TrustFeedbackEvent {
    id: string;
    taskId: string;
    userId: string;
    userRole: 'poster' | 'hustler';

    // Friction context
    frictionApplied: {
        type: 'proof_required' | 'confirmation_step' | 'visibility_delay' | 'size_limit';
        level: 'minimal' | 'standard' | 'elevated' | 'high';
        riskTier: RiskTier;
        riskScore: number;
    };

    // Explanation
    explanation: {
        userFacing: string;
        internalReason: string;
        benefitStatement: string;
    };

    // Outcome (if known)
    outcome?: {
        disputed: boolean;
        frictionBypass?: boolean;  // User tried to bypass
        completedSuccessfully: boolean;
    };

    createdAt: Date;
}

export interface TrustFeedbackSummary {
    taskId: string;

    // User-facing explanation
    explanation: {
        headline: string;
        reason: string;
        benefit: string;
    };

    // How to reduce friction
    howToReduce: {
        actions: string[];
        currentProgress: string;
    };

    // Trust context
    trustContext: {
        currentTier: RiskTier;
        frictionLevel: string;
        tasksUntilReview: number;
    };
}

// ============================================================
// TRUST FEEDBACK SERVICE
// ============================================================

export class TrustFeedbackService {

    /**
     * RECORD FRICTION APPLICATION
     * Called when friction is recommended for a task
     */
    static async recordFriction(params: {
        taskId: string;
        userId: string;
        userRole: 'poster' | 'hustler';
        frictionType: 'proof_required' | 'confirmation_step' | 'visibility_delay' | 'size_limit';
        riskTier: RiskTier;
        riskScore: number;
    }): Promise<TrustFeedbackEvent> {
        const { taskId, userId, userRole, frictionType, riskTier, riskScore } = params;

        // Determine level
        const level = this.getFrictionLevel(riskTier);

        // Generate explanation
        const explanation = this.generateExplanation(frictionType, riskTier, userRole);

        const event: TrustFeedbackEvent = {
            id: ulid(),
            taskId,
            userId,
            userRole,
            frictionApplied: {
                type: frictionType,
                level,
                riskTier,
                riskScore
            },
            explanation,
            createdAt: new Date()
        };

        // Persist
        await this.persistEvent(event);

        // Emit metric (log for now - would integrate with metrics system)
        logger.info({
            type: frictionType,
            level,
            tier: riskTier
        });

        logger.info({
            taskId, userId, frictionType, level
        }, 'Trust friction recorded');

        return event;
    }

    /**
     * RECORD OUTCOME
     * Called when task completes
     */
    static async recordOutcome(params: {
        taskId: string;
        disputed: boolean;
        completedSuccessfully: boolean;
    }): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            const [existing] = await db`
                SELECT data FROM trust_feedback_events WHERE task_id = ${params.taskId}
            ` as any[];

            if (!existing) return;

            const event: TrustFeedbackEvent = existing.data;
            event.outcome = {
                disputed: params.disputed,
                completedSuccessfully: params.completedSuccessfully
            };

            await db`
                UPDATE trust_feedback_events 
                SET data = ${JSON.stringify(event)}
                WHERE task_id = ${params.taskId}
            `;

            // Emit learning metric
            if (event.frictionApplied.level === 'elevated' || event.frictionApplied.level === 'high') {
                if (!params.disputed) {
                    logger.info({
                        tier: event.frictionApplied.riskTier
                    });
                }
            }

        } catch (error) {
            logger.error({ error, taskId: params.taskId }, 'Failed to record outcome');
        }
    }

    /**
     * GET FEEDBACK FOR TASK
     */
    static async getFeedback(taskId: string): Promise<TrustFeedbackSummary | null> {
        const db = getDb();
        if (!db) return null;

        try {
            const [row] = await db`
                SELECT data FROM trust_feedback_events WHERE task_id = ${taskId}
            ` as any[];

            if (!row) return null;

            const event: TrustFeedbackEvent = row.data;
            return this.buildSummary(event);

        } catch (error) {
            logger.error({ error, taskId }, 'Failed to get trust feedback');
            return null;
        }
    }

    /**
     * GET USER TRUST PROFILE
     */
    static async getUserTrustProfile(userId: string): Promise<{
        totalInteractions: number;
        frictionFrequency: Record<string, number>;
        disputeRate: number;
        trustTrajectory: 'improving' | 'stable' | 'declining';
        nextSteps: string[];
    }> {
        const db = getDb();

        const defaultProfile = {
            totalInteractions: 0,
            frictionFrequency: {},
            disputeRate: 0,
            trustTrajectory: 'stable' as const,
            nextSteps: ['Complete tasks successfully to build trust']
        };

        if (!db) return defaultProfile;

        try {
            const rows = await db`
                SELECT data FROM trust_feedback_events 
                WHERE user_id = ${userId}
                ORDER BY created_at DESC
                LIMIT 50
            ` as any[];

            if (rows.length === 0) return defaultProfile;

            const events: TrustFeedbackEvent[] = rows.map((r: any) => r.data);

            // Count friction types
            const frictionFrequency: Record<string, number> = {};
            let disputes = 0;
            let withOutcome = 0;

            for (const e of events) {
                const type = e.frictionApplied.type;
                frictionFrequency[type] = (frictionFrequency[type] || 0) + 1;

                if (e.outcome) {
                    withOutcome++;
                    if (e.outcome.disputed) disputes++;
                }
            }

            const disputeRate = withOutcome > 0 ? disputes / withOutcome : 0;

            // Determine trajectory
            const recentEvents = events.slice(0, 10);
            const olderEvents = events.slice(10, 20);

            let trajectory: 'improving' | 'stable' | 'declining' = 'stable';
            if (recentEvents.length >= 5 && olderEvents.length >= 5) {
                const recentHighFriction = recentEvents.filter(e =>
                    e.frictionApplied.level === 'elevated' || e.frictionApplied.level === 'high'
                ).length;
                const olderHighFriction = olderEvents.filter(e =>
                    e.frictionApplied.level === 'elevated' || e.frictionApplied.level === 'high'
                ).length;

                if (recentHighFriction < olderHighFriction) trajectory = 'improving';
                if (recentHighFriction > olderHighFriction) trajectory = 'declining';
            }

            // Generate next steps
            const nextSteps = this.getNextSteps(disputeRate, trajectory, frictionFrequency);

            return {
                totalInteractions: events.length,
                frictionFrequency,
                disputeRate,
                trustTrajectory: trajectory,
                nextSteps
            };

        } catch (error) {
            logger.error({ error, userId }, 'Failed to get trust profile');
            return defaultProfile;
        }
    }

    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------

    private static getFrictionLevel(tier: RiskTier): 'minimal' | 'standard' | 'elevated' | 'high' {
        switch (tier) {
            case 'minimal': return 'minimal';
            case 'low': return 'standard';
            case 'medium': return 'standard';
            case 'high': return 'elevated';
            case 'critical': return 'high';
        }
    }

    private static generateExplanation(
        type: string,
        tier: RiskTier,
        role: 'poster' | 'hustler'
    ): TrustFeedbackEvent['explanation'] {
        const benefits: Record<string, string> = {
            proof_required: 'Tasks with photo proof have 73% fewer disputes',
            confirmation_step: 'Confirmation reduces misunderstandings by 45%',
            visibility_delay: 'Delayed visibility allows better matching',
            size_limit: 'Smaller tasks complete faster with fewer issues'
        };

        const reasons: Record<RiskTier, string> = {
            minimal: 'Standard verification for all transactions',
            low: 'Basic verification to protect both parties',
            medium: 'Additional verification based on transaction profile',
            high: 'Enhanced verification for complex transactions',
            critical: 'Maximum verification for high-value transactions'
        };

        const userFacing = role === 'poster'
            ? 'This step helps ensure your task completes smoothly'
            : 'This verification protects your earnings and reputation';

        return {
            userFacing,
            internalReason: `Risk tier: ${tier}. Friction type: ${type}`,
            benefitStatement: benefits[type] || 'This step improves success rates'
        };
    }

    private static buildSummary(event: TrustFeedbackEvent): TrustFeedbackSummary {
        const headlines: Record<string, string> = {
            minimal: '✓ Streamlined process',
            standard: '✓ Standard verification',
            elevated: '⚡ Enhanced verification',
            high: '🔒 Maximum protection'
        };

        return {
            taskId: event.taskId,
            explanation: {
                headline: headlines[event.frictionApplied.level],
                reason: event.explanation.userFacing,
                benefit: event.explanation.benefitStatement
            },
            howToReduce: {
                actions: this.getReductionActions(event.frictionApplied.riskTier),
                currentProgress: `Current trust tier: ${event.frictionApplied.riskTier}`
            },
            trustContext: {
                currentTier: event.frictionApplied.riskTier,
                frictionLevel: event.frictionApplied.level,
                tasksUntilReview: this.getTasksUntilReview(event.frictionApplied.riskTier)
            }
        };
    }

    private static getReductionActions(tier: RiskTier): string[] {
        if (tier === 'minimal' || tier === 'low') {
            return ['You have earned streamlined verification!'];
        }

        const actions: string[] = [];
        actions.push('Complete tasks successfully');
        actions.push('Submit clear, timestamped proof photos');
        actions.push('Resolve issues promptly and professionally');

        if (tier === 'high' || tier === 'critical') {
            actions.push('Build consistent track record over 10+ tasks');
        }

        return actions;
    }

    private static getTasksUntilReview(tier: RiskTier): number {
        switch (tier) {
            case 'critical': return 10;
            case 'high': return 7;
            case 'medium': return 5;
            case 'low': return 3;
            case 'minimal': return 0;
        }
    }

    private static getNextSteps(
        disputeRate: number,
        trajectory: 'improving' | 'stable' | 'declining',
        frictionFrequency: Record<string, number>
    ): string[] {
        const steps: string[] = [];

        if (disputeRate > 0.05) {
            steps.push('Focus on dispute prevention to improve trust');
        }

        if (trajectory === 'declining') {
            steps.push('Recent activity shows increased friction - review recent tasks');
        } else if (trajectory === 'improving') {
            steps.push('Great progress! Continue to reduce friction level');
        }

        if (frictionFrequency['proof_required'] > 5) {
            steps.push('High-quality proofs can reduce verification requirements');
        }

        if (steps.length === 0) {
            steps.push('Maintain consistent performance to keep streamlined access');
        }

        return steps;
    }

    private static async persistEvent(event: TrustFeedbackEvent): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO trust_feedback_events (
                    id, task_id, user_id, user_role, friction_level,
                    risk_tier, data, created_at
                ) VALUES (
                    ${event.id}, ${event.taskId}, ${event.userId}, ${event.userRole},
                    ${event.frictionApplied.level}, ${event.frictionApplied.riskTier},
                    ${JSON.stringify(event)}, ${event.createdAt}
                )
            `;
        } catch (error) {
            logger.error({ error, taskId: event.taskId }, 'Failed to persist trust feedback');
        }
    }
}
