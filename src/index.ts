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
import { AIProofService } from './services/AIProofService.js';
import { PricingEngine } from './services/PricingEngine.js';
import { TaskCompletionService } from './services/TaskCompletionService.js';
import { DynamicBadgeEngine } from './services/DynamicBadgeEngine.js';
import { QuestEngine } from './services/QuestEngine.js';
import { AIGrowthCoachService } from './services/AIGrowthCoachService.js';
import { ContextualCoachService, type ScreenContext } from './services/ContextualCoachService.js';
import { ProfileOptimizerService } from './services/ProfileOptimizerService.js';
import { SocialCardGenerator } from './services/SocialCardGenerator.js';
import { EnhancedAIProofService } from './services/EnhancedAIProofService.js';
import { AICostGuardService } from './services/AICostGuardService.js';
import { SmartMatchAIService } from './services/SmartMatchAIService.js';
import { ErrorTracker } from './utils/errorTracker.js';
import { getAIEventsSummary, getRecentAIEvents } from './utils/aiEventLogger.js';
import { logger } from './utils/logger.js';
import { testConnection, isDatabaseAvailable } from './db/index.js';
import { runMigrations, seedTestData } from './db/schema.js';
import { checkRateLimit, isRateLimitingEnabled, testRedisConnection } from './middleware/rateLimiter.js';
import { validateEnv, logEnvStatus } from './utils/envValidator.js';
import { runHealthCheck, quickHealthCheck } from './utils/healthCheck.js';
import { requireAuth, optionalAuth, isAuthEnabled } from './middleware/firebaseAuth.js';
import type { OrchestrateMode, TaskDraft, TaskCategory, AIContextBlock } from './types/index.js';

const fastify = Fastify({
    logger: false, // We use our own pino logger
});

// Register CORS
await fastify.register(cors, {
    origin: true,
});

// ============================================
// Global Authentication Hook
// ============================================

// Public routes that don't require authentication
const PUBLIC_ROUTES = [
    '/health',
    '/health/detailed',
    // Core API endpoints for frontend
    '/api/tasks',
    '/api/users',
    // AI endpoints
    '/ai/orchestrate',
    '/ai/onboarding',
    '/ai/task-card',
    '/api/onboarding',  // Alias for frontend compatibility
    // Gamification endpoints (allow optional auth - they work for demo users too)
    '/api/coach',
    '/api/badges',
    '/api/quests',
    '/api/tips',
    '/api/profile',
    '/api/cards',
    '/api/match',
    '/api/cost',
    '/api/proof',
    '/api/pricing',
    '/api/boost',
    '/api/planner',
    '/api/actions',
    '/api/brain',
    '/api/memory',
];

// Add global auth hook - protects ALL routes except public ones
fastify.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]; // Remove query params

    // Skip auth for public routes
    if (PUBLIC_ROUTES.some(route => path === route || path.startsWith(route + '/'))) {
        return;
    }

    // Require authentication for all other routes
    await requireAuth(request, reply);
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

// Quick health check (for load balancers - fast response)
fastify.get('/health', async () => {
    return quickHealthCheck();
});

