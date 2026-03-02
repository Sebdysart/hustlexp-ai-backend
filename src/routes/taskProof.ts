/**
 * taskProofRoutes — proof, GPS-proof, planner, and boost routes
 *
 * Split from src/routes/tasks.ts at the proof/planner boundary to keep
 * both files under 600 lines (Task 15 — Route decomposition).
 *
 * Registered in src/index.ts:
 *   await fastify.register(taskProofRoutes);
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskService } from '../services/TaskService.js';
import { PriorityBoostService, HustlerTaskPlanner } from '../services/PriorityBoostService.js';
import { AIProofService } from '../services/AIProofService.js';
import { ProofValidationService } from '../services/ProofValidationService.js';
import { EnhancedAIProofService } from '../services/EnhancedAIProofService.js';
import { logger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';
import { requireAuth } from '../middleware/firebaseAuth.js';
import type { TaskCategory } from '../types/index.js';

// ── Zod schemas ──────────────────────────────────────────────────────────────

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

// ── Route plugin ─────────────────────────────────────────────────────────────

export async function taskProofRoutes(fastify: FastifyInstance): Promise<void> {

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
    fastify.get('/api/proof/trust/:hustlerId', async (request, _reply) => {
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
