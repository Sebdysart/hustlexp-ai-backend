import { describe, expect, it } from 'vitest';
import type { BuildIdentity } from '../../src/buildIdentity.js';
import {
  assertMigrationExecutionAuthorized,
  PINNED_PRODUCTION_RAILWAY_PROJECT_ID,
} from '../../src/jobs/migration-execution-authority.js';
import {
  releaseManifestDigest,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';

const REVISION = '1'.repeat(40);
const EXECUTABLE_DIGEST = `sha256:${'2'.repeat(64)}`;
const MIGRATION_DIGEST = `sha256:${'3'.repeat(64)}`;

function manifest(environment: ReleaseManifest['environment'] = 'staging'): ReleaseManifest {
  return {
    version: 1,
    environment,
    releaseId: `${environment}-migration-authority-0001`,
    createdAt: '2026-08-26T12:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: `sha256:${'4'.repeat(64)}`,
    },
    components: {
      backend: {
        revision: REVISION,
        artifactDigest: EXECUTABLE_DIGEST,
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: `sha256:${'5'.repeat(64)}`,
      },
      worker: {
        revision: REVISION,
        artifactDigest: EXECUTABLE_DIGEST,
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: `sha256:${'6'.repeat(64)}`,
      },
      web: {
        revision: '7'.repeat(40),
        artifactDigest: `sha256:${'7'.repeat(64)}`,
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: `sha256:${'8'.repeat(64)}`,
      },
      migration: { revision: REVISION, artifactDigest: MIGRATION_DIGEST },
      policy: { revision: '9'.repeat(40), artifactDigest: `sha256:${'9'.repeat(64)}` },
      fixtures: {
        revision: 'a'.repeat(40),
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: `sha256:${'b'.repeat(64)}`,
      },
    },
    capabilities: {
      financialProvider: environment === 'production' ? 'disabled' : 'fake',
      fakeFinancialEvents: environment !== 'production',
      customerMoneyCreation: false,
      hardAssignment: false,
      realSettlement: false,
      outboundCommunication: 'sink',
      dataClass: 'synthetic',
    },
    promotion: {
      baseManifestDigest: null,
      changedComponents: ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'],
    },
    health: {
      backend: { component: 'backend', path: '/health' },
      worker: { component: 'worker', path: '/health' },
      web: { component: 'web', path: '/version.json' },
    },
  };
}

function release(environment: ReleaseManifest['environment'] = 'staging'): ReleaseManifestEvidence {
  const exact = manifest(environment);
  return {
    schema_version: 1,
    status: 'valid',
    digest: releaseManifestDigest(exact),
    source: 'HX_RELEASE_MANIFEST_JSON',
    errors: [],
    manifest: exact,
    authentication: {
      status: 'verified',
      algorithm: 'ed25519',
      keyId: 'unit-test-release-authority',
      keyFingerprint: `sha256:${'c'.repeat(64)}`,
      signatureDigest: `sha256:${'d'.repeat(64)}`,
      source: 'unit-test-detached-signature',
      errors: [],
    },
  };
}

function identity(): BuildIdentity {
  return {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision: REVISION,
    built_at: '2026-08-26T12:00:00.000Z',
    environment: 'production',
    clean_source: true,
    source: 'GITHUB_SHA',
    artifact_digest: EXECUTABLE_DIGEST,
    artifact_verified: true,
  };
}

function stagingEnv(exactRelease = release()): Record<string, string> {
  return {
    NODE_ENV: 'production',
    HX_ENVIRONMENT: 'staging',
    SERVICE_ROLE: 'migration',
    HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST: exactRelease.digest,
    RAILWAY_PROJECT_NAME: 'hustlexp-nonprod',
    RAILWAY_PROJECT_ID: 'nonprod-project-id',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    RAILWAY_ENVIRONMENT_ID: 'staging-environment-id',
  };
}