// Detailed health check (includes service connectivity)
fastify.get('/health/detailed', async () => {
    return await runHealthCheck();
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
// Task Completion Endpoints (Smart Completion Flow)
// ============================================

const CompleteTaskSchema = z.object({
    hustlerId: z.string(),
    rating: z.number().min(1).max(5).optional(),
    skipProofCheck: z.boolean().optional(),
});

// Check completion eligibility
fastify.get('/api/tasks/:taskId/eligibility', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const eligibility = await TaskCompletionService.getCompletionEligibility(taskId);
    return eligibility;
});

// Smart complete a task (full reward flow)
fastify.post('/api/tasks/:taskId/complete', async (request, reply) => {
    try {
        const { taskId } = request.params as { taskId: string };
        const body = CompleteTaskSchema.parse(request.body);

        const result = await TaskCompletionService.smartComplete(taskId, body.hustlerId, {
            rating: body.rating,
            skipProofCheck: body.skipProofCheck,
        });

        if (!result.success) {
            reply.status(400);
            return { error: result.message };
        }

        return result;
    } catch (error) {
        logger.error({ error }, 'Task completion error');
        if (error instanceof z.ZodError) {
            reply.status(400);
            return { error: 'Invalid request', details: error.errors };
        }
        reply.status(500);
        return { error: 'Failed to complete task' };
    }
});

// Get streak status for a hustler
fastify.get('/api/users/:userId/streak', async (request) => {
    const { userId } = request.params as { userId: string };
    const streak = TaskCompletionService.getStreakStatus(userId);
    return streak;
});

// Get completion history for a hustler
fastify.get('/api/users/:userId/completions', async (request) => {
    const { userId } = request.params as { userId: string };
    const { limit } = request.query as { limit?: string };
    const history = TaskCompletionService.getCompletionHistory(userId);
    return {
        completions: history.slice(0, limit ? parseInt(limit) : 20),
        count: history.length,
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
// API Onboarding Aliases (for frontend compatibility)
// Frontend calls /api/onboarding/:userId/start instead of /ai/onboarding/start
// ============================================

fastify.post('/api/onboarding/:userId/start', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const body = request.body as { referralCode?: string } | undefined;
        const result = await OnboardingService.startOnboarding(userId, body?.referralCode);
        return result;
    } catch (error) {
        logger.error({ error }, 'API Onboarding start error');
        reply.status(500);
        return { error: 'Failed to start onboarding' };
    }
});

fastify.post('/api/onboarding/:userId/role', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const body = request.body as { sessionId: string; role: 'hustler' | 'client' };
        const result = await OnboardingService.chooseRole(body.sessionId, body.role);
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
// AI Proof System Endpoints
// ============================================

const StartProofSchema = z.object({
    taskId: z.string(),
    hustlerId: z.string(),
    category: z.enum(['delivery', 'moving', 'cleaning', 'pet_care', 'errands', 'handyman', 'tech_help', 'yard_work', 'event_help', 'other']),
});

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
const SubmitProofSchema = z.object({
    sessionId: z.string(),
    requirementId: z.string(),
    photoUrl: z.string().url(),
    caption: z.string().optional(),
});

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
// Pricing Engine Endpoints
// ============================================

// Get pricing breakdown for a task
fastify.get('/api/pricing/calculate/:price', async (request) => {
    const { price } = request.params as { price: string };
    const basePrice = parseFloat(price);
    const query = request.query as { boost?: string; newHustler?: string; rating?: string };

    if (isNaN(basePrice) || basePrice <= 0) {
        return { error: 'Invalid price' };
    }

    const boostTier = (query.boost || 'normal') as 'normal' | 'priority' | 'rush' | 'vip';
    const pricing = PricingEngine.calculatePricing(basePrice, boostTier, {
        isNewHustler: query.newHustler === 'true',
        hustlerRating: query.rating ? parseFloat(query.rating) : undefined,
    });

    return pricing;
});

// Get comparison table for all tiers
fastify.get('/api/pricing/table/:price', async (request) => {
    const { price } = request.params as { price: string };
    const basePrice = parseFloat(price);

    if (isNaN(basePrice) || basePrice <= 0) {
        return { error: 'Invalid price' };
    }

    return PricingEngine.getPricingTable(basePrice);
});

// Get poster quote (what client sees)
fastify.get('/api/pricing/quote/:price', async (request) => {
    const { price } = request.params as { price: string };
    const query = request.query as { boost?: string };
    const basePrice = parseFloat(price);
    const boostTier = (query.boost || 'normal') as 'normal' | 'priority' | 'rush' | 'vip';

    if (isNaN(basePrice) || basePrice <= 0) {
        return { error: 'Invalid price' };
    }

    return PricingEngine.getPosterQuote(basePrice, boostTier);
});

// Get hustler earnings preview
fastify.get('/api/pricing/earnings/:price', async (request) => {
    const { price } = request.params as { price: string };
    const query = request.query as { boost?: string; newHustler?: string; rating?: string };
    const basePrice = parseFloat(price);
    const boostTier = (query.boost || 'normal') as 'normal' | 'priority' | 'rush' | 'vip';

    if (isNaN(basePrice) || basePrice <= 0) {
        return { error: 'Invalid price' };
    }

    return PricingEngine.getHustlerEarnings(basePrice, boostTier, {
        isNewHustler: query.newHustler === 'true',
        hustlerRating: query.rating ? parseFloat(query.rating) : undefined,
    });
});

// Request instant payout
const InstantPayoutSchema = z.object({
    hustlerId: z.string(),
    taskId: z.string(),
    amount: z.number().positive(),
});

fastify.post('/api/pricing/payout/instant', async (request, reply) => {
    try {
        const body = InstantPayoutSchema.parse(request.body);
        const payout = PricingEngine.requestInstantPayout(body.hustlerId, body.taskId, body.amount);
        return payout;
    } catch (error) {
        logger.error({ error }, 'Instant payout error');
        reply.status(400);
        return { error: 'Failed to process payout' };
    }
});

// Get payout history
fastify.get('/api/pricing/payout/:hustlerId', async (request) => {
    const { hustlerId } = request.params as { hustlerId: string };
    const history = PricingEngine.getPayoutHistory(hustlerId);
    return { payouts: history, count: history.length };
});

// Get revenue metrics
fastify.get('/api/pricing/revenue', async (request) => {
    const query = request.query as { period?: string };
    const period = (query.period || 'all') as 'day' | 'week' | 'month' | 'all';
    return PricingEngine.getRevenueMetrics(period);
});

// Get/update pricing config (admin)
fastify.get('/api/pricing/config', async () => {
    return PricingEngine.getConfig();
});

// ============================================
// Growth Coach Endpoints (Phase 1: Dopamine Core)
// ============================================

// Get full personalized growth plan
fastify.get('/api/coach/:userId/plan', async (request) => {
    const { userId } = request.params as { userId: string };
    const plan = await AIGrowthCoachService.getGrowthPlan(userId);
    return plan;
});

// Get earnings projection
fastify.get('/api/coach/:userId/earnings', async (request) => {
    const { userId } = request.params as { userId: string };
    const plan = await AIGrowthCoachService.getGrowthPlan(userId);
    return {
        current: plan.earnings,
        projection: plan.projection,
    };
});

// Get single best next action
fastify.get('/api/coach/:userId/next-action', async (request) => {
    const { userId } = request.params as { userId: string };
    const action = await AIGrowthCoachService.getNextBestAction(userId);
    return action || { message: 'No recommendations right now', type: 'none' };
});

// Get optimal tasks for this user
fastify.get('/api/coach/:userId/optimal-tasks', async (request) => {
    const { userId } = request.params as { userId: string };
    const { limit } = request.query as { limit?: string };
    const tasks = await AIGrowthCoachService.getOptimalTasks(userId, limit ? parseInt(limit) : 5);
    return { tasks, count: tasks.length };
});

// Get context-aware coaching tip
fastify.get('/api/coach/:userId/tip', async (request) => {
    const { userId } = request.params as { userId: string };
    const { context } = request.query as { context?: string };
    const tip = await AIGrowthCoachService.getCoachingTip(userId, undefined, context);
    return tip;
});

// Get poster insights
fastify.get('/api/coach/poster/:userId/insights', async (request) => {
    const { userId } = request.params as { userId: string };
    const insights = AIGrowthCoachService.getPosterInsights(userId);
    return insights;
});

// ============================================
// Badge Endpoints (Dynamic Badge Engine)
// ============================================

// Get all badges with progress for user
fastify.get('/api/badges/:userId', async (request) => {
    const { userId } = request.params as { userId: string };
    const progress = DynamicBadgeEngine.getBadgeProgress(userId);
    const stats = DynamicBadgeEngine.getBadgeStats(userId);
    return {
        badges: progress,
        stats,
        totalAvailable: DynamicBadgeEngine.getAllBadges().length,
    };
});

// Get recently earned badges
fastify.get('/api/badges/:userId/recent', async (request) => {
    const { userId } = request.params as { userId: string };
    const { limit } = request.query as { limit?: string };
    const badges = DynamicBadgeEngine.getRecentBadges(userId, limit ? parseInt(limit) : 5);
    return { badges, count: badges.length };
});

// Get public profile showcase badges
fastify.get('/api/badges/:userId/showcase', async (request) => {
    const { userId } = request.params as { userId: string };
    const badges = DynamicBadgeEngine.getBadgeShowcase(userId);
    return { badges, count: badges.length };
});

// Get seasonal/special badges
fastify.get('/api/badges/seasonal', async () => {
    const badges = DynamicBadgeEngine.getSeasonalBadges();
    return { badges, count: badges.length };
});

// Evaluate and award badges for user
fastify.post('/api/badges/:userId/evaluate', async (request) => {
    const { userId } = request.params as { userId: string };
    const result = await DynamicBadgeEngine.evaluateBadges(userId);
    return {
        newBadges: result.newBadges,
        xpAwarded: result.totalXPAwarded,
        message: result.newBadges.length > 0
            ? `🎉 Unlocked ${result.newBadges.length} new badge(s)!`
            : 'No new badges unlocked',
    };
});

// Award beta pioneer badge (special)
fastify.post('/api/badges/:userId/beta-pioneer', async (request) => {
    const { userId } = request.params as { userId: string };
    const badge = DynamicBadgeEngine.awardBetaPioneer(userId);
    return badge
        ? { success: true, badge, message: '🚀 Beta Pioneer badge awarded!' }
        : { success: false, message: 'Badge already awarded or not found' };
});

// ============================================
// Quest Endpoints (Quest Engine)
// ============================================

// Get daily quests
fastify.get('/api/quests/:userId/daily', async (request) => {
    const { userId } = request.params as { userId: string };
    const quests = QuestEngine.getDailyQuests(userId);
    return { quests, count: quests.length };
});

// Get weekly quests
fastify.get('/api/quests/:userId/weekly', async (request) => {
    const { userId } = request.params as { userId: string };
    const quests = QuestEngine.getWeeklyQuests(userId);
    return { quests, count: quests.length };
});

// Get seasonal quests
fastify.get('/api/quests/:userId/seasonal', async (request) => {
    const { userId } = request.params as { userId: string };
    const quests = QuestEngine.getSeasonalQuests(userId);
    return { quests, count: quests.length };
});

// Get all active quests
fastify.get('/api/quests/:userId/all', async (request) => {
    const { userId } = request.params as { userId: string };
    const quests = QuestEngine.getAllActiveQuests(userId);
    const stats = QuestEngine.getQuestStats(userId);
    return { quests, count: quests.length, stats };
});

// Refresh daily quests
fastify.post('/api/quests/:userId/refresh', async (request) => {
    const { userId } = request.params as { userId: string };
    const quests = QuestEngine.refreshDailyQuests(userId);
    return { quests, count: quests.length, message: '🔄 Daily quests refreshed!' };
});

// Claim quest reward
fastify.post('/api/quests/:userId/:questId/claim', async (request) => {
    const { userId, questId } = request.params as { userId: string; questId: string };
    const result = QuestEngine.claimQuest(userId, questId);
    return result;
});

// Generate personalized AI quest
const GenerateQuestSchema = z.object({
    topCategories: z.array(z.string()).optional().default([]),
    currentStreak: z.number().optional().default(0),
    recentEarnings: z.number().optional().default(0),
    level: z.number().optional().default(1),
});

fastify.post('/api/quests/:userId/generate', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const body = GenerateQuestSchema.parse(request.body);
        const quest = await QuestEngine.generatePersonalizedQuest(userId, {
            topCategories: body.topCategories as TaskCategory[],
            currentStreak: body.currentStreak,
            recentEarnings: body.recentEarnings,
            level: body.level,
        });
        return quest
            ? { success: true, quest }
            : { success: false, message: 'Failed to generate quest' };
    } catch (error) {
        logger.error({ error }, 'Quest generation failed');
        reply.status(500);
        return { error: 'Failed to generate quest' };
    }
});

// ============================================
// Contextual Coach Endpoints (Phase 2: Live Coaching)
// ============================================

// Get contextual tip for current screen
fastify.get('/api/tips/:userId/screen/:screen', async (request) => {
    const { userId, screen } = request.params as { userId: string; screen: string };
    const tip = ContextualCoachService.getTipForScreen(userId, screen as ScreenContext);
    return tip ? { tip } : { message: 'No tip available for this context' };
});

// Get best contextual tip (auto-detect)
fastify.get('/api/tips/:userId/contextual', async (request) => {
    const { userId } = request.params as { userId: string };
    const tip = ContextualCoachService.getContextualTip(userId);
    return tip ? { tip } : { message: 'No tips right now' };
});

// Get time-sensitive opportunities
fastify.get('/api/tips/:userId/time-sensitive', async (request) => {
    const { userId } = request.params as { userId: string };
    const tip = ContextualCoachService.getTimeSensitiveTip(userId);
    return tip ? { tip } : { message: 'No time-sensitive opportunities right now' };
});

// Get streak-related tip
fastify.get('/api/tips/:userId/streak', async (request) => {
    const { userId } = request.params as { userId: string };
    const { currentStreak } = request.query as { currentStreak?: string };
    const tip = ContextualCoachService.getStreakTip(userId, parseInt(currentStreak || '0'));
    return tip ? { tip } : { message: 'No streak tips right now' };
});

// Get all relevant tips
fastify.get('/api/tips/:userId/all', async (request) => {
    const { userId } = request.params as { userId: string };
    const { limit } = request.query as { limit?: string };
    const tips = ContextualCoachService.getAllRelevantTips(userId, parseInt(limit || '3'));
    return { tips, count: tips.length };
});

// ============================================
// Action Tracking & User Brain Endpoints (Always-Aware AI)
// ============================================

import { UserBrainService } from './services/UserBrainService.js';
import { ActionTrackerService, type ActionType } from './services/ActionTrackerService.js';
import type { ScreenContext as BrainScreenContext } from './services/UserBrainService.js';

// Track user action
fastify.post('/api/actions/track', async (request, reply) => {
    try {
        const body = request.body as {
            userId: string;
            actionType: ActionType;
            screen: BrainScreenContext;
            metadata?: Record<string, unknown>;
        };

        if (!body.userId || !body.actionType || !body.screen) {
            reply.status(400);
            return { error: 'Missing required fields: userId, actionType, screen' };
        }

        const action = ActionTrackerService.trackAction(body.userId, {
            actionType: body.actionType,
            screen: body.screen,
            metadata: body.metadata,
        });

        return { tracked: true, actionId: action.id };
    } catch (error) {
        logger.error({ error }, 'Action tracking failed');
        reply.status(500);
        return { error: 'Failed to track action' };
    }
});

// Get user's recent actions
fastify.get('/api/actions/:userId/recent', async (request) => {
    const { userId } = request.params as { userId: string };
    const { limit } = request.query as { limit?: string };
    const actions = ActionTrackerService.getRecentActions(userId, parseInt(limit || '10'));
    return { actions, count: actions.length };
});

// Get user's action patterns (for debugging/analytics)
fastify.get('/api/actions/:userId/patterns', async (request) => {
    const { userId } = request.params as { userId: string };
    const patterns = ActionTrackerService.analyzePatterns(userId);
    const stats = ActionTrackerService.getStats(userId);
    return { patterns, stats };
});

// Get user's brain (learned preferences)
fastify.get('/api/brain/:userId', async (request) => {
    const { userId } = request.params as { userId: string };
    const brain = UserBrainService.getUserBrain(userId);
    return {
        userId: brain.userId,
        role: brain.role,
        goals: brain.goals,
        constraints: brain.constraints,
        taskPreferences: brain.taskPreferences,
        aiHistorySummary: brain.aiHistorySummary,
        learningScore: brain.learningScore,
        totalInteractions: brain.totalInteractions,
        lastActiveAt: brain.lastActiveAt,
    };
});

// Get AI context for a user (what the AI knows)
fastify.get('/api/brain/:userId/context', async (request) => {
    const { userId } = request.params as { userId: string };
    const context = await UserBrainService.getContextForAI(userId);
    return { context };
});

// Update brain from external source (e.g., profile update)
fastify.post('/api/brain/:userId/learn', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const body = request.body as { message: string };

        if (!body.message) {
            reply.status(400);
            return { error: 'Missing message field' };
        }

        await UserBrainService.updateFromChat(userId, body.message);
        const brain = UserBrainService.getUserBrain(userId);

        return {
            learned: true,
            learningScore: brain.learningScore,
            aiHistorySummary: brain.aiHistorySummary,
        };
    } catch (error) {
        logger.error({ error }, 'Brain learning failed');
        reply.status(500);
        return { error: 'Failed to learn from message' };
    }
});

