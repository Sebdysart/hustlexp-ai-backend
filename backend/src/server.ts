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

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './routers';
import { createContext } from './trpc';
import { config } from './config';
import { db } from './db';
import { securityHeaders, rateLimitMiddleware } from './middleware/security';

// ============================================================================
// APP INITIALIZATION
// ============================================================================

const app = new Hono();

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Security headers (X-Frame-Options, X-Content-Type-Options, etc.)
app.use('*', securityHeaders);

// Logging
app.use('*', logger());

// CORS — restrict origins in production
app.use('*', cors({
  origin: config.app.isDevelopment
    ? '*'
    : (config.app.allowedOrigins.length > 0
        ? config.app.allowedOrigins
        : ['https://app.hustlexp.com']),
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400, // Cache preflight for 24h
}));

// Rate limiting per route category
app.use('/trpc/ai.*', rateLimitMiddleware('ai'));
app.use('/trpc/escrow.*', rateLimitMiddleware('escrow'));
app.use('/trpc/task.*', rateLimitMiddleware('task'));
app.use('/api/*', rateLimitMiddleware('general'));

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
  
  const allHealthy = Object.values(checks).every(c => c.status === 'ok' || c.status === 'configured');
  
  return c.json({
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  }, allHealthy ? 200 : 503);
});

// ============================================================================
// REALTIME STREAM (Pillar A - Realtime Tracking)
// ============================================================================

// SSE endpoint for task progress updates
app.get('/realtime/stream', sseHandler);

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
import { sseHandler } from './realtime/sse-handler';

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

// Animation Tracking Endpoints

app.get('/api/users/:userId/xp-celebration-status', async (c) => {
  const user = await getAuthUser(c);
  if (!user || user.id !== c.req.param('userId')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const result = await db.query<{ xp_first_celebration_shown_at: Date | null }>(
    `SELECT xp_first_celebration_shown_at FROM users WHERE id = $1`,
    [user.id]
  );
  
  const shouldShow = result.rows[0]?.xp_first_celebration_shown_at === null;
  
  return c.json({
    shouldShow,
    xpFirstCelebrationShownAt: result.rows[0]?.xp_first_celebration_shown_at?.toISOString() || null,
  });
});

app.post('/api/users/:userId/xp-celebration-shown', async (c) => {
  const user = await getAuthUser(c);
  if (!user || user.id !== c.req.param('userId')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const body = await c.req.json().catch(() => ({}));
  
  const result = await db.query(
    `UPDATE users 
     SET xp_first_celebration_shown_at = COALESCE($2::timestamptz, NOW())
     WHERE id = $1 AND xp_first_celebration_shown_at IS NULL
     RETURNING xp_first_celebration_shown_at`,
    [user.id, body.timestamp ? new Date(body.timestamp) : null]
  );
  
  return c.json({
    success: true,
    xpFirstCelebrationShownAt: result.rows[0]?.xp_first_celebration_shown_at?.toISOString() || null,
  });
});

app.get('/api/users/:userId/badges/:badgeId/animation-status', async (c) => {
  const user = await getAuthUser(c);
  if (!user || user.id !== c.req.param('userId')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const badgeId = c.req.param('badgeId');
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
});

app.post('/api/users/:userId/badges/:badgeId/animation-shown', async (c) => {
  const user = await getAuthUser(c);
  if (!user || user.id !== c.req.param('userId')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const badgeId = c.req.param('badgeId');
  const body = await c.req.json().catch(() => ({}));
  
  const result = await db.query(
    `UPDATE badges 
     SET animation_shown_at = COALESCE($3::timestamptz, NOW())
     WHERE id = $1 AND user_id = $2 AND animation_shown_at IS NULL
     RETURNING animation_shown_at`,
    [badgeId, user.id, body.timestamp ? new Date(body.timestamp) : null]
  );
  
  return c.json({
    success: true,
    animationShownAt: result.rows[0]?.animation_shown_at?.toISOString() || null,
  });
});

// State Confirmation Endpoints

app.get('/api/tasks/:taskId/state', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const taskId = c.req.param('taskId');
  const result = await db.query<{ state: string }>(
    `SELECT state FROM tasks WHERE id = $1`,
    [taskId]
  );
  
  if (result.rows.length === 0) {
    return c.json({ error: 'Task not found' }, 404);
  }
  
  return c.json({ state: result.rows[0].state });
});

app.get('/api/escrows/:escrowId/state', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const escrowId = c.req.param('escrowId');
  const result = await db.query<{ state: string }>(
    `SELECT state FROM escrows WHERE id = $1`,
    [escrowId]
  );
  
  if (result.rows.length === 0) {
    return c.json({ error: 'Escrow not found' }, 404);
  }
  
  return c.json({ state: result.rows[0].state });
});

// Violation Reporting

app.post('/api/ui/violations', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const body = await c.req.json();
  
  await db.query(
    `INSERT INTO admin_actions (admin_user_id, action_type, details, created_at)
     VALUES ($1, 'UI_VIOLATION', $2, NOW())`,
    [
      user.id,
      JSON.stringify({
        violationType: body.type,
        rule: body.rule,
        component: body.component,
        context: body.context,
        severity: body.severity || 'ERROR',
      }),
    ]
  );
  
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
    if (result.error.code === 'WEBHOOK_VERIFICATION_FAILED' || 
        result.error.code === 'WEBHOOK_SECRET_MISSING' ||
        result.error.code === 'STRIPE_NOT_CONFIGURED') {
      return c.json({ error: result.error.message }, 400);
    }
    // Return 500 for storage errors (retryable)
    return c.json({ error: result.error.message }, 500);
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
  }, 404);
});

