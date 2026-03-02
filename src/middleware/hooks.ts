/**
 * Named hook helpers extracted from src/index.ts to keep that file under 300 lines.
 *
 * Three onRequest hooks:
 *   authHook        – global Firebase auth (public / optional / required)
 *   idempotencyHook – require idempotency key on financial POSTs
 *   rateLimiterHook – admin + financial rate limiting
 *
 * One CORS helper:
 *   corsOriginCallback – @fastify/cors origin function
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth, optionalAuth } from './firebaseAuth.js';
import { requireIdempotencyKey } from './idempotency.js';
import { adminRateLimiter, financialRateLimiter } from './rateLimiter.js';

// Public routes that don't require authentication
// SECURITY: Only truly public endpoints should be listed here.
// Sensitive endpoints moved to OPTIONAL_AUTH_ROUTES (auth available but not required).
export const PUBLIC_ROUTES = [
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
export const OPTIONAL_AUTH_ROUTES = [
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

/**
 * Global authentication hook — protects ALL routes except public ones.
 * Attach with: fastify.addHook('onRequest', authHook)
 */
export async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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
}

/**
 * Idempotency hook — requires idempotency key on state-changing financial POSTs.
 * Attach with: fastify.addHook('onRequest', idempotencyHook)
 */
export async function idempotencyHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Only apply to financial endpoints
    const path = request.url.split('?')[0];
    const FINANCIAL_PATHS = ['/api/escrow', '/api/tasks', '/api/disputes', '/api/admin'];

    if (FINANCIAL_PATHS.some(fp => path.startsWith(fp)) && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
        await requireIdempotencyKey(request, reply);
    }
}

/**
 * Rate-limiter hook — throttles admin (10/min) and financial (5/min) endpoints.
 * Attach with: fastify.addHook('onRequest', rateLimiterHook)
 */
export async function rateLimiterHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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
}

/**
 * CORS origin callback for @fastify/cors.
 *
 * - Allows no-origin requests (mobile apps, curl, server-to-server)
 * - In development, allows localhost / 127.0.0.1
 * - In production, only ALLOWED_ORIGINS env-var entries are permitted
 */
export function corsOriginCallback(origin: string | undefined, cb: (err: Error | null, allow: boolean) => void): void {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return cb(null, true);

    const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean);

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
}
