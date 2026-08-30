import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { buildIdentity, isTrustedBuildIdentity } from './buildIdentity.js';
import { config } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';
import { publicIpRateLimitMiddleware, rateLimitMiddleware } from './middleware/security.js';
import type { HustleApp } from './serverTypes.js';
import {
  exactManifestRequired,
  releaseManifestForRuntime,
  releaseManifestEvidence,
} from './releaseManifest.js';
import { newPaymentCreationHealth } from './services/NewPaymentCreationGuard.js';
import { readNonproductionFinancialBootstrapReadiness } from './services/payment/NonproductionFinancialBootstrapReadiness.js';

export function runtimeHealthEnvironment(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const hxEnvironment = env.HX_ENVIRONMENT?.trim().toLowerCase();
  const nodeEnvironment = env.NODE_ENV?.trim().toLowerCase();
  if (
    hxEnvironment === 'production'
    && nodeEnvironment
    && nodeEnvironment !== 'production'
  ) {
    return 'unknown';
  }
  if (
    (hxEnvironment === 'preview' || hxEnvironment === 'staging')
    && nodeEnvironment !== 'production'
  ) {
    return 'unknown';
  }
  return hxEnvironment
    || nodeEnvironment
    || config.app.env;
}

function runtimeReleaseManifest(environment: string) {
  return releaseManifestForRuntime(
    releaseManifestEvidence,
    {
      service: 'backend',
      revision: buildIdentity.revision,
      environment,
      artifactDigest: buildIdentity.artifact_digest,
    }
  );
}

function exactReleaseReady(environment: string): boolean {
  if (!exactManifestRequired(environment)) return true;
  return isTrustedBuildIdentity(buildIdentity)
    && runtimeReleaseManifest(environment).status === 'compatible';
}

function runtimeFinancialBootstrap(environment: string) {
  return readNonproductionFinancialBootstrapReadiness({
    environment,
    component: 'backend',
    env: process.env,
    release: releaseManifestEvidence,
    identity: buildIdentity,
    database: db,
  });
}

function secretMatches(provided: string | null, expected: string): boolean {
  const rawProvided = Buffer.from(provided || '', 'utf8');
  const rawExpected = Buffer.from(expected, 'utf8');
  const length = Math.max(rawProvided.length, rawExpected.length);
  const paddedProvided = Buffer.alloc(length);
  const paddedExpected = Buffer.alloc(length);
  rawProvided.copy(paddedProvided);
  rawExpected.copy(paddedExpected);
  return Boolean(provided) && timingSafeEqual(paddedProvided, paddedExpected);
}

async function dependencyChecks(paymentCreationMode: 'enabled' | 'frozen') {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
  const dbStart = Date.now();
  try {
    await db.query('SELECT 1 as ping');
    checks.database = { status: 'ok', latency: Date.now() - dbStart };
  } catch (error) {
    checks.database = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown',
    };
  }
  try {
    const result = await db.query(
      'SELECT version, applied_at FROM schema_versions ORDER BY applied_at DESC LIMIT 1'
    );
    checks.schema = { status: result.rows[0]?.version === '1.0.0' ? 'ok' : 'outdated' };
  } catch (error) {
    checks.schema = { status: 'error', error: error instanceof Error ? error.message : 'Unknown' };
  }
  checks.firebase = { status: config.firebase.projectId ? 'configured' : 'missing' };
  checks.stripe = {
    status: paymentCreationMode === 'frozen'
      ? 'disabled_by_policy'
      : config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')
        ? 'configured'
        : 'placeholder',
  };
  return checks;
}

async function circuitBreakerStates() {
  const breakers = await import('./middleware/circuit-breaker.js');
  return {
    openai: breakers.openaiBreaker.getState(),
    anthropic: breakers.anthropicBreaker.getState(),
    groq: breakers.groqBreaker.getState(),
    deepseek: breakers.deepseekBreaker.getState(),
    stripe: breakers.stripeBreaker.getState(),
    sendgrid: breakers.sendgridBreaker.getState(),
    twilio: breakers.twilioBreaker.getState(),
    awsRekognition: breakers.awsRekognitionBreaker.getState(),
    gcpVision: breakers.gcpVisionBreaker.getState(),
    googleMaps: breakers.googleMapsBreaker.getState(),
  };
}

