import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskService } from '../services/TaskService.js';
import { TaskCompletionService } from '../services/TaskCompletionService.js';
import { OnboardingService } from '../services/OnboardingService.js';
import { PayoutEligibilityResolver } from '../services/PayoutEligibilityResolver.js';
import { PayoutExplainer } from '../services/PayoutExplainer.js';
import { logger } from '../utils/logger.js';
import { requireAuth, optionalAuth } from '../middleware/firebaseAuth.js';
import type { TaskCategory } from '../types/index.js';

const CreateTaskSchema = z.object({
    title: z.string().min(3, 'Title must be at least 3 characters'),
    description: z.string().min(10, 'Description must be at least 10 characters'),
    category: z.string(),
    price: z.number().min(5, 'Minimum price is $5').max(10000, 'Maximum price is $10,000'),
    location: z.string().optional(),
});


export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
    // Get open tasks
    fastify.get('/api/tasks', async (request) => {
        const { category, limit } = request.query as {
            category?: TaskCategory;
            limit?: string;
        };

        const tasks = await TaskService.searchTasks({
            category,
            limit: limit ? parseInt(limit) : 20,
        });

        return { tasks, count: tasks.length };
    });

    // Get single task by ID (C3)
    fastify.get<{
        Params: { taskId: string };
    }>('/api/tasks/:taskId', async (request, reply) => {
        const { taskId } = request.params;
        const task = await TaskService.getTask(taskId);

        if (!task) {
            reply.code(404);
            return { error: 'Task not found', code: 'TASK_NOT_FOUND' };
        }

        return { task };
    });

    // Direct task creation (B5.1) - non-AI path for simple task creation
    fastify.post('/api/tasks', { preHandler: [optionalAuth] }, async (request, reply) => {
        try {
            const body = CreateTaskSchema.parse(request.body);

            // Get user from auth context or use anonymous
            const clientId = request.user?.uid ?? 'anonymous';

            // Create task directly via TaskService
            const task = await TaskService.createTask({
                clientId,
                title: body.title,
                description: body.description,
                category: body.category as TaskCategory,
                recommendedPrice: body.price,
                minPrice: body.price * 0.8,
                maxPrice: body.price * 1.2,
                locationText: body.location || 'Seattle, WA',
                flags: [],
            });

            reply.code(201);
            return {
                id: task.id,
                title: task.title,
                description: task.description,
                category: task.category,
                xp_reward: Math.floor(task.recommendedPrice * 0.1),
                price: task.recommendedPrice,
                status: task.status,
                location: task.locationText || 'Seattle, WA',
                creator_id: clientId,
                created_at: task.createdAt.toISOString(),
            };
        } catch (error) {
            if (error instanceof z.ZodError) {
                reply.code(400);
                return { error: 'Validation failed', details: error.errors };
            }
            if ((error as { code?: string }).code === 'DB_REQUIRED') {
                reply.code(503);
                return { error: 'Database unavailable', code: 'DB_REQUIRED' };
            }

            logger.error({ error }, 'Failed to create task');
            reply.code(500);
            return { error: 'Failed to create task' };
        }
    });

    // Accept task (B6.1) - Hustler accepts an open task
    fastify.post<{
        Params: { taskId: string };
    }>('/api/tasks/:taskId/accept', { preHandler: [requireAuth] }, async (request, reply) => {
        const { taskId } = request.params;

        // Get hustler from auth context
        const hustlerId = request.user?.uid ?? 'unknown';

        // Check task exists and is active (available)
        const task = await TaskService.getTask(taskId);
        if (!task) {
            reply.code(404);
            return { error: 'Task not found' };
        }

        if (task.status !== 'active') {
            reply.code(400);
            return { error: 'Task is not available for acceptance', currentStatus: task.status };
        }

        // Assign hustler to task
        const updatedTask = await TaskService.assignHustler(taskId, hustlerId);
        if (!updatedTask) {
            reply.code(500);
            return { error: 'Failed to accept task' };
        }

        logger.info({ taskId, hustlerId }, 'Task accepted by hustler');

        return {
            success: true,
            task: {
                id: updatedTask.id,
                title: updatedTask.title,
                status: updatedTask.status,
                assignedHustlerId: updatedTask.assignedHustlerId,
            },
            message: 'Task accepted successfully'
        };
    });

    // Check completion eligibility
    fastify.get('/api/tasks/:taskId/eligibility', async (request, _reply) => {
        const { taskId } = request.params as { taskId: string };
        const eligibility = await TaskCompletionService.getCompletionEligibility(taskId);
        return eligibility;
    });

    // Smart complete a task (full reward flow) - HARDENED
    // Security: requireAuth + task state + hustler identity validation
    fastify.post<{
        Params: { taskId: string };
    }>('/api/tasks/:taskId/complete', { preHandler: [requireAuth] }, async (request, reply) => {
        try {
            const { taskId } = request.params;
            const hustlerId = request.user?.uid;

            if (!hustlerId) {
                reply.status(401);
                return { error: 'Authentication required', code: 'NO_AUTH' };
            }

            // Get task and validate state + hustler identity
            const task = await TaskService.getTask(taskId);
            if (!task) {
                reply.status(404);
                return { error: 'Task not found', code: 'TASK_NOT_FOUND' };
            }

            // Only assigned tasks can be completed
            if (task.status !== 'assigned') {
                reply.status(400);
                return {
                    error: 'Task cannot be completed in current state',
                    code: 'INVALID_STATE',
                    currentStatus: task.status,
                    requiredStatus: 'assigned'
                };
            }

            // Only the assigned hustler can complete
            if (task.assignedHustlerId !== hustlerId) {
                reply.status(403);
                return {
                    error: 'Only the assigned hustler can complete this task',
                    code: 'NOT_ASSIGNED_HUSTLER'
                };
            }

            // Parse optional body fields
            const body = request.body as { rating?: number; skipProofCheck?: boolean } || {};

            if (body.skipProofCheck) {
                const allowDemoSkip = process.env.ALLOW_DEMO_SKIP_PROOF === 'true';
                const isAdmin = request.user?.role === 'admin';
                const isDev = process.env.NODE_ENV === 'development';
                if (!allowDemoSkip && !isAdmin && !isDev) {
                    reply.status(403);
                    return { error: 'skipProofCheck not allowed', code: 'SKIP_PROOF_FORBIDDEN' };
                }
            }

            const result = await TaskCompletionService.smartComplete(taskId, hustlerId, {
                rating: body.rating,
                skipProofCheck: body.skipProofCheck,
            });

            if (!result.success) {
                reply.status(400);
                return { error: result.message };
            }

            logger.info({ taskId, hustlerId }, 'Task completed by hustler');
            return result;
        } catch (error) {
            logger.error({ error }, 'Task completion error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            if ((error as { code?: string }).code === 'DB_REQUIRED') {
                reply.status(503);
                return { error: 'Database unavailable', code: 'DB_REQUIRED' };
            }
            reply.status(500);
            return { error: 'Failed to complete task' };
        }
    });

    // Get user-friendly payout status for a task
    fastify.get('/api/tasks/:taskId/payout-status', async (request, reply) => {
        try {
            const { taskId } = request.params as { taskId: string };

            // Get the raw eligibility result
            const eligibility = await PayoutEligibilityResolver.resolve(taskId);

            // Get task context for better messaging
            const task = await TaskService.getTask(taskId);

            // Convert to user-friendly explanation
            const explanation = PayoutExplainer.explain(eligibility, {
                taskTitle: task?.title,
                amountCents: task?.recommendedPrice ? Math.round(Number(task.recommendedPrice) * 100) : undefined
            });

            // Also include short status for list views
            const shortStatus = PayoutExplainer.getShortStatus(eligibility);

            return {
                taskId,
                explanation,
                shortStatus,
                // Include raw decision for debug/admin (but not exposed in UI)
                _debug: process.env.NODE_ENV === 'development' ? {
                    decision: eligibility.decision,
                    blockReason: eligibility.blockReason,
                    evaluationId: eligibility.evaluationId
                } : undefined
            };
        } catch (error) {
            logger.error({ error }, 'Payout status error');
            reply.status(500);
            return { error: 'Failed to get payout status' };
        }
    });

    // Get proof status explanation for a task
    fastify.get('/api/tasks/:taskId/proof-status', async (request, reply) => {
        try {
            const { taskId } = request.params as { taskId: string };

            // Get proof truth from freeze service
            const { ProofFreezeService } = await import('../services/proof/ProofFreezeService.js');
            const proofTruth = await ProofFreezeService.getProofTruth(taskId);

            // Convert to user-friendly explanation
            const explanation = PayoutExplainer.explainProofState(proofTruth.proofState);

            return {
                taskId,
                ...explanation,
                hasValidProof: proofTruth.hasValidProof,
                submissionId: proofTruth.submissionId,
                verifiedAt: proofTruth.verifiedAt
            };
        } catch (error) {
            logger.error({ error }, 'Proof status error');
            reply.status(500);
            return { error: 'Failed to get proof status' };
        }
    });

    // ============================================
    // API Onboarding Aliases (for frontend compatibility)
    // ============================================

    // SECURED: Start onboarding - requires auth, self-only
    fastify.post('/api/onboarding/:userId/start', { preHandler: [requireAuth] }, async (request, reply) => {
        try {
            if (!request.user) {
                reply.status(401);
                return { error: 'Authentication required' };
            }

            const { userId } = request.params as { userId: string };

            // CRITICAL: User can only start their own onboarding
            if (userId !== request.user.uid) {
                reply.status(403);
                return { error: 'Cannot start onboarding for another user' };
            }

            // HIVS GATE: Verify identity before AI onboarding
            const { VerificationService } = await import('../services/VerificationService.js');
            const verificationCheck = await VerificationService.canStartOnboarding(userId);

            if (!verificationCheck.allowed) {
                reply.status(403);
                return {
                    error: 'IDENTITY_UNVERIFIED',
                    message: 'Identity verification required before onboarding',
                    nextRequired: verificationCheck.nextRequired,
                    verificationUrl: `/api/verify/${verificationCheck.nextRequired}/send`,
                };
            }

            const body = request.body as { referralCode?: string } | undefined;
            const result = await OnboardingService.startOnboarding(userId, body?.referralCode);
            return result;
        } catch (error) {
            logger.error({ error }, 'API Onboarding start error');
            reply.status(500);
            return { error: 'Failed to start onboarding' };
        }
    });

    // SECURED: Choose role - requires auth, self-only, ONE-TIME ONLY, NO admin escalation
    fastify.post('/api/onboarding/:userId/role', { preHandler: [requireAuth] }, async (request, reply) => {
        try {
            if (!request.user) {
                reply.status(401);
                return { error: 'Authentication required' };
            }

            const { userId } = request.params as { userId: string };

            // CRITICAL: User can only change their own role
            if (userId !== request.user.uid) {
                reply.status(403);
                return { error: 'Cannot change role for another user' };
            }

            // CRITICAL: One-time role assignment only
            // If user already has a role set (not the default 'poster'), reject
            // The dbUser is attached by requireAuth middleware
            const existingUser = request.dbUser;
            if (existingUser && existingUser.role && existingUser.role !== 'poster') {
                reply.status(403);
                return {
                    error: 'Role already assigned',
                    code: 'ROLE_ALREADY_SET',
                    currentRole: existingUser.role,
                    message: 'Role can only be set once during onboarding. Contact support to change.'
                };
            }

            const body = request.body as { sessionId: string; role: 'hustler' | 'client' };

            // CRITICAL: Only allow poster/hustler roles - NEVER admin via this endpoint
            // Normalize to lowercase for safety
            const normalizedRole = body.role?.toLowerCase();
            if (normalizedRole !== 'hustler' && normalizedRole !== 'client') {
                reply.status(400);
                return { error: 'Invalid role. Must be hustler or client' };
            }

            const result = await OnboardingService.chooseRole(body.sessionId, normalizedRole as 'hustler' | 'client');
            return result;
        } catch (error) {
            logger.error({ error }, 'API Onboarding role error');
            reply.status(500);
            return { error: 'Failed to set role' };
        }
    });

    fastify.post('/api/onboarding/:userId/answer', async (request, reply) => {
        try {
            const body = request.body as { sessionId: string; questionKey: string; answer?: string; skip?: boolean };
            const result = await OnboardingService.answerQuestion(
                body.sessionId,
                body.questionKey,
                body.answer ?? '',
                body.skip
            );
            return result;
        } catch (error) {
            logger.error({ error }, 'API Onboarding answer error');
            reply.status(500);
            return { error: 'Failed to process answer' };
        }
    });

    // Get onboarding status for a user (used by frontend to determine if onboarding is needed)
    fastify.get('/api/onboarding/:userId/status', async (request) => {
        const { userId } = request.params as { userId: string };
        return OnboardingService.getOnboardingStatus(userId);
    });

}