// ============================================
// AI Memory Endpoints (Phase 2: Conversation Memory)
// ============================================

import { AIMemoryService } from './services/AIMemoryService.js';

// Get user's conversation history
fastify.get('/api/memory/:userId/history', async (request) => {
    const { userId } = request.params as { userId: string };
    const { limit } = request.query as { limit?: string };
    const history = AIMemoryService.getRecentConversation(userId, parseInt(limit || '20'));
    return { history, count: history.length };
});

// Get extracted facts
fastify.get('/api/memory/:userId/facts', async (request) => {
    const { userId } = request.params as { userId: string };
    const facts = AIMemoryService.getFacts(userId);
    const structured = AIMemoryService.getStructuredData(userId);
    return { facts, structured, count: facts.length };
});

// Get AI-generated summary
fastify.get('/api/memory/:userId/summary', async (request) => {
    const { userId } = request.params as { userId: string };
    const summary = AIMemoryService.getSummary(userId);
    const stats = AIMemoryService.getStats(userId);
    return { summary, stats };
});

// Force regenerate summary
fastify.post('/api/memory/:userId/regenerate-summary', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const summary = await AIMemoryService.regenerateSummary(userId);
        return { summary, regenerated: true };
    } catch (error) {
        logger.error({ error }, 'Summary regeneration failed');
        reply.status(500);
        return { error: 'Failed to regenerate summary' };
    }
});

