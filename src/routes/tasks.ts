import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskService } from '../services/TaskService.js';
import { TaskCompletionService } from '../services/TaskCompletionService.js';
import { OnboardingService } from '../services/OnboardingService.js';
import { PriorityBoostService, HustlerTaskPlanner } from '../services/PriorityBoostService.js';
import { AIProofService } from '../services/AIProofService.js';
import { ProofValidationService } from '../services/ProofValidationService.js';
import { EnhancedAIProofService } from '../services/EnhancedAIProofService.js';
import { PayoutEligibilityResolver } from '../services/PayoutEligibilityResolver.js';
import { PayoutExplainer } from '../services/PayoutExplainer.js';
import { logger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';
import { requireAuth, optionalAuth } from '../middleware/firebaseAuth.js';
import type { TaskCategory } from '../types/index.js';

const CreateTaskSchema = z.object({
    title: z.string().min(3, 'Title must be at least 3 characters'),
    description: z.string().min(10, 'Description must be at least 10 characters'),
    category: z.string(),
    price: z.number().min(5, 'Minimum price is $5').max(10000, 'Maximum price is $10,000'),
    location: z.string().optional(),
});

const CompleteTaskSchema = z.object({
    hustlerId: z.string(),
    rating: z.number().min(1).max(5).optional(),
    skipProofCheck: z.boolean().optional(),
});

const StartProofSchema = z.object({
    taskId: z.string(),
    hustlerId: z.string(),
    category: z.enum(['delivery', 'moving', 'cleaning', 'pet_care', 'errands', 'handyman', 'tech_help', 'yard_work', 'event_help', 'other']),
});

const SubmitProofSchema = z.object({
    sessionId: z.string(),
    requirementId: z.string(),
    photoUrl: z.string().url(),
    caption: z.string().optional(),
});

const ValidatedProofSchema = z.object({
    taskId: z.string(),
    hustlerId: z.string(),
    photoData: z.string(), // base64 encoded
    photoType: z.enum(['before', 'during', 'after', 'result']),
    gps: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy: z.number().optional(),
        timestamp: z.string().optional(),
    }),
    caption: z.string().max(500).optional(),
});

const PosterApproveSchema = z.object({
    posterId: z.string(),
    rating: z.number().min(1).max(5).optional(),
    tip: z.number().min(0).optional(),
    instantPayout: z.boolean().optional().default(false),
});

const PosterRejectSchema = z.object({
    posterId: z.string(),
    reason: z.string().min(10).max(500),
    action: z.enum(['refund', 'dispute', 'redo']).optional().default('dispute'),
});

const GeneratePlanSchema = z.object({
    taskId: z.string(),
    hustlerId: z.string(),
    task: z.object({
        title: z.string(),
        category: z.enum(['delivery', 'moving', 'cleaning', 'pet_care', 'errands', 'handyman', 'tech_help', 'yard_work', 'event_help', 'other']),
        description: z.string(),
        durationMinutes: z.number(),
        location: z.string(),
        baseXP: z.number().optional().default(100),
    }),
    boostMultiplier: z.number().optional().default(1.0),
});

const UpdateObjectiveSchema = z.object({
    planId: z.string(),
    objectiveId: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
    photoUrl: z.string().optional(),
    notes: z.string().optional(),
});

const CheckpointSchema = z.object({
    planId: z.string(),
    checkpointType: z.enum(['arrival', 'progress', 'completion', 'photo', 'signature']),
});

