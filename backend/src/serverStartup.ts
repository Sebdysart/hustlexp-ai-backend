import { config, validateConfig } from './config.js';
import { assertApiActorAttesterCredentialIsolation } from './auth/universal-v1-actor-attestation-runtime-boundary.js';
import { db } from './db.js';
import { logger } from './logger.js';
import { installConfiguredRuntimeDatabase } from './jobs/install-runtime-database.js';
import type { HttpServerStartupHandle } from './serverBoot.js';
import {
  productionStartupMigrationRuntime,
  runStartupMigrations,
} from './serverStartupMigrations.js';

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

export async function startServer(): Promise<HttpServerStartupHandle> {
  assertApiActorAttesterCredentialIsolation();
  validateConfig();
  const startLog = logger.child({ module: 'startup' });
  startLog.info('═══════════════════════════════════════════════════════════');
  startLog.info('  HustleXP Backend v1.0.0 — CONSTITUTIONAL AUTHORITY');
  startLog.info('═══════════════════════════════════════════════════════════');
  startLog.info(
    {
      configStatus: {
        database: Boolean(config.database.url),
        firebase: Boolean(config.firebase.projectId),
        stripe: Boolean(
          config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')
        ),
        redis: Boolean(config.redis.url),
      },
    },
    'Configuration check'
  );
  const installed = await installConfiguredRuntimeDatabase('api');
  try {
    await db.query('SELECT 1 as ping');
    startLog.info('Database connected');
    await runStartupMigrations(startLog, productionStartupMigrationRuntime(db.readQuery));
    startLog.info(
      { environment: config.app.env, port: config.app.port, endpoints },
      `Startup attestation complete; HTTP listener authorized on port ${config.app.port}`
    );
    return { closeDatabase: () => installed.close() };
  } catch (error) {
    try {
      await installed.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'API_DATABASE_STARTUP_AND_CLEANUP_FAILED');
    }
    throw error;
  }
}
