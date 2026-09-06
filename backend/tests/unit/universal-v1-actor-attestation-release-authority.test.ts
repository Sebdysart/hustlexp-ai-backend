import { describe, expect, it } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import type { ReleaseManifestEvidence } from '../../src/releaseManifest.js';
import { resolveUniversalV1ActorReleaseBinding } from '../../src/services/UniversalV1ActorAttestationReleaseAuthority.js';

const revision = 'a'.repeat(40);
const artifactDigest = `sha256:${'b'.repeat(64)}`;
const manifestDigest = `sha256:${'c'.repeat(64)}`;
const env = {
  HX_ENVIRONMENT: 'local',
  HX_PAYMENT_CREATION_MODE: 'frozen',
  STRIPE_MODE: 'test',
  ENGINE_API_MODE: 'test',
  HX_EXTERNAL_VALUE: 'false',
};
const evidence = {
  status: 'valid',
  digest: manifestDigest,
  manifest: {
    environment: 'local',
    components: { backend: { revision, artifactDigest } },
    capabilities: {
      financialProvider: 'fake',
      customerMoneyCreation: false,
      hardAssignment: false,
      realSettlement: false,
      dataClass: 'synthetic',
    },
  },
} as unknown as ReleaseManifestEvidence;
const identity: BuildIdentity = {
  schema_version: 1,
  service: 'hustlexp-engine',
  revision,
  built_at: '2026-09-01T12:00:00.000Z',
  environment: 'local',
  clean_source: true,
  source: 'compiled',
  artifact_digest: artifactDigest,
  artifact_verified: true,
};

describe('Universal V1 actor attestation release authority', () => {
  it('binds a trusted executable to the exact isolated release manifest', () => {
    expect(resolveUniversalV1ActorReleaseBinding(env, evidence, identity)).toEqual({
      environment: 'local',
      releaseManifestSha256: manifestDigest,
      backendRevision: revision,
      backendArtifactSha256: artifactDigest,
    });
  });

  it('holds when the executable artifact is not the manifest artifact', () => {
    expect(() =>
      resolveUniversalV1ActorReleaseBinding(env, evidence, {
        ...identity,
        artifact_digest: `sha256:${'d'.repeat(64)}`,
      })
    ).toThrow('EXACT_RELEASE_MANIFEST_REQUIRED');
  });

  it('denies production before release evidence can authorize the service', () => {
    expect(() =>
      resolveUniversalV1ActorReleaseBinding(
        { ...env, HX_ENVIRONMENT: 'production' },
        evidence,
        identity
      )
    ).toThrow('ENVIRONMENT_NOT_ISOLATED_NONPRODUCTION');
  });
});