const ApplyBoostSchema = z.object({
    taskId: z.string(),
    basePrice: z.number().positive(),
    tier: z.enum(['normal', 'priority', 'rush', 'vip']),
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
    fastify.get('/api/tasks/:taskId/eligibility', async (request, reply) => {
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
            const { userId } = request.params as { userId: string };
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

    // ============================================
    // Priority Boost Endpoints
    // ============================================

    // Get boost options for a price
    fastify.get('/api/boost/options/:price', async (request) => {
        const { price } = request.params as { price: string };
        const basePrice = parseInt(price);

        if (isNaN(basePrice) || basePrice <= 0) {
            return { error: 'Invalid price' };
        }

        const options = PriorityBoostService.getBoostOptions(basePrice);
        return { basePrice, options };
    });

    // Apply boost to a task
    fastify.post('/api/boost/apply', async (request, reply) => {
        try {
            const body = ApplyBoostSchema.parse(request.body);
            const boost = PriorityBoostService.applyBoost(body.taskId, body.basePrice, body.tier);
            return boost;
        } catch (error) {
            logger.error({ error }, 'Boost apply error');
            reply.status(400);
            return { error: 'Failed to apply boost' };
        }
    });

    // Get task boost info
    fastify.get('/api/boost/task/:taskId', async (request, reply) => {
        const { taskId } = request.params as { taskId: string };
        const boost = PriorityBoostService.getTaskBoost(taskId);

        if (!boost) {
            reply.status(404);
            return { error: 'No boost found for this task' };
        }

        return boost;
    });

    // ============================================
    // Hustler Task Planner Endpoints
    // ============================================

    // Generate task plan for hustler
    fastify.post('/api/planner/generate', async (request, reply) => {
        try {
            const body = GeneratePlanSchema.parse(request.body);
            const plan = await HustlerTaskPlanner.generatePlan(
                body.taskId,
                body.hustlerId,
                body.task,
                body.boostMultiplier
            );
            return plan;
        } catch (error) {
            logger.error({ error }, 'Plan generation error');
            reply.status(500);
            return { error: 'Failed to generate plan' };
        }
    });

    // Get plan by ID
    fastify.get('/api/planner/:planId', async (request, reply) => {
        const { planId } = request.params as { planId: string };
        const plan = HustlerTaskPlanner.getPlan(planId);

        if (!plan) {
            reply.status(404);
            return { error: 'Plan not found' };
        }

        return plan;
    });

    // Update objective
    fastify.post('/api/planner/objective', async (request, reply) => {
        try {
            const body = UpdateObjectiveSchema.parse(request.body);
            const result = await HustlerTaskPlanner.updateObjective(
                body.planId,
                body.objectiveId,
                body.status,
                body.photoUrl,
                body.notes
            );
            return result;
        } catch (error) {
            logger.error({ error }, 'Objective update error');
            reply.status(500);
            return { error: 'Failed to update objective' };
        }
    });

    // Record checkpoint (arrival, photo, completion)
    fastify.post('/api/planner/checkpoint', async (request, reply) => {
        try {
            const body = CheckpointSchema.parse(request.body);
            const result = await HustlerTaskPlanner.recordCheckpoint(body.planId, body.checkpointType);
            return result;
        } catch (error) {
            logger.error({ error }, 'Checkpoint error');
            reply.status(500);
            return { error: 'Failed to record checkpoint' };
        }
    });

    // Get hustler's plans
    fastify.get('/api/planner/hustler/:hustlerId', async (request) => {
        const { hustlerId } = request.params as { hustlerId: string };
        const plans = HustlerTaskPlanner.getHustlerPlans(hustlerId);
        return { plans, count: plans.length };
    });

    // ============================================
    // AI Proof System Endpoints
    // ============================================

    // Start proof session for a task
    fastify.post('/api/proof/start', async (request, reply) => {
        try {
            const body = StartProofSchema.parse(request.body);
            const session = AIProofService.startProofSession(body.taskId, body.hustlerId, body.category);
            const nextPrompt = AIProofService.getNextProofPrompt(session.sessionId);
            return { session, nextPrompt };
        } catch (error) {
            logger.error({ error }, 'Proof start error');
            reply.status(500);
            return { error: 'Failed to start proof session' };
        }
    });

    // Get next proof prompt
    fastify.get('/api/proof/:sessionId/next', async (request, reply) => {
        const { sessionId } = request.params as { sessionId: string };
        const prompt = AIProofService.getNextProofPrompt(sessionId);

        if (!prompt) {
            reply.status(404);
            return { error: 'Session not found or completed' };
        }

        return prompt;
    });

    // Submit proof photo
    fastify.post('/api/proof/submit', async (request, reply) => {
        try {
            const body = SubmitProofSchema.parse(request.body);
            const result = await AIProofService.submitProof(
                body.sessionId,
                body.requirementId,
                body.photoUrl,
                body.caption
            );
            return result;
        } catch (error) {
            logger.error({ error }, 'Proof submit error');
            if (error instanceof Error) {
                reply.status(400);
                return { error: error.message };
            }
            reply.status(500);
            return { error: 'Failed to submit proof' };
        }
    });

    // Get proof session status
    fastify.get('/api/proof/session/:sessionId', async (request, reply) => {
        const { sessionId } = request.params as { sessionId: string };
        const session = AIProofService.getSession(sessionId);

        if (!session) {
            reply.status(404);
            return { error: 'Session not found' };
        }

        return session;
    });

    // Get live task update (for client view)
    fastify.get('/api/proof/task/:taskId', async (request, reply) => {
        const { taskId } = request.params as { taskId: string };
        const update = AIProofService.getLiveTaskUpdate(taskId);

        if (!update) {
            reply.status(404);
            return { error: 'No proof session for this task' };
        }

        return update;
    });

    // Get trust profile
    fastify.get('/api/proof/trust/:hustlerId', async (request, reply) => {
        const { hustlerId } = request.params as { hustlerId: string };
        const profile = AIProofService.getTrustProfile(hustlerId);

        if (!profile) {
            // Return default profile
            return {
                hustlerId,
                trustScore: 50,
                verifiedProofCount: 0,
                proofStreak: 0,
                badges: [],
                recentProofs: [],
            };
        }

        return profile;
    });

    // Get proof feed (for profile gallery)
    fastify.get('/api/proof/feed/:hustlerId', async (request) => {
        const { hustlerId } = request.params as { hustlerId: string };
        const limit = parseInt((request.query as { limit?: string }).limit || '20');
        const feed = AIProofService.getProofFeed(hustlerId, limit);
        return { proofs: feed, count: feed.length };
    });

    // ============================================
    // Validated Proof System (Phase B) - GPS Required
    // ============================================

    // Submit validated proof with GPS
    fastify.post('/api/proof/validated/submit', async (request, reply) => {
        try {
            const body = ValidatedProofSchema.parse(request.body);

            const result = await ProofValidationService.submitProof({
                taskId: body.taskId,
                hustlerId: body.hustlerId,
                photoData: body.photoData,
                photoType: body.photoType,
                gps: {
                    latitude: body.gps.latitude,
                    longitude: body.gps.longitude,
                    accuracy: body.gps.accuracy,
                    timestamp: body.gps.timestamp ? new Date(body.gps.timestamp) : undefined,
                },
                caption: body.caption,
            });

            if (!result.success) {
                reply.status(400);
                return {
                    error: result.error,
                    verificationStatus: result.verificationStatus,
                };
            }

            return {
                success: true,
                proof: result.proof,
                session: result.session,
                verificationStatus: result.verificationStatus,
            };
        } catch (error) {
            logger.error({ error }, 'Validated proof submission error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: 'Failed to submit proof' };
        }
    });

    // Get task verification status (for poster review screen)
    fastify.get('/api/proof/validated/:taskId/status', async (request) => {
        const { taskId } = request.params as { taskId: string };
        return ProofValidationService.getTaskVerificationStatus(taskId);
    });

    // Check if task is ready for approval
    fastify.get('/api/proof/validated/:taskId/can-approve', async (request) => {
        const { taskId } = request.params as { taskId: string };
        const result = ProofValidationService.canApprove(taskId);
        return {
            canApprove: result.canApprove,
            reason: result.reason,
            session: result.session ? {
                sessionId: result.session.sessionId,
                status: result.session.status,
                proofCount: result.session.proofs.length,
                requiredTypes: result.session.requiredProofTypes,
                completedTypes: result.session.completedTypes,
            } : null,
        };
    });

    // Poster approves task with validated proofs → triggers real payout
    fastify.post('/api/proof/validated/:taskId/approve', async (request, reply) => {
        try {
            const { taskId } = request.params as { taskId: string };
            const body = PosterApproveSchema.parse(request.body);

            const result = await ProofValidationService.approveTask(taskId, body.posterId, {
                rating: body.rating,
                tip: body.tip,
                instantPayout: body.instantPayout,
            });

            if (!result.success) {
                reply.status(400);
                return { error: result.message };
            }

            return result;
        } catch (error) {
            logger.error({ error }, 'Proof approval error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: 'Failed to approve task' };
        }
    });

    // Poster rejects task → refund or dispute
    fastify.post('/api/proof/validated/:taskId/reject', async (request, reply) => {
        try {
            const { taskId } = request.params as { taskId: string };
            const body = PosterRejectSchema.parse(request.body);

            const result = await ProofValidationService.rejectTask(
                taskId,
                body.posterId,
                body.reason,
                body.action
            );

            if (!result.success) {
                reply.status(400);
                return { error: result.message };
            }

            return result;
        } catch (error) {
            logger.error({ error }, 'Proof rejection error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: 'Failed to reject task' };
        }
    });

    // Get all proofs for a task (for poster review)
    fastify.get('/api/proof/validated/:taskId/proofs', async (request) => {
        const { taskId } = request.params as { taskId: string };
        const proofs = ProofValidationService.getProofsForTask(taskId);
        return {
            proofs: proofs.map(p => ({
                id: p.id,
                photoUrl: p.photoUrl,
                photoType: p.photoType,
                latitude: p.latitude,
                longitude: p.longitude,
                neighborhood: p.neighborhood,
                verificationStatus: p.verificationStatus,
                gpsValidated: p.gpsValidated,
                caption: p.caption,
                createdAt: p.createdAt,
            })),
            count: proofs.length,
        };
    });

    // Get moderation logs for a task
    fastify.get('/api/proof/validated/:taskId/moderation-logs', async (request) => {
        const { taskId } = request.params as { taskId: string };
        const logs = ProofValidationService.getModerationLogs(taskId);
        return { logs, count: logs.length };
    });

    // Validate GPS location (utility endpoint)
    fastify.post('/api/proof/validate-gps', async (request) => {
        const { latitude, longitude } = request.body as { latitude: number; longitude: number };
        const result = ProofValidationService.isWithinSeattle(latitude, longitude);
        const neighborhood = ProofValidationService.getNeighborhood(latitude, longitude);

        return {
            isWithinSeattle: result,
            neighborhood,
            bounds: {
                north: 47.7341,
                south: 47.4919,
                east: -122.2244,
                west: -122.4596,
            },
        };
    });

    // Initialize proof workflow for a task
    fastify.post('/api/proof/:taskId/init', async (request) => {
        const { taskId } = request.params as { taskId: string };
        const { category } = request.body as { category: TaskCategory };
        const workflow = EnhancedAIProofService.initializeWorkflow(taskId, category);
        return workflow;
    });

    // Get proof requirements for a category
    fastify.get('/api/proof/requirements/:category', async (request) => {
        const { category } = request.params as { category: string };
        const requirements = EnhancedAIProofService.getRequirements(category as TaskCategory);
        return { category, requirements };
    });

    // Get proof instructions for UI
    fastify.get('/api/proof/instructions/:category', async (request) => {
        const { category } = request.params as { category: string };
        const instructions = EnhancedAIProofService.getProofInstructions(category as TaskCategory);
        return instructions;
    });

    // Submit a proof photo - HARDENED
    // Security: requireAuth + task state + hustler identity validation
    fastify.post<{
        Params: { taskId: string };
    }>('/api/proof/:taskId/submit', { preHandler: [requireAuth] }, async (request, reply) => {
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

            // Only assigned tasks can have proof submitted
            if (task.status !== 'assigned') {
                reply.status(400);
                return {
                    error: 'Cannot submit proof for task in current state',
                    code: 'INVALID_STATE',
                    currentStatus: task.status,
                    requiredStatus: 'assigned'
                };
            }

            // Only the assigned hustler can submit proof
            if (task.assignedHustlerId !== hustlerId) {
                reply.status(403);
                return {
                    error: 'Only the assigned hustler can submit proof',
                    code: 'NOT_ASSIGNED_HUSTLER'
                };
            }

            const { phase, photoUrl, caption } = request.body as {
                phase: 'before' | 'during' | 'after';
                photoUrl: string;
                caption?: string;
            };

            if (!phase || !photoUrl) {
                reply.status(400);
                return { error: 'Missing required fields: phase, photoUrl', code: 'VALIDATION_ERROR' };
            }

            const submission = await EnhancedAIProofService.submitPhoto(taskId, hustlerId, phase, photoUrl, caption);
            logger.info({ taskId, hustlerId, phase }, 'Proof photo submitted');
            return submission;
        } catch (error) {
            logger.error({ error }, 'Proof submission error');
            reply.status(400);
            return { error: getErrorMessage(error) };
        }
    });

    // Get workflow status
    fastify.get('/api/proof/:taskId/status', async (request) => {
        const { taskId } = request.params as { taskId: string };
        const workflow = EnhancedAIProofService.getWorkflow(taskId);
        return workflow || { error: 'Workflow not found' };
    });

    // Verify proof consistency
    fastify.post('/api/proof/:taskId/verify', async (request) => {
        const { taskId } = request.params as { taskId: string };
        const result = await EnhancedAIProofService.verifyConsistency(taskId);
        return result;
    });
}
