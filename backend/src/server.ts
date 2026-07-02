/**
 * HustleXP Backend Server v1.0.0
 * 
 * CONSTITUTIONAL: Unified entry point for HustleXP backend
 * 
 * Architecture:
 * - Hono for HTTP handling
 * - tRPC for type-safe API
 * - Firebase for authentication
 * - Neon PostgreSQL with constitutional schema
 * - Upstash Redis for caching
 * 
 * @see ARCHITECTURE.md §1
 */

// Sentry must be imported first to capture all errors
import { Sentry } from './sentry.js';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './routers/index.js';
import { createContext } from './trpc.js';
import { config, validateConfig } from './config.js';
import { securityHeaders, rateLimitMiddleware, publicIpRateLimitMiddleware, aiRateLimitMiddleware } from './middleware/security.js';
import { requestIdMiddleware, serverTimingMiddleware } from './middleware/request-id.js';
import { httpMetricsMiddleware } from './monitoring/http-metrics.js';
import { createMetricsEndpoint } from './monitoring/metrics.js';

// ============================================================================
// SECURITY VALIDATION (Fail-Fast in Production)
// ============================================================================

// CRITICAL: Fail-fast if CORS is misconfigured in production
if (config.app.isProduction) {
  const allowedOrigins = config.app.allowedOrigins;
  
  if (allowedOrigins.length === 0) {
    console.error('❌ CRITICAL: ALLOWED_ORIGINS is not set in production');
    console.error('   Set ALLOWED_ORIGINS to your frontend domain(s)');
    console.error('   Example: ALLOWED_ORIGINS=https://app.hustlexp.com,https://admin.hustlexp.com');
    process.exit(1);
  }
  
  if (allowedOrigins.includes('*')) {
    console.error('❌ CRITICAL: ALLOWED_ORIGINS contains "*" in production');
    console.error('   This allows any website to access your API');
    console.error('   Set specific origins like: ALLOWED_ORIGINS=https://app.hustlexp.com');
    process.exit(1);
  }
  
  // Validate all origins are HTTPS
  const nonHttpsOrigins = allowedOrigins.filter(o => o.startsWith('http:'));
  if (nonHttpsOrigins.length > 0) {
    console.error('❌ CRITICAL: Non-HTTPS origins in production:');
    nonHttpsOrigins.forEach(o => console.error(`   - ${o}`));
    console.error('   All origins must use HTTPS in production');
    process.exit(1);
  }
  
  console.log('✅ CORS configured for production:');
  allowedOrigins.forEach(origin => console.log(`   - ${origin}`));
}

// Hono context variable type augmentation
type AppVariables = {
  requestId: string;
};
import { compress } from 'hono/compress';
import { bodyLimit } from 'hono/body-limit';
import { logger as pinoLogger } from './logger.js';
import { createHmac, timingSafeEqual } from 'crypto';

// ============================================================================
// APP INITIALIZATION
// ============================================================================

const app = new Hono<{ Variables: AppVariables }>();

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Request body size limit — prevent abuse via oversized payloads
app.use('*', bodyLimit({
  maxSize: 10 * 1024 * 1024, // 10MB
  onError: (c) => {
    return c.json({ error: 'Request body too large', maxSize: '10MB' }, 413);
  },
}));

// Request ID — unique ID per request for distributed tracing
app.use('*', requestIdMiddleware);

// Server Timing — performance metrics in response headers
app.use('*', serverTimingMiddleware);

// Response compression (gzip/deflate)
app.use('*', compress());

// Security headers (X-Frame-Options, X-Content-Type-Options, etc.)
app.use('*', securityHeaders);

// API versioning headers
app.use('*', async (c, next) => {
  await next();
  c.header('X-API-Version', '2024-02-19');
  c.header('X-HustleXP-Version', '2.4.0');
  c.header('Deprecation', 'false');
});

// Structured request logging (Pino) — includes requestId
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const status = c.res.status;
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  pinoLogger[level]({
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    status,
    duration,
    ip: (() => { const cfIp = c.req.header('cf-connecting-ip'); if (cfIp) return cfIp.trim(); const xff = c.req.header('x-forwarded-for'); if (xff) { const parts = xff.split(',').map((s) => s.trim()).filter(Boolean); if (parts.length > 0) return parts[parts.length - 1]; } return c.req.header('x-real-ip') || 'unknown'; })(),
  }, `${c.req.method} ${c.req.path} → ${status} (${duration}ms)`);
});

// CORS — explicit origins only (no wildcard with credentials)
const allowedOrigins = config.app.isDevelopment
  ? ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:8081']
  : (config.app.allowedOrigins.length > 0
      ? config.app.allowedOrigins
      : [
          'https://hustlexp.app',
          'https://www.hustlexp.app',
        ]);

