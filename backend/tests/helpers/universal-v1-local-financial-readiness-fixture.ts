import { randomUUID } from 'node:crypto';
import type { BuildIdentity } from '../../src/buildIdentity.js';
import { engineMigrationArtifactDigest } from '../../src/jobs/engine-migration-manifest.js';
import {
  releaseManifestDigest,
  type ReleaseManifestV2,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';
const revision = '1'.repeat(40);
const artifactDigest = (value: string) => 'sha256:' + value.repeat(64);
export async function createLocalFinancialReadinessAuthority(): Promise<{
  identity: BuildIdentity;
  manifest: ReleaseManifestV2;
  release: ReleaseManifestEvidence;
}> {
  const migrationArtifactDigest = `sha256:${await engineMigrationArtifactDigest()}`;
  const manifest: ReleaseManifestV2 = {
    version: 2,
    environment: 'local',
    releaseId: `local-readiness-pg-${randomUUID()}`,
    createdAt: '2026-08-28T21:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: artifactDigest('f'),
    },
    components: {
      backend: {
        revision,
        artifactDigest: artifactDigest('1'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: artifactDigest('2'),
      },
      worker: {
        revision,
        artifactDigest: artifactDigest('3'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: artifactDigest('4'),
      },
      web: {
        revision: '2'.repeat(40),
        artifactDigest: artifactDigest('5'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: artifactDigest('6'),
      },
      migration: { revision, artifactDigest: migrationArtifactDigest },
      policy: { revision: '3'.repeat(40), artifactDigest: artifactDigest('8') },
      fixtures: {
        revision: '4'.repeat(40),
        artifactDigest: artifactDigest('9'),
        providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        providerImageDigest: artifactDigest('a'),
        databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        databaseImageDigest: artifactDigest('b'),
      },
    },
    infrastructure: {
      revision: '5'.repeat(40),
      artifactDigest: artifactDigest('c'),
      desiredTopologyDigest: artifactDigest('d'),
    },
    databaseTargets: {
      api: { component: 'api', environment: 'local', databaseTargetDigest: artifactDigest('e') },
      worker: {
        component: 'worker',
        environment: 'local',
        databaseTargetDigest: artifactDigest('f'),
      },
      attester: {
        component: 'attester',
        environment: 'local',
        databaseTargetDigest: artifactDigest('1'),
      },
    },
    capabilities: {
      financialProvider: 'fake',
      fakeFinancialEvents: true,
      customerMoneyCreation: false,
      hardAssignment: false,
      realSettlement: false,
      outboundCommunication: 'sink',
      dataClass: 'synthetic',
    },
    promotion: {
      baseManifestDigest: null,
      changedComponents: ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'],
      infrastructureChanged: true,
    },
    acceptance: {
      backend: { kind: 'http', component: 'backend', path: '/health' },
      worker: { kind: 'http', component: 'worker', path: '/health' },
      web: { kind: 'http', component: 'web', path: '/version.json' },
      migration: { kind: 'receipt', component: 'migration', receiptType: 'migration-execution-v1' },
      policy: { kind: 'receipt', component: 'policy', receiptType: 'canonical-policy-digest-v1' },
      fixtures: { kind: 'receipt', component: 'fixtures', receiptType: 'fixture-seed-v1' },
      infrastructure: {
        kind: 'readback',
        binding: 'infrastructure',
        receiptType: 'infrastructure-readback-v1',
      },
    },
  };
  const identity: BuildIdentity = {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision,
    built_at: '2026-08-28T21:00:00.000Z',
    environment: 'development',
    clean_source: false,
    source: 'git',
    artifact_digest: artifactDigest('1'),
    artifact_verified: false,
  };
  return {
    identity,
    manifest,
    release: {
      schema_version: 1,
      status: 'valid',
      digest: releaseManifestDigest(manifest),
      source: 'pg-test',
      errors: [],
      manifest,
      authentication: {
        status: 'missing',
        algorithm: null,
        keyId: null,
        keyFingerprint: null,
        signatureDigest: null,
        source: 'none',
        errors: [],
      },
    },
  };
}
