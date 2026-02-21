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
import { Sentry } from './sentry';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './routers';
import { createContext } from './trpc';
import { config } from './config';
import { securityHeaders, rateLimitMiddleware } from './middleware/security';
import { requestIdMiddleware, serverTimingMiddleware } from './middleware/request-id';
import { httpMetricsMiddleware } from './monitoring/http-metrics';
import { createMetricsEndpoint } from './monitoring/metrics';

// Hono context variable type augmentation
type AppVariables = {
  requestId: string;
};
import { compress } from 'hono/compress';
import { bodyLimit } from 'hono/body-limit';
import { logger as pinoLogger } from './logger';

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
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
  }, `${c.req.method} ${c.req.path} → ${status} (${duration}ms)`);
});

// CORS — explicit origins only (no wildcard with credentials)
const allowedOrigins = config.app.isDevelopment
  ? ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8081']
  : (config.app.allowedOrigins.length > 0
      ? config.app.allowedOrigins
      : ['https://app.hustlexp.com', 'https://www.hustlexp.com']);

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

// Rate limiting per route category
app.use('/trpc/ai.*', rateLimitMiddleware('ai'));
app.use('/trpc/escrow.*', rateLimitMiddleware('escrow'));
app.use('/trpc/task.*', rateLimitMiddleware('task'));
app.use('/api/*', rateLimitMiddleware('general'));

// ============================================================================
// PROMETHEUS METRICS ENDPOINT
// ============================================================================

createMetricsEndpoint(app);

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', async (c) => {
  try {
    // Check database
    const dbResult = await db.query('SELECT version FROM schema_versions ORDER BY applied_at DESC LIMIT 1');
    const schemaVersion = dbResult.rows[0]?.version || 'unknown';
    
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      schema: schemaVersion,
      environment: config.app.env,
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 503);
  }
});

// Readiness probe — for Kubernetes/Railway to determine if app can accept traffic
// Returns 200 only if database is reachable (critical dependency)
app.get('/health/readiness', async (c) => {
  try {
    const start = Date.now();
    await db.query('SELECT 1');
    return c.json({
      ready: true,
      dbLatencyMs: Date.now() - start,
    });
  } catch {
    return c.json({ ready: false }, 503);
  }
});

// Liveness probe — lightweight "am I alive?" check (no DB)
app.get('/health/liveness', (c) => {
  return c.json({ alive: true, uptime: process.uptime() });
});

