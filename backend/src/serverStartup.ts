import { config, validateConfig } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';
import {
  verifyRuntimeSchema,
  type RuntimeSchemaVerification,
} from './serverStartupMigrations.js';
import { assertTaskLocationCryptoConfigured } from './services/TaskLocationCrypto.js';

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

export async function startServer(): Promise<RuntimeSchemaVerification> {
  validateConfig();
  if (config.app.isProduction) assertTaskLocationCryptoConfigured();
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
    const code = (error as { code?: unknown } | null)?.code;
    startLog.error({ code: typeof code === 'string' ? code : undefined }, 'Database connection failed');
    process.exit(1);
    throw new Error('Runtime database connection failed');
  }
  try {
    const databaseAdmission = await verifyRuntimeSchema(startLog);
    startLog.info({
      environment: config.app.env,
      port: config.app.port,
      endpoints,
    }, 'Runtime admission passed; server socket may now bind');
    return databaseAdmission;
  } catch {
    process.exit(1);
    throw new Error('Runtime database schema admission failed');
  }
}
