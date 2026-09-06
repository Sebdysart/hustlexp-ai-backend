import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS } from '../../src/releaseAuthorityKeys';
import {
  isAuthenticatedReleaseManifest,
  isReleaseManifestCompatible,
  readReleaseManifest,
  releaseManifestDigest,
  releaseManifestForRuntime,
  releaseManifestSignaturePayload,
  STAGING_PROMOTION_AUTHORITY_ENROLLED,
  verifyReleaseManifest,
  verifyReleasePromotion,
  type LegacyLocalReleaseManifestV1,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
  type ReleaseManifestV2,
} from '../../src/releaseManifest';

const COMPONENTS = ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'] as const;
const VECTOR_DIGEST = 'sha256:10acd25d53095bbca440fceb1020110fdb1bdf9c31b36082271e0fcd6463aedf';
const VECTOR_SIGNATURE =
  'Ja/zcp0/1C0DXDzxbGioY5zK5jihJLlgcsbmHMc+Ar/zgjsKAop4crYW4WkmMv7t1meN93JIYKYMttHFM0AECw==';
const VECTOR_SIGNATURE_DIGEST =
  'sha256:13e722525091fdb1730a1a851e8130832f1645c2baf7540a1a0967d71d30e536';
const VECTOR_KEY_FINGERPRINT =
  'sha256:235f0c4208ac567d21f81c3291276bb6cc68a6ba4ba46f73d5470b08ee0c9f6c';
const VECTOR_KEY_ID = 'hustlexp-cross-runtime-v2';
const VECTOR_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('1f'.repeat(32), 'hex'),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const VECTOR_PUBLIC_KEY = createPublicKey(VECTOR_PRIVATE_KEY);
const VECTOR_PUBLIC_KEY_PEM = VECTOR_PUBLIC_KEY.export({ type: 'spki', format: 'pem' }).toString();
const directories: string[] = [];
const runtimeEnvironmentKeys = [
  'HX_RELEASE_MANIFEST_SIGNATURE_JSON',
  'HX_RELEASE_MANIFEST_SIGNATURE_PATH',
  'HX_RELEASE_PROMOTION_MODE',
  'HX_PREVIOUS_RELEASE_MANIFEST_JSON',
  'HX_PREVIOUS_RELEASE_MANIFEST_PATH',
] as const;
const originalRuntimeEnvironment = Object.fromEntries(
  runtimeEnvironmentKeys.map((name) => [name, process.env[name]])
) as Record<(typeof runtimeEnvironmentKeys)[number], string | undefined>;

function digest(value: string): string {
  return `sha256:${value.repeat(64)}`;
}

function revision(value: string): string {
  return value.repeat(40);
}

