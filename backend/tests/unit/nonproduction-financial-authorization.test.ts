import { describe, expect, it } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import {
  releaseManifestDigest,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';
import { fakeFinancialProviderEnabled } from '../../src/services/payment/FakeFinancialProvider.js';
import {
  assertNonproductionFakeFinanceAuthorized,
  nonproductionFakeFinanceEnabled,
} from '../../src/services/payment/NonproductionFinancialAuthorization.js';

const BACKEND_REVISION = '1'.repeat(40);
const WORKER_REVISION = '2'.repeat(40);
const WEB_REVISION = '3'.repeat(40);
const POLICY_REVISION = '4'.repeat(40);
const FIXTURE_REVISION = '5'.repeat(40);

function digest(value: string): string {
  return `sha256:${value.repeat(64)}`;
}

function manifest(
  environment: ReleaseManifest['environment'] = 'staging',
): ReleaseManifest {
  return {
    version: 1,
    environment,
    releaseId: `test-${environment}-release-0001`,
    createdAt: '2026-08-26T12:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: digest('f'),
    },
    components: {
      backend: {
        revision: BACKEND_REVISION,
        artifactDigest: digest('1'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('2'),
      },
      worker: {
        revision: WORKER_REVISION,
        artifactDigest: digest('3'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('4'),
      },
      web: {
        revision: WEB_REVISION,
        artifactDigest: digest('5'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('6'),
      },
      migration: { revision: BACKEND_REVISION, artifactDigest: digest('7') },
      policy: { revision: POLICY_REVISION, artifactDigest: digest('8') },
      fixtures: {
        revision: FIXTURE_REVISION,
        artifactDigest: digest('9'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('a'),
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

function evidence(value: ReleaseManifest): ReleaseManifestEvidence {
  return {
    schema_version: 1,
    status: 'valid',
    digest: releaseManifestDigest(value),
    source: 'HX_RELEASE_MANIFEST_JSON',
    errors: [],
    manifest: value,
    authentication: {
      status: 'verified',
      algorithm: 'ed25519',
      keyId: 'unit-test-release-authority',
      keyFingerprint: digest('e'),
      signatureDigest: digest('d'),
      source: 'unit-test-detached-signature',
      errors: [],
    },
  };
}

function identity(revision = BACKEND_REVISION, cleanSource = true): BuildIdentity {
  const artifactDigest = revision === WORKER_REVISION
    ? manifest().components.worker.artifactDigest
    : manifest().components.backend.artifactDigest;
  return {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision,
    built_at: '2026-08-26T12:00:00.000Z',
    environment: 'production',
    clean_source: cleanSource,
    source: cleanSource ? 'RAILWAY_GIT_COMMIT_SHA' : 'git',
    artifact_digest: artifactDigest,
    artifact_verified: cleanSource,
  };
}

function stagingEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    SERVICE_ROLE: 'api',
    HX_ENVIRONMENT: 'staging',
    HX_PAYMENT_CREATION_MODE: 'frozen',
    RAILWAY_PROJECT_NAME: 'hustlexp-nonprod',
    RAILWAY_PROJECT_ID: 'project-nonprod-1',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    RAILWAY_ENVIRONMENT_ID: 'environment-staging-1',
    ...overrides,
  };
}

describe('nonproduction fake-finance authority', () => {
  it('matches the canonical platform release-manifest digest vector', () => {
    const candidate = {
      $schema: '../schemas/release-manifest.schema.json',
      version: 1,
      environment: 'staging',
      releaseId: 'staging-20260826-001',
      createdAt: '2026-08-26T00:00:00.000Z',
      components: {} as Record<string, Record<string, string>>,
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
    const hexadecimal = ['1', '2', '3', '4', '5', '6'];
    for (const [index, name] of [
      'backend', 'worker', 'web', 'migration', 'policy', 'fixtures',
    ].entries()) {
      candidate.components[name] = {
        revision: hexadecimal[index].repeat(40),
        artifactDigest: `sha256:${hexadecimal[(index + 1) % hexadecimal.length].repeat(64)}`,
      };
      if (['backend', 'worker', 'web', 'fixtures'].includes(name)) {
        candidate.components[name].imageDigest =
          `sha256:${hexadecimal[(index + 2) % hexadecimal.length].repeat(64)}`;
      }
    }

    expect(releaseManifestDigest(candidate)).toBe(
      'sha256:e13bf6c02adcf0b4ba140ba822ccc29b1b6eef25a831c614632fc52f58c7d31b',
    );
  });

  it('authorizes exact clean staging evidence even when Node uses production optimizations', () => {
    const exactManifest = manifest();
    expect(assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(),
      release: evidence(exactManifest),
      identity: identity(),
      component: 'backend',
    })).toBe(exactManifest);
  });

  it('allows a dirty local development build only when its exact revision still matches', () => {
    expect(nonproductionFakeFinanceEnabled({
      env: {
        HX_ENVIRONMENT: 'local',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      },
      release: evidence(manifest('local')),
      identity: identity(BACKEND_REVISION, false),
      component: 'migration',
    })).toBe(true);
  });

  it('derives provider enablement from the manifest, not the legacy feature flag', () => {
    expect(fakeFinancialProviderEnabled(
      stagingEnv({ HX_FAKE_FINANCIAL_PROVIDER_ENABLED: 'false' }),
      evidence(manifest()),
      identity(),
    )).toBe(true);
  });

  it('rejects production and a staging-label spoof inside a Railway production environment', () => {
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: {
        HX_ENVIRONMENT: 'production',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      },
      release: evidence(manifest('production')),
      identity: identity(),
    })).toThrow('HX_ENVIRONMENT_MUST_BE_LOCAL_PREVIEW_OR_STAGING');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({ RAILWAY_ENVIRONMENT_NAME: 'production' }),
      release: evidence(manifest()),
      identity: identity(),
    })).toThrow('RAILWAY_PRODUCTION_ENVIRONMENT');
  });

  it('cannot turn production into the fake-value lane with environment flags or a mislabeled manifest', () => {
    const mislabeledProduction = manifest('production');
    Object.assign(mislabeledProduction.capabilities, {
      financialProvider: 'fake',
      fakeFinancialEvents: true,
      customerMoneyCreation: false,
      hardAssignment: false,
      realSettlement: false,
    });

    expect(
      nonproductionFakeFinanceEnabled({
        env: {
          NODE_ENV: 'production',
          SERVICE_ROLE: 'api',
          HX_ENVIRONMENT: 'production',
          HX_PAYMENT_CREATION_MODE: 'frozen',
          HX_FAKE_FINANCIAL_PROVIDER_ENABLED: 'true',
          HX_EXTERNAL_VALUE: 'false',
          HX_LIVE_PROVIDER_ACCESS: 'false',
        },
        release: evidence(mislabeledProduction),
        identity: identity(),
      })
    ).toBe(false);
  });

  it('rejects a production project, local manifest in Railway, and mismatched preview lane', () => {
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({ RAILWAY_PROJECT_NAME: 'hustlexp-production' }),
      release: evidence(manifest()),
      identity: identity(),
    })).toThrow('RAILWAY_PROJECT_IS_NOT_HUSTLEXP_NONPROD');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: {
        HX_ENVIRONMENT: 'local',
        HX_PAYMENT_CREATION_MODE: 'frozen',
        RAILWAY_PROJECT_ID: 'project-1',
      },
      release: evidence(manifest('local')),
      identity: identity(),
    })).toThrow('LOCAL_MANIFEST_CANNOT_RUN_ON_RAILWAY');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({
        HX_ENVIRONMENT: 'preview',
        RAILWAY_ENVIRONMENT_NAME: 'staging',
      }),
      release: evidence(manifest('preview')),
      identity: identity(),
    })).toThrow('RAILWAY_ENVIRONMENT_DOES_NOT_MATCH_PREVIEW_MANIFEST');
  });

  it('requires complete, internally consistent Railway identity for preview and staging', () => {
    const exactRelease = evidence(manifest());
    for (const [override, reason] of [
      [{ RAILWAY_PROJECT_NAME: undefined }, 'RAILWAY_PROJECT_IS_NOT_HUSTLEXP_NONPROD'],
      [{ RAILWAY_PROJECT_ID: undefined }, 'RAILWAY_PROJECT_ID_REQUIRED'],
      [{ RAILWAY_ENVIRONMENT_NAME: undefined }, 'RAILWAY_ENVIRONMENT_NAME_REQUIRED'],
      [{ RAILWAY_ENVIRONMENT_ID: undefined }, 'RAILWAY_ENVIRONMENT_ID_REQUIRED'],
      [{
        RAILWAY_ENVIRONMENT_NAME: 'staging',
        RAILWAY_ENVIRONMENT: 'production',
      }, 'RAILWAY_PRODUCTION_ENVIRONMENT'],
      [{
        RAILWAY_ENVIRONMENT_NAME: 'staging',
        RAILWAY_ENVIRONMENT: 'preview-123',
      }, 'RAILWAY_ENVIRONMENT_METADATA_CONFLICT'],
    ] as const) {
      expect(() => assertNonproductionFakeFinanceAuthorized({
        env: stagingEnv(override),
        release: exactRelease,
        identity: identity(),
      })).toThrow(reason);
    }

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: {
        HX_ENVIRONMENT: 'staging',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      },
      release: exactRelease,
      identity: identity(),
    })).toThrow('RAILWAY_CONTEXT_REQUIRED');
  });

  it('rejects invalid, substituted, and environment-mismatched manifests', () => {
    const exactManifest = manifest();
    const invalid: ReleaseManifestEvidence = {
      ...evidence(exactManifest),
      status: 'invalid',
      manifest: null,
      errors: ['invalid'],
    };
    expect(nonproductionFakeFinanceEnabled({
      env: stagingEnv(), release: invalid, identity: identity(),
    })).toBe(false);

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(),
      release: { ...evidence(exactManifest), digest: digest('b') },
      identity: identity(),
    })).toThrow('MANIFEST_DIGEST_MISMATCH');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(),
      release: evidence(manifest('preview')),
      identity: identity(),
    })).toThrow('MANIFEST_ENVIRONMENT_MISMATCH');
  });

  it('independently rejects every positive effect even if evidence is mislabeled valid', () => {
    for (const mutation of [
      (candidate: ReleaseManifest) => Object.assign(candidate.capabilities, {
        customerMoneyCreation: true,
      }),
      (candidate: ReleaseManifest) => Object.assign(candidate.capabilities, {
        hardAssignment: true,
      }),
      (candidate: ReleaseManifest) => Object.assign(candidate.capabilities, {
        realSettlement: true,
      }),
      (candidate: ReleaseManifest) => Object.assign(candidate.capabilities, {
        financialProvider: 'disabled',
      }),
      (candidate: ReleaseManifest) => Object.assign(candidate.capabilities, {
        fakeFinancialEvents: false,
      }),
    ]) {
      const candidate = manifest();
      mutation(candidate);
      expect(nonproductionFakeFinanceEnabled({
        env: stagingEnv(), release: evidence(candidate), identity: identity(),
      })).toBe(false);
    }
  });

  it('rejects unfrozen runtime money state, live credentials, and external-value access', () => {
    const exactRelease = evidence(manifest());
    for (const env of [
      stagingEnv({ HX_PAYMENT_CREATION_MODE: 'enabled' }),
      stagingEnv({ STRIPE_SECRET_KEY: 'sk_live_not_allowed' }),
      stagingEnv({ STRIPE_SECRET_KEY: 'sk_test_external_provider_not_allowed' }),
      stagingEnv({ HX_EXTERNAL_VALUE: ' TRUE ' }),
      stagingEnv({ HX_EXTERNAL_VALUE: '1' }),
      stagingEnv({ HX_LIVE_PROVIDER_ACCESS: 'On' }),
      stagingEnv({ HX_LIVE_PROVIDER_ACCESS: 'unexpected' }),
      stagingEnv({ UNRELATED_VALUE: ' pk_live_not_allowed' }),
    ]) {
      expect(nonproductionFakeFinanceEnabled({
        env, release: exactRelease, identity: identity(),
      })).toBe(false);
    }

    expect(nonproductionFakeFinanceEnabled({
      env: stagingEnv({
        HX_EXTERNAL_VALUE: ' FALSE ',
        HX_LIVE_PROVIDER_ACCESS: '0',
        HXOS_LOCAL_TEST_PAYMENT_SECRET: 'synthetic-only-secret',
      }),
      release: exactRelease,
      identity: identity(),
    })).toBe(true);
  });

  it('requires the runtime manifest channel and a trusted embedded build source', () => {
    const exactManifest = manifest();
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(),
      release: { ...evidence(exactManifest), source: '/run/hustlexp/release-manifest.json' },
      identity: identity(),
    })).toThrow('RUNTIME_MANIFEST_INPUT_REQUIRED');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(),
      release: evidence(exactManifest),
      identity: { ...identity(), source: 'HX_BUILD_REVISION' },
    })).toThrow('TRUSTED_NONLOCAL_BUILD_SOURCE_REQUIRED');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({ RAILWAY_GIT_COMMIT_SHA: '9'.repeat(40) }),
      release: evidence(exactManifest),
      identity: identity(),
    })).toThrow('RUNTIME_BUILD_REVISION_MISMATCH_RAILWAY_GIT_COMMIT_SHA');
  });

  it('binds the selected manifest component to the nonproduction service role', () => {
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({ SERVICE_ROLE: undefined }),
      release: evidence(manifest()),
      identity: identity(),
      component: 'backend',
    })).toThrow('SERVICE_ROLE_REQUIRED');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({ SERVICE_ROLE: 'worker' }),
      release: evidence(manifest()),
      identity: identity(),
      component: 'backend',
    })).toThrow('MANIFEST_COMPONENT_ROLE_MISMATCH');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({ SERVICE_ROLE: 'unknown' }),
      release: evidence(manifest()),
      identity: identity(),
      component: 'backend',
    })).toThrow('SERVICE_ROLE_INVALID');

    expect(fakeFinancialProviderEnabled(
      stagingEnv({ SERVICE_ROLE: 'worker' }),
      evidence(manifest()),
      identity(WORKER_REVISION),
    )).toBe(true);
  });

  it('requires a clean immutable staging revision matching the selected component', () => {
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(), release: evidence(manifest()), identity: identity(BACKEND_REVISION, false),
    })).toThrow('MEASURED_IMMUTABLE_BUILD_REQUIRED');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(), release: evidence(manifest()), identity: identity(WORKER_REVISION),
    })).toThrow('MANIFEST_BACKEND_REVISION_MISMATCH');
  });
});