// ============================================
// Profile Optimizer Endpoints (Phase 2)
// ============================================

// Get full profile analysis
fastify.get('/api/profile/:userId/score', async (request) => {
    const { userId } = request.params as { userId: string };
    const score = ProfileOptimizerService.getProfileScore(userId);
    return score;
});

// Get improvement suggestions
fastify.get('/api/profile/:userId/suggestions', async (request) => {
    const { userId } = request.params as { userId: string };
    const suggestions = ProfileOptimizerService.getProfileSuggestions(userId);
    return { suggestions, count: suggestions.length };
});

// Generate AI bio
const GenerateBioSchema = z.object({
    currentBio: z.string().optional(),
    skills: z.array(z.string()).optional(),
    personality: z.string().optional(),
});

fastify.post('/api/profile/:userId/generate-bio', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const body = GenerateBioSchema.parse(request.body);
        const result = await ProfileOptimizerService.generateBioSuggestion(userId, body);
        return result;
    } catch (error) {
        logger.error({ error }, 'Bio generation failed');
        reply.status(500);
        return { error: 'Failed to generate bio' };
    }
});

// Generate AI headline
const GenerateHeadlineSchema = z.object({
    currentHeadline: z.string().optional(),
    skills: z.array(z.string()).optional(),
    specialty: z.string().optional(),
});