// Detailed health for monitoring
app.get('/health/detailed', async (c) => {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
  
  // Database check
  const dbStart = Date.now();
  try {
    const result = await db.query('SELECT 1 as ping');
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
  } = await import('./middleware/circuit-breaker');
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
app.get('/realtime/stream', sseHandler);

// ============================================================================
// STATIC PAGES (Legal — Privacy Policy, Terms of Service)
// ============================================================================

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const publicDir = join(import.meta.dirname || __dirname, '..', '..', 'public');

function serveStatic(path: string, contentType = 'text/html') {
  return (c: any) => {
    const filePath = join(publicDir, path);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      return c.html(content);
    }
    return c.text('Not found', 404);
  };
}

app.get('/privacy-policy', serveStatic('privacy-policy.html'));
app.get('/privacy', serveStatic('privacy-policy.html'));
app.get('/terms-of-service', serveStatic('terms-of-service.html'));
app.get('/terms', serveStatic('terms-of-service.html'));
app.get('/legal', serveStatic('index.html'));

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

import { firebaseAuth } from './auth/firebase';
import { db } from './db';
import type { User } from './types';
import type { WebhookResult } from './services/StripeWebhookService';
import { sseHandler } from './realtime/sse-handler';
import { z } from 'zod';

// Helper to get authenticated user from Bearer token
async function getAuthUser(c: any): Promise<User | null> {
  const authHeader = c.req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  
  const token = authHeader.slice(7);
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    const result = await db.query<User>(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [decoded.uid]
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

// Shared Zod schemas for REST param validation
const uuidParam = z.string().uuid();
const timestampBody = z.object({ timestamp: z.string().datetime().optional() }).optional();

// Animation Tracking Endpoints

app.get('/api/users/:userId/xp-celebration-status', async (c) => {
  const user = await getAuthUser(c);
  if (!user || user.id !== c.req.param('userId')) {
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
  const user = await getAuthUser(c);
  if (!user || user.id !== c.req.param('userId')) {
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
  const user = await getAuthUser(c);
  if (!user || user.id !== c.req.param('userId')) {
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
  const user = await getAuthUser(c);
  if (!user || user.id !== c.req.param('userId')) {
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
    const result = await db.query<{ state: string }>(
      `SELECT state FROM tasks WHERE id = $1`,
      [taskId]
    );
    if (result.rows.length === 0) {
      return c.json({ error: 'Task not found' }, 404);
    }
    return c.json({ state: result.rows[0].state });
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
    const result = await db.query<{ state: string }>(
      `SELECT state FROM escrows WHERE id = $1`,
      [escrowId]
    );
    if (result.rows.length === 0) {
      return c.json({ error: 'Escrow not found' }, 404);
    }
    return c.json({ state: result.rows[0].state });
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
  context: z.record(z.unknown()).optional(),
  severity: z.enum(['ERROR', 'WARNING', 'INFO']).default('ERROR'),
});

app.post('/api/ui/violations', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const rawBody = await c.req.json().catch(() => null);
  const parsed = violationSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', details: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;

  try {
    await db.query(
      `INSERT INTO admin_actions (admin_user_id, admin_role, action_type, action_details, result)
       VALUES ($1, 'user', 'UI_VIOLATION', $2, 'logged')`,
      [
        user.id,
        JSON.stringify({
          violationType: body.type,
          rule: body.rule,
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
  const user = await getAuthUser(c);
  if (!user || user.id !== c.req.param('userId')) {
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

app.post('/webhooks/stripe', async (c) => {
  const sig = c.req.header('stripe-signature');
  const rawBody = await c.req.text();
  
  if (!sig) {
    return c.json({ error: 'Missing stripe-signature header' }, 400);
  }
  
  // Phase D: Pure webhook ingestion (store-only, no business logic)
  const { StripeWebhookService } = await import('./services/StripeWebhookService');
  const result = await StripeWebhookService.processWebhook(rawBody, sig);
  
  if (!result.success) {
    // Return 400 for verification errors (malicious or misconfigured)
    if (result.error?.code === 'WEBHOOK_VERIFICATION_FAILED' ||
        result.error?.code === 'WEBHOOK_SECRET_MISSING' ||
        result.error?.code === 'STRIPE_NOT_CONFIGURED') {
      return c.json({ error: result.error.message }, 400);
    }
    // Return 500 for storage errors (retryable)
    return c.json({ error: result.error?.message ?? 'Unknown webhook error' }, 500);
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
// 404 HANDLER
// ============================================================================

app.notFound((c) => {
  return c.json({
    error: 'Not Found',
    path: c.req.path,
    method: c.req.method,
    requestId: c.get('requestId'),
  }, 404);
});

// ============================================================================
// ERROR HANDLER
// ============================================================================

app.onError((err, c) => {
  const requestId = c.get('requestId');

  // Handle circuit breaker open errors — return 503 with Retry-After
  if (err.name === 'CircuitOpenError' && 'retryAfterMs' in err) {
    const retryAfterSec = Math.ceil((err as any).retryAfterMs / 1000);
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
  } catch (schemaErr: any) {
    startLog.warn({ code: schemaErr?.code, message: schemaErr?.message?.substring(0, 120) }, 'Schema check failed');
    if (schemaErr?.message?.includes('schema_versions') || schemaErr?.message?.includes('does not exist') || schemaErr?.code === '42P01') {
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
          } catch (readErr: any) {
            startLog.debug({ path: p, code: readErr?.code }, 'Schema not at path');
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
      } catch (migErr: any) {
        startLog.error({ err: migErr, position: migErr?.position, detail: migErr?.detail }, 'Auto-migration failed');
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
  } catch (colErr: any) {
    startLog.warn({ message: colErr?.message?.substring(0, 120) }, 'Column migration note');
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
  } catch (migRunErr: any) {
    startLog.error({ err: migRunErr, position: migRunErr?.position }, 'Migration error');
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
  } catch (idxErr: any) {
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
      webhooks: '/webhooks/stripe',
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
