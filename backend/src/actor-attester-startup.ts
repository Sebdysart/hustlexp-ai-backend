import type { Hono } from 'hono';
import { db } from './db.js';
import { logger } from './logger.js';
import { releaseManifestEvidence } from './releaseManifest.js';
import { installConfiguredRuntimeDatabase } from './jobs/install-runtime-database.js';
import type { HttpServerStartupHandle } from './serverBoot.js';
import {
  productionStartupMigrationRuntime,
  runStartupMigrations,
} from './serverStartupMigrations.js';
import { PostgresUniversalV1ActorAssertionIssuer } from './services/UniversalV1ActorAssertionIssuer.js';
import { resolveUniversalV1ActorReleaseBinding } from './services/UniversalV1ActorAttestationReleaseAuthority.js';
import { createUniversalV1ActorAttesterApp } from './services/UniversalV1ActorAttesterService.js';

export interface ActorAttesterStartup extends HttpServerStartupHandle {
  readonly app: Hono;
  readonly port: number;
  readonly hostname: string;
}

/** Process-owned composition: no caller-provided release verifier or database. */
export async function startActorAttester(): Promise<ActorAttesterStartup> {
  const rawPort = process.env.ACTOR_ATTESTER_PORT?.trim() || '3002';
  const port = Number(rawPort);
  if (!/^\d+$/u.test(rawPort) || !Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('UNIVERSAL_V1_ACTOR_ATTESTER_REFUSED:PORT_INVALID');
  }
  const issuer = new PostgresUniversalV1ActorAssertionIssuer();
  // Requests and startup share the same process-owned release evidence. A
  // later file/env path change must not introduce a second release root.
  const releaseBinding = () =>
    resolveUniversalV1ActorReleaseBinding(process.env, releaseManifestEvidence);
  const release = releaseBinding();
  const app = createUniversalV1ActorAttesterApp({ issuer, releaseBinding });
  const installed = await installConfiguredRuntimeDatabase('attester');
  const closeDatabase = async () => {
    await issuer.close();
    await installed.close();
  };
  try {
    await runStartupMigrations(
      logger.child({ module: 'actor-attester-startup' }),
      productionStartupMigrationRuntime(db.readQuery)
    );
    await issuer.readiness();
    return Object.freeze({
      app,
      port,
      hostname: release.environment === 'local' ? '127.0.0.1' : '0.0.0.0',
      closeDatabase,
    });
  } catch (error) {
    try {
      await closeDatabase();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'ATTESTER_DATABASE_STARTUP_AND_CLEANUP_FAILED'
      );
    }
    throw error;
  }
}
