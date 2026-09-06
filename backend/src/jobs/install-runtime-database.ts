import { installAttestedDatabaseRuntime } from '../db.js';
import { releaseManifestEvidence } from '../releaseManifest.js';
import { configuredRuntimeDatabaseStartup } from './runtime-database-startup-config.js';
import { composeRuntimeDatabaseReleaseAuthority } from './runtime-database-release-authority.js';
import { createPgRuntimeDatabaseAuthorityAdapter } from './runtime-database-pg-adapter.js';
import { attestRuntimeDatabaseAuthority } from './runtime-database-authority.js';
import {
  createRuntimeDatabaseDataPlane,
  type RuntimeDatabaseDataPlane,
} from './runtime-database-data-plane.js';

export interface InstalledRuntimeDatabase {
  close(): Promise<void>;
}
let installationAttempted = false;

/** Process entry only: no caller-authored verifier, build proof, target or signing key. */
export async function installConfiguredRuntimeDatabase(
  component: 'api' | 'worker' | 'attester'
): Promise<InstalledRuntimeDatabase> {
  if (installationAttempted) throw new Error('RUNTIME_DATABASE_STARTUP_ALREADY_ATTEMPTED');
  installationAttempted = true;
  const configured = configuredRuntimeDatabaseStartup(component);
  const release = composeRuntimeDatabaseReleaseAuthority(releaseManifestEvidence, component);
  if (
    release.environment !== configured.expectedTarget.environment ||
    release.databaseTargetDigest !== configured.targetDigest
  ) {
    throw new Error('RUNTIME_DATABASE_STARTUP_RELEASE_TARGET_MISMATCH');
  }
  const adapter = createPgRuntimeDatabaseAuthorityAdapter({
    primaryDatabaseUrl: configured.primaryDatabaseUrl,
    target: configured.target,
    poolConfig: configured.poolConfig,
  });
  let plane: RuntimeDatabaseDataPlane | undefined;
  try {
    const capability = await attestRuntimeDatabaseAuthority(
      {
        component,
        primaryDatabaseUrl: configured.primaryDatabaseUrl,
        replicaDatabaseUrl: configured.replicaDatabaseUrl,
        expectedTarget: configured.expectedTarget,
        expectedTargetDigest: release.databaseTargetDigest,
        roleTopology: configured.roleTopology,
        releasePins: release.releasePins,
      },
      adapter,
      release.verifier
    );
    plane = createRuntimeDatabaseDataPlane({
      primaryDatabaseUrl: configured.primaryDatabaseUrl,
      replicaDatabaseUrl: configured.replicaDatabaseUrl,
      target: configured.target,
      adapter,
      capability,
    });
    installAttestedDatabaseRuntime(plane);
    const installed = plane;
    return Object.freeze({ close: () => installed.close() });
  } catch (error) {
    try {
      // Never close the global facade on duplicate-install rejection: it may
      // belong to an earlier successful installation. Close this attempt only.
      if (plane) await plane.close();
      else await adapter.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'RUNTIME_DATABASE_STARTUP_AND_CLEANUP_FAILED'
      );
    }
    throw error;
  }
}