fastify.post('/api/profile/:userId/generate-headline', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const body = GenerateHeadlineSchema.parse(request.body);
        const result = await ProfileOptimizerService.generateHeadlineSuggestion(userId, body);
        return result;
    } catch (error) {
        logger.error({ error }, 'Headline generation failed');
        reply.status(500);
        return { error: 'Failed to generate headline' };
    }
});

// Get skill recommendations
fastify.get('/api/profile/:userId/skill-recommendations', async (request) => {
    const { userId } = request.params as { userId: string };
    const recommendations = ProfileOptimizerService.getSkillRecommendations(userId);
    return recommendations;
});

// Predict earnings impact of profile changes
const EarningsImpactSchema = z.object({
    photoUrl: z.string().optional(),
    bio: z.string().optional(),
    skills: z.array(z.string()).optional(),
    availabilitySet: z.boolean().optional(),
});

fastify.post('/api/profile/:userId/earnings-impact', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const changes = EarningsImpactSchema.parse(request.body);
        const impact = ProfileOptimizerService.predictEarningsImpact(userId, changes);
        return impact;
    } catch (error) {
        reply.status(400);
        return { error: 'Invalid request body' };
    }
});

// ============================================
// Social Card Endpoints (Phase 2: Viral Growth)
// ============================================

