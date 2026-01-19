/**
 * HustleXP Unified Server v2.0.0
 * 
 * CONSTITUTIONAL: Combines infrastructure from ai-backend with
 * spec-compliant services from HustleXP-DOCS
 * 
 * Authority Hierarchy (ARCHITECTURE.md §1):
 * - Layer 0: PostgreSQL (triggers enforce invariants)
 * - Layer 1: Services (state machine transitions)
 * - Layer 2: API (tRPC endpoints)
 * - Layer 3: AI (A0-A3 authority model)
 * 
 * @see schema.sql v1.0.0
 * @see PRODUCT_SPEC.md v4.2
 */

import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';

// Constitutional imports (from src/)
import { appRouter as constitutionalRouter } from './src/routers';
import { createContext } from './src/trpc';
import { db, checkHealth } from './src/db';

// Infrastructure imports (existing)
import { authenticateRequest } from './auth/middleware';
import { config } from './src/config';

// ============================================================================
// APP INITIALIZATION
// ============================================================================

const app = new Hono();

const allowedOrigins = config.app.allowedOrigins.length
  ? config.app.allowedOrigins
  : ['*'];

// CORS
app.use('*', cors({
  origin: allowedOrigins.length === 1 && allowedOrigins[0] === '*' ? '*' : allowedOrigins,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// ============================================================================
// tRPC - Constitutional Routes
// ============================================================================

app.use(
  '/api/trpc/*',
  trpcServer({
    router: constitutionalRouter,
    createContext,
  })
);

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/', (c) => {
  return c.json({ 
    status: 'ok', 
    message: 'HustleXP API v2.0.0 - Constitutional Edition',
    schema: '1.0.0',
  });
});

app.get('/api/health', async (c) => {
  const health = await checkHealth();
  
  const services = {
    database: health.database,
    schema_version: health.schemaVersion,
    triggers: health.triggers,
    firebase: !!config.firebase.projectId,
    redis: !!config.redis.url,
    stripe: !!config.stripe.secretKey && config.stripe.secretKey !== 'sk_test_placeholder_for_verification_only',
  };

  const isHealthy = services.database && services.triggers >= 15;

  return c.json({
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    constitutional: {
      schema: services.schema_version,
      triggers: services.triggers,
      invariants: ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5'],
    },
    services,
  });
});

// ============================================================================
// AUTH ENDPOINTS (Firebase)
// ============================================================================

app.post('/api/auth/signup', async (c) => {
  try {
    const authUser = await authenticateRequest(c);
    if (!authUser) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    // Check existing user by firebase_uid
    const existing = await db.query(
      'SELECT id, email FROM users WHERE email = $1',
      [authUser.email]
    );

    if (existing.rows.length > 0) {
      return c.json({
        success: true,
        user: existing.rows[0],
        isNew: false,
      });
    }

    // Create new user with constitutional schema
    const newUser = await db.query(`
      INSERT INTO users (
        email,
        full_name,
        default_mode,
        trust_tier,
        xp_total,
        current_level,
        current_streak
      ) VALUES ($1, $2, $3, 1, 0, 1, 0)
      RETURNING id, email, full_name, default_mode, trust_tier, xp_total, current_level
    `, [
      authUser.email,
      authUser.name || authUser.email?.split('@')[0] || 'User',
      'worker',
    ]);

    return c.json({
      success: true,
      user: newUser.rows[0],
      isNew: true,
    });

  } catch (error) {
    console.error('[Auth] Signup error:', error);
    return c.json({ error: 'Signup failed' }, 500);
  }
});

app.get('/api/auth/me', async (c) => {
  try {
    const authUser = await authenticateRequest(c);
    if (!authUser) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    const user = await db.query(`
      SELECT 
        id, email, full_name, default_mode,
        trust_tier, xp_total, current_level, current_streak,
        is_verified, created_at
      FROM users 
      WHERE email = $1
    `, [authUser.email]);

    if (user.rows.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({ user: user.rows[0] });

  } catch (error) {
    console.error('[Auth] Me error:', error);
    return c.json({ error: 'Failed to get user' }, 500);
  }
});

// ============================================================================
// STRIPE WEBHOOKS (Placeholder for now)
// ============================================================================

app.post('/api/webhooks/stripe', async (c) => {
  // TODO: Implement Stripe webhook handler
  // Must use EscrowService.fundEscrow() on payment_intent.succeeded
  return c.json({ received: true });
});

// ============================================================================
// SERVER START
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10);

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('   HustleXP Backend v2.0.0 - Constitutional Edition');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

// Verify database on startup
checkHealth().then(health => {
  console.log(`📊 Database: ${health.database ? '✅ Connected' : '❌ Failed'}`);
  console.log(`📋 Schema: v${health.schemaVersion || 'unknown'}`);
  console.log(`🔒 Triggers: ${health.triggers} (17 required for full enforcement)`);
  console.log('');
  
  if (!health.database) {
    console.error('❌ Cannot start without database connection');
    process.exit(1);
  }
  
  if (health.triggers < 15) {
    console.warn('⚠️  WARNING: Missing triggers - invariants may not be enforced!');
  }
  
  serve({
    fetch: app.fetch,
    port: PORT,
  });
  
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 tRPC: http://localhost:${PORT}/api/trpc`);
  console.log(`❤️  Health: http://localhost:${PORT}/api/health`);
  console.log('');
});

export default app;