// ============================================================================
// ERROR HANDLER
// ============================================================================

app.onError((err, c) => {
  // Log full error internally
  console.error('[Server Error]', {
    message: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
  });

  // Never leak stack traces or internal details to clients
  return c.json({
    error: 'Internal Server Error',
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
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  HustleXP Backend v1.0.0');
  console.log('  CONSTITUTIONAL AUTHORITY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  
  // Validate configuration
  const configStatus = {
    database: !!config.database.url,
    firebase: !!config.firebase.projectId,
    stripe: !!config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder'),
    redis: !!config.redis.url,
  };
  
  console.log('Configuration:');
  console.log(`  Database:  ${configStatus.database ? '✅' : '❌'} ${configStatus.database ? 'Connected' : 'Missing DATABASE_URL'}`);
  console.log(`  Firebase:  ${configStatus.firebase ? '✅' : '⚠️'} ${configStatus.firebase ? 'Configured' : 'Missing'}`);
  console.log(`  Stripe:    ${configStatus.stripe ? '✅' : '⚠️'} ${configStatus.stripe ? 'Configured' : 'Placeholder'}`);
  console.log(`  Redis:     ${configStatus.redis ? '✅' : '⚠️'} ${configStatus.redis ? 'Configured' : 'Missing'}`);
  console.log('');
  
  // Check database connection and auto-migrate if needed
  try {
    // Test basic connectivity first
    await db.query('SELECT 1 as ping');
    console.log('Database:    ✅ Connected');

    // Check if schema exists
    const tableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'schema_versions'
      ) as exists
    `);

    if (!tableCheck.rows[0]?.exists) {
      console.log('Schema:      ⚠️  No tables found — running auto-migration...');
      try {
        const { readFileSync } = await import('fs');
        const { join, dirname } = await import('path');
        const { fileURLToPath } = await import('url');
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const schemaPath = join(__dirname, '../../backend/database/constitutional-schema.sql');
        const schemaSQL = readFileSync(schemaPath, 'utf-8');
        await db.query(schemaSQL);
        console.log('Schema:      ✅ Auto-migration complete');
      } catch (migErr) {
        console.error('Schema:      ❌ Auto-migration failed:', migErr instanceof Error ? migErr.message : 'Unknown');
      }
    }

    // Now check schema version
    const result = await db.query('SELECT version, applied_at FROM schema_versions ORDER BY applied_at DESC LIMIT 1');
    if (result.rows.length > 0) {
      console.log(`Schema:      ✅ v${result.rows[0].version} (applied ${new Date(result.rows[0].applied_at).toISOString()})`);
    } else {
      console.log('Schema:      ⚠️ No version found');
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
    console.log(`Triggers:    ✅ ${triggers.rows.length}/5 invariant triggers active`);
  } catch (error) {
    console.error('Database:    ❌ Connection failed:', error instanceof Error ? error.message : 'Unknown');
  }
  
  console.log('');
  console.log(`Environment: ${config.app.env}`);
  console.log(`Port:        ${config.app.port}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health                              - Basic health check');
  console.log('  GET  /health/detailed                     - Detailed health check');
  console.log('  POST /trpc/*                              - tRPC API endpoints');
  console.log('  POST /webhooks/stripe                     - Stripe webhooks');
  console.log('');
  console.log('REST API (Frontend Integration):');
  console.log('  GET  /api/users/:userId/xp-celebration-status      - Animation tracking');
  console.log('  POST /api/users/:userId/xp-celebration-shown       - Animation tracking');
  console.log('  GET  /api/users/:userId/badges/:badgeId/animation-status - Animation tracking');
  console.log('  POST /api/users/:userId/badges/:badgeId/animation-shown   - Animation tracking');
  console.log('  GET  /api/tasks/:taskId/state                       - State confirmation');
  console.log('  GET  /api/escrows/:escrowId/state                   - State confirmation');
  console.log('  POST /api/ui/violations                             - Violation reporting');
  console.log('  GET  /api/users/:userId/onboarding-status           - Onboarding status');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Server listening on http://localhost:${config.app.port}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

// Start server
startServer().catch(console.error);

// For Bun/Edge deployment
export default {
  port: config.app.port,
  fetch: app.fetch,
};

// For Node.js deployment
import { serve } from '@hono/node-server';
serve({
  fetch: app.fetch,
  port: config.app.port,
});

export { app };
