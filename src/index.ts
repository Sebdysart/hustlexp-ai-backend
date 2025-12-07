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