app.use('*', cors({
  origin: (requestOrigin) => {
    // Reject null/missing origin in production (CSRF protection)
    // iOS native apps should use X-HustleXP-Platform header instead
    if (!requestOrigin) {
      // In development, allow for testing convenience
      if (config.app.isDevelopment) return allowedOrigins[0];
      return null;
    }
    return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-HustleXP-Platform'],
  credentials: true,
  maxAge: 3600, // Cache preflight for 1h (was 24h — reduced for faster policy rotation)
}));

// Prometheus HTTP metrics collection
app.use('*', httpMetricsMiddleware());

// Rate limiting per route category.
// Specific limits for high-risk routers run first — Hono matches first rule.
// Order matters: most restrictive patterns first, catch-all last.

// Tier 1: Auth (20/min) — brute force protection
app.use('/trpc/user.register*', rateLimitMiddleware('auth'));       // 20/min — registration
app.use('/trpc/biometric.*', rateLimitMiddleware('auth'));          // 20/min — biometric auth
app.use('/trpc/admin.*', rateLimitMiddleware('auth'));              // 20/min — privileged admin access

// Tier 2: Financial (10/min) — strictest, money operations
app.use('/trpc/escrow.release*', rateLimitMiddleware('financial')); // 10/min — escrow release
app.use('/trpc/stripe.*', rateLimitMiddleware('financial'));        // 10/min — Stripe financial ops (dead pattern, kept for forward compat)
app.use('/trpc/stripeConnect.*', rateLimitMiddleware('financial')); // 10/min — Stripe Connect onboarding
app.use('/trpc/subscription.*', rateLimitMiddleware('financial')); // 10/min — Stripe subscription billing mutations
app.use('/trpc/fraud.*', rateLimitMiddleware('financial'));         // 10/min — fraud reporting

// Tier 3: AI (20/min) — cost protection
// A-07 FIX: Also apply per-user per-provider AI rate limiters (aiRateLimitMiddleware).
// Previously only the IP-based general limiter ran on /trpc/ai.* routes; the
// per-provider limits defined in AI_RATE_LIMITS were never wired to any route.
app.use('/trpc/ai.*', rateLimitMiddleware('ai'));                  // 20/min — AI cost protection (IP-based)
app.use('/trpc/ai.*', aiRateLimitMiddleware('openai'));            // per-user openai limit
app.use('/trpc/disputeAI.*', rateLimitMiddleware('ai'));           // 20/min — AI dispute resolution
app.use('/trpc/disputeAI.*', aiRateLimitMiddleware('openai'));     // per-user openai limit for dispute AI
app.use('/trpc/matchmaker.*', rateLimitMiddleware('ai'));          // 20/min — AI matchmaking
app.use('/trpc/matchmaker.*', aiRateLimitMiddleware('openai'));    // per-user openai limit for matchmaker
app.use('/trpc/taskDiscovery.getAISuggestions', rateLimitMiddleware('ai')); // 20/min — AI task suggestions
app.use('/trpc/taskDiscovery.getAISuggestions', aiRateLimitMiddleware('openai')); // per-user openai limit

// Tier 3b: Public browse (30/min, IP-based) — DoS protection for unauthenticated endpoint.
// Must precede the general /trpc/* catch-all and the taskDiscovery.* pattern below
// so that this tighter limit wins for the no-auth browse endpoint.
app.use('/trpc/taskDiscovery.browseTasks', rateLimitMiddleware('browse')); // 30/min — public task browse

// Tier 4: Domain-specific
// A-04: escrow.refund and escrow.confirmFunding trigger Stripe API calls — they must use
// the tighter 'financial' bucket (10/min) not the general 'escrow' bucket (30/min).
// These rules must precede the escrow.* catch-all so Hono's first-match wins.
app.use('/trpc/escrow.refund*', rateLimitMiddleware('financial'));           // 10/min — Stripe refund API
app.use('/trpc/escrow.confirmFunding*', rateLimitMiddleware('financial'));   // 10/min — Stripe payment confirmation
app.use('/trpc/escrow.*', rateLimitMiddleware('escrow'));           // 30/min — other escrow ops
app.use('/trpc/live.*', rateLimitMiddleware('live'));               // 20/min — live mode (multi-table JOIN, geo amplification risk)
app.use('/trpc/task.*', rateLimitMiddleware('task'));               // 60/min — core task ops

// Tier 5: Mutation (60/min) — write-heavy routes
app.use('/trpc/messaging.*', rateLimitMiddleware('mutation'));      // 60/min — message sends
app.use('/trpc/rating.*', rateLimitMiddleware('mutation'));         // 60/min — review submissions
app.use('/trpc/moderation.*', rateLimitMiddleware('mutation'));     // 60/min — moderation actions
app.use('/trpc/upload.*', rateLimitMiddleware('mutation'));         // 60/min — file uploads
app.use('/trpc/notification.*', rateLimitMiddleware('mutation'));   // 60/min — notification management
app.use('/trpc/tipping.*', rateLimitMiddleware('mutation'));        // 60/min — tip mutations
app.use('/trpc/recurringTask.*', rateLimitMiddleware('mutation'));  // 60/min — recurring task create/pause/resume/cancel
app.use('/trpc/dispute.*', rateLimitMiddleware('mutation'));        // 60/min — dispute submissions
app.use('/trpc/xpTax.*', rateLimitMiddleware('mutation'));          // 60/min — XP tax mutations
app.use('/trpc/incidents.*', rateLimitMiddleware('mutation'));      // 60/min — incident reporting (admin-authed separately)

// Tier 5b: Sensitive user mutations — explicit limits to prevent queue flooding
// user.requestErasure gets auth tier (20/min) — GDPR erasure queue flood protection
// Must precede the general /trpc/* catch-all so this tighter limit wins.
app.use('/trpc/user.requestErasure', rateLimitMiddleware('auth'));        // 20/min — GDPR erasure queue flood protection
app.use('/trpc/user.updateProfile', rateLimitMiddleware('mutation'));     // 60/min — profile write mutations
app.use('/trpc/user.completeOnboarding', rateLimitMiddleware('mutation')); // 60/min — onboarding write mutations

// Tier 6: Public IP rate limit (60/min) — ALL tRPC requests, authenticated and unauthenticated.
// Runs before the user-bucket catch-all; applies to every request regardless of whether a
// Bearer token is present. Authenticated users are intentionally not exempt — this is a
// defence-in-depth IP-level limit. Per-user limits are enforced separately by rateLimitMiddleware.
app.use('/trpc/*', publicIpRateLimitMiddleware());                 // 60/min per IP — public/unauthenticated access

// Tier 7: General (120/min) — catch-all for remaining tRPC and REST routes
app.use('/trpc/*', rateLimitMiddleware('general'));                 // 120/min — all other tRPC routes
app.use('/api/*', publicIpRateLimitMiddleware());                   // 60/min per IP — A48-2: defence-in-depth (prevents Firebase quota exhaustion via unauthenticated /api/* requests)
app.use('/api/*', rateLimitMiddleware('general'));                  // 120/min — REST endpoints

// ============================================================================
// PROMETHEUS METRICS ENDPOINT
// ============================================================================

createMetricsEndpoint(app);

// ============================================================================
// HEALTH CHECK
// ============================================================================

// A49-2 FIX: Apply IP-based rate limiting to all health endpoints.
// Without this, an attacker can flood /health, /health/readiness, and
// /health/liveness at unbounded rates, triggering DB queries (/health,
// /health/readiness) on every request and consuming connection pool budget.
// /health/liveness has no DB cost but still benefits from DoS protection.
// The /health/detailed route already has rateLimitMiddleware('auth') and
// now also gets publicIpRateLimitMiddleware() via the wildcard below.
app.use('/health*', publicIpRateLimitMiddleware());

app.get('/health', async (c) => {
  try {
    // Verify database is reachable without leaking schema internals to unauthenticated callers
    await db.query('SELECT 1');
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  } catch {
    return c.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
    }, 503);
  }
});

// Readiness probe — for Kubernetes/Railway to determine if app can accept traffic
// Returns 200 only if database is reachable (critical dependency)
app.get('/health/readiness', async (c) => {
  try {
    await db.query('SELECT 1');
    return c.json({ ready: true });
  } catch {
    return c.json({ ready: false }, 503);
  }
});

// Liveness probe — lightweight "am I alive?" check (no DB)
app.get('/health/liveness', (c) => {
  return c.json({ alive: true, uptime: process.uptime() });
});

// Temporary debug — remove after CORS is confirmed working
app.get('/debug/cors-config', (c) => {
  return c.json({
    nodeEnv: process.env.NODE_ENV,
    isDevelopment: config.app.isDevelopment,
    allowedOriginsEnv: process.env.ALLOWED_ORIGINS ?? null,
    allowedOriginsParsed: config.app.allowedOrigins,
  });
});

// ── Public action-link endpoints (used by /go/:token on the website) ──────────
// Fully unauthenticated — no Firebase JWT required. Token is opaque + hashed.
app.get('/api/action-link', async (c) => {
  const { handleActionLinkGet } = await import('./routers/web/actionLinks.js');
  const token = c.req.query('token') ?? '';
  const result = await handleActionLinkGet(token);
  if (!result.ok && result.code === 'expired') return c.json(result, 410);
  if (!result.ok && result.code === 'not_found') return c.json(result, 404);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/action-link', async (c) => {
  const { handleActionLinkPost } = await import('./routers/web/actionLinks.js');
  const body = await c.req.json().catch(() => ({})) as { token?: string; action?: string };
  const result = await handleActionLinkPost(body.token ?? '', body.action ?? '');
  if (!result.ok && result.code === 'expired') return c.json(result, 410);
  return c.json(result, result.ok ? 200 : 400);
});

