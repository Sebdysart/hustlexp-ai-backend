import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import { PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS } from '../../src/releaseAuthorityKeys.js';
import {
  readReleaseManifest,
  releaseManifestDigest,
  releaseManifestSignaturePayload,
  STAGING_PROMOTION_AUTHORITY_ENROLLED,
  type LegacyLocalReleaseManifestV1,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
  type ReleaseManifestV2,
} from '../../src/releaseManifest.js';
import {
  composeRuntimeDatabaseReleaseAuthority,
  composeRuntimeDatabaseReleaseAuthorityKernelForTest,
  type RuntimeDatabaseReleaseAuthorityComposition,
} from '../../src/jobs/runtime-database-release-authority.js';
import {
  runtimeDatabaseBuildProofDigest,
  type RuntimeDatabaseAuthorityComponent,
  type RuntimeDatabaseReleaseVerificationRequest,
} from '../../src/jobs/runtime-database-authority.js';

const COMPONENTS = ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'] as const;
const DATABASE_COMPONENTS = ['api', 'worker', 'attester'] as const;
const KEY_ID = 'hustlexp-runtime-database-release-test-v1';
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('2a'.repeat(32), 'hex'),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const PUBLIC_KEY = createPublicKey(PRIVATE_KEY).export({ type: 'spki', format: 'pem' }).toString();
const directories: string[] = [];
const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  VITEST: process.env.VITEST,
  HX_RELEASE_PROMOTION_MODE: process.env.HX_RELEASE_PROMOTION_MODE,
  HX_PREVIOUS_RELEASE_MANIFEST_JSON: process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON,
  HX_PREVIOUS_RELEASE_MANIFEST_PATH: process.env.HX_PREVIOUS_RELEASE_MANIFEST_PATH,
};

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function revision(character: string): string {
  return character.repeat(40);
}

