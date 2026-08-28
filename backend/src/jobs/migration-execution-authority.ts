import { buildIdentity, isTrustedBuildIdentity, type BuildIdentity } from '../buildIdentity.js';
import {
  isAuthenticatedReleaseManifest,
  readReleaseManifest,
  type ReleaseEnvironment,
  type ReleaseManifestEvidence,
} from '../releaseManifest.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const NONPRODUCTION_PROJECT = 'hustlexp-nonprod';

/**
 * Production target identity is intentionally not enrolled during the release
 * hold. Enrolling it requires a protected source change, not a Railway variable.
 */
export const PINNED_PRODUCTION_RAILWAY_PROJECT_ID: string | null = null;

export interface MigrationExecutionAuthorityOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  release?: ReleaseManifestEvidence;
  identity?: BuildIdentity;
  migrationArtifactDigest: string;
}

export interface MigrationExecutionAuthority {
  environment: ReleaseEnvironment;
  releaseManifestDigest: string | null;
  migrationArtifactDigest: string;
  localOnly: boolean;
}

function refuse(reason: string): never {
  throw new Error(`MIGRATION_EXECUTION_REFUSED:${reason}`);
}

function environmentOf(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ReleaseEnvironment {
  const raw = (env.HX_ENVIRONMENT || env.NODE_ENV || 'local').trim().toLowerCase();
  if (raw === 'test' || raw === 'development' || raw === 'local') return 'local';
  if (raw === 'preview' || raw === 'staging' || raw === 'production') return raw;
  return refuse('ENVIRONMENT_INVALID');
}

function assertRailwayTarget(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  environment: Exclude<ReleaseEnvironment, 'local'>,
): void {
  const projectId = env.RAILWAY_PROJECT_ID?.trim();
  const projectName = env.RAILWAY_PROJECT_NAME?.trim();
  const environmentId = env.RAILWAY_ENVIRONMENT_ID?.trim();
  const environmentName = (
    env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || ''
  ).trim().toLowerCase();
  if (!projectId || !environmentId || !environmentName) refuse('EXACT_RAILWAY_TARGET_REQUIRED');

  if (environment === 'production') {
    if (!PINNED_PRODUCTION_RAILWAY_PROJECT_ID) refuse('PRODUCTION_TARGET_NOT_ENROLLED');
    if (projectId !== PINNED_PRODUCTION_RAILWAY_PROJECT_ID) refuse('PRODUCTION_PROJECT_MISMATCH');
    if (environmentName !== 'production') refuse('PRODUCTION_ENVIRONMENT_MISMATCH');
    return;
  }

  if (projectName !== NONPRODUCTION_PROJECT) refuse('NONPRODUCTION_PROJECT_MISMATCH');
  if (environment === 'staging' && environmentName !== 'staging') {
    refuse('STAGING_ENVIRONMENT_MISMATCH');
  }
  if (
    environment === 'preview'
    && !environmentName.startsWith('pr-')
    && !environmentName.startsWith('preview-')
  ) {
    refuse('PREVIEW_ENVIRONMENT_MISMATCH');
  }
}

/**
 * Fail-closed preflight for the only deployed schema-writing role.
 *
 * This function performs no database operation. All nonlocal authority is
 * bound to a signed manifest, a runtime-measured artifact, an exact migration
 * digest, and an environment approval that names that signed manifest digest.
 */
export function assertMigrationExecutionAuthorized(
  options: MigrationExecutionAuthorityOptions,
): MigrationExecutionAuthority {
  const env = options.env ?? process.env;
  const environment = environmentOf(env);
  const migrationArtifactDigest = options.migrationArtifactDigest.startsWith('sha256:')
    ? options.migrationArtifactDigest
    : `sha256:${options.migrationArtifactDigest}`;
  if (!DIGEST.test(migrationArtifactDigest)) refuse('MIGRATION_ARTIFACT_DIGEST_INVALID');

  const role = env.SERVICE_ROLE?.trim().toLowerCase();
  if (role && role !== 'migration') refuse('SERVICE_ROLE_MUST_BE_MIGRATION');
  if (environment === 'local') {
    if (env.NODE_ENV?.trim().toLowerCase() === 'production') {
      refuse('PRODUCTION_RUNTIME_CANNOT_CLAIM_LOCAL');
    }
    const railwayPresent = Object.entries(env).some(
      ([name, value]) => name.startsWith('RAILWAY_') && Boolean(value?.trim()),
    );
    if (railwayPresent) refuse('LOCAL_EXECUTION_CANNOT_TARGET_RAILWAY');
    return {
      environment,
      releaseManifestDigest: null,
      migrationArtifactDigest,
      localOnly: true,
    };
  }

  if (env.NODE_ENV !== 'production') refuse('DEPLOYED_RUNTIME_MUST_USE_NODE_ENV_PRODUCTION');
  if (role !== 'migration') refuse('SERVICE_ROLE_MUST_BE_MIGRATION');
  const release = options.release ?? readReleaseManifest();
  const identity = options.identity ?? buildIdentity;
  if (!isAuthenticatedReleaseManifest(release) || !release.manifest) {
    refuse('AUTHENTICATED_RELEASE_MANIFEST_REQUIRED');
  }
  if (!isTrustedBuildIdentity(identity)) refuse('MEASURED_IMMUTABLE_BUILD_REQUIRED');
  const manifest = release.manifest;
  if (manifest.environment !== environment) refuse('MANIFEST_ENVIRONMENT_MISMATCH');
  if (manifest.components.migration.revision !== identity.revision) {
    refuse('MIGRATION_REVISION_MISMATCH');
  }
  if (manifest.components.backend.revision !== identity.revision) {
    refuse('EXECUTABLE_REVISION_MISMATCH');
  }
  if (manifest.components.backend.artifactDigest !== identity.artifact_digest) {
    refuse('EXECUTABLE_ARTIFACT_MISMATCH');
  }
  if (manifest.components.migration.artifactDigest !== migrationArtifactDigest) {
    refuse('MIGRATION_ARTIFACT_MISMATCH');
  }
  if (env.HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST !== release.digest) {
    refuse('EXACT_ENVIRONMENT_APPROVAL_REQUIRED');
  }
  assertRailwayTarget(env, environment);
  return {
    environment,
    releaseManifestDigest: release.digest,
    migrationArtifactDigest,
    localOnly: false,
  };
}