// Detailed health for monitoring — internal only, requires INTERNAL_API_KEY
app.get('/health/detailed', rateLimitMiddleware('auth'), async (c) => {
  // Gate behind internal API key to prevent leaking circuit breaker states,
  // DB pool config, memory usage, and uptime to unauthenticated callers.
  const internalApiKey = process.env.INTERNAL_API_KEY;
  if (!internalApiKey) {
    pinoLogger.warn('INTERNAL_API_KEY is not configured — /health/detailed is disabled');
    return c.json({ error: 'Service Unavailable', message: 'Internal API key not configured' }, 503);
  }
  const authHeader = c.req.header('Authorization');
  const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  // A46-4 FIX: The previous length pre-check (`providedBuf.length === expectedBuf.length`)
  // leaked the byte length of INTERNAL_API_KEY via a timing side-channel — an attacker
  // could binary-search the key length by observing which requests fail fast vs. slow.
  // Fix: pad both buffers to the same length (max of the two) with zeros before calling
  // timingSafeEqual, which requires equal-length buffers without revealing which is longer.
  const rawProvided = Buffer.from(provided || '', 'utf8');
  const expectedBuf = Buffer.from(internalApiKey, 'utf8');
  const maxLen = Math.max(rawProvided.length, expectedBuf.length);
  const providedBuf = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  rawProvided.copy(providedBuf);
  expectedBuf.copy(paddedExpected);
  const match = timingSafeEqual(providedBuf, paddedExpected);
  if (!provided || !match) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
  
  // Database check
  const dbStart = Date.now();
  try {
    await db.query('SELECT 1 as ping');
    checks.database = {
      status: 'ok',
      latency: Date.now() - dbStart
    };
  } catch (error) {
    checks.database = { 
      status: 'error', 
      error: error instanceof Error ? error.message : 'Unknown' 
    };
  }
  
  // Schema version check
  try {
    const result = await db.query('SELECT version, applied_at FROM schema_versions ORDER BY applied_at DESC LIMIT 1');
    checks.schema = { 
      status: result.rows[0]?.version === '1.0.0' ? 'ok' : 'outdated',
    };
  } catch (error) {
    checks.schema = { 
      status: 'error', 
      error: error instanceof Error ? error.message : 'Unknown' 
    };
  }
  
  // Firebase check
  checks.firebase = {
    status: config.firebase.projectId ? 'configured' : 'missing',
  };
  
  // Stripe check
  checks.stripe = {
    status: config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')
      ? 'configured'
      : 'placeholder',
  };

  // Database pool metrics
  const pool = db.getPool();
  const poolMetrics = {
    totalConnections: pool.totalCount,
    idleConnections: pool.idleCount,
    waitingClients: pool.waitingCount,
  };

  // Circuit breaker states
  const {
    openaiBreaker, anthropicBreaker, groqBreaker, deepseekBreaker,
    stripeBreaker, sendgridBreaker, twilioBreaker, awsRekognitionBreaker,
    gcpVisionBreaker, googleMapsBreaker,
  } = await import('./middleware/circuit-breaker.js');
  const circuitBreakers = {
    openai: openaiBreaker.getState(),
    anthropic: anthropicBreaker.getState(),
    groq: groqBreaker.getState(),
    deepseek: deepseekBreaker.getState(),
    stripe: stripeBreaker.getState(),
    sendgrid: sendgridBreaker.getState(),
    twilio: twilioBreaker.getState(),
    awsRekognition: awsRekognitionBreaker.getState(),
    gcpVision: gcpVisionBreaker.getState(),
    googleMaps: googleMapsBreaker.getState(),
  };

  const allHealthy = Object.values(checks).every(c => c.status === 'ok' || c.status === 'configured');

  return c.json({
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
    pool: poolMetrics,
    circuitBreakers,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  }, allHealthy ? 200 : 503);
});

// ============================================================================
// REALTIME STREAM (Pillar A - Realtime Tracking)
// ============================================================================

// SSE endpoint for task progress updates
// SECURITY: rate-limited to 10 new connection attempts/min per user (connection-flood protection)
// Also applies the global publicIpRateLimitMiddleware (60/min per IP) to match /trpc/* protection
app.use('/realtime/stream', publicIpRateLimitMiddleware(), rateLimitMiddleware('sse'));
app.get('/realtime/stream', sseHandler);

// ============================================================================
// STATIC PAGES (Legal — Privacy Policy, Terms of Service)
// ============================================================================

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const publicDir = join(import.meta.dirname || __dirname, '..', '..', 'public');

function serveStatic(path: string, _contentType = 'text/html') {
  return (c: Context) => {
    const filePath = join(publicDir, path);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      return c.html(content);
    }
    return c.text('Not found', 404);
  };
}

// A50-3 FIX: Apply rate limiting to static legal pages. Without this guard,
// the pages were unauthenticated and unmetered, making them an easy amplification
// vector (large HTML responses, no throttle). Pattern matches /health* protection.
app.use('/privacy*', publicIpRateLimitMiddleware());
app.use('/terms*', publicIpRateLimitMiddleware());
app.use('/legal*', publicIpRateLimitMiddleware());

app.get('/privacy-policy', serveStatic('privacy-policy.html'));
app.get('/privacy', serveStatic('privacy-policy.html'));
app.get('/terms-of-service', serveStatic('terms-of-service.html'));
app.get('/terms', serveStatic('terms-of-service.html'));
app.get('/legal', serveStatic('index.html'));

// ============================================================================
// tRPC BATCH SIZE GUARD
// ============================================================================
// tRPC batches are encoded as comma-separated procedure paths in the URL, e.g.:
//   GET /trpc/task.getById,task.listOpen,user.getProfile,...
// Without a limit an attacker can craft a single HTTP request with hundreds of
// operations, bypassing per-procedure rate limits and exhausting the DB pool.
// We cap at 10 operations per request — enough for any legitimate UI use-case.
//
// POST BODY BATCHING — FALSE ALARM (URL-path check already covers it):
// tRPC v11 uses the @trpc/server fetchRequestHandler which always derives the
// procedure path(s) from url.pathname, never from the POST body.
// Source: node_modules/@trpc/server/dist/adapters/fetch/index.mjs
//   const path = trimSlashes(pathname.slice(endpoint.length));
// Source: node_modules/@trpc/server/dist/resolveResponse-BVDlNZwN.mjs
//   const isBatchCall = opts.searchParams.get("batch") === "1";
//   const paths = isBatchCall ? opts.path.split(",") : [opts.path];
// Both GET and POST batches encode all procedure names comma-separated in the
// URL path (e.g. /trpc/a,b,c?batch=1). The POST body only carries per-procedure
// input payloads indexed by position — it does NOT introduce additional
// procedures that bypass the URL. Therefore this URL-path comma-count check
// is the single correct and sufficient guard for all batch modes.

const TRPC_MAX_BATCH_SIZE = 10;