describe('explicit migration execution authority', () => {
  it('allows a disposable local command without release credentials or Railway access', () => {
    expect(assertMigrationExecutionAuthorized({
      env: { NODE_ENV: 'test', SERVICE_ROLE: 'migration' },
      migrationArtifactDigest: MIGRATION_DIGEST,
    })).toMatchObject({ environment: 'local', localOnly: true, releaseManifestDigest: null });
  });

  it('accepts exact signed staging, measured code, migration digest, and approval', () => {
    const exactRelease = release();
    expect(assertMigrationExecutionAuthorized({
      env: stagingEnv(exactRelease),
      release: exactRelease,
      identity: identity(),
      migrationArtifactDigest: MIGRATION_DIGEST,
    })).toEqual({
      environment: 'staging',
      releaseManifestDigest: exactRelease.digest,
      migrationArtifactDigest: MIGRATION_DIGEST,
      localOnly: false,
    });
  });

  it.each([
    ['unsigned manifest', (candidate: ReleaseManifestEvidence, build: BuildIdentity, env: Record<string, string>) => {
      candidate.authentication.status = 'missing';
    }, 'AUTHENTICATED_RELEASE_MANIFEST_REQUIRED'],
    ['unmeasured executable', (_candidate: ReleaseManifestEvidence, build: BuildIdentity) => {
      build.artifact_verified = false;
    }, 'MEASURED_IMMUTABLE_BUILD_REQUIRED'],
    ['substituted executable digest', (_candidate: ReleaseManifestEvidence, build: BuildIdentity) => {
      build.artifact_digest = `sha256:${'f'.repeat(64)}`;
    }, 'EXECUTABLE_ARTIFACT_MISMATCH'],
    ['migration digest drift', (candidate: ReleaseManifestEvidence) => {
      candidate.manifest!.components.migration.artifactDigest = `sha256:${'f'.repeat(64)}`;
    }, 'MIGRATION_ARTIFACT_MISMATCH'],
    ['missing environment approval', (_candidate: ReleaseManifestEvidence, _build: BuildIdentity, env: Record<string, string>) => {
      delete env.HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST;
    }, 'EXACT_ENVIRONMENT_APPROVAL_REQUIRED'],
  ] as const)('fails before database access for %s', (_label, mutate, reason) => {
    const exactRelease = release();
    const build = identity();
    const env = stagingEnv(exactRelease);
    mutate(exactRelease, build, env);
    expect(() => assertMigrationExecutionAuthorized({
      env,
      release: exactRelease,
      identity: build,
      migrationArtifactDigest: MIGRATION_DIGEST,
    })).toThrow(reason);
  });

  it('rejects Railway from the local lane and keeps production target enrollment held in code', () => {
    expect(() => assertMigrationExecutionAuthorized({
      env: {
        NODE_ENV: 'test',
        SERVICE_ROLE: 'migration',
        RAILWAY_PROJECT_ID: 'must-not-be-local',
      },
      migrationArtifactDigest: MIGRATION_DIGEST,
    })).toThrow('LOCAL_EXECUTION_CANNOT_TARGET_RAILWAY');

    expect(PINNED_PRODUCTION_RAILWAY_PROJECT_ID).toBeNull();
    const productionRelease = release('production');
    expect(() => assertMigrationExecutionAuthorized({
      env: {
        NODE_ENV: 'production',
        HX_ENVIRONMENT: 'production',
        SERVICE_ROLE: 'migration',
        HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST: productionRelease.digest,
        RAILWAY_PROJECT_NAME: 'hustlexp-production',
        RAILWAY_PROJECT_ID: 'runtime-cannot-enroll-this',
        RAILWAY_ENVIRONMENT_NAME: 'production',
        RAILWAY_ENVIRONMENT_ID: 'production-environment-id',
      },
      release: productionRelease,
      identity: identity(),
      migrationArtifactDigest: MIGRATION_DIGEST,
    })).toThrow('PRODUCTION_TARGET_NOT_ENROLLED');
  });
});