// Generate a social card
const GenerateCardSchema = z.object({
    type: z.enum(['task_completed', 'level_up', 'badge_unlocked', 'streak_milestone', 'earnings_milestone', 'quest_completed', 'first_task', 'weekly_recap']),
    data: z.object({
        taskTitle: z.string().optional(),
        taskCategory: z.string().optional(),
        earnings: z.number().optional(),
        xpEarned: z.number().optional(),
        rating: z.number().optional(),
        newLevel: z.number().optional(),
        totalXP: z.number().optional(),
        badgeName: z.string().optional(),
        badgeIcon: z.string().optional(),
        badgeRarity: z.string().optional(),
        streakDays: z.number().optional(),
        streakBonus: z.number().optional(),
        milestoneAmount: z.number().optional(),
        period: z.string().optional(),
        questTitle: z.string().optional(),
        questXP: z.number().optional(),
        weeklyTasks: z.number().optional(),
        weeklyEarnings: z.number().optional(),
        weeklyXP: z.number().optional(),
        weeklyStreak: z.number().optional(),
    }),
    userName: z.string().optional(),
});

fastify.post('/api/cards/:userId/generate', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const body = GenerateCardSchema.parse(request.body);
        const cardData = {
            ...body.data,
            taskCategory: body.data.taskCategory as TaskCategory | undefined,
        };
        const card = SocialCardGenerator.generateCard(userId, body.type, cardData, body.userName);
        return { card, ascii: SocialCardGenerator.getCardAscii(card) };
    } catch (error) {
        logger.error({ error }, 'Card generation failed');
        reply.status(500);
        return { error: 'Failed to generate card' };
    }
});