app.use('/trpc/*', async (c, next) => {
  // The tRPC path after "/trpc/" may contain comma-separated procedure names
  // (batch) or a single name (non-batch). Extract it from the raw URL.
  // NOTE: POST body batching in tRPC v11 also encodes procedures in the URL
  // path — see comment block above. This check covers all batch modes.
  const rawPath = c.req.path; // e.g. "/trpc/task.getById,user.getProfile"
  const trpcPath = rawPath.replace(/^\/trpc\//, ''); // strip leading "/trpc/"

  // Split on commas to count distinct operations in this batch request
  const operationCount = trpcPath.split(',').length;

  if (operationCount > TRPC_MAX_BATCH_SIZE) {
    return c.json(
      {
        error: 'Batch Too Large',
        message: `tRPC batch requests are limited to ${TRPC_MAX_BATCH_SIZE} operations. Received ${operationCount}.`,
        maxBatchSize: TRPC_MAX_BATCH_SIZE,
      },
      400,
    );
  }

  // A-06 FIX: Batch amplification — a batch of N operations must consume N tokens
  // from the general rate limiter, not just 1. Without this a client can batch 10
  // operations in one HTTP request and bypass per-request limits 10×.
  // We call the middleware N-1 extra times (the Hono middleware registered below
  // already fires once for this request, so we only need the additional N-1 checks).
  if (operationCount > 1) {
    const identifier = `ip:${(() => {
      // A-22: use proxy-confirmed IP (cf-connecting-ip first, then rightmost XFF).
      // Never use leftmost XFF — it is client-controlled and trivially spoofable.
      const cfIp = c.req.header('cf-connecting-ip');
      if (cfIp) return cfIp.trim();
      const xff = c.req.header('x-forwarded-for');
      if (xff) {
        const ips = xff.split(',').map((ip) => ip.trim()).filter(Boolean);
        if (ips.length > 0) return ips[ips.length - 1]; // rightmost = proxy-confirmed
      }
      return c.req.header('x-real-ip') || 'unknown';
    })()}`;
    const { checkRateLimit } = await import('./cache/redis.js');
    for (let i = 1; i < operationCount; i++) {
      const result = await checkRateLimit(identifier, 'general', 120, 60);
      if (!result.allowed) {
        c.header('Retry-After', '60');
        return c.json(
          {
            error: 'Too Many Requests',
            message: 'Rate limit exceeded (batch amplification). Try again in 60 seconds.',
            retryAfter: 60,
          },
          429,
        );
      }
    }
  }

  await next();
});

// ============================================================================
// tRPC HANDLER
// ============================================================================

app.use('/trpc/*', trpcServer({
  router: appRouter,
  createContext,
}));

// ============================================================================
// REST API WRAPPERS (Frontend Compatibility)
// ============================================================================
// These routes provide REST endpoints for the React Native frontend
// They internally call tRPC endpoints for type safety

import { firebaseAuth } from './auth/firebase.js';
import { redis } from './cache/redis.js';
import { db } from './db.js';
import type { User } from './types.js';
import { sseHandler } from './realtime/sse-handler.js';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';

// Helper to get authenticated user from Bearer token
async function getAuthUser(c: Context): Promise<User | null> {
  const authHeader = c.req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = await firebaseAuth.verifyIdToken(token, true); // checkRevoked = true
    // A51-1 FIX: Check Redis revocation marker (set by revokeUserSessions on sign-out /
    // password change). Firebase's checkRevoked=true above only catches revoked *refresh*
    // tokens; the Redis marker provides a fast-path check for our own revocation events.
    const REVOKED_KEY = (uid: string) => `auth:revoked:${uid}`;
    const revoked = await redis.get(REVOKED_KEY(decoded.uid));
    if (revoked) {
      return null;
    }
    const result = await db.query<User>(
      'SELECT id, firebase_uid, email, full_name, is_banned, account_status, default_mode, role, trust_tier, stripe_connect_id FROM users WHERE firebase_uid = $1',
      [decoded.uid]
    );
    const user = result.rows[0] || null;
    if (user && (user.is_banned || user.account_status === 'SUSPENDED' || user.account_status === 'DELETED')) {
      throw new HTTPException(403, { message: 'Account suspended' });
    }
    return user;
  } catch (err) {
    if (err instanceof HTTPException) {
      throw err;
    }
    return null;
  }
}

// Shared Zod schemas for REST param validation
const uuidParam = z.string().uuid();
const timestampBody = z.object({ timestamp: z.string().datetime().optional() }).optional();

// Animation Tracking Endpoints

