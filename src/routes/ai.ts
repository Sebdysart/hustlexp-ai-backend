import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orchestrate } from '../ai/orchestrator.js';
import { OnboardingService } from '../services/OnboardingService.js';
import { TaskCardGenerator } from '../services/TaskCardGenerator.js';
import { TaskService } from '../services/TaskService.js';
import { UserService } from '../services/UserService.js';
import { TPEEService } from '../services/TPEEService.js';
import { getAIEventsSummary, getRecentAIEvents } from '../utils/aiEventLogger.js';
import { logger } from '../utils/logger.js';
import { isDatabaseAvailable, sql } from '../db/index.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { isDegradedMode, handleDegradedRequest } from '../ai/degradedMode.js';
import type { OrchestrateMode, TaskDraft, AIContextBlock } from '../types/index.js';

const OrchestrateSchema = z.object({
    userId: z.string(),
    message: z.string().min(1).max(2000),
    mode: z.enum(['client_assistant', 'hustler_assistant', 'support']),
    context: z.record(z.unknown()).optional(),
});

const ConfirmTaskSchema = z.object({
    userId: z.string(),
    taskDraft: z.object({
        title: z.string(),
        description: z.string(),
        category: z.string(),
        minPrice: z.number().optional(),
        recommendedPrice: z.number(),
        maxPrice: z.number().optional(),
        locationText: z.string().optional(),
        timeWindow: z.object({
            start: z.string(),
            end: z.string(),
        }).optional(),
        flags: z.array(z.string()),
        priceExplanation: z.string().optional(),
    }),
});

const OnboardingStartSchema = z.object({
    userId: z.string(),
    referralCode: z.string().optional(),
});

const OnboardingRoleSchema = z.object({
    sessionId: z.string(),
    role: z.enum(['hustler', 'client']),
});

const OnboardingAnswerSchema = z.object({
    sessionId: z.string(),
    questionKey: z.string(),
    answer: z.string().optional().default(''),
    skip: z.boolean().optional().default(false),
});

const TaskCardSchema = z.object({
    rawText: z.string().min(3),
    location: z.string().optional(),
    categoryHint: z.enum(['delivery', 'moving', 'cleaning', 'pet_care', 'errands', 'handyman', 'tech_help', 'yard_work', 'event_help', 'other']).optional(),
    scheduledTime: z.string().optional(),
    userId: z.string().optional(),
    userLevel: z.number().optional(),
    userStreak: z.number().optional(),
});

