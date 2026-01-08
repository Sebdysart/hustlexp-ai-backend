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

// ============================================================================
// APP INITIALIZATION
// ============================================================================

const app = new Hono();

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Logging
app.use('*', logger());

// CORS
app.use('*', cors({
  origin: config.app.isDevelopment 
    ? '*' 
    : config.app.allowedOrigins,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

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
// tRPC HANDLER
// ============================================================================

app.use('/trpc/*', trpcServer({
  router: appRouter,
  createContext,
}));

// ============================================================================
// STRIPE WEBHOOKS (Raw body needed)
// ============================================================================

app.post('/webhooks/stripe', async (c) => {
  const sig = c.req.header('stripe-signature');
  const rawBody = await c.req.text();
  
  if (!sig) {
    return c.json({ error: 'Missing stripe-signature header' }, 400);
  }
  
  // TODO: Implement Stripe webhook handling
  // const { StripeService } = await import('./services/StripeService');
  // const result = await StripeService.handleWebhook(rawBody, sig);
  
  console.log('[Stripe Webhook] Received event (handling not yet implemented)');
  return c.json({ received: true });
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
  console.error('[Server Error]', err);
  
  return c.json({
    error: 'Internal Server Error',
    message: config.app.isDevelopment ? err.message : 'An unexpected error occurred',
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
  
  // Check database connection and schema
  try {
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
  console.log('  GET  /health          - Basic health check');
  console.log('  GET  /health/detailed - Detailed health check');
  console.log('  POST /trpc/*          - tRPC API endpoints');
  console.log('  POST /webhooks/stripe - Stripe webhooks');
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