app.get('/api/users/:userId/xp-celebration-status', async (c) => {
  const userId = c.req.param('userId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  const user = await getAuthUser(c);
  if (!user || user.id !== userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const result = await db.query<{ xp_first_celebration_shown_at: Date | null }>(
      `SELECT xp_first_celebration_shown_at FROM users WHERE id = $1`,
      [user.id]
    );
    const shouldShow = result.rows[0]?.xp_first_celebration_shown_at === null;
    return c.json({
      shouldShow,
      xpFirstCelebrationShownAt: result.rows[0]?.xp_first_celebration_shown_at?.toISOString() || null,
    });
  } catch (err) {
    pinoLogger.error({ err, userId: user.id }, 'Failed to fetch xp celebration status');
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post('/api/users/:userId/xp-celebration-shown', async (c) => {
  const userId = c.req.param('userId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  const user = await getAuthUser(c);
  if (!user || user.id !== userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = timestampBody.safeParse(rawBody);
  const ts = parsed.success && parsed.data?.timestamp ? new Date(parsed.data.timestamp) : null;

  try {
    const result = await db.query<{ xp_first_celebration_shown_at: Date | null }>(
      `UPDATE users
       SET xp_first_celebration_shown_at = COALESCE($2::timestamptz, NOW())
       WHERE id = $1 AND xp_first_celebration_shown_at IS NULL
       RETURNING xp_first_celebration_shown_at`,
      [user.id, ts]
    );
    return c.json({
      success: true,
      xpFirstCelebrationShownAt: result.rows[0]?.xp_first_celebration_shown_at?.toISOString() || null,
    });
  } catch (err) {
    pinoLogger.error({ err, userId: user.id }, 'Failed to mark xp celebration shown');
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/api/users/:userId/badges/:badgeId/animation-status', async (c) => {
  const userId = c.req.param('userId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  const user = await getAuthUser(c);
  if (!user || user.id !== userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const badgeId = c.req.param('badgeId');
  if (!uuidParam.safeParse(badgeId).success) {
    return c.json({ error: 'Invalid badgeId' }, 400);
  }

  try {
    const result = await db.query<{ animation_shown_at: Date | null }>(
      `SELECT animation_shown_at FROM badges WHERE id = $1 AND user_id = $2`,
      [badgeId, user.id]
    );
    if (result.rows.length === 0) {
      return c.json({ error: 'Badge not found' }, 404);
    }
    const shouldShow = result.rows[0].animation_shown_at === null;
    return c.json({
      shouldShow,
      animationShownAt: result.rows[0].animation_shown_at?.toISOString() || null,
    });
  } catch (err) {
    pinoLogger.error({ err, badgeId, userId: user.id }, 'Failed to fetch badge animation status');
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post('/api/users/:userId/badges/:badgeId/animation-shown', async (c) => {
  const userId = c.req.param('userId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  const user = await getAuthUser(c);
  if (!user || user.id !== userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const badgeId = c.req.param('badgeId');
  if (!uuidParam.safeParse(badgeId).success) {
    return c.json({ error: 'Invalid badgeId' }, 400);
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = timestampBody.safeParse(rawBody);
  const ts = parsed.success && parsed.data?.timestamp ? new Date(parsed.data.timestamp) : null;

  try {
    const result = await db.query<{ animation_shown_at: Date | null }>(
      `UPDATE badges
       SET animation_shown_at = COALESCE($3::timestamptz, NOW())
       WHERE id = $1 AND user_id = $2 AND animation_shown_at IS NULL
       RETURNING animation_shown_at`,
      [badgeId, user.id, ts]
    );
    return c.json({
      success: true,
      animationShownAt: result.rows[0]?.animation_shown_at?.toISOString() || null,
    });
  } catch (err) {
    pinoLogger.error({ err, badgeId, userId: user.id }, 'Failed to mark badge animation shown');
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// State Confirmation Endpoints

app.get('/api/tasks/:taskId/state', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const taskId = c.req.param('taskId');
  if (!uuidParam.safeParse(taskId).success) {
    return c.json({ error: 'Invalid taskId' }, 400);
  }

  try {
    const result = await db.query<{ state: string; poster_id: string; worker_id: string | null }>(
      `SELECT state, poster_id, worker_id FROM tasks WHERE id = $1`,
      [taskId]
    );
    if (result.rows.length === 0) {
      return c.json({ error: 'Task not found' }, 404);
    }
    const task = result.rows[0];
    if (task.poster_id !== user.id && task.worker_id !== user.id) {
      // Return 404 to avoid leaking existence to unauthorized callers
      return c.json({ error: 'Task not found' }, 404);
    }
    return c.json({ state: task.state });
  } catch (err) {
    pinoLogger.error({ err, taskId }, 'Failed to fetch task state');
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/api/escrows/:escrowId/state', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const escrowId = c.req.param('escrowId');
  if (!uuidParam.safeParse(escrowId).success) {
    return c.json({ error: 'Invalid escrowId' }, 400);
  }

  try {
    const result = await db.query<{ state: string; poster_id: string; worker_id: string | null }>(
      `SELECT e.state, t.poster_id, t.worker_id
       FROM escrows e
       INNER JOIN tasks t ON t.id = e.task_id
       WHERE e.id = $1`,
      [escrowId]
    );
    if (result.rows.length === 0) {
      return c.json({ error: 'Escrow not found' }, 404);
    }
    const escrow = result.rows[0];
    if (escrow.poster_id !== user.id && escrow.worker_id !== user.id) {
      // Return 404 to avoid leaking existence to unauthorized callers
      return c.json({ error: 'Escrow not found' }, 404);
    }
    return c.json({ state: escrow.state });
  } catch (err) {
    pinoLogger.error({ err, escrowId }, 'Failed to fetch escrow state');
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Violation Reporting

const violationSchema = z.object({
  type: z.string().min(1).max(100),
  rule: z.string().min(1).max(200),
  component: z.string().min(1).max(200).optional(),
  context: z.record(z.string().max(128), z.string().max(512)).superRefine((val, ctx) => {
    if (Object.keys(val).length > 10) {
      ctx.addIssue({ code: z.ZodIssueCode.too_big, maximum: 10, type: 'array', inclusive: true, message: 'context may have at most 10 keys' });
    }
  }).optional(),
  severity: z.enum(['ERROR', 'WARNING', 'INFO']).default('ERROR'),
});

app.post('/api/ui/violations', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // A-10 FIX: Only admin users may write to admin_actions. Any authenticated user
  // could previously write arbitrary rows to the admin audit log, polluting it or
  // forging admin action records. Check the admin_roles table before inserting.
  const adminRoleResult = await db.query<{ user_id: string }>(
    'SELECT user_id FROM admin_roles WHERE user_id = $1 LIMIT 1',
    [user.id]
  );
  if (adminRoleResult.rows.length === 0) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const rawBody = await c.req.json().catch(() => null);
  const parsed = violationSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', details: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;

  try {
    await db.query(
      `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, metadata)
       VALUES ($1, 'UI_VIOLATION', NULL, $2, $3)`,
      [
        user.id,
        body.rule,
        JSON.stringify({
          violationType: body.type,
          component: body.component,
          context: body.context,
          severity: body.severity,
        }),
      ]
    );
  } catch (err) {
    pinoLogger.error({ err, userId: user.id }, 'Failed to log UI violation');
    return c.json({ error: 'Failed to log violation' }, 500);
  }

  return c.json({
    success: true,
    loggedAt: new Date().toISOString(),
  });
});

// User Onboarding Status

app.get('/api/users/:userId/onboarding-status', async (c) => {
  const userId = c.req.param('userId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }
  const user = await getAuthUser(c);
  if (!user || user.id !== userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const result = await db.query<{
      onboarding_completed_at: Date | null;
      default_mode: string;
      xp_first_celebration_shown_at: Date | null;
    }>(
      `SELECT onboarding_completed_at, default_mode, xp_first_celebration_shown_at
       FROM users WHERE id = $1`,
      [user.id]
    );
    if (result.rows.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    const userData = result.rows[0];
    return c.json({
      onboardingComplete: userData.onboarding_completed_at !== null,
      role: userData.default_mode,
      xpFirstCelebrationShownAt: userData.xp_first_celebration_shown_at?.toISOString() || null,
      hasCompletedFirstTask: userData.xp_first_celebration_shown_at !== null,
    });
  } catch (err) {
    pinoLogger.error({ err, userId: user.id }, 'Failed to fetch onboarding status');
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ============================================================================
// STRIPE WEBHOOKS (Raw body needed)
// ============================================================================

/// A-06 FIX: Rate-limit all /webhooks/* routes to bound the compute cost of
// HMAC verification even though signatures are checked before DB writes.
// A47-4 FIX: Also apply publicIpRateLimitMiddleware (60/min per IP) as
// defence-in-depth, matching the protection applied to /trpc/* and /realtime/stream.
app.use('/webhooks/*', publicIpRateLimitMiddleware());
app.use('/webhooks/*', rateLimitMiddleware('general'));

app.post('/webhooks/stripe', async (c) => {
  const sig = c.req.header('stripe-signature');
  const rawBody = await c.req.text();
  
  if (!sig) {
    return c.json({ error: 'Missing stripe-signature header' }, 400);
  }
  
  // Phase D: Pure webhook ingestion (store-only, no business logic)
  const { StripeWebhookService } = await import('./services/StripeWebhookService.js');
  const result = await StripeWebhookService.processWebhook(rawBody, sig);
  
  if (!result.success) {
    // Return 400 for verification errors (malicious or misconfigured)
    if (result.error?.code === 'WEBHOOK_VERIFICATION_FAILED' ||
        result.error?.code === 'WEBHOOK_SECRET_MISSING' ||
        result.error?.code === 'STRIPE_NOT_CONFIGURED') {
      return c.json({ error: result.error.message }, 400);
    }
    // Return 500 for storage errors (retryable) — do not expose internal error details
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
  
  // Always return 200 for successful ingestion (even if duplicate/replay)
  // Stripe expects 200 to stop retrying
  return c.json({ 
    received: true, 
    eventId: result.stripeEventId,
    stored: result.stripeEventId !== undefined
  }, 200);
});

// ============================================================================
// CHECKR WEBHOOKS (Background Checks)
// ============================================================================

app.post('/webhooks/checkr', async (c) => {
  // SECURITY: Verify Checkr HMAC-SHA256 signature before processing any payload.
  // Checkr signs the raw request body using the webhook secret and sends the
  // hex digest in the X-Checkr-Signature header.
  const checkrWebhookSecret = process.env.CHECKR_WEBHOOK_SECRET;
  if (!checkrWebhookSecret) {
    pinoLogger.warn('CHECKR_WEBHOOK_SECRET is not configured — rejecting Checkr webhook');
    return c.json({ error: 'Service Unavailable', message: 'Webhook secret not configured' }, 503);
  }

  // Read raw body as text so the HMAC is computed over the exact bytes Checkr signed.
  const rawBodyText = await c.req.text().catch(() => null);
  if (rawBodyText === null) {
    return c.json({ error: 'Invalid webhook payload' }, 400);
  }

  const providedSig = c.req.header('X-Checkr-Signature');
  if (!providedSig) {
    return c.json({ error: 'Missing signature header' }, 401);
  }

  const expectedSig = createHmac('sha256', checkrWebhookSecret)
    .update(rawBodyText, 'utf8')
    .digest('hex');

  // A51-3 FIX: Use constant-time comparison with padding so that a length mismatch
  // (e.g. non-hex or truncated input) does not leak signature length via early-return
  // timing.  Both buffers are padded to the longer length before timingSafeEqual so
  // the comparison always takes the same amount of time regardless of input length.
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  const providedBuf = Buffer.from(providedSig, 'hex');
  const maxLen = Math.max(providedBuf.length, expectedBuf.length);
  const paddedProvided = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  providedBuf.copy(paddedProvided);
  expectedBuf.copy(paddedExpected);
  const valid = timingSafeEqual(paddedProvided, paddedExpected);
  if (!valid) {
    pinoLogger.warn({ sigLength: (providedSig ?? '').length }, 'Checkr webhook signature verification failed');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Parse JSON only after signature is confirmed valid.
  let rawBody: Record<string, unknown>;
  try {
    rawBody = JSON.parse(rawBodyText);
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  if (!rawBody || !rawBody.type) {
    return c.json({ error: 'Invalid webhook payload' }, 400);
  }

  const { updateBackgroundCheckStatus } = await import('./services/BackgroundCheckService.js');

  try {
    const { type, data } = rawBody as { type: string; data?: { object?: { id?: string; result?: string } } };
    const reportId = data?.object?.id;

    if (type === 'report.completed' || type === 'report.suspended' || type === 'report.disputed') {
      if (!reportId) {
        pinoLogger.warn({ type }, 'Checkr webhook missing report ID — skipping status update');
        return c.json({ received: true, processed: false, reason: 'missing report id' }, 200);
      }
      const statusMap: Record<string, 'IN_PROGRESS' | 'CLEAR' | 'CONSIDER' | 'FAILED'> = {
        'report.completed': 'CLEAR',
        'report.suspended': 'CONSIDER',
        'report.disputed': 'CONSIDER',
      };
      await updateBackgroundCheckStatus(reportId, statusMap[type] ?? 'CONSIDER', data?.object?.result);
    }

    return c.json({ received: true, processed: true }, 200);
  } catch (error) {
    pinoLogger.error({ error: error instanceof Error ? error.message : String(error) }, 'Checkr webhook processing failed');
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

// ============================================================================
// 404 HANDLER
// ============================================================================

app.notFound((_c) => {
  // Return only a static body — reflecting path/method/requestId enables log injection.
  return _c.json({ error: 'Not Found' }, 404);
});

// ============================================================================
// ERROR HANDLER
// ============================================================================

app.onError((err, c) => {
  const requestId = c.get('requestId');

  // Handle circuit breaker open errors — return 503 with Retry-After
  if (err.name === 'CircuitOpenError' && 'retryAfterMs' in err) {
    const retryAfterSec = Math.ceil((err as unknown as { retryAfterMs: number }).retryAfterMs / 1000);
    c.header('Retry-After', String(retryAfterSec));
    pinoLogger.warn({
      requestId,
      service: err.message,
      retryAfterSec,
    }, 'Circuit breaker open — service unavailable');
    return c.json({
      error: 'Service Unavailable',
      code: 'CIRCUIT_OPEN',
      requestId,
      retryAfter: retryAfterSec,
      message: 'An external service is temporarily unavailable. Please retry.',
    }, 503);
  }

  // Log full error with structured context
  pinoLogger.error({
    err,
    requestId,
    path: c.req.path,
    method: c.req.method,
  }, 'Unhandled server error');

  // Report to Sentry with request context
  Sentry.captureException(err, {
    extra: {
      requestId,
      path: c.req.path,
      method: c.req.method,
    },
  });

  // Never leak stack traces or internal details to clients
  return c.json({
    error: 'Internal Server Error',
    requestId,
    message: config.app.isDevelopment
      ? err.message
      : 'An unexpected error occurred. Please try again later.',
    ...(config.app.isDevelopment && { stack: err.stack }),
  }, 500);
});

// ============================================================================
// SERVER START
// ============================================================================

async function startServer() {
  // Fail-fast: validate required production configuration before the server does
  // any boot work (DB connect, migrations, port bind). In production
  // validateConfig() calls process.exit(1) on missing/invalid required vars; in
  // dev/test it is a no-op. Placed inside startServer() (the real boot path) — no
  // test imports this module, so plain `{ app }`-style imports never trigger it.
  validateConfig();

  const startLog = pinoLogger.child({ module: 'startup' });

  startLog.info('═══════════════════════════════════════════════════════════');
  startLog.info('  HustleXP Backend v1.0.0 — CONSTITUTIONAL AUTHORITY');
  startLog.info('═══════════════════════════════════════════════════════════');

  // Validate configuration
  const configStatus = {
    database: !!config.database.url,
    firebase: !!config.firebase.projectId,
    stripe: !!config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder'),
    redis: !!config.redis.url,
  };

  startLog.info({ configStatus }, 'Configuration check');

  // Check database connection and auto-migrate if needed
  try {
    await db.query('SELECT 1 as ping');
    startLog.info('Database connected');
  } catch (connErr) {
    startLog.error({ err: connErr }, 'Database connection failed');
  }

  // Auto-migrate if schema_versions table is missing
  try {
    await db.query('SELECT 1 FROM schema_versions LIMIT 1');
    startLog.info('Schema tables exist');
  } catch (schemaErr: unknown) {
    const schemaError = schemaErr instanceof Error ? schemaErr : null;
    const pgCode = (schemaErr as Record<string, unknown>)?.code;
    startLog.warn({ code: pgCode, message: schemaError?.message?.substring(0, 120) }, 'Schema check failed');
    if (schemaError?.message?.includes('schema_versions') || schemaError?.message?.includes('does not exist') || pgCode === '42P01') {
      startLog.warn('Tables missing — running auto-migration');
      try {
        const fs = await import('fs');
        const path = await import('path');
        const cwd = process.cwd();
        startLog.info({ cwd }, 'Searching for schema file');
        const candidates = [
          path.join(cwd, 'backend/database/constitutional-schema.sql'),
          path.join(cwd, 'backend', 'database', 'constitutional-schema.sql'),
          '/app/backend/database/constitutional-schema.sql',
          path.join(cwd, '../backend/database/constitutional-schema.sql'),
        ];
        let schemaSQL = '';
        let foundPath = '';
        for (const p of candidates) {
          try {
            schemaSQL = fs.readFileSync(p, 'utf-8');
            foundPath = p;
            startLog.info({ path: p, chars: schemaSQL.length }, 'Found schema file');
            break;
          } catch (readErr: unknown) {
            startLog.debug({ path: p, code: (readErr as Record<string, unknown>)?.code }, 'Schema not at path');
          }
        }
        if (!schemaSQL) {
          startLog.error('Could not find constitutional-schema.sql in any candidate path');
          try {
            const dirContents = fs.readdirSync(cwd);
            startLog.debug({ contents: dirContents.slice(0, 20) }, 'CWD directory listing');
          } catch { /* ignore */ }
        } else {
          startLog.info({ chars: schemaSQL.length, path: foundPath }, 'Executing schema SQL');
          const pool = db.getPool();
          const client = await pool.connect();
          try {
            await client.query(schemaSQL);
            startLog.info('Auto-migration complete');
          } finally {
            client.release();
          }
        }
      } catch (migErr: unknown) {
        const migError = migErr as Record<string, unknown>;
        startLog.error({ err: migErr, position: migError?.position, detail: migError?.detail }, 'Auto-migration failed');
      }
    } else {
      startLog.error({ err: schemaErr }, 'Unexpected schema error');
    }
  }

  // Ensure firebase_uid and bio columns exist (safe for existing databases)
  try {
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT UNIQUE`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid)`);
    startLog.info('firebase_uid + bio columns ensured');
  } catch (colErr: unknown) {
    startLog.warn({ message: colErr instanceof Error ? colErr.message.substring(0, 120) : String(colErr) }, 'Column migration note');
  }

  // Run inline migration v2: Create all missing tables required by routers/services
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const migName = 'add_missing_tables_v2';
    const already = await db.query('SELECT 1 FROM applied_migrations WHERE name = $1', [migName]);
    if (already.rows.length > 0) {
      startLog.debug({ migration: migName }, 'Migration already applied');
    } else {
      startLog.info({ migration: migName }, 'Running table creation migration');
      const pool = db.getPool();
      const client = await pool.connect();
      try {
        // All tables are idempotent (CREATE IF NOT EXISTS)
        await client.query(`
          CREATE TABLE IF NOT EXISTS user_xp_tax_status (
            user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            total_unpaid_tax_cents INTEGER NOT NULL DEFAULT 0,
            total_xp_held_back INTEGER NOT NULL DEFAULT 0,
            offline_payments_blocked BOOLEAN NOT NULL DEFAULT FALSE,
            last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS xp_tax_ledger (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            task_id UUID NOT NULL,
            gross_payout_cents INTEGER NOT NULL,
            tax_percentage NUMERIC(5,2) NOT NULL DEFAULT 10.0,
            tax_amount_cents INTEGER NOT NULL,
            net_payout_cents INTEGER NOT NULL,
            payment_method TEXT NOT NULL CHECK (payment_method IN ('escrow','offline_cash','offline_venmo','offline_cashapp')),
            tax_paid BOOLEAN NOT NULL DEFAULT FALSE,
            tax_paid_at TIMESTAMPTZ,
            xp_held_back BOOLEAN NOT NULL DEFAULT FALSE,
            xp_released BOOLEAN NOT NULL DEFAULT FALSE,
            xp_released_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (task_id, user_id)
          );
          CREATE INDEX IF NOT EXISTS idx_xp_tax_ledger_user_id ON xp_tax_ledger(user_id);
          CREATE INDEX IF NOT EXISTS idx_xp_tax_ledger_unpaid ON xp_tax_ledger(user_id) WHERE tax_paid = FALSE;
          CREATE TABLE IF NOT EXISTS self_insurance_pool (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            total_deposits_cents INTEGER NOT NULL DEFAULT 0,
            total_claims_cents INTEGER NOT NULL DEFAULT 0,
            available_balance_cents INTEGER GENERATED ALWAYS AS (total_deposits_cents - total_claims_cents) STORED,
            coverage_percentage NUMERIC(5,2) NOT NULL DEFAULT 80.0,
            max_claim_cents INTEGER NOT NULL DEFAULT 500000,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          INSERT INTO self_insurance_pool (id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM self_insurance_pool);
          CREATE TABLE IF NOT EXISTS insurance_contributions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            task_id UUID NOT NULL,
            hustler_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            contribution_cents INTEGER NOT NULL,
            contribution_percentage NUMERIC(5,2) NOT NULL DEFAULT 2.0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (task_id, hustler_id)
          );
          CREATE TABLE IF NOT EXISTS insurance_claims (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            task_id UUID NOT NULL,
            hustler_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            claim_amount_cents INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','paid')),
            claim_reason TEXT NOT NULL,
            evidence_urls TEXT[] NOT NULL DEFAULT '{}',
            reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
            reviewed_at TIMESTAMPTZ,
            review_notes TEXT,
            paid_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS skill_categories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            icon_name TEXT NOT NULL DEFAULT 'default',
            sort_order INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS skills (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            category_id UUID NOT NULL REFERENCES skill_categories(id) ON DELETE CASCADE,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            description TEXT,
            icon_name TEXT,
            gate_type TEXT NOT NULL DEFAULT 'soft' CHECK (gate_type IN ('soft','hard')),
            min_trust_tier INTEGER NOT NULL DEFAULT 1,
            requires_license BOOLEAN NOT NULL DEFAULT FALSE,
            requires_background_check BOOLEAN NOT NULL DEFAULT FALSE,
            risk_level TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW','MEDIUM','HIGH','IN_HOME')),
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS worker_skills (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
            verified BOOLEAN NOT NULL DEFAULT FALSE,
            verified_at TIMESTAMPTZ,
            license_url TEXT,
            license_expiry TIMESTAMPTZ,
            tasks_completed INTEGER NOT NULL DEFAULT 0,
            avg_rating NUMERIC(3,2),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, skill_id)
          );
          CREATE TABLE IF NOT EXISTS processed_stripe_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id TEXT NOT NULL UNIQUE,
            event_type TEXT NOT NULL,
            object_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS device_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            fcm_token TEXT NOT NULL,
            device_type TEXT NOT NULL DEFAULT 'ios' CHECK (device_type IN ('ios','android')),
            device_name TEXT,
            app_version TEXT,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, fcm_token)
          );
          CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active ON device_tokens(user_id) WHERE is_active = TRUE;
          CREATE TABLE IF NOT EXISTS alpha_telemetry (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_group TEXT NOT NULL,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('hustler','poster')),
            state TEXT, trust_tier INTEGER, location_radius_miles NUMERIC,
            instant_mode_enabled BOOLEAN, time_on_screen_ms INTEGER, exit_type TEXT,
            task_id UUID, trigger_state TEXT, time_since_completion_seconds INTEGER,
            reason_selected TEXT, submitted BOOLEAN, rejected_by_guard BOOLEAN, cooldown_hit BOOLEAN,
            attempt_number INTEGER, proof_type TEXT, gps_verified BOOLEAN,
            verification_result TEXT, failure_reason TEXT, resolved BOOLEAN,
            xp_released BOOLEAN, escrow_released BOOLEAN,
            delta_type TEXT, delta_amount NUMERIC, reason_code TEXT,
            metadata JSONB NOT NULL DEFAULT '{}',
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_event_group ON alpha_telemetry(event_group);
          CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_user ON alpha_telemetry(user_id);
          CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_timestamp ON alpha_telemetry(timestamp);
          CREATE TABLE IF NOT EXISTS ai_agent_decisions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            agent_type TEXT NOT NULL CHECK (agent_type IN ('scoper','logistics','dispute','reputation')),
            task_id UUID, proof_id UUID,
            proposal JSONB NOT NULL DEFAULT '{}',
            confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0.0,
            reasoning TEXT, accepted BOOLEAN,
            validator_override BOOLEAN DEFAULT FALSE, validator_reason TEXT,
            authority_level TEXT NOT NULL DEFAULT 'A2',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS dispute_jury_votes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            dispute_id UUID NOT NULL,
            juror_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            vote TEXT NOT NULL CHECK (vote IN ('worker_complete','worker_incomplete','inconclusive')),
            confidence NUMERIC(4,3) NOT NULL DEFAULT 0.0,
            xp_reward INTEGER NOT NULL DEFAULT 5,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (dispute_id, juror_id)
          );
          CREATE TABLE IF NOT EXISTS plan_entitlements (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            task_id UUID,
            risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','IN_HOME')),
            source_event_id TEXT NOT NULL UNIQUE,
            source_payment_intent TEXT,
            expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS task_geofence_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('ENTER','EXIT','DWELL')),
            location_lat DECIMAL(10,8) NOT NULL,
            location_lng DECIMAL(11,8) NOT NULL,
            distance_meters NUMERIC NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          ALTER TABLE users ADD COLUMN IF NOT EXISTS price_modifier_percent NUMERIC DEFAULT 0;
        `);
        await client.query('INSERT INTO applied_migrations (name) VALUES ($1)', [migName]);
        startLog.info({ migration: migName, tables: 16 }, 'Migration complete — 16 tables created');
      } finally {
        client.release();
      }
    }
  } catch (migRunErr: unknown) {
    startLog.error({ err: migRunErr, position: (migRunErr as Record<string, unknown>)?.position }, 'Migration error');
  }

  // Performance indexes migration (007)
  try {
    const idxMig = 'performance_indexes_v1';
    const idxAlready = await db.query('SELECT 1 FROM applied_migrations WHERE name = $1', [idxMig]);
    if (idxAlready.rows.length > 0) {
      startLog.debug({ migration: idxMig }, 'Migration already applied');
    } else {
      startLog.info({ migration: idxMig }, 'Running performance indexes migration');
      await db.query(`
        -- Task feed compound indexes
        CREATE INDEX IF NOT EXISTS idx_matching_scores_hustler_feed
          ON task_matching_scores(hustler_id, expires_at DESC, relevance_score DESC);
        CREATE INDEX IF NOT EXISTS idx_matching_scores_hustler_distance
          ON task_matching_scores(hustler_id, expires_at DESC, distance_miles ASC);
        CREATE INDEX IF NOT EXISTS idx_tasks_state_category
          ON tasks(state, category, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tasks_state_price
          ON tasks(state, price DESC, created_at DESC);
        -- Escrow lookups
        CREATE INDEX IF NOT EXISTS idx_escrows_task_state
          ON escrows(task_id, state);
        -- Messaging
        CREATE INDEX IF NOT EXISTS idx_task_messages_task_created
          ON task_messages(task_id, created_at DESC);
        -- XP ledger
        CREATE INDEX IF NOT EXISTS idx_xp_ledger_user_created
          ON xp_ledger(user_id, created_at DESC);
        -- Ratings
        CREATE INDEX IF NOT EXISTS idx_task_ratings_ratee
          ON task_ratings(ratee_id);
        -- Notifications
        CREATE INDEX IF NOT EXISTS idx_notifications_user_created
          ON notifications(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
          ON notifications(user_id, is_read) WHERE is_read = false;
        -- Outbox poller
        CREATE INDEX IF NOT EXISTS idx_outbox_events_unprocessed
          ON outbox_events(processed_at, created_at ASC) WHERE processed_at IS NULL;
        -- Proofs
        CREATE INDEX IF NOT EXISTS idx_proofs_task_state
          ON proofs(task_id, state);
      `);
      await db.query('INSERT INTO applied_migrations (name) VALUES ($1)', [idxMig]);
      startLog.info({ migration: idxMig, indexes: 12 }, 'Performance indexes created');
    }
  } catch (idxErr: unknown) {
    startLog.warn({ err: idxErr }, 'Performance indexes migration warning');
  }

  // Report schema version
  try {
    const result = await db.query<{ version: string; applied_at: string }>('SELECT version, applied_at FROM schema_versions ORDER BY applied_at DESC LIMIT 1');
    if (result.rows.length > 0) {
      startLog.info({ schemaVersion: result.rows[0].version, appliedAt: result.rows[0].applied_at }, 'Schema version loaded');
    } else {
      startLog.warn('No schema version found');
    }

    // Verify critical triggers exist
    const triggers = await db.query(`
      SELECT trigger_name FROM information_schema.triggers
      WHERE trigger_schema = 'public'
      AND trigger_name IN (
        'xp_requires_released_escrow',
        'escrow_released_requires_completed_task',
        'task_completed_requires_accepted_proof',
        'task_terminal_guard',
        'escrow_terminal_guard'
      )
    `);
    startLog.info({ triggersActive: triggers.rows.length, expected: 5 }, 'Invariant triggers check');
  } catch (error) {
    startLog.error({ err: error }, 'Schema version check failed');
  }

  startLog.info({
    environment: config.app.env,
    port: config.app.port,
    endpoints: {
      health: ['/health', '/health/detailed', '/health/readiness', '/health/liveness'],
      trpc: '/trpc/*',
      webhooks: ['/webhooks/stripe', '/webhooks/checkr'],
      rest: [
        '/api/users/:userId/xp-celebration-status',
        '/api/users/:userId/xp-celebration-shown',
        '/api/users/:userId/badges/:badgeId/animation-status',
        '/api/users/:userId/badges/:badgeId/animation-shown',
        '/api/tasks/:taskId/state',
        '/api/escrows/:escrowId/state',
        '/api/ui/violations',
        '/api/users/:userId/onboarding-status',
      ],
    },
  }, `HustleXP server listening on http://localhost:${config.app.port}`);
}

// Start server
startServer().catch((err) => pinoLogger.fatal({ err }, 'Failed to start server'));

// For Bun/Edge deployment
export default {
  port: config.app.port,
  fetch: app.fetch,
};

// For Node.js deployment
import { serve } from '@hono/node-server';
const server = serve({
  fetch: app.fetch,
  port: config.app.port,
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let shutdownInProgress = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) {
    pinoLogger.warn('Shutdown already in progress, forcing exit...');
    process.exit(1);
  }

  shutdownInProgress = true;
  pinoLogger.info({ signal }, `Received ${signal}, shutting down gracefully...`);

  // 1. Stop accepting new connections
  server.close((err) => {
    if (err) {
      pinoLogger.error({ err }, 'Error closing HTTP server');
    } else {
      pinoLogger.info('HTTP server closed — no new connections');
    }
  });

  // 2. Allow in-flight requests to complete (10s grace period)
  const drainTimeout = setTimeout(() => {
    pinoLogger.warn('Drain timeout reached (10s), forcing shutdown...');
  }, 10000);

  // 3. Close database pool
  try {
    await db.close();
    pinoLogger.info('Database pool closed');
  } catch (err) {
    pinoLogger.error({ err }, 'Error closing database pool');
  }

  clearTimeout(drainTimeout);
  pinoLogger.info('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Catch unhandled rejections in production
process.on('unhandledRejection', (reason) => {
  pinoLogger.error({ reason }, 'Unhandled promise rejection');
  Sentry.captureException(reason);
});

process.on('uncaughtException', (error) => {
  pinoLogger.fatal({ err: error }, 'Uncaught exception — shutting down');
  Sentry.captureException(error);
  // Give Sentry time to flush, then exit
  setTimeout(() => process.exit(1), 2000);
});

export { app };