function manifest(environment: ReleaseManifestV2['environment'] = 'preview'): ReleaseManifestV2 {
  return {
    $schema: '../schemas/release-manifest.schema.json',
    version: 2,
    environment,
    releaseId: `${environment}-runtime-database-release-001`,
    createdAt: '2026-09-01T20:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: digest('9'),
    },
    components: {
      backend: {
        revision: revision('1'),
        artifactDigest: digest('1'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('2'),
      },
      worker: {
        revision: revision('2'),
        artifactDigest: digest('3'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('4'),
      },
      web: {
        revision: revision('3'),
        artifactDigest: digest('5'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('6'),
      },
      migration: { revision: revision('4'), artifactDigest: digest('7') },
      policy: { revision: revision('5'), artifactDigest: digest('8') },
      fixtures: {
        revision: revision('6'),
        artifactDigest: digest('a'),
        providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        providerImageDigest: digest('b'),
        databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        databaseImageDigest: digest('c'),
      },
    },
    infrastructure: {
      revision: revision('7'),
      artifactDigest: digest('d'),
      desiredTopologyDigest: digest('e'),
    },
    databaseTargets: {
      api: { component: 'api', environment, databaseTargetDigest: digest('4') },
      worker: { component: 'worker', environment, databaseTargetDigest: digest('5') },
      attester: { component: 'attester', environment, databaseTargetDigest: digest('6') },
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
      changedComponents: [...COMPONENTS],
      infrastructureChanged: true,
    },
    acceptance: {
      backend: { kind: 'http', component: 'backend', path: '/health' },
      worker: { kind: 'http', component: 'worker', path: '/health' },
      web: { kind: 'http', component: 'web', path: '/version.json' },
      migration: {
        kind: 'receipt',
        component: 'migration',
        receiptType: 'migration-execution-v1',
      },
      policy: {
        kind: 'receipt',
        component: 'policy',
        receiptType: 'canonical-policy-digest-v1',
      },
      fixtures: {
        kind: 'receipt',
        component: 'fixtures',
        receiptType: 'fixture-seed-v1',
      },
      infrastructure: {
        kind: 'readback',
        binding: 'infrastructure',
        receiptType: 'infrastructure-readback-v1',
      },
    },
  };
}

function legacyManifest(): LegacyLocalReleaseManifestV1 {
  const current = manifest('local');
  return {
    $schema: current.$schema,
    version: 1,
    environment: 'local',
    releaseId: 'local-runtime-database-release-legacy-001',
    createdAt: current.createdAt,
    authority: current.authority,
    components: {
      backend: current.components.backend,
      worker: current.components.worker,
      web: current.components.web,
      migration: current.components.migration,
      policy: current.components.policy,
      fixtures: {
        revision: current.components.fixtures.revision,
        artifactDigest: current.components.fixtures.artifactDigest,
        imageEvidence: current.components.fixtures.providerImageEvidence,
        imageDigest: current.components.fixtures.providerImageDigest,
      },
    },
    capabilities: current.capabilities,
    promotion: { baseManifestDigest: null, changedComponents: [...COMPONENTS] },
    health: {
      backend: { component: 'backend', path: '/health' },
      worker: { component: 'worker', path: '/health' },
      web: { component: 'web', path: '/version.json' },
    },
  };
}

function restoreEnvironment(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function issueEvidence(value: ReleaseManifest, authenticated = true): ReleaseManifestEvidence {
  const directory = mkdtempSync(join(tmpdir(), 'hx-runtime-db-release-'));
  directories.push(directory);
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  const manifestDigest = releaseManifestDigest(value);
  const signature = sign(
    null,
    releaseManifestSignaturePayload(manifestDigest, value.version),
    PRIVATE_KEY
  ).toString('base64');
  return readReleaseManifest(path, {
    signatureRaw: authenticated
      ? JSON.stringify({
          version: 1,
          algorithm: 'ed25519',
          keyId: KEY_ID,
          manifestDigest,
          signature,
        })
      : undefined,
    signatureSource: authenticated ? 'focused-test-vector' : 'none',
    trustedPublicKeys: { [KEY_ID]: PUBLIC_KEY },
  });
}

function releaseComponent(component: RuntimeDatabaseAuthorityComponent): 'backend' | 'worker' {
  return component === 'worker' ? 'worker' : 'backend';
}

function identityFor(
  value: ReleaseManifestV2,
  component: RuntimeDatabaseAuthorityComponent
): Readonly<BuildIdentity> {
  const executable = value.components[releaseComponent(component)];
  return Object.freeze({
    schema_version: 1,
    service: 'hustlexp-engine',
    revision: executable.revision,
    built_at: '2026-09-01T20:00:00.000Z',
    environment: value.environment,
    clean_source: true,
    source: 'focused-test-vector',
    artifact_digest: executable.artifactDigest,
    artifact_verified: true,
  });
}

function requestFor(
  authority: RuntimeDatabaseReleaseAuthorityComposition
): RuntimeDatabaseReleaseVerificationRequest {
  return {
    component: authority.component,
    releaseComponent: authority.releaseComponent,
    environment: authority.environment,
    databaseTargetDigest: authority.databaseTargetDigest,
    pins: authority.releasePins,
  };
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.VITEST = 'true';
  delete process.env.HX_RELEASE_PROMOTION_MODE;
  delete process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON;
  delete process.env.HX_PREVIOUS_RELEASE_MANIFEST_PATH;
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  restoreEnvironment('NODE_ENV');
  restoreEnvironment('VITEST');
  restoreEnvironment('HX_RELEASE_PROMOTION_MODE');
  restoreEnvironment('HX_PREVIOUS_RELEASE_MANIFEST_JSON');
  restoreEnvironment('HX_PREVIOUS_RELEASE_MANIFEST_PATH');
});

describe('runtime database release authority composition', () => {
  it('binds api, worker, and attester to their exact signed component and target', async () => {
    const exact = manifest();
    const evidence = issueEvidence(exact);
    for (const component of DATABASE_COMPONENTS) {
      const authority = composeRuntimeDatabaseReleaseAuthorityKernelForTest(
        evidence,
        component,
        identityFor(exact, component)
      );
      const mappedComponent = releaseComponent(component);
      expect(authority).toEqual(
        expect.objectContaining({
          component,
          releaseComponent: mappedComponent,
          environment: exact.environment,
          databaseTargetDigest: exact.databaseTargets[component].databaseTargetDigest,
        })
      );
      expect(authority.releasePins).toEqual({
        manifestDigest: evidence.digest,
        signerKeyId: evidence.authentication.keyId,
        signerKeyFingerprint: evidence.authentication.keyFingerprint,
        revision: exact.components[mappedComponent].revision,
        artifactDigest: exact.components[mappedComponent].artifactDigest,
      });
      expect(Object.isFrozen(authority)).toBe(true);
      expect(Object.isFrozen(authority.releasePins)).toBe(true);
      expect(Object.isFrozen(authority.verifier)).toBe(true);
      expect(Object.keys(authority).sort()).toEqual([
        'component',
        'databaseTargetDigest',
        'environment',
        'releaseComponent',
        'releasePins',
        'verifier',
      ]);

      const proof = await authority.verifier.verifyReleaseAuthority(requestFor(authority));
      expect(proof).toEqual({
        schemaVersion: 1,
        signatureAlgorithm: 'ed25519',
        canonicalManifestDigest: evidence.digest,
        manifestDigest: evidence.digest,
        signerKeyId: evidence.authentication.keyId,
        signerKeyFingerprint: evidence.authentication.keyFingerprint,
        environment: exact.environment,
        component: mappedComponent,
        revision: exact.components[mappedComponent].revision,
        artifactDigest: exact.components[mappedComponent].artifactDigest,
        databaseTargetDigest: exact.databaseTargets[component].databaseTargetDigest,
        build: {
          identityDigest: runtimeDatabaseBuildProofDigest({
            releaseManifestDigest: evidence.digest,
            environment: exact.environment,
            component: mappedComponent,
            revision: exact.components[mappedComponent].revision,
            artifactDigest: exact.components[mappedComponent].artifactDigest,
            databaseTargetDigest: exact.databaseTargets[component].databaseTargetDigest,
          }),
          releaseManifestDigest: evidence.digest,
          environment: exact.environment,
          component: mappedComponent,
          revision: exact.components[mappedComponent].revision,
          artifactDigest: exact.components[mappedComponent].artifactDigest,
          databaseTargetDigest: exact.databaseTargets[component].databaseTargetDigest,
        },
      });
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.isFrozen(proof.build)).toBe(true);
    }
  });

  it('accepts only exact module-issued authenticated V2 evidence', () => {
    const exact = manifest();
    const evidence = issueEvidence(exact);
    const identity = identityFor(exact, 'api');
    expect(() =>
      composeRuntimeDatabaseReleaseAuthorityKernelForTest(
        { ...evidence } as ReleaseManifestEvidence,
        'api',
        identity
      )
    ).toThrow('AUTHENTICATED_V2_RELEASE_MANIFEST_REQUIRED');
    expect(() =>
      composeRuntimeDatabaseReleaseAuthorityKernelForTest(
        issueEvidence(exact, false),
        'api',
        identity
      )
    ).toThrow('AUTHENTICATED_V2_RELEASE_MANIFEST_REQUIRED');

    const legacy = legacyManifest();
    expect(() =>
      composeRuntimeDatabaseReleaseAuthorityKernelForTest(
        issueEvidence(legacy),
        'api',
        Object.freeze({
          ...identityFor(manifest('local'), 'api'),
          environment: 'local',
        })
      )
    ).toThrow('AUTHENTICATED_V2_RELEASE_MANIFEST_REQUIRED');

    const missingTargets = structuredClone(exact) as unknown as Record<string, unknown>;
    delete missingTargets.databaseTargets;
    expect(() =>
      composeRuntimeDatabaseReleaseAuthorityKernelForTest(
        issueEvidence(missingTargets as unknown as ReleaseManifest),
        'api',
        identity
      )
    ).toThrow('AUTHENTICATED_V2_RELEASE_MANIFEST_REQUIRED');
  });

  it('rejects dirty, unverified, environment-, revision-, and artifact-drifted identities', () => {
    const exact = manifest();
    const evidence = issueEvidence(exact);
    const identity = identityFor(exact, 'api');
    for (const changed of [
      { clean_source: false },
      { artifact_verified: false },
      { environment: 'local' },
      { revision: revision('f') },
      { artifact_digest: digest('f') },
    ]) {
      expect(() =>
        composeRuntimeDatabaseReleaseAuthorityKernelForTest(
          evidence,
          'api',
          Object.freeze({ ...identity, ...changed })
        )
      ).toThrow(/BUILD_IDENTITY_(?:INVALID|MISMATCH)/u);
    }
  });

  it('refuses a fixture-only signing key before composing canonical release authority', () => {
    expect(PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS).not.toHaveProperty(KEY_ID);
    const evidence = issueEvidence(manifest());
    expect(() => composeRuntimeDatabaseReleaseAuthority(evidence, 'api')).toThrow(
      'RUNTIME_DATABASE_RELEASE_AUTHORITY_REFUSED:SIGNING_AUTHORITY_INVALID'
    );
  });

  it('rejects every request binding drift and mixed composition pins', async () => {
    const exact = manifest();
    const evidence = issueEvidence(exact);
    const api = composeRuntimeDatabaseReleaseAuthorityKernelForTest(
      evidence,
      'api',
      identityFor(exact, 'api')
    );
    const worker = composeRuntimeDatabaseReleaseAuthorityKernelForTest(
      evidence,
      'worker',
      identityFor(exact, 'worker')
    );
    const request = requestFor(api);
    const cases: RuntimeDatabaseReleaseVerificationRequest[] = [
      { ...request, component: 'worker' },
      { ...request, releaseComponent: 'worker' },
      { ...request, environment: 'local' },
      { ...request, databaseTargetDigest: digest('f') },
      { ...request, pins: worker.releasePins },
      { ...request, pins: { ...request.pins, manifestDigest: digest('f') } },
      { ...request, pins: { ...request.pins, signerKeyId: 'wrong-key' } },
      { ...request, pins: { ...request.pins, signerKeyFingerprint: digest('f') } },
      { ...request, pins: { ...request.pins, revision: revision('f') } },
      { ...request, pins: { ...request.pins, artifactDigest: digest('f') } },
    ];
    for (const changed of cases) {
      await expect(api.verifier.verifyReleaseAuthority(changed)).rejects.toMatchObject({
        code: 'VERIFICATION_REQUEST_MISMATCH',
      });
    }
  });

  it('rejects missing, extra, and symbol request or pin fields', async () => {
    const exact = manifest();
    const authority = composeRuntimeDatabaseReleaseAuthorityKernelForTest(
      issueEvidence(exact),
      'api',
      identityFor(exact, 'api')
    );
    const request = requestFor(authority);
    const { environment: _environment, ...missing } = request;
    const extra = { ...request, proof: 'caller-authored' };
    const symbol = { ...request };
    Object.defineProperty(symbol, Symbol('caller-authored'), { enumerable: true, value: true });
    const { revision: _revision, ...pinMissing } = request.pins;
    const pinExtra = { ...request.pins, proof: 'caller-authored' };
    for (const changed of [
      missing,
      extra,
      symbol,
      { ...request, pins: pinMissing },
      { ...request, pins: pinExtra },
    ]) {
      await expect(
        authority.verifier.verifyReleaseAuthority(
          changed as RuntimeDatabaseReleaseVerificationRequest
        )
      ).rejects.toMatchObject({ code: 'VERIFICATION_REQUEST_INVALID' });
    }
  });

  it('snapshots getters once and recomputes fresh proof only from closed evidence', async () => {
    const exact = manifest();
    const authority = composeRuntimeDatabaseReleaseAuthorityKernelForTest(
      issueEvidence(exact),
      'api',
      identityFor(exact, 'api')
    );
    const expected = requestFor(authority);
    const reads = new Map<string, number>();
    const readOnce = <T>(name: string, first: T, later: T) => () => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      return count === 1 ? first : later;
    };
    const pins = {} as RuntimeDatabaseReleaseVerificationRequest['pins'];
    for (const key of [
      'manifestDigest',
      'signerKeyId',
      'signerKeyFingerprint',
      'revision',
      'artifactDigest',
    ] as const) {
      Object.defineProperty(pins, key, {
        enumerable: true,
        get: readOnce(`pins.${key}`, expected.pins[key], 'forged'),
      });
    }
    const request = {} as RuntimeDatabaseReleaseVerificationRequest;
    const values = {
      component: expected.component,
      releaseComponent: expected.releaseComponent,
      environment: expected.environment,
      databaseTargetDigest: expected.databaseTargetDigest,
      pins,
    };
    for (const key of Object.keys(values) as Array<keyof typeof values>) {
      Object.defineProperty(request, key, {
        enumerable: true,
        get: readOnce(`request.${key}`, values[key], 'forged'),
      });
    }

    const first = await authority.verifier.verifyReleaseAuthority(request);
    const second = await authority.verifier.verifyReleaseAuthority(expected);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.build).not.toBe(second.build);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(first.databaseTargetDigest).toBe(authority.databaseTargetDigest);
    expect(first.build.identityDigest).toBe(
      runtimeDatabaseBuildProofDigest({
        releaseManifestDigest: authority.releasePins.manifestDigest,
        environment: authority.environment,
        component: authority.releaseComponent,
        revision: authority.releasePins.revision,
        artifactDigest: authority.releasePins.artifactDigest,
        databaseTargetDigest: authority.databaseTargetDigest,
      })
    );
  });

  it('requires protected staging enrollment even for a correctly signed V2 manifest', () => {
    process.env.HX_RELEASE_PROMOTION_MODE = 'INITIAL';
    const exact = manifest('staging');
    const evidence = issueEvidence(exact);
    expect(evidence.status).toBe('valid');
    expect(STAGING_PROMOTION_AUTHORITY_ENROLLED).toBe(false);
    expect(() =>
      composeRuntimeDatabaseReleaseAuthorityKernelForTest(
        evidence,
        'api',
        identityFor(exact, 'api')
      )
    ).toThrow('AUTHENTICATED_V2_RELEASE_MANIFEST_REQUIRED');
  });

  it('keeps the identity dependency seam unavailable outside focused Vitest', () => {
    const exact = manifest();
    const evidence = issueEvidence(exact);
    process.env.VITEST = 'false';
    expect(() =>
      composeRuntimeDatabaseReleaseAuthorityKernelForTest(
        evidence,
        'api',
        identityFor(exact, 'api')
      )
    ).toThrow('TEST_VECTOR_DEPENDENCY_FORBIDDEN');
  });

  it('requires a newly signed manifest when a database target changes', async () => {
    const firstManifest = manifest();
    const first = composeRuntimeDatabaseReleaseAuthorityKernelForTest(
      issueEvidence(firstManifest),
      'api',
      identityFor(firstManifest, 'api')
    );
    const secondManifest = structuredClone(firstManifest);
    secondManifest.releaseId = 'preview-runtime-database-release-002';
    secondManifest.createdAt = '2026-09-01T21:00:00.000Z';
    secondManifest.databaseTargets.api.databaseTargetDigest = digest('f');
    const second = composeRuntimeDatabaseReleaseAuthorityKernelForTest(
      issueEvidence(secondManifest),
      'api',
      identityFor(secondManifest, 'api')
    );
    expect(second.releasePins.manifestDigest).not.toBe(first.releasePins.manifestDigest);
    expect(second.databaseTargetDigest).toBe(digest('f'));
    await expect(
      first.verifier.verifyReleaseAuthority({
        ...requestFor(first),
        databaseTargetDigest: second.databaseTargetDigest,
      })
    ).rejects.toMatchObject({ code: 'VERIFICATION_REQUEST_MISMATCH' });
  });
});
