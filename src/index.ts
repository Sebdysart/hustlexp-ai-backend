/**
 * HustleXP AI Backend - Main Entry Point
 * 
 * A multi-model AI orchestration system for the HustleXP gig marketplace.
 * Uses DeepSeek for reasoning, Groq for fast operations, and GPT-4o for safety.
 */

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';

import { orchestrate } from './ai/orchestrator.js';
import { tools } from './ai/tools.js';
import { TaskService } from './services/TaskService.js';
import { OnboardingService } from './services/OnboardingService.js';
import { TaskCardGenerator } from './services/TaskCardGenerator.js';
import { PriorityBoostService, HustlerTaskPlanner } from './services/PriorityBoostService.js';
import { getAIEventsSummary, getRecentAIEvents } from './utils/aiEventLogger.js';
import { logger } from './utils/logger.js';
import { testConnection, isDatabaseAvailable } from './db/index.js';
import { runMigrations, seedTestData } from './db/schema.js';
import { checkRateLimit, isRateLimitingEnabled, testRedisConnection } from './middleware/rateLimiter.js';
import type { OrchestrateMode, TaskDraft, TaskCategory } from './types/index.js';

const fastify = Fastify({
    logger: false, // We use our own pino logger
});

// Register CORS
await fastify.register(cors, {
    origin: true,
});

// ============================================
// Request Validation Schemas
// ============================================

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

// ============================================
// Routes
// ============================================

// Health check
fastify.get('/health', async () => {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
    };
});

// Main AI orchestration endpoint
fastify.post('/ai/orchestrate', async (request, reply) => {
    try {
        const body = OrchestrateSchema.parse(request.body);

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
            context: body.context,
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
fastify.post('/ai/confirm-task', async (request, reply) => {
    try {
        const body = ConfirmTaskSchema.parse(request.body);

        const task = await TaskService.createTaskFromDraft(
            body.userId,
            body.taskDraft as TaskDraft
        );

        // Optionally trigger SmartMatch to find hustlers
        const candidates = await TaskService.getCandidateHustlers(task, 5);

        return {
            success: true,
            task,
            matchedHustlers: candidates.length,
            topCandidates: candidates.slice(0, 3),
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

// Get user stats
fastify.get('/api/users/:userId/stats', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const stats = await tools.getUserStats(userId);

    if (!stats) {
        reply.status(404);
        return { error: 'User not found' };
    }

    return stats;
});

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

// AI analytics endpoint (for monitoring)
fastify.get('/api/ai/analytics', async () => {
    const summary = getAIEventsSummary();
    const recentEvents = getRecentAIEvents(20);

    return {
        summary,
        recentEvents,
    };
});

// ============================================
// AI Onboarding Endpoints
// ============================================

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

// ============================================
// AI Task Card Generator
// ============================================

const TaskCardSchema = z.object({
    rawText: z.string().min(3),
    location: z.string().optional(),
    categoryHint: z.enum(['delivery', 'moving', 'cleaning', 'pet_care', 'errands', 'handyman', 'tech_help', 'yard_work', 'event_help', 'other']).optional(),
    scheduledTime: z.string().optional(),
    userId: z.string().optional(),
    userLevel: z.number().optional(),
    userStreak: z.number().optional(),
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
const ApplyBoostSchema = z.object({
    taskId: z.string(),
    basePrice: z.number().positive(),
    tier: z.enum(['normal', 'priority', 'rush', 'vip']),
});

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
const UpdateObjectiveSchema = z.object({
    planId: z.string(),
    objectiveId: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
    photoUrl: z.string().optional(),
    notes: z.string().optional(),
});

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
const CheckpointSchema = z.object({
    planId: z.string(),
    checkpointType: z.enum(['arrival', 'progress', 'completion', 'photo', 'signature']),
});

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
// Server Startup
// ============================================

const PORT = parseInt(process.env.PORT || '3000');

async function start() {
    try {
        // Initialize database
        if (isDatabaseAvailable()) {
            const connected = await testConnection();
            if (connected) {
                await runMigrations();
                await seedTestData();
            }
        } else {
            logger.warn('DATABASE_URL not set - using in-memory storage');
        }

        // Start server
        await fastify.listen({ port: PORT, host: '0.0.0.0' });

        const dbStatus = isDatabaseAvailable() ? '✓ Connected' : '✗ Memory mode';

        logger.info(`
╔═══════════════════════════════════════════════════════╗
║         HustleXP AI Backend Started                   ║
╠═══════════════════════════════════════════════════════╣
║  Port: ${PORT}                                          ║
║  Database: ${dbStatus.padEnd(14)}                       ║
║  Environment: ${(process.env.NODE_ENV || 'development').padEnd(11)}                       ║
║                                                       ║
║  Endpoints:                                           ║
║    POST /ai/orchestrate     - Main AI endpoint        ║
║    POST /ai/confirm-task    - Confirm task creation   ║
║    GET  /api/tasks          - List open tasks         ║
║    GET  /api/ai/analytics   - AI usage analytics      ║
║    GET  /health             - Health check            ║
╚═══════════════════════════════════════════════════════╝
    `);
    } catch (err) {
        logger.error(err);
        process.exit(1);
    }
}

start();