export async function aiRoutes(fastify: FastifyInstance): Promise<void> {
    // Main AI orchestration endpoint
    fastify.post('/ai/orchestrate', async (request, reply) => {
        try {
            const body = OrchestrateSchema.parse(request.body);

            // TASK-13: Degraded mode — queue the request and return 202 immediately
            if (isDegradedMode()) {
                logger.warn({ userId: body.userId }, 'AI degraded mode active — queuing request');
                reply.status(202);
                return handleDegradedRequest(body.userId, body.message, body.mode || 'chat');
            }

            // Check rate limit
            const rateLimit = await checkRateLimit('ai', body.userId);
            if (!rateLimit.success) {
                reply.status(429);
                return {
                    error: 'Rate limit exceeded',
                    remaining: rateLimit.remaining,
                    resetAt: new Date(rateLimit.reset).toISOString(),
                };
            }

            const result = await orchestrate({
                userId: body.userId,
                message: body.message,
                mode: body.mode as OrchestrateMode,
                context: body.context as AIContextBlock | undefined,
            });

            return result;
        } catch (error) {
            logger.error({ error }, 'Orchestration endpoint error');

            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }

            reply.status(500);
            return { error: 'Internal server error' };
        }
    });

    // Confirm and create task (after user reviews draft)
    // TPEE GATE: All tasks must pass Trust & Pricing Enforcement Engine
    fastify.post('/ai/confirm-task', async (request, reply) => {
        try {
            const body = ConfirmTaskSchema.parse(request.body);

            // FIX: Resolve internal User ID from Firebase UID
            const dbUser = await UserService.getByFirebaseUid(body.userId);
            if (!dbUser) {
                reply.status(404);
                return { error: 'User not found' };
            }

            const taskDraft = body.taskDraft as TaskDraft;

            // ============================================
            // TPEE GATE: Trust & Pricing Enforcement
            // ============================================
            const tpeeInput = TPEEService.taskDraftToTPEEInput(
                taskDraft,
                dbUser.id,
                'city_seattle' // Seattle beta
            );

            const tpeeResult = await TPEEService.evaluateTask(tpeeInput);

            // In shadow mode: log but don't block
            // In enforcement mode: block/adjust based on result
            if (!TPEEService.isShadowMode()) {
                if (tpeeResult.decision === 'BLOCK') {
                    reply.status(403);
                    return {
                        success: false,
                        error: 'Task creation blocked',
                        code: 'TPEE_BLOCKED',
                        reason: tpeeResult.enforcement_reason_code,
                        evaluationId: tpeeResult.evaluation_id,
                        humanReviewRequired: tpeeResult.human_review_required,
                    };
                }

                if (tpeeResult.decision === 'ADJUST') {
                    // Return adjustment suggestion, don't auto-modify
                    reply.status(422);
                    return {
                        success: false,
                        error: 'Price adjustment required',
                        code: 'TPEE_ADJUST',
                        reason: tpeeResult.enforcement_reason_code,
                        recommendedPrice: tpeeResult.recommended_price.amount,
                        evaluationId: tpeeResult.evaluation_id,
                    };
                }
            }
            // ============================================
            // END TPEE GATE
            // ============================================

            // ============================================
            // AI ESCALATION (Phase 2B) - Advisory only
            // Only runs if deterministic decision is ACCEPT
            // ============================================
            if (tpeeResult.decision === 'ACCEPT') {
                try {
                    const { TPEEAIEscalation } = await import('../services/TPEEAIEscalation.js');
                    const escalation = await TPEEAIEscalation.escalate(
                        tpeeResult,
                        tpeeInput,
                        taskDraft.recommendedPrice, // median price fallback
                        60, // default median duration
                        'PRE_AI'
                    );

                    // AI can only escalate severity, never downgrade
                    if (!TPEEService.isShadowMode()) {
                        if (escalation.should_adjust && escalation.recommended_price) {
                            reply.status(422);
                            return {
                                success: false,
                                error: 'Price adjustment recommended by AI',
                                code: 'TPEE_AI_ADJUST',
                                reason: 'AI_PRICING_REALISM',
                                recommendedPrice: escalation.recommended_price,
                                evaluationId: tpeeResult.evaluation_id,
                            };
                        }
                        if (escalation.should_review) {
                            tpeeResult.human_review_required = true;
                        }
                    }
                } catch (aiErr) {
                    // AI failure → log but don't block (safe degradation)
                    logger.warn({ aiErr }, 'AI escalation failed - continuing with deterministic result');
                }
            }
            // ============================================
            // END AI ESCALATION
            // ============================================

            const task = await TaskService.createTaskFromDraft(
                dbUser.id,
                taskDraft
            );

            // ============================================
            // POLICY SNAPSHOT ASSIGNMENT (Phase 2C)
            // Sticky: assigned once, never changes
            // ============================================
            let policyAssignment: { policy_snapshot_id: string; config_hash: string } | null = null;
            try {
                const { PolicySnapshotService } = await import('../services/PolicySnapshotService.js');
                policyAssignment = await PolicySnapshotService.assignPolicyToTask(
                    task.id,
                    { city_id: 'city_seattle', category: taskDraft.category }
                );
            } catch (policyErr) {
                logger.warn({ policyErr }, 'Policy assignment failed - using default');
            }
            // ============================================
            // END POLICY SNAPSHOT ASSIGNMENT
            // ============================================

            // ============================================
            // TPEE OUTCOME WIRING: Persist evaluation + policy on task
            // ============================================
            if (isDatabaseAvailable() && sql) {
                try {
                    await sql`
                        UPDATE tasks SET
                            tpee_evaluation_id = ${tpeeResult.evaluation_id},
                            tpee_decision = ${tpeeResult.decision},
                            tpee_reason_code = ${tpeeResult.enforcement_reason_code},
                            tpee_confidence = ${tpeeResult.confidence_score},
                            tpee_model_version = ${tpeeResult.model_version},
                            tpee_evaluated_at = ${tpeeResult.evaluated_at},
                            policy_snapshot_id = ${policyAssignment?.policy_snapshot_id || null},
                            policy_config_hash = ${policyAssignment?.config_hash || null}
                        WHERE id = ${task.id}
                    `;
                    logger.info({ taskId: task.id, tpeeEvalId: tpeeResult.evaluation_id, policyId: policyAssignment?.policy_snapshot_id }, 'TPEE + policy linked to task');
                } catch (err) {
                    logger.error({ err, taskId: task.id }, 'Failed to persist TPEE/policy on task');
                }
            }
            // ============================================
            // END TPEE OUTCOME WIRING
            // ============================================

            // Optionally trigger SmartMatch to find hustlers
            const candidates = await TaskService.getCandidateHustlers(task, 5);

            return {
                success: true,
                task,
                matchedHustlers: candidates.length,
                topCandidates: candidates.slice(0, 3),
                // Include TPEE result for transparency
                _tpee: {
                    evaluationId: tpeeResult.evaluation_id,
                    decision: tpeeResult.decision,
                    checksCompleted: tpeeResult.checks_passed.length,
                },
            };
        } catch (error) {
            logger.error({ error }, 'Confirm task endpoint error');

            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }

            reply.status(500);
            return { error: 'Internal server error' };
        }
    });

    // AI analytics endpoint (for monitoring)
    fastify.get('/api/ai/analytics', async () => {
        const summary = getAIEventsSummary();
        const recentEvents = getRecentAIEvents(20);

        return {
            summary,
            recentEvents,
        };
    });

    // Start or resume onboarding - AI introduces itself
    fastify.post('/ai/onboarding/start', async (request, reply) => {
        try {
            const body = OnboardingStartSchema.parse(request.body);
            const result = await OnboardingService.startOnboarding(body.userId, body.referralCode);
            return result;
        } catch (error) {
            logger.error({ error }, 'Onboarding start error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: 'Failed to start onboarding' };
        }
    });

    // Choose role (hustler or client)
    fastify.post('/ai/onboarding/role', async (request, reply) => {
        try {
            const body = OnboardingRoleSchema.parse(request.body);
            const result = await OnboardingService.chooseRole(body.sessionId, body.role);
            return result;
        } catch (error) {
            logger.error({ error }, 'Onboarding role error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: 'Failed to set role' };
        }
    });

    // Answer interview question (or skip if allowed)
    fastify.post('/ai/onboarding/answer', async (request, reply) => {
        try {
            const body = OnboardingAnswerSchema.parse(request.body);
            const result = await OnboardingService.answerQuestion(
                body.sessionId,
                body.questionKey,
                body.answer,
                body.skip
            );
            return result;
        } catch (error) {
            logger.error({ error }, 'Onboarding answer error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            if (error instanceof Error && error.message.includes('cannot be skipped')) {
                reply.status(400);
                return { error: error.message };
            }
            reply.status(500);
            return { error: 'Failed to process answer' };
        }
    });

    // Get referral stats
    fastify.get('/ai/onboarding/referral/:userId', async (request, reply) => {
        const { userId } = request.params as { userId: string };
        const stats = OnboardingService.getReferralStats(userId);

        if (!stats) {
            reply.status(404);
            return { error: 'No referral code found' };
        }

        return stats;
    });

    // Generate enriched task card from minimal input
    fastify.post('/ai/task-card', async (request, reply) => {
        try {
            const body = TaskCardSchema.parse(request.body);
            const card = await TaskCardGenerator.generateCard({
                rawText: body.rawText,
                location: body.location,
                categoryHint: body.categoryHint,
                scheduledTime: body.scheduledTime,
                userId: body.userId,
                userLevel: body.userLevel,
                userStreak: body.userStreak,
            });
            return card;
        } catch (error) {
            logger.error({ error }, 'Task card generation error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: 'Failed to generate task card' };
        }
    });
}
