import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isReleaseManifestCompatible,
  readReleaseManifest,
  releaseManifestDigest,
  releaseManifestSignaturePayload,
  releaseManifestForRuntime,
  type ReleaseManifest,
} from '../../src/releaseManifest';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'d'.repeat(64)}`;
const directories: string[] = [];
const releaseAuthority = generateKeyPairSync('ed25519');
const RELEASE_KEY_ID = 'test-release-authority-v1';
const RELEASE_PUBLIC_KEY = releaseAuthority.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function manifest(environment: ReleaseManifest['environment'] = 'staging'): ReleaseManifest {
  const financialProvider = environment === 'production' ? 'disabled' : 'fake';
  const outboundCommunication = environment === 'production' ? 'bounded_live' : 'sink';
  const dataClass = environment === 'production' ? 'approved_customer' : 'synthetic';
  return {
    version: 1,
    environment,
    releaseId: `${environment}-20260826-001`,
    createdAt: '2026-08-26T12:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: DIGEST,
    },
    components: {
      backend: {
        revision: SHA,
        artifactDigest: DIGEST,
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: OTHER_DIGEST,
      },
      worker: {
        revision: SHA,
        artifactDigest: OTHER_DIGEST,
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: DIGEST,
      },
      web: {
        revision: OTHER_SHA,
        artifactDigest: DIGEST,
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: OTHER_DIGEST,
      },
      migration: { revision: SHA, artifactDigest: OTHER_DIGEST },
      policy: { revision: SHA, artifactDigest: DIGEST },
      fixtures: {
        revision: SHA,
        artifactDigest: OTHER_DIGEST,
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: DIGEST,
      },
    },
    capabilities: {
      financialProvider,
      fakeFinancialEvents: environment !== 'production',
      customerMoneyCreation: false,
      hardAssignment: false,
      realSettlement: false,
      outboundCommunication,
      dataClass,
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

function writeManifest(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'hx-release-'));
  directories.push(directory);
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function readSignedManifest(value: ReleaseManifest) {
  const digest = releaseManifestDigest(value);
  const signatureRaw = JSON.stringify({
    version: 1,
    algorithm: 'ed25519',
    keyId: RELEASE_KEY_ID,
    manifestDigest: digest,
    signature: sign(
      null,
      releaseManifestSignaturePayload(digest),
      releaseAuthority.privateKey,
    ).toString('base64'),
  });
  return readReleaseManifest(writeManifest(value), {
    signatureRaw,
    signatureSource: 'unit-test-detached-signature',
    trustedPublicKeys: { [RELEASE_KEY_ID]: RELEASE_PUBLIC_KEY },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('exact release manifest evidence', () => {
  it('reads and hashes an exact synthetic staging manifest', () => {
    const evidence = readSignedManifest(manifest());

    expect(evidence.status).toBe('valid');
    expect(evidence.manifest?.releaseId).toBe('staging-20260826-001');
    expect(evidence.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evidence.authentication.status).toBe('verified');
    expect(
      isReleaseManifestCompatible(evidence, {
        service: 'backend',
        revision: SHA,
        environment: 'staging',
        artifactDigest: DIGEST,
      })
    ).toBe(true);
    expect(
      releaseManifestForRuntime(evidence, {
        service: 'backend',
        revision: SHA,
        environment: 'staging',
        artifactDigest: DIGEST,
      }).status
    ).toBe('compatible');
  });

  it('uses canonical object-key ordering for the exact manifest digest', () => {
    const exact = manifest();
    const reordered = {
      health: exact.health,
      promotion: exact.promotion,
      capabilities: exact.capabilities,
      components: exact.components,
      authority: exact.authority,
      createdAt: exact.createdAt,
      releaseId: exact.releaseId,
      environment: exact.environment,
      version: exact.version,
    };

    expect(releaseManifestDigest(reordered)).toBe(releaseManifestDigest(exact));
  });

  it('matches the fixed platform and web cross-runtime digest vector', () => {
    const vector: ReleaseManifest = {
      $schema: '../schemas/release-manifest.schema.json',
      version: 1,
      environment: 'staging',
      releaseId: 'staging-20260826-001',
      createdAt: '2026-08-26T00:00:00.000Z',
      authority: {
        document: 'HustleXP Business and Universal V1 Charter',
        charterVersion: '1.1.0',
        charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
        capabilityPolicyDigest:
          'sha256:6422c992ec7a8143ecb90ce25c0097c3c7477e6bf8e3bd3e5f53c6ad1f5bc9ea',
      },
      components: {
        backend: {
          revision: '1'.repeat(40),
          artifactDigest: `sha256:${'2'.repeat(64)}`,
          imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
          imageDigest: `sha256:${'3'.repeat(64)}`,
        },
        worker: {
          revision: '2'.repeat(40),
          artifactDigest: `sha256:${'3'.repeat(64)}`,
          imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
          imageDigest: `sha256:${'4'.repeat(64)}`,
        },
        web: {
          revision: '3'.repeat(40),
          artifactDigest: `sha256:${'4'.repeat(64)}`,
          imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
          imageDigest: `sha256:${'5'.repeat(64)}`,
        },
        migration: { revision: '4'.repeat(40), artifactDigest: `sha256:${'5'.repeat(64)}` },
        policy: { revision: '5'.repeat(40), artifactDigest: `sha256:${'6'.repeat(64)}` },
        fixtures: {
          revision: '6'.repeat(40),
          artifactDigest: `sha256:${'1'.repeat(64)}`,
          imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
          imageDigest: `sha256:${'2'.repeat(64)}`,
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
      },
      health: {
        backend: { component: 'backend', path: '/health' },
        worker: { component: 'worker', path: '/health' },
        web: { component: 'web', path: '/version.json' },
      },
    };

    expect(releaseManifestDigest(vector)).toBe(
      'sha256:d7da6d2dcbdc127d81e685be65c2d151f276d70cca5f1fdee21343f8fe1fd4d5'
    );
    expect(readReleaseManifest(writeManifest(vector)).status).toBe('valid');
  });

  it('fails closed when a component revision or runtime environment drifts', () => {
    const evidence = readReleaseManifest(writeManifest(manifest()));

    expect(
      isReleaseManifestCompatible(evidence, {
        service: 'backend',
        revision: OTHER_SHA,
        environment: 'staging',
      })
    ).toBe(false);
    expect(
      isReleaseManifestCompatible(evidence, {
        service: 'backend',
        revision: SHA,
        environment: 'preview',
      })
    ).toBe(false);
  });

  it('requires production manifests to keep financial creation and hard assignment disabled', () => {
    const production = manifest('production');
    const valid = readSignedManifest(production);
    expect(
      isReleaseManifestCompatible(valid, {
        service: 'worker',
        revision: SHA,
        environment: 'production',
        artifactDigest: OTHER_DIGEST,
      })
    ).toBe(true);

    production.capabilities.financialProvider = 'fake';
    const invalid = readReleaseManifest(writeManifest(production));
    expect(invalid.status).toBe('invalid');
  });

  it('allows held image evidence only for explicitly non-promotable local manifests', () => {
    const local = manifest('local');
    local.components.backend.imageEvidence = 'IMAGE_UNAVAILABLE_HELD';
    local.components.backend.imageDigest = null;
    expect(readReleaseManifest(writeManifest(local)).status).toBe('valid');

    const staging = manifest('staging');
    staging.components.backend.imageEvidence = 'IMAGE_UNAVAILABLE_HELD';
    staging.components.backend.imageDigest = null;
    const held = readReleaseManifest(writeManifest(staging));
    expect(held.status).toBe('invalid');
    expect(held.errors.join('\n')).toMatch(/staging image must be verified and immutable/u);

    const contradictory = manifest('local');
    contradictory.components.backend.imageEvidence = 'IMAGE_UNAVAILABLE_HELD';
    expect(readReleaseManifest(writeManifest(contradictory)).errors.join('\n')).toMatch(
      /held imageEvidence requires imageDigest=null/u
    );
  });

  it('rejects unknown fields, embedded credentials, and positive money effects', () => {
    const unsafe = manifest() as ReleaseManifest & {
      apiToken?: string;
      capabilities: ReleaseManifest['capabilities'] & { customerMoneyCreation: boolean };
    };
    unsafe.apiToken = 'github_pat_must-never-be-in-a-manifest';
    unsafe.capabilities.customerMoneyCreation = true;

    const invalid = readReleaseManifest(writeManifest(unsafe));
    expect(invalid.status).toBe('invalid');
    expect(invalid.errors.join('\n')).toMatch(/apiToken|secret material|customerMoneyCreation/u);
  });

  it('rejects a competing Charter authority or placeholder capability policy', () => {
    const competing = manifest();
    competing.authority.charterRevision = OTHER_SHA as typeof competing.authority.charterRevision;
    competing.authority.capabilityPolicyDigest = `sha256:${'0'.repeat(64)}`;
    const invalid = readReleaseManifest(writeManifest(competing));
    expect(invalid.status).toBe('invalid');
    expect(invalid.errors.join('\n')).toMatch(/signed Charter authority SHA|capabilityPolicyDigest/u);
  });

  it('returns unattributed evidence for missing or malformed manifests', () => {
    expect(readReleaseManifest(join(tmpdir(), 'missing-hx-release.json')).status).toBe(
      'unattributed'
    );
    const malformed = writeManifest({ releaseId: 'invented' });
    expect(readReleaseManifest(malformed).status).toBe('invalid');
  });

  it('never treats unsigned, unpinned, or digest-substituted evidence as deployable', () => {
    const exact = manifest();
    const unsigned = readReleaseManifest(writeManifest(exact));
    expect(unsigned.status).toBe('valid');
    expect(unsigned.authentication.status).toBe('missing');
    expect(isReleaseManifestCompatible(unsigned, {
      service: 'backend', revision: SHA, environment: 'staging',
    })).toBe(false);

    const digest = releaseManifestDigest(exact);
    const signatureRaw = JSON.stringify({
      version: 1,
      algorithm: 'ed25519',
      keyId: 'not-pinned',
      manifestDigest: digest,
      signature: sign(
        null,
        releaseManifestSignaturePayload(digest),
        releaseAuthority.privateKey,
      ).toString('base64'),
    });
    const unpinned = readReleaseManifest(writeManifest(exact), { signatureRaw });
    expect(unpinned.authentication.status).toBe('untrusted_key');

    const changed = manifest();
    changed.releaseId = 'staging-substituted-0001';
    const substituted = readReleaseManifest(writeManifest(changed), {
      signatureRaw,
      trustedPublicKeys: { 'not-pinned': RELEASE_PUBLIC_KEY },
    });
    expect(substituted.authentication.status).toBe('invalid');
  });
});
