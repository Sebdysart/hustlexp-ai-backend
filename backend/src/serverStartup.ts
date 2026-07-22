import { config, validateConfig } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';
import { runStartupMigrations } from './serverStartupMigrations.js';

const endpoints = {
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
};

export async function startServer(): Promise<void> {
  validateConfig();
  const startLog = logger.child({ module: 'startup' });
  startLog.info('═══════════════════════════════════════════════════════════');
  startLog.info('  HustleXP Backend v1.0.0 — CONSTITUTIONAL AUTHORITY');
  startLog.info('═══════════════════════════════════════════════════════════');
  startLog.info({
    configStatus: {
      database: Boolean(config.database.url),
      firebase: Boolean(config.firebase.projectId),
      stripe: Boolean(config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')),
      redis: Boolean(config.redis.url),
    },
  }, 'Configuration check');
  try {
    await db.query('SELECT 1 as ping');
    startLog.info('Database connected');
  } catch (error) {
    startLog.error({ err: error }, 'Database connection failed');
  }
  await runStartupMigrations(startLog);
  startLog.info({
    environment: config.app.env,
    port: config.app.port,
    endpoints,
  }, `HustleXP server listening on http://localhost:${config.app.port}`);
}