async function detailedHealth(context: Context) {
  const internalApiKey = process.env.INTERNAL_API_KEY;
  if (!internalApiKey) {
    logger.warn('INTERNAL_API_KEY is not configured — /health/detailed is disabled');
    return context.json(
      { error: 'Service Unavailable', message: 'Internal API key not configured' },
      503
    );
  }
  const header = context.req.header('Authorization');
  const provided = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!secretMatches(provided, internalApiKey)) {
    return context.json({ error: 'Unauthorized' }, 401);
  }
  const paymentCreation = newPaymentCreationHealth();
  const checks = await dependencyChecks(paymentCreation.mode);
  const environment = runtimeHealthEnvironment();
  const financialBootstrap = await runtimeFinancialBootstrap(environment);
  const pool = db.getPool();
  const allHealthy = exactReleaseReady(environment)
    && financialBootstrap.ready
    && Object.values(checks).every(
      (check) => ['ok', 'configured', 'disabled_by_policy'].includes(check.status)
    );
  return context.json(
    {
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
      pool: {
        totalConnections: pool.totalCount,
        idleConnections: pool.idleCount,
        waitingClients: pool.waitingCount,
      },
      circuitBreakers: await circuitBreakerStates(),
      build: buildIdentity,
      releaseManifest: runtimeReleaseManifest(environment),
      paymentCreation,
      nonproductionFinancialBootstrap: financialBootstrap,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    },
    allHealthy ? 200 : 503
  );
}

export function registerHealthRoutes(app: HustleApp): void {
  app.use('/health*', publicIpRateLimitMiddleware());
  app.get('/health', async (context) => {
    const environment = runtimeHealthEnvironment();
    const financialBootstrap = await runtimeFinancialBootstrap(environment);
    try {
      await db.query('SELECT 1');
      const releaseReady = exactReleaseReady(environment) && financialBootstrap.ready;
      return context.json(
        {
          status: releaseReady ? 'healthy' : 'unhealthy',
          timestamp: new Date().toISOString(),
          build: buildIdentity,
          releaseManifest: runtimeReleaseManifest(environment),
          paymentCreation: newPaymentCreationHealth(),
          nonproductionFinancialBootstrap: financialBootstrap,
        },
        releaseReady ? 200 : 503
      );
    } catch {
      return context.json(
        {
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          build: buildIdentity,
          releaseManifest: runtimeReleaseManifest(runtimeHealthEnvironment()),
          paymentCreation: newPaymentCreationHealth(),
          nonproductionFinancialBootstrap: financialBootstrap,
        },
        503
      );
    }
  });
  app.get('/health/readiness', async (context) => {
    const environment = runtimeHealthEnvironment();
    const financialBootstrap = await runtimeFinancialBootstrap(environment);
    try {
      await db.query('SELECT 1');
      const ready = exactReleaseReady(environment) && financialBootstrap.ready;
      return context.json({
        ready,
        build: buildIdentity,
        releaseManifest: runtimeReleaseManifest(environment),
        paymentCreation: newPaymentCreationHealth(),
        nonproductionFinancialBootstrap: financialBootstrap,
      }, ready ? 200 : 503);
    } catch {
      return context.json({
        ready: false,
        build: buildIdentity,
        releaseManifest: runtimeReleaseManifest(runtimeHealthEnvironment()),
        paymentCreation: newPaymentCreationHealth(),
        nonproductionFinancialBootstrap: financialBootstrap,
      }, 503);
    }
  });
  app.get('/health/liveness', (context) => {
    const environment = runtimeHealthEnvironment();
    return context.json({
      alive: true,
      uptime: process.uptime(),
      build: buildIdentity,
      releaseManifest: runtimeReleaseManifest(environment),
      paymentCreation: newPaymentCreationHealth(),
    });
  });
  app.get('/health/detailed', rateLimitMiddleware('auth'), detailedHealth);
}