// Get recent cards
fastify.get('/api/cards/:userId/recent', async (request) => {
    const { userId } = request.params as { userId: string };
    const { limit } = request.query as { limit?: string };
    const cards = SocialCardGenerator.getRecentCards(userId, parseInt(limit || '10'));
    return { cards, count: cards.length };
});

// Get specific card
fastify.get('/api/cards/:cardId', async (request) => {
    const { cardId } = request.params as { cardId: string };
    const card = SocialCardGenerator.getCard(cardId);
    return card ? { card } : { error: 'Card not found' };
});

// Generate weekly recap card
const WeeklyRecapSchema = z.object({
    tasks: z.number(),
    earnings: z.number(),
    xp: z.number(),
    streak: z.number(),
    topCategory: z.string().optional(),
    userName: z.string().optional(),
});

fastify.post('/api/cards/:userId/weekly-recap', async (request, reply) => {
    try {
        const { userId } = request.params as { userId: string };
        const body = WeeklyRecapSchema.parse(request.body);
        const card = SocialCardGenerator.generateWeeklyRecap(userId, {
            tasks: body.tasks,
            earnings: body.earnings,
            xp: body.xp,
            streak: body.streak,
            topCategory: body.topCategory as TaskCategory | undefined,
        }, body.userName);
        return { card, ascii: SocialCardGenerator.getCardAscii(card) };
    } catch (error) {
        logger.error({ error }, 'Weekly recap generation failed');
        reply.status(500);
        return { error: 'Failed to generate weekly recap' };
    }
});

// Get share text for specific platform
fastify.get('/api/cards/:cardId/share/:platform', async (request) => {
    const { cardId, platform } = request.params as { cardId: string; platform: string };
    const card = SocialCardGenerator.getCard(cardId);

    if (!card) {
        return { error: 'Card not found' };
    }

    const validPlatforms = ['twitter', 'instagram', 'tiktok', 'sms'];
    if (!validPlatforms.includes(platform)) {
        return { error: 'Invalid platform. Use: twitter, instagram, tiktok, or sms' };
    }

    const shareText = SocialCardGenerator.getShareTextForPlatform(
        card,
        platform as 'twitter' | 'instagram' | 'tiktok' | 'sms'
    );

    return { platform, shareText };
});

