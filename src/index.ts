/**
 * HustleXP AI Backend - Main Entry Point
 *
 * A multi-model AI orchestration system for the HustleXP gig marketplace.
 * Uses DeepSeek for reasoning, Groq for fast operations, and GPT-4o for safety.
 *
 * Route modules:
 *   src/routes/healthFastify.ts  — health check + beta metrics
 *   src/routes/ai.ts             — AI orchestration + onboarding + task cards
 *   src/routes/tasks.ts          — task CRUD, proof, planner, boost
 *   src/routes/taskProof.ts      — proof, GPS-proof, planner, boost routes
 *   src/routes/users.ts          — user profile, badges, quests, coach, brain, social
 *   src/routes/escrow.ts         — escrow hold/refund, payout approval
 *   src/routes/stripe.ts         — Stripe Connect + webhooks
 *   src/routes/admin.ts          — admin TPEE, disputes, safety, metrics, jobs, flags
 *   src/routes/controlplane.ts   — risk scoring, shadow policy, market signals, city domination
 */

import { env } from './config/env.js';
import 'dotenv/config'; // Fallback for other files still using process.env
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rawBody from 'fastify-raw-body';

import { logger } from './utils/logger.js';
import { testConnection, isDatabaseAvailable } from './db/index.js';
import { runMigrations, seedTestData } from './db/schema.js';
import { validateEnv, logEnvStatus } from './utils/envValidator.js';
import { validateConfig } from './config.js';
import { isAuthEnabled } from './middleware/firebaseAuth.js';
import { DatabaseHealthService } from './services/DatabaseHealthService.js';
import { addRequestId, returnRequestId, createGlobalErrorHandler, logRequest } from './middleware/requestId.js';
import { cacheIdempotentResponse } from './middleware/idempotency.js';
import { authHook, idempotencyHook, rateLimiterHook, corsOriginCallback } from './middleware/hooks.js';

// Route modules
import disputeRoutes from './routes/disputes.js';
import debugRoutes from './routes/debug.js';
import identityRoutes from './identity/routes/identity.js';
import trustRoutes from './routes/trust.js';
import authRoutes from './routes/auth.js';
import frontendRoutes from './routes/frontend.js';
import { healthRoutes } from './routes/healthFastify.js';
import { aiRoutes } from './routes/ai.js';
import { taskRoutes } from './routes/tasks.js';
import { taskProofRoutes } from './routes/taskProof.js';
import { userRoutes } from './routes/users.js';
import { escrowRoutes } from './routes/escrow.js';
import { stripeRoutes } from './routes/stripe.js';
import { adminRoutes } from './routes/admin.js';
import { controlPlaneRoutes } from './routes/controlplane.js';

const fastify = Fastify({
    logger: false, // We use our own pino logger
    bodyLimit: 1_048_576, // 1MB max body size (SECURITY: prevent memory exhaustion)
});

// Register CORS — restrict to configured origins (SECURITY: never use origin:true in production)
await fastify.register(cors, {
    origin: corsOriginCallback,
    credentials: true,
});

// Register raw-body plugin for Stripe webhook signature verification
await fastify.register(rawBody, {
    field: 'rawBody', // Make raw body available as request.rawBody
    global: false,    // Only apply to routes that specify rawBody: true
    encoding: 'utf8',
    runFirst: true,   // Run before other parsers
});

// ============================================
// PHASE 6: MIDDLEWARE STACK (CORRECT ORDER)
// ============================================

// 1. REQUEST ID — MUST BE FIRST
fastify.addHook('onRequest', addRequestId);
fastify.addHook('onResponse', returnRequestId);

// 2. GLOBAL AUTH — public / optional / required
fastify.addHook('onRequest', authHook);

// 3. IDEMPOTENCY KEY — After auth, before routes
fastify.addHook('onRequest', idempotencyHook);

// 4. RATE LIMITERS — After idempotency check
fastify.addHook('onRequest', rateLimiterHook);

// 5. RESPONSE LOGGING
fastify.addHook('onResponse', logRequest);

// 6. IDEMPOTENCY RESPONSE CACHING
fastify.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload === 'string') {
        await cacheIdempotentResponse(request, reply, payload);
    }
    return payload;
});

// ============================================
// Server Startup
// ============================================

const PORT = parseInt(process.env.PORT || '3000');

async function start() {
    try {
        // Validate backend configuration (fail fast on critical missing vars)
        const configResult = validateConfig();
        if (!configResult.valid) {
            for (const err of configResult.errors) {
                logger.error(`CONFIG ERROR: ${err}`);
            }
            if (process.env.NODE_ENV === 'production') {
                logger.fatal('Cannot start in production with invalid configuration');
                process.exit(1);
            }
        }
        for (const warn of configResult.warnings) {
            logger.warn(`CONFIG WARNING: ${warn}`);
        }

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

        // Verify authentication configuration
        if (isAuthEnabled()) {
            logger.info('Firebase Authentication ENABLED');
        } else {
            logger.warn('Firebase Authentication DISABLED (Development Mode)');
        }

        // ============================================
        // Register API Route Modules
        // ============================================

        // Core platform routes (pre-existing modular)
        await fastify.register(authRoutes, { prefix: '/api' });
        await fastify.register(debugRoutes, { prefix: '/api' });
        await fastify.register(disputeRoutes, { prefix: '/api/disputes' });
        await fastify.register(trustRoutes, { prefix: '/api/trust' });
        await fastify.register(frontendRoutes);  // BUILD_GUIDE frontend routes (xp-progress, escrow-status, etc.)

        // HIVS: Identity Verification Routes (Email + Phone before AI onboarding)
        const verificationRoutes = (await import('./routes/verification.js')).default;
        await fastify.register(verificationRoutes, { prefix: '/api/verify' });

        // IVS Webhook: Receives identity verification events from IVS microservice
        // IDENTITY ROUTES (Merged IVS)
        await fastify.register(identityRoutes, { prefix: '/identity' });

        // Identity Context: AI onboarding personalization endpoints
        const identityContextRoutes = (await import('./routes/identityContext.js')).default;
        await fastify.register(identityContextRoutes, { prefix: '/api/onboarding' });

        // Decomposed domain route modules
        await fastify.register(healthRoutes);
        await fastify.register(aiRoutes);
        await fastify.register(taskRoutes);
        await fastify.register(taskProofRoutes);
        await fastify.register(userRoutes);
        await fastify.register(escrowRoutes);
        await fastify.register(stripeRoutes);
        await fastify.register(adminRoutes);
        await fastify.register(controlPlaneRoutes);

        // 7. GLOBAL ERROR HANDLER — MUST BE LAST (but before listen)
        fastify.setErrorHandler(createGlobalErrorHandler());

        // Start Database Health Monitoring
        if (isDatabaseAvailable()) {
            DatabaseHealthService.start();
            logger.info('Database health monitoring started (30s interval)');
        }

        // Start server
        const address = await fastify.listen({ port: PORT, host: '0.0.0.0' });
        logger.info(`Server listening explicitly at: ${address}`);

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
