import { createServer, type Server } from 'node:http';
import {
  buildIdentity as runtimeBuildIdentity,
  isTrustedBuildIdentity,
  type BuildIdentity,
} from '../buildIdentity.js';
import {
  exactManifestRequired,
  readReleaseManifest,
  releaseManifestForRuntime,
  type ReleaseManifestEvidence,
} from '../releaseManifest.js';
import { db } from '../db.js';
import { getRedisCommandClient } from '../redis/RedisCommandPort.js';
import {
  readNonproductionFinancialBootstrapReadiness,
  unavailableNonproductionFinancialBootstrapReadiness,
  type NonproductionFinancialBootstrapReadiness,
} from '../services/payment/NonproductionFinancialBootstrapReadiness.js';

export type WorkerHealthState = 'starting' | 'ready' | 'shutting_down';

export interface WorkerHealthServer {
  server: Server;
  markReady(): void;
  markShuttingDown(): void;
  close(): Promise<void>;
}

interface WorkerHealthServerOptions {
  host?: string;
  port?: number;
  production?: boolean;
  environment?: string;
  identity?: BuildIdentity;
  release?: ReleaseManifestEvidence;
  trustedIdentity?: (identity: BuildIdentity) => boolean;
  financialReadiness?: () => Promise<NonproductionFinancialBootstrapReadiness>;
  dependencyReadiness?: () => Promise<WorkerDependencyReadiness>;
  readinessTimeoutMs?: number;
}

export interface WorkerDependencyReadiness {
  readonly database: 'ok' | 'unavailable';
  readonly redis: 'ok' | 'unavailable';
}

const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const MAX_READINESS_TIMEOUT_MS = 10_000;

function resolveReadinessTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? Math.min(value, MAX_READINESS_TIMEOUT_MS)
    : DEFAULT_READINESS_TIMEOUT_MS;
}

function settleBeforeDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    timer.unref();
    Promise.resolve()
      .then(operation)
      .then(finish, () => finish(fallback));
  });
}

async function runtimeDependencyReadiness(timeoutMs: number): Promise<WorkerDependencyReadiness> {
  const [database, redis] = await Promise.all([
    settleBeforeDeadline(
      () => db.query('SELECT 1').then(() => 'ok' as const),
      timeoutMs,
      'unavailable' as const,
    ),
    settleBeforeDeadline(async () => {
      const client = getRedisCommandClient();
      if (!client) return 'unavailable' as const;
      await client.get('hx:worker:readiness:v1');
      return 'ok' as const;
    }, timeoutMs, 'unavailable' as const),
  ]);
  return { database, redis };
}

function resolvePort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 3000;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startWorkerHealthServer(
  options: WorkerHealthServerOptions = {},
): Promise<WorkerHealthServer> {
  const identity = options.identity ?? runtimeBuildIdentity;
  const rawEnvironment = options.environment
    ?? (options.production ? 'production' : process.env.HX_ENVIRONMENT || process.env.NODE_ENV || 'development');
  const environment = rawEnvironment.trim().toLowerCase() || 'unknown';
  // Any production signal is authoritative for trust enforcement. An explicit
  // `false` cannot downgrade a production environment spelling and conflicting
  // options therefore fail closed through the production identity checks.
  const production = options.production === true || environment === 'production';
  const release = options.release ?? readReleaseManifest();
  const trustedIdentity = options.trustedIdentity ?? isTrustedBuildIdentity;
  const readinessTimeoutMs = resolveReadinessTimeout(options.readinessTimeoutMs);
  const financialReadiness = options.financialReadiness ?? (() => (
    readNonproductionFinancialBootstrapReadiness({
      environment,
      component: 'worker',
      env: options.environment !== undefined || options.production !== undefined
        ? {
            ...process.env,
            HX_ENVIRONMENT: environment,
            ...(production ? { NODE_ENV: 'production' } : {}),
          }
        : process.env,
      release,
      identity,
      database: db,
    })
  ));
  const dependencyReadiness = options.dependencyReadiness
    ?? (() => runtimeDependencyReadiness(readinessTimeoutMs));
  let state: WorkerHealthState = 'starting';

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://worker.local').pathname;
    const supportedPath = path === '/health'
      || path === '/health/readiness'
      || path === '/health/liveness';

    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');

    if (!supportedPath) {
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      response.writeHead(405);
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    if (path === '/health/liveness') {
      const alive = state !== 'shutting_down';
      const releaseManifest = releaseManifestForRuntime(release, {
        service: 'worker',
        revision: identity.revision,
        environment,
        artifactDigest: identity.artifact_digest,
      });
      response.writeHead(alive ? 200 : 503);
      response.end(JSON.stringify({
        status: alive ? 'alive' : 'shutting_down',
        service: 'hustlexp-worker',
        state,
        alive,
        build: identity,
        releaseManifest,
      }));
      return;
    }

    const trustedBuild = !production || trustedIdentity(identity);
    const releaseManifest = releaseManifestForRuntime(release, {
      service: 'worker',
      revision: identity.revision,
      environment,
      artifactDigest: identity.artifact_digest,
    });
    const trustedRelease = !exactManifestRequired(environment)
      || releaseManifest.status === 'compatible';
    const unavailableFinancialBootstrap = unavailableNonproductionFinancialBootstrapReadiness(environment);
    const unavailableDependencies: WorkerDependencyReadiness = {
      database: 'unavailable',
      redis: 'unavailable',
    };
    const [financialBootstrap, dependencies] = await Promise.all([
      settleBeforeDeadline(
        financialReadiness,
        readinessTimeoutMs,
        unavailableFinancialBootstrap,
      ),
      settleBeforeDeadline(
        dependencyReadiness,
        readinessTimeoutMs,
        unavailableDependencies,
      ),
    ]);
    const ready = state === 'ready'
      && trustedBuild
      && trustedRelease
      && financialBootstrap.ready
      && dependencies.database === 'ok'
      && dependencies.redis === 'ok';
    response.writeHead(ready ? 200 : 503);
    response.end(JSON.stringify({
      status: ready ? 'healthy' : 'unhealthy',
      service: 'hustlexp-worker',
      state,
      ready,
      build: identity,
      releaseManifest,
      nonproductionFinancialBootstrap: financialBootstrap,
      dependencies,
    }));
  });

  await listen(server, options.port ?? resolvePort(process.env.WORKER_PORT ?? process.env.PORT), options.host ?? '0.0.0.0');

  return {
    server,
    markReady() {
      state = 'ready';
    },
    markShuttingDown() {
      state = 'shutting_down';
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
