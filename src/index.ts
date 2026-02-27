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
import { requireAuth, optionalAuth, isAuthEnabled, requireFreshToken } from './middleware/firebaseAuth.js';
import { DatabaseHealthService } from './services/DatabaseHealthService.js';
import { addRequestId, returnRequestId, createGlobalErrorHandler, logRequest } from './middleware/requestId.js';
import { requireIdempotencyKey, cacheIdempotentResponse } from './middleware/idempotency.js';
import { adminRateLimiter, financialRateLimiter } from './middleware/rateLimiter.js';

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
    origin: (origin, cb) => {
        // Allow requests with no origin (mobile apps, curl, server-to-server)
        if (!origin) return cb(null, true);

        const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
            : [];

        // In development, allow localhost origins (parse URL to prevent bypass via crafted domains)
        const isDev = process.env.NODE_ENV !== 'production';
        if (isDev) {
            try {
                const hostname = new URL(origin).hostname;
                if (hostname === 'localhost' || hostname === '127.0.0.1') {
                    return cb(null, true);
                }
            } catch { /* invalid origin URL, fall through */ }
        }

        if (allowedOrigins.length === 0 && isDev) {
            // Dev fallback: allow all if no origins configured
            return cb(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return cb(null, true);
        }

        cb(new Error(`CORS: Origin ${origin} not allowed`), false);
    },
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
// Tags every request for log correlation and Stripe tracing
fastify.addHook('onRequest', addRequestId);
fastify.addHook('onResponse', returnRequestId);

// ============================================
// Global Authentication Hook
// ============================================

// Public routes that don't require authentication
// SECURITY: Only truly public endpoints should be listed here.
// Sensitive endpoints moved to OPTIONAL_AUTH_ROUTES (auth available but not required).
const PUBLIC_ROUTES = [
    '/health',
    '/health/detailed',
    '/health/ai',
    // Stripe webhooks (use Stripe signature verification, not Firebase auth)
    '/api/stripe/webhook',
    '/webhooks/stripe',
    // Webhooks from external services
    '/webhooks/identity',
];

// Routes where auth is checked but not required (demo/anonymous access allowed)
// These use optionalAuth — if a token is present it's validated, but requests without tokens are allowed
const OPTIONAL_AUTH_ROUTES = [
    '/api/tasks',       // Task browsing (read-only)
    '/api/users',       // User lookup
    '/ai/orchestrate',  // AI chat (may work in demo mode)
    '/ai/onboarding',   // Onboarding flow
    '/ai/task-card',    // Card generation
    '/api/onboarding',  // Alias for frontend compatibility
    '/api/coach',       // Growth coach tips
    '/api/badges',      // Badge browsing
    '/api/quests',      // Quest browsing
    '/api/tips',        // Tips
    '/api/pricing',     // Pricing info (public)
    '/identity',        // Identity verification start

    // Previously-public routes: keep optional auth to preserve demo/anonymous UX
    '/api/profile',
    '/api/trust',
    '/api/cards',
    '/api/match',
    '/api/cost',
    '/api/proof',
    '/api/boost',
    '/api/planner',
    '/api/actions',
    '/api/brain',
    '/api/memory',
];

// Add global auth hook - protects ALL routes except public ones
fastify.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]; // Remove query params

    // Skip auth entirely for public routes (webhooks, health)
    if (PUBLIC_ROUTES.some(route => path === route || path.startsWith(route + '/'))) {
        return;
    }

    // Optional auth for browsing/demo routes — validate token if present, but don't require it
    if (OPTIONAL_AUTH_ROUTES.some(route => path === route || path.startsWith(route + '/'))) {
        await optionalAuth(request, reply);
        return;
    }

    // Require authentication for all other routes (financial, admin, sensitive)
    await requireAuth(request, reply);
});

// 2. IDEMPOTENCY KEY — After auth, before routes
// Prevents duplicate POSTs for state-changing operations
fastify.addHook('onRequest', async (request, reply) => {
    // Only apply to financial endpoints
    const path = request.url.split('?')[0];
    const FINANCIAL_PATHS = ['/api/escrow', '/api/tasks', '/api/disputes', '/api/admin'];

    if (FINANCIAL_PATHS.some(fp => path.startsWith(fp)) && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
        await requireIdempotencyKey(request, reply);
    }
});

// 3. RATE LIMITERS — After idempotency check
// Throttle financial and admin endpoints
fastify.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];

    // Admin rate limit (10/min)
    if (path.startsWith('/api/admin') && adminRateLimiter) {
        if (process.env.NODE_ENV !== 'development') {
            const result = await adminRateLimiter.limit(request.user?.uid || request.ip);
            if (!result.success) {
                reply.status(429).send({ error: 'Admin rate limit exceeded', code: 'RATE_LIMITED' });
                return;
            }
        }
    }

    // Financial rate limit (5/min) for payouts
    if ((path.includes('/approve') || path.includes('/release') || path.includes('/payout')) && financialRateLimiter) {
        if (process.env.NODE_ENV !== 'development') {
            const result = await financialRateLimiter.limit(request.user?.uid || request.ip);
            if (!result.success) {
                reply.status(429).send({ error: 'Financial rate limit exceeded', code: 'RATE_LIMITED' });
                return;
            }
        }
    }
});

// 4. RESPONSE LOGGING
fastify.addHook('onResponse', logRequest);

// 5. IDEMPOTENCY RESPONSE CACHING
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
        await fastify.register(userRoutes);
        await fastify.register(escrowRoutes);
        await fastify.register(stripeRoutes);
        await fastify.register(adminRoutes);
        await fastify.register(controlPlaneRoutes);

        // 6. GLOBAL ERROR HANDLER — MUST BE LAST (but before listen)
        // Sanitizes stack traces and provides consistent error responses
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