// ============================================
// Enhanced Proof Photo Endpoints
// ============================================

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

// Submit a proof photo
fastify.post('/api/proof/:taskId/submit', async (request, reply) => {
    try {
        const { taskId } = request.params as { taskId: string };
        const { userId, phase, photoUrl, caption } = request.body as {
            userId: string;
            phase: 'before' | 'during' | 'after';
            photoUrl: string;
            caption?: string;
        };
        const submission = await EnhancedAIProofService.submitPhoto(taskId, userId, phase, photoUrl, caption);
        return submission;
    } catch (error) {
        reply.status(400);
        return { error: (error as Error).message };
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

// ============================================
// AI Cost Guard Endpoints
// ============================================

// Check if user can make AI call
fastify.get('/api/cost/:userId/check/:provider', async (request) => {
    const { userId, provider } = request.params as { userId: string; provider: string };
    const result = AICostGuardService.checkLimit(userId, provider as 'openai' | 'deepseek' | 'qwen');
    return result;
});

// Get user's AI usage stats
fastify.get('/api/cost/:userId/stats', async (request) => {
    const { userId } = request.params as { userId: string };
    const stats = AICostGuardService.getUserStats(userId);
    return stats;
});

// Get system-wide AI stats (admin)
fastify.get('/api/cost/system/stats', async (request) => {
    const stats = AICostGuardService.getSystemStats();
    const limits = AICostGuardService.getLimits();
    return { stats, limits };
});

// Update cost limits (admin)
fastify.post('/api/cost/limits', async (request) => {
    const newLimits = request.body as Partial<typeof AICostGuardService extends { updateLimits: (l: infer P) => unknown } ? P : never>;
    const limits = AICostGuardService.updateLimits(newLimits);
    return limits;
});

// ============================================
// SmartMatch AI Endpoints
// ============================================

// Re-rank candidates for a task
fastify.post('/api/match/:taskId/rerank', async (request, reply) => {
    try {
        const { taskId } = request.params as { taskId: string };
        const { task, candidates, limit } = request.body as {
            task: Parameters<typeof SmartMatchAIService.reRankCandidates>[0];
            candidates: Parameters<typeof SmartMatchAIService.reRankCandidates>[1];
            limit?: number;
        };
        const result = await SmartMatchAIService.reRankCandidates(task, candidates, limit);
        return result;
    } catch (error) {
        reply.status(500);
        return { error: 'Match ranking failed' };
    }
});

// Quick score a candidate
fastify.post('/api/match/quick-score', async (request) => {
    const { task, candidate } = request.body as {
        task: Parameters<typeof SmartMatchAIService.quickScore>[0];
        candidate: Parameters<typeof SmartMatchAIService.quickScore>[1];
    };
    const score = SmartMatchAIService.quickScore(task, candidate);
    return { score };
});

// Explain a match
fastify.post('/api/match/explain', async (request) => {
    const { task, candidate } = request.body as {
        task: Parameters<typeof SmartMatchAIService.explainMatch>[0];
        candidate: Parameters<typeof SmartMatchAIService.explainMatch>[1];
    };
    const explanation = await SmartMatchAIService.explainMatch(task, candidate);
    return explanation;
});

// Get test candidates for simulation
fastify.get('/api/match/test-candidates', async (request) => {
    const { count } = request.query as { count?: string };
    const candidates = SmartMatchAIService.generateTestCandidates(parseInt(count || '10'));
    return { candidates };
});

// ============================================
// Error Tracking Endpoints
// ============================================

// Get recent errors (admin)
fastify.get('/api/errors/recent', async (request) => {
    const { limit } = request.query as { limit?: string };
    const events = ErrorTracker.getRecentEvents(parseInt(limit || '10'));
    return { events, enabled: ErrorTracker.isEnabled() };
});

// ============================================
// Server Startup
// ============================================

const PORT = parseInt(process.env.PORT || '3000');

async function start() {
    try {
        // Validate environment variables
        const envResult = validateEnv();
        logEnvStatus(envResult);

        // Initialize database
        if (isDatabaseAvailable()) {
            const connected = await testConnection();
            if (connected) {
                await runMigrations();
                await seedTestData();
            }
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