function manifest(environment: ReleaseManifestV2['environment'] = 'staging'): ReleaseManifestV2 {
  return {
    $schema: '../schemas/release-manifest.schema.json',
    version: 2,
    environment,
    releaseId: `${environment}-20260826-001`,
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
        revision: revision('1'),
        artifactDigest: digest('2'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('3'),
      },
      worker: {
        revision: revision('2'),
        artifactDigest: digest('3'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('4'),
      },
      web: {
        revision: revision('3'),
        artifactDigest: digest('4'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('5'),
      },
      migration: { revision: revision('4'), artifactDigest: digest('5') },
      policy: { revision: revision('5'), artifactDigest: digest('6') },
      fixtures: {
        revision: revision('6'),
        artifactDigest: digest('1'),
        providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        providerImageDigest: digest('7'),
        databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        databaseImageDigest: digest('8'),
      },
    },
    infrastructure: {
      revision: revision('9'),
      artifactDigest: digest('a'),
      desiredTopologyDigest: digest('b'),
    },
    databaseTargets: {
      api: {
        component: 'api',
        environment,
        databaseTargetDigest: digest('c'),
      },
      worker: {
        component: 'worker',
        environment,
        databaseTargetDigest: digest('d'),
      },
      attester: {
        component: 'attester',
        environment,
        databaseTargetDigest: digest('e'),
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

function legacyLocalManifest(): LegacyLocalReleaseManifestV1 {
  const exact = manifest('local');
  return {
    $schema: exact.$schema,
    version: 1,
    environment: 'local',
    releaseId: 'local-legacy-20260826-001',
    createdAt: exact.createdAt,
    authority: exact.authority,
    components: {
      backend: exact.components.backend,
      worker: exact.components.worker,
      web: exact.components.web,
      migration: exact.components.migration,
      policy: exact.components.policy,
      fixtures: {
        revision: exact.components.fixtures.revision,
        artifactDigest: exact.components.fixtures.artifactDigest,
        imageEvidence: exact.components.fixtures.providerImageEvidence,
        imageDigest: exact.components.fixtures.providerImageDigest,
      },
    },
    capabilities: exact.capabilities,
    promotion: {
      baseManifestDigest: null,
      changedComponents: [...COMPONENTS],
    },
    health: {
      backend: { component: 'backend', path: '/health' },
      worker: { component: 'worker', path: '/health' },
      web: { component: 'web', path: '/version.json' },
    },
  };
}

function writeManifest(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'hx-release-v2-'));
  directories.push(directory);
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function signatureEnvelope(value: ReleaseManifest, version = value.version) {
  const manifestDigest = releaseManifestDigest(value);
  return {
    version: 1,
    algorithm: 'ed25519',
    keyId: VECTOR_KEY_ID,
    manifestDigest,
    signature: sign(
      null,
      releaseManifestSignaturePayload(manifestDigest, version),
      VECTOR_PRIVATE_KEY
    ).toString('base64'),
  };
}

function readSignedManifest(value: ReleaseManifest) {
  return readReleaseManifest(writeManifest(value), {
    signatureRaw: JSON.stringify(signatureEnvelope(value)),
    signatureSource: 'unit-test-detached-signature',
    trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
  });
}

beforeEach(() => {
  delete process.env.HX_RELEASE_MANIFEST_SIGNATURE_JSON;
  delete process.env.HX_RELEASE_MANIFEST_SIGNATURE_PATH;
  delete process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON;
  delete process.env.HX_PREVIOUS_RELEASE_MANIFEST_PATH;
  process.env.HX_RELEASE_PROMOTION_MODE = 'INITIAL';
});

afterEach(() => {
  for (const name of runtimeEnvironmentKeys) {
    const value = originalRuntimeEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('platform-converged release manifest contract', () => {
  it('matches fixed platform digest, V2 payload, and Ed25519 signature vectors', () => {
    const exact = manifest();
    const manifestDigest = releaseManifestDigest(exact);
    const signature = sign(
      null,
      releaseManifestSignaturePayload(manifestDigest, 2),
      VECTOR_PRIVATE_KEY
    );

    expect(manifestDigest).toBe(VECTOR_DIGEST);
    expect(releaseManifestSignaturePayload(manifestDigest, 2).toString('utf8')).toBe(
      `HUSTLEXP_RELEASE_MANIFEST_V2\n${VECTOR_DIGEST}\n`
    );
    expect(signature.toString('base64')).toBe(VECTOR_SIGNATURE);
    expect(`sha256:${createHash('sha256').update(signature).digest('hex')}`).toBe(
      VECTOR_SIGNATURE_DIGEST
    );
    expect(
      `sha256:${createHash('sha256')
        .update(VECTOR_PUBLIC_KEY.export({ type: 'spki', format: 'der' }))
        .digest('hex')}`
    ).toBe(VECTOR_KEY_FINGERPRINT);

    expect(Object.keys(PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS)).toEqual([
      'hustlexp-release-2026-v1',
    ]);
    const pinnedKey = createPublicKey(
      PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS['hustlexp-release-2026-v1']
    );
    expect(
      `sha256:${createHash('sha256')
        .update(pinnedKey.export({ type: 'spki', format: 'der' }))
        .digest('hex')}`
    ).toBe('sha256:1357325729c6439a494ede241b67bd550935ad9946e8bf11079bf41e83a6fa98');

    const evidence = readReleaseManifest(writeManifest(exact), {
      signatureRaw: JSON.stringify({
        version: 1,
        algorithm: 'ed25519',
        keyId: VECTOR_KEY_ID,
        manifestDigest,
        signature: VECTOR_SIGNATURE,
      }),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    });
    expect(evidence.status).toBe('valid');
    expect(evidence.authentication).toMatchObject({
      status: 'verified',
      keyFingerprint: VECTOR_KEY_FINGERPRINT,
      signatureDigest: VECTOR_SIGNATURE_DIGEST,
    });
  });

  it('canonicalizes object keys while binding infrastructure and all acceptance lanes', () => {
    const exact = manifest();
    const reordered = {
      acceptance: exact.acceptance,
      promotion: exact.promotion,
      capabilities: exact.capabilities,
      databaseTargets: exact.databaseTargets,
      infrastructure: exact.infrastructure,
      components: exact.components,
      authority: exact.authority,
      createdAt: exact.createdAt,
      releaseId: exact.releaseId,
      environment: exact.environment,
      version: exact.version,
      $schema: exact.$schema,
    };
    expect(releaseManifestDigest(reordered)).toBe(VECTOR_DIGEST);

    const changed = structuredClone(exact);
    changed.infrastructure.desiredTopologyDigest = digest('c');
    expect(releaseManifestDigest(changed)).not.toBe(VECTOR_DIGEST);

    const databaseTargetChanged = structuredClone(exact);
    databaseTargetChanged.databaseTargets.attester.databaseTargetDigest = digest('f');
    expect(releaseManifestDigest(databaseTargetChanged)).not.toBe(VECTOR_DIGEST);
  });

  it('requires exact authenticated v2 service revision and artifact for hosted health', () => {
    delete process.env.HX_RELEASE_PROMOTION_MODE;
    const exact = manifest('preview');
    const signed = readSignedManifest(exact);
    const runtime = {
      service: 'backend' as const,
      revision: exact.components.backend.revision,
      artifactDigest: exact.components.backend.artifactDigest,
      environment: 'preview',
    };
    expect(isReleaseManifestCompatible(signed, runtime)).toBe(true);
    expect(releaseManifestForRuntime(signed, runtime).status).toBe('compatible');

    const unsigned = readReleaseManifest(writeManifest(exact));
    expect(isReleaseManifestCompatible(unsigned, runtime)).toBe(false);
    expect(isReleaseManifestCompatible(signed, { ...runtime, artifactDigest: digest('f') })).toBe(
      false
    );
    expect(isReleaseManifestCompatible(signed, { ...runtime, revision: revision('f') })).toBe(
      false
    );
    expect(isReleaseManifestCompatible(signed, { ...runtime, environment: 'production' })).toBe(
      false
    );
    expect(isReleaseManifestCompatible(signed, {
      ...runtime,
      service: 'invented',
      environment: 42,
    } as never)).toBe(false);
  });

  it('never treats unsigned production-shaped evidence as component-compatible', () => {
    delete process.env.HX_RELEASE_PROMOTION_MODE;
    const productionShaped = structuredClone(manifest('preview')) as unknown as {
      environment: 'production';
      components: ReleaseManifestV2['components'];
    };
    productionShaped.environment = 'production';
    const unsigned: ReleaseManifestEvidence = {
      schema_version: 1,
      status: 'valid',
      digest: releaseManifestDigest(productionShaped),
      source: 'adversarial-production-shaped-evidence',
      errors: [],
      manifest: productionShaped as never,
      authentication: {
        status: 'missing',
        algorithm: null,
        keyId: null,
        keyFingerprint: null,
        signatureDigest: null,
        source: 'none',
        errors: ['detached release signature is unavailable'],
      },
    };
    const runtime = {
      service: 'backend' as const,
      revision: productionShaped.components.backend.revision,
      artifactDigest: productionShaped.components.backend.artifactDigest,
      environment: 'production',
    };

    expect(isReleaseManifestCompatible(unsigned, runtime)).toBe(false);
    expect(releaseManifestForRuntime(unsigned, runtime).status).toBe('invalid');
  });

  it('rejects fabricated, cloned, and rebound authentication evidence', () => {
    delete process.env.HX_RELEASE_PROMOTION_MODE;
    const exact = manifest('preview');
    const signed = readSignedManifest(exact);

    expect(isAuthenticatedReleaseManifest(signed)).toBe(true);
    expect(Object.isFrozen(signed)).toBe(true);
    expect(Object.isFrozen(signed.manifest)).toBe(true);

    const cloned = structuredClone(signed);
    expect(isAuthenticatedReleaseManifest(cloned)).toBe(false);

    const fabricated = {
      ...structuredClone(signed),
      authentication: { ...signed.authentication, status: 'verified' as const },
    };
    expect(isAuthenticatedReleaseManifest(fabricated)).toBe(false);

    const rebound = structuredClone(signed);
    if (!rebound.manifest || rebound.manifest.version !== 2) {
      throw new Error('expected an exact manifest v2 test fixture');
    }
    rebound.manifest.components.backend.revision = revision('f');
    rebound.digest = releaseManifestDigest(rebound.manifest);
    expect(rebound.authentication.status).toBe('verified');
    expect(isAuthenticatedReleaseManifest(rebound)).toBe(false);
  });

  it('holds both initial and historical staging evidence until promotion authority is enrolled', () => {
    expect(STAGING_PROMOTION_AUTHORITY_ENROLLED).toBe(false);

    process.env.HX_RELEASE_PROMOTION_MODE = 'INITIAL';
    const initialManifest = manifest();
    const initial = readSignedManifest(initialManifest);
    const initialRuntime = {
      service: 'backend' as const,
      revision: initialManifest.components.backend.revision,
      artifactDigest: initialManifest.components.backend.artifactDigest,
      environment: 'staging',
    };
    expect(initial).toMatchObject({
      status: 'valid',
      authentication: { status: 'verified' },
    });
    expect(isAuthenticatedReleaseManifest(initial)).toBe(false);
    expect(isReleaseManifestCompatible(initial, initialRuntime)).toBe(false);

    const chainedManifest = structuredClone(initialManifest);
    chainedManifest.releaseId = 'staging-20260826-replay-001';
    chainedManifest.createdAt = '2026-08-26T00:10:00.000Z';
    chainedManifest.components.backend.revision = revision('c');
    chainedManifest.components.backend.artifactDigest = digest('d');
    chainedManifest.components.backend.imageDigest = digest('e');
    chainedManifest.promotion = {
      baseManifestDigest: releaseManifestDigest(initialManifest),
      changedComponents: ['backend'],
      infrastructureChanged: false,
    };
    process.env.HX_RELEASE_PROMOTION_MODE = 'CHAINED';
    process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON = JSON.stringify(initialManifest);
    const chained = readSignedManifest(chainedManifest);
    const chainedRuntime = {
      ...initialRuntime,
      revision: chainedManifest.components.backend.revision,
      artifactDigest: chainedManifest.components.backend.artifactDigest,
    };
    expect(chained).toMatchObject({
      status: 'valid',
      authentication: { status: 'verified' },
    });
    expect(isAuthenticatedReleaseManifest(chained)).toBe(false);
    expect(isReleaseManifestCompatible(chained, chainedRuntime)).toBe(false);
  });

  it('retains v1 only as unsigned local diagnostic evidence', () => {
    delete process.env.HX_RELEASE_PROMOTION_MODE;
    const local = legacyLocalManifest();
    const evidence = readReleaseManifest(writeManifest(local));
    expect(evidence.status).toBe('valid');
    expect(
      isReleaseManifestCompatible(evidence, {
        service: 'backend',
        revision: local.components.backend.revision,
        environment: 'local',
      })
    ).toBe(true);
    expect(verifyReleasePromotion(local, local)).toEqual([
      'shared-staging promotion comparison requires two manifest v2 documents',
    ]);

    const hosted = structuredClone(local) as unknown as { environment: string };
    hosted.environment = 'staging';
    expect(verifyReleaseManifest(hosted).join('\n')).toMatch(
      /v1 is local-only and non-promotable/u
    );

    const claimedV2Shape = { ...local, infrastructure: manifest().infrastructure };
    expect(verifyReleaseManifest(claimedV2Shape).join('\n')).toMatch(
      /manifest\.infrastructure is not allowed/u
    );
  });

  it('allows held images only for local v2 and keeps evidence/digest pairs exact', () => {
    const local = manifest('local');
    local.components.backend.imageEvidence = 'IMAGE_UNAVAILABLE_HELD';
    local.components.backend.imageDigest = null;
    local.components.fixtures.providerImageEvidence = 'IMAGE_UNAVAILABLE_HELD';
    local.components.fixtures.providerImageDigest = null;
    local.components.fixtures.databaseImageEvidence = 'IMAGE_UNAVAILABLE_HELD';
    local.components.fixtures.databaseImageDigest = null;
    expect(verifyReleaseManifest(local)).toEqual([]);

    const hosted = structuredClone(local);
    hosted.environment = 'preview';
    expect(verifyReleaseManifest(hosted).join('\n')).toMatch(
      /preview image must be verified and immutable/u
    );

    const contradictory = manifest('local');
    contradictory.components.fixtures.providerImageEvidence = 'IMAGE_UNAVAILABLE_HELD';
    expect(verifyReleaseManifest(contradictory).join('\n')).toMatch(
      /providerImage held evidence requires digest=null/u
    );
  });

  it('rejects zero placeholders and every digest-equality substitution', () => {
    const zero = manifest();
    zero.components.fixtures.providerImageDigest = digest('0');
    zero.infrastructure.revision = revision('0');
    zero.infrastructure.desiredTopologyDigest = digest('0');
    expect(verifyReleaseManifest(zero).join('\n')).toMatch(/non-placeholder/u);

    for (const service of ['backend', 'worker', 'web'] as const) {
      const equal = manifest();
      equal.components[service].artifactDigest = equal.components[service].imageDigest!;
      expect(verifyReleaseManifest(equal).join('\n')).toMatch(
        new RegExp(`components\\.${service}\\.artifactDigest may not substitute`, 'u')
      );
    }

    const fixtureImages = manifest();
    fixtureImages.components.fixtures.databaseImageDigest =
      fixtureImages.components.fixtures.providerImageDigest;
    expect(verifyReleaseManifest(fixtureImages).join('\n')).toMatch(/distinct bindings/u);

    const fixtureArtifact = manifest();
    fixtureArtifact.components.fixtures.artifactDigest =
      fixtureArtifact.components.fixtures.providerImageDigest!;
    expect(verifyReleaseManifest(fixtureArtifact).join('\n')).toMatch(
      /fixture artifactDigest may not substitute/u
    );

    const infrastructure = manifest();
    infrastructure.infrastructure.desiredTopologyDigest =
      infrastructure.infrastructure.artifactDigest;
    expect(verifyReleaseManifest(infrastructure).join('\n')).toMatch(
      /artifactDigest may not substitute for desiredTopologyDigest/u
    );

    const policy = manifest();
    policy.infrastructure.artifactDigest = policy.components.policy.artifactDigest;
    expect(verifyReleaseManifest(policy).join('\n')).toMatch(
      /policy artifactDigest may not substitute/u
    );
  });

  it('requires exactly six components and seven correctly typed acceptance lanes', () => {
    const missing = manifest() as unknown as {
      components: Record<string, unknown>;
      acceptance: Record<string, unknown>;
    };
    delete missing.components.policy;
    delete missing.acceptance.infrastructure;
    missing.acceptance.backend = { kind: 'receipt', component: 'worker', path: '/ready' };
    expect(verifyReleaseManifest(missing).join('\n')).toMatch(
      /components\.policy is required|acceptance\.infrastructure is required|acceptance\.backend/u
    );

    const extra = manifest() as unknown as {
      components: Record<string, unknown>;
      acceptance: Record<string, unknown>;
    };
    extra.components.unreviewed = { revision: revision('f'), artifactDigest: digest('f') };
    extra.acceptance.unreviewed = { kind: 'http' };
    expect(verifyReleaseManifest(extra).join('\n')).toMatch(
      /components\.unreviewed is not allowed|acceptance\.unreviewed is not allowed/u
    );
  });

  it('requires exact environment-bound api, worker, and attester database targets', () => {
    const missing = manifest() as unknown as {
      databaseTargets: Record<string, unknown>;
    };
    delete missing.databaseTargets.worker;
    expect(verifyReleaseManifest(missing).join('\n')).toMatch(
      /databaseTargets\.worker is required/u
    );

    const extra = manifest() as unknown as {
      databaseTargets: Record<string, unknown>;
    };
    extra.databaseTargets.migration = {
      component: 'migration',
      environment: 'staging',
      databaseTargetDigest: digest('f'),
    };
    expect(verifyReleaseManifest(extra).join('\n')).toMatch(
      /databaseTargets\.migration is not allowed/u
    );

    const malformedEntries = manifest() as unknown as {
      databaseTargets: {
        api: Record<string, unknown>;
        worker: Record<string, unknown>;
      };
    };
    delete malformedEntries.databaseTargets.api.component;
    malformedEntries.databaseTargets.worker.unreviewed = true;
    expect(verifyReleaseManifest(malformedEntries).join('\n')).toMatch(
      /databaseTargets\.api\.component is required|databaseTargets\.worker\.unreviewed is not allowed/u
    );

    const mismatched = manifest();
    mismatched.databaseTargets.api.component = 'worker' as 'api';
    mismatched.databaseTargets.worker.environment = 'preview';
    mismatched.databaseTargets.attester.databaseTargetDigest = `sha256:${'A'.repeat(64)}`;
    expect(verifyReleaseManifest(mismatched).join('\n')).toMatch(
      /databaseTargets\.api\.component must be api|databaseTargets\.worker\.environment must exactly match|databaseTargets\.attester\.databaseTargetDigest must be an exact lowercase/u
    );

    const zero = manifest();
    zero.databaseTargets.api.databaseTargetDigest = digest('0');
    expect(verifyReleaseManifest(zero).join('\n')).toMatch(
      /databaseTargets\.api\.databaseTargetDigest.*non-placeholder/u
    );

    const exact = manifest('preview');
    const signedEnvelope = signatureEnvelope(exact);
    const substituted = structuredClone(exact);
    substituted.databaseTargets.attester.databaseTargetDigest = digest('f');
    const evidence = readReleaseManifest(writeManifest(substituted), {
      signatureRaw: JSON.stringify(signedEnvelope),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    });
    expect(evidence.authentication).toMatchObject({ status: 'invalid' });
    expect(evidence.authentication.errors.join('\n')).toMatch(/canonical manifest digest/u);
  });

  it('compares component and infrastructure promotion declarations exactly', () => {
    const previous = manifest();

    const component = structuredClone(previous);
    component.releaseId = 'staging-20260826-002';
    component.createdAt = '2026-08-26T00:01:00.000Z';
    component.components.backend.revision = revision('c');
    component.components.backend.artifactDigest = digest('d');
    component.components.backend.imageDigest = digest('e');
    component.promotion = {
      baseManifestDigest: releaseManifestDigest(previous),
      changedComponents: ['backend'],
      infrastructureChanged: false,
    };
    expect(verifyReleasePromotion(component, previous)).toEqual([]);

    const contractDrift = structuredClone(component);
    contractDrift.authority.capabilityPolicyDigest = digest('f');
    expect(verifyReleasePromotion(contractDrift, previous).join('\n')).toMatch(
      /authority may not change/u
    );
    const reusedIdentity = structuredClone(component);
    reusedIdentity.releaseId = previous.releaseId;
    reusedIdentity.createdAt = previous.createdAt;
    expect(verifyReleasePromotion(reusedIdentity, previous).join('\n')).toMatch(
      /releaseId must differ|createdAt must be later/u
    );

    const infrastructure = structuredClone(previous);
    infrastructure.releaseId = 'staging-20260826-003';
    infrastructure.createdAt = '2026-08-26T00:02:00.000Z';
    infrastructure.infrastructure.artifactDigest = digest('c');
    infrastructure.infrastructure.desiredTopologyDigest = digest('d');
    infrastructure.promotion = {
      baseManifestDigest: releaseManifestDigest(previous),
      changedComponents: [],
      infrastructureChanged: true,
    };
    expect(verifyReleasePromotion(infrastructure, previous)).toEqual([]);

    for (const [index, targetComponent] of (
      ['api', 'worker', 'attester'] as const
    ).entries()) {
      const databaseTarget = structuredClone(previous);
      databaseTarget.releaseId = `staging-20260826-database-target-${index + 1}`;
      databaseTarget.createdAt = `2026-08-26T00:0${index + 3}:00.000Z`;
      databaseTarget.databaseTargets[targetComponent].databaseTargetDigest = digest('f');
      databaseTarget.promotion = {
        baseManifestDigest: releaseManifestDigest(previous),
        changedComponents: [],
        infrastructureChanged: true,
      };
      expect(verifyReleasePromotion(databaseTarget, previous)).toEqual([]);

      databaseTarget.promotion.infrastructureChanged = false;
      databaseTarget.promotion.changedComponents = ['backend'];
      expect(verifyReleasePromotion(databaseTarget, previous).join('\n')).toMatch(
        /infrastructureChanged must exactly equal infrastructure or database-target payload change/u
      );
    }

    infrastructure.promotion.infrastructureChanged = false;
    infrastructure.promotion.changedComponents = ['worker'];
    expect(verifyReleasePromotion(infrastructure, previous).join('\n')).toMatch(
      /changedComponents|infrastructureChanged/u
    );

    const noOp = structuredClone(previous);
    noOp.releaseId = 'staging-20260826-004';
    noOp.createdAt = '2026-08-26T00:03:00.000Z';
    noOp.promotion = {
      baseManifestDigest: releaseManifestDigest(previous),
      changedComponents: [],
      infrastructureChanged: false,
    };
    expect(verifyReleasePromotion(noOp, previous).join('\n')).toMatch(/no-op/u);
  });

  it('requires an exact staging promotion mode and rejects staging modes outside staging', () => {
    const initial = manifest();
    const initialPath = writeManifest(initial);
    const initialTrust = {
      signatureRaw: JSON.stringify(signatureEnvelope(initial)),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    };
    expect(readReleaseManifest(initialPath, initialTrust).status).toBe('valid');

    process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON = JSON.stringify(initial);
    expect(readReleaseManifest(initialPath, initialTrust).errors.join('\n')).toMatch(
      /initial staging manifest forbids HX_PREVIOUS_RELEASE_MANIFEST/u
    );
    delete process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON;
    process.env.HX_PREVIOUS_RELEASE_MANIFEST_PATH = initialPath;
    expect(readReleaseManifest(initialPath, initialTrust).errors.join('\n')).toMatch(
      /initial staging manifest forbids HX_PREVIOUS_RELEASE_MANIFEST/u
    );
    delete process.env.HX_PREVIOUS_RELEASE_MANIFEST_PATH;

    delete process.env.HX_RELEASE_PROMOTION_MODE;
    expect(readReleaseManifest(initialPath, initialTrust).errors.join('\n')).toMatch(
      /HX_RELEASE_PROMOTION_MODE=INITIAL/u
    );
    process.env.HX_RELEASE_PROMOTION_MODE = 'CHAINED';
    expect(readReleaseManifest(initialPath, initialTrust).errors.join('\n')).toMatch(
      /HX_RELEASE_PROMOTION_MODE=INITIAL/u
    );
    process.env.HX_RELEASE_PROMOTION_MODE = ' initial ';
    expect(readReleaseManifest(initialPath, initialTrust).status).toBe('invalid');

    for (const environment of ['preview', 'local'] as const) {
      const nonStaging = manifest(environment);
      process.env.HX_RELEASE_PROMOTION_MODE = 'INITIAL';
      expect(readReleaseManifest(writeManifest(nonStaging), {
        signatureRaw: JSON.stringify(signatureEnvelope(nonStaging)),
        trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
      }).errors.join('\n')).toMatch(/reserved for staging/u);
    }
  });

  it('loads the exact previous staging manifest and rejects missing or false promotion chains', () => {
    delete process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON;
    delete process.env.HX_PREVIOUS_RELEASE_MANIFEST_PATH;
    const previous = manifest();
    const candidate = structuredClone(previous);
    candidate.releaseId = 'staging-20260826-005';
    candidate.createdAt = '2026-08-26T00:05:00.000Z';
    candidate.components.backend.revision = revision('c');
    candidate.components.backend.artifactDigest = digest('d');
    candidate.components.backend.imageDigest = digest('e');
    candidate.promotion = {
      baseManifestDigest: releaseManifestDigest(previous),
      changedComponents: ['backend'],
      infrastructureChanged: false,
    };
    const candidatePath = writeManifest(candidate);
    const trust = {
      signatureRaw: JSON.stringify(signatureEnvelope(candidate)),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    };

    delete process.env.HX_RELEASE_PROMOTION_MODE;
    const missingMode = readReleaseManifest(candidatePath, trust);
    expect(missingMode.status).toBe('invalid');
    expect(missingMode.errors.join('\n')).toMatch(/HX_RELEASE_PROMOTION_MODE=CHAINED/u);

    process.env.HX_RELEASE_PROMOTION_MODE = 'INITIAL';
    const mismatchedMode = readReleaseManifest(candidatePath, trust);
    expect(mismatchedMode.status).toBe('invalid');
    expect(mismatchedMode.errors.join('\n')).toMatch(/HX_RELEASE_PROMOTION_MODE=CHAINED/u);

    process.env.HX_RELEASE_PROMOTION_MODE = 'CHAINED';
    const missingPrevious = readReleaseManifest(candidatePath, trust);
    expect(missingPrevious.status).toBe('invalid');
    expect(missingPrevious.errors.join('\n')).toMatch(/requires HX_PREVIOUS_RELEASE_MANIFEST/u);

    process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON = JSON.stringify(previous);
    const inline = readReleaseManifest(candidatePath, trust);
    expect(inline.status).toBe('valid');
    const runtime = {
      service: 'backend',
      revision: candidate.components.backend.revision,
      artifactDigest: candidate.components.backend.artifactDigest,
      environment: 'staging',
    } as const;
    expect(isAuthenticatedReleaseManifest(inline)).toBe(false);
    expect(isReleaseManifestCompatible(inline, runtime)).toBe(false);

    process.env.HX_RELEASE_PROMOTION_MODE = 'INITIAL';
    const modeDrift = readReleaseManifest(candidatePath, trust);
    expect(modeDrift.status).toBe('invalid');
    expect(modeDrift.errors.join('\n')).toMatch(/HX_RELEASE_PROMOTION_MODE=CHAINED/u);
    process.env.HX_RELEASE_PROMOTION_MODE = 'CHAINED';

    const substitutedPrevious = structuredClone(previous);
    substitutedPrevious.components.worker.artifactDigest = digest('e');
    substitutedPrevious.components.worker.imageDigest = digest('f');
    process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON = JSON.stringify(substitutedPrevious);
    const substituted = readReleaseManifest(candidatePath, trust);
    expect(substituted.status).toBe('invalid');
    expect(substituted.errors.join('\n')).toMatch(/baseManifestDigest/u);

    const falseDeclaration = structuredClone(candidate);
    falseDeclaration.promotion.changedComponents = ['worker'];
    process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON = JSON.stringify(previous);
    const falseEvidence = readReleaseManifest(writeManifest(falseDeclaration), {
      ...trust,
      signatureRaw: JSON.stringify(signatureEnvelope(falseDeclaration)),
    });
    expect(falseEvidence.status).toBe('invalid');
    expect(falseEvidence.errors.join('\n')).toMatch(/changedComponents/u);

    delete process.env.HX_PREVIOUS_RELEASE_MANIFEST_JSON;
    process.env.HX_PREVIOUS_RELEASE_MANIFEST_PATH = writeManifest(previous);
    expect(readReleaseManifest(candidatePath, trust).status).toBe('valid');
  });

  it('loads an explicit detached signature path and retains adjacent signature fallback', () => {
    delete process.env.HX_RELEASE_MANIFEST_SIGNATURE_JSON;
    delete process.env.HX_RELEASE_PROMOTION_MODE;
    const exact = manifest('preview');
    const manifestPath = writeManifest(exact);
    const signatureRaw = JSON.stringify(signatureEnvelope(exact));
    const explicitPath = `${manifestPath}.detached-signature.json`;
    writeFileSync(explicitPath, signatureRaw, 'utf8');
    process.env.HX_RELEASE_MANIFEST_SIGNATURE_PATH = explicitPath;

    const explicit = readReleaseManifest(manifestPath, {
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    });
    expect(explicit.authentication).toMatchObject({ status: 'verified', source: explicitPath });

    writeFileSync(`${manifestPath}.sig`, signatureRaw, 'utf8');
    process.env.HX_RELEASE_MANIFEST_SIGNATURE_PATH = `${manifestPath}.missing`;
    expect(readReleaseManifest(manifestPath, {
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    }).authentication.status).toBe('missing');

    delete process.env.HX_RELEASE_MANIFEST_SIGNATURE_PATH;
    const adjacent = readReleaseManifest(manifestPath, {
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    });
    expect(adjacent.authentication).toMatchObject({
      status: 'verified',
      source: `${manifestPath}.sig`,
    });
  });

  it('rejects malformed signatures and signatures from the legacy V1 domain', () => {
    const exact = manifest();
    const v1Envelope = signatureEnvelope(exact, 1);
    const wrongDomain = readReleaseManifest(writeManifest(exact), {
      signatureRaw: JSON.stringify(v1Envelope),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    });
    expect(wrongDomain.authentication.errors.join('\n')).toMatch(/signature verification failed/u);

    const malformed = signatureEnvelope(exact);
    malformed.signature = `${malformed.signature} `;
    const malformedEvidence = readReleaseManifest(writeManifest(exact), {
      signatureRaw: JSON.stringify(malformed),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    });
    expect(malformedEvidence.authentication.errors.join('\n')).toMatch(/canonical Ed25519/u);

    const privateKeyTrustAnchor = readReleaseManifest(writeManifest(exact), {
      signatureRaw: JSON.stringify(signatureEnvelope(exact)),
      trustedPublicKeys: {
        [VECTOR_KEY_ID]: VECTOR_PRIVATE_KEY.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
    });
    expect(privateKeyTrustAnchor.authentication).toMatchObject({
      status: 'invalid',
      errors: ['pinned release public key set is invalid'],
    });

    const invalidUnrelatedTrustAnchor = readReleaseManifest(writeManifest(exact), {
      signatureRaw: JSON.stringify(signatureEnvelope(exact)),
      trustedPublicKeys: {
        [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM,
        'unrelated-private-key': VECTOR_PRIVATE_KEY.export({
          type: 'pkcs8',
          format: 'pem',
        }).toString(),
      },
    });
    expect(invalidUnrelatedTrustAnchor.authentication).toMatchObject({
      status: 'invalid',
      errors: ['pinned release public key set is invalid'],
    });

    const invalidTrustWithoutSignature = readReleaseManifest(writeManifest(exact), {
      signatureRaw: '',
      trustedPublicKeys: {
        'unrelated-private-key': VECTOR_PRIVATE_KEY.export({
          type: 'pkcs8',
          format: 'pem',
        }).toString(),
      },
    });
    expect(invalidTrustWithoutSignature.authentication).toMatchObject({
      status: 'invalid',
      errors: ['pinned release public key set is invalid'],
    });

    const nonStringSignature = readReleaseManifest(writeManifest(exact), {
      signatureRaw: 42 as never,
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    });
    expect(nonStringSignature.authentication.status).toBe('missing');

    const unknownField = { ...signatureEnvelope(exact), publicKey: VECTOR_PUBLIC_KEY_PEM };
    expect(readReleaseManifest(writeManifest(exact), {
      signatureRaw: JSON.stringify(unknownField),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    }).authentication.errors.join('\n')).toMatch(/signature\.publicKey is not allowed/u);

    const unpinned = { ...signatureEnvelope(exact), keyId: 'unpinned-release-authority' };
    expect(readReleaseManifest(writeManifest(exact), {
      signatureRaw: JSON.stringify(unpinned),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    }).authentication.status).toBe('untrusted_key');

    const substitutedDigest = { ...signatureEnvelope(exact), manifestDigest: digest('f') };
    expect(readReleaseManifest(writeManifest(exact), {
      signatureRaw: JSON.stringify(substitutedDigest),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    }).authentication.errors.join('\n')).toMatch(/canonical manifest digest/u);

    const otherPrivateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from('2f'.repeat(32), 'hex'),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const wrongSigner = signatureEnvelope(exact);
    wrongSigner.signature = sign(
      null,
      releaseManifestSignaturePayload(wrongSigner.manifestDigest, exact.version),
      otherPrivateKey
    ).toString('base64');
    expect(readReleaseManifest(writeManifest(exact), {
      signatureRaw: JSON.stringify(wrongSigner),
      trustedPublicKeys: { [VECTOR_KEY_ID]: VECTOR_PUBLIC_KEY_PEM },
    }).authentication.errors.join('\n')).toMatch(/signature verification failed/u);

    expect(releaseManifestSignaturePayload(VECTOR_DIGEST, 1)).not.toEqual(
      releaseManifestSignaturePayload(VECTOR_DIGEST, 2)
    );
    expect(() => releaseManifestSignaturePayload(VECTOR_DIGEST, 3 as 2)).toThrow(/version 1 or 2/u);
  });

  it('rejects production, money or assignment authority, unknown secret-shaped fields, and bad JSON', () => {
    const unsafe = manifest() as unknown as {
      environment: string;
      apiToken?: string;
      capabilities: Record<string, unknown>;
    };
    unsafe.environment = 'production';
    unsafe.apiToken = 'github_pat_must-never-be-here';
    unsafe.capabilities.customerMoneyCreation = true;
    unsafe.capabilities.hardAssignment = true;
    expect(verifyReleaseManifest(unsafe).join('\n')).toMatch(
      /environment|apiToken|secret material|customerMoneyCreation|hardAssignment/u
    );

    const boxed = manifest() as unknown as {
      $schema: unknown;
      environment: unknown;
      components: { backend: { imageEvidence: unknown } };
    };
    boxed.$schema = 42;
    boxed.environment = Object('staging');
    boxed.components.backend.imageEvidence = Object('VERIFIED_IMMUTABLE_IMAGE');
    expect(verifyReleaseManifest(boxed).join('\n')).toMatch(/\$schema|environment|imageEvidence/u);

    expect(readReleaseManifest(writeManifest({ releaseId: 'invented' })).status).toBe('invalid');
    const invalidJsonPath = writeManifest({});
    writeFileSync(invalidJsonPath, '{', 'utf8');
    const invalidJson = readReleaseManifest(invalidJsonPath, {
      signatureRaw: JSON.stringify(signatureEnvelope(manifest())),
    });
    expect(invalidJson.status).toBe('invalid');
    expect(invalidJson.authentication.status).toBe('invalid');
  });
});
