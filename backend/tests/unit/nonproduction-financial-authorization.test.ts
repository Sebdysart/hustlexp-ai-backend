import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import {
  releaseManifestDigest,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
  type ReleaseManifestV2,
} from '../../src/releaseManifest.js';
import {
  createDatabaseBackedFakeFinancialProvider,
  fakeFinancialProviderEnabled,
  issueLiveFakeFinancialDatabaseCapability,
  type LiveFakeFinancialDatabaseCapability,
} from '../../src/services/payment/FakeFinancialProvider.js';
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
  environment: ReleaseManifestV2['environment'] = 'staging',
): ReleaseManifestV2 {
  return {
    version: 2,
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
        providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        providerImageDigest: digest('a'),
        databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        databaseImageDigest: digest('b'),
      },
    },
    infrastructure: {
      revision: '6'.repeat(40),
      artifactDigest: digest('c'),
      desiredTopologyDigest: digest('d'),
    },
    databaseTargets: {
      api: { component: 'api', environment, databaseTargetDigest: digest('e') },
      worker: { component: 'worker', environment, databaseTargetDigest: digest('f') },
      attester: { component: 'attester', environment, databaseTargetDigest: digest('1') },
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
    HX_RELEASE_PROMOTION_MODE: 'INITIAL',
    HX_PAYMENT_CREATION_MODE: 'frozen',
    RAILWAY_PROJECT_NAME: 'hustlexp-nonprod',
    RAILWAY_PROJECT_ID: 'project-nonprod-1',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    RAILWAY_ENVIRONMENT_ID: 'environment-staging-1',
    ...overrides,
  };
}

function localEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    HX_ENVIRONMENT: 'local',
    HX_PAYMENT_CREATION_MODE: 'frozen',
    ...overrides,
  };
}

describe('nonproduction fake-finance authority', () => {
  beforeEach(() => {
    // This authority suite proves the fake-only lane from an explicitly clean
    // ambient process. The global diagnostic test setup carries a Stripe test
    // placeholder that must never be inherited by this lane.
    vi.stubEnv('STRIPE_SECRET_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('binds fake-finance authority to the complete v2 manifest digest', () => {
    const exact = manifest();
    const changed = structuredClone(exact);
    changed.infrastructure.desiredTopologyDigest = digest('e');
    expect(releaseManifestDigest(changed)).not.toBe(releaseManifestDigest(exact));
  });

  it('holds hosted fake finance until the protected Railway target is enrolled', () => {
    const exactManifest = manifest();
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(),
      release: evidence(exactManifest),
      identity: identity(),
      component: 'backend',
    })).toThrow('CALLER_SHAPED_HOSTED_ENVIRONMENT_REFUSED');
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

  it('never treats a legacy v1 local diagnostic as fake-finance authority', () => {
    const v2 = manifest('local');
    const legacy = {
      version: 1 as const,
      environment: 'local' as const,
      releaseId: 'legacy-local-diagnostic-0001',
      createdAt: v2.createdAt,
      authority: v2.authority,
      components: {
        ...v2.components,
        fixtures: {
          revision: v2.components.fixtures.revision,
          artifactDigest: v2.components.fixtures.artifactDigest,
          imageEvidence: v2.components.fixtures.providerImageEvidence,
          imageDigest: v2.components.fixtures.providerImageDigest,
        },
      },
      capabilities: v2.capabilities,
      promotion: {
        baseManifestDigest: null,
        changedComponents: ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'] as const,
      },
      health: {
        backend: { component: 'backend' as const, path: '/health' as const },
        worker: { component: 'worker' as const, path: '/health' as const },
        web: { component: 'web' as const, path: '/version.json' as const },
      },
    };
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: { HX_ENVIRONMENT: 'local', HX_PAYMENT_CREATION_MODE: 'frozen' },
      release: evidence(legacy as unknown as ReleaseManifest),
      identity: identity(BACKEND_REVISION, false),
      component: 'backend',
    })).toThrow('PROMOTABLE_RELEASE_MANIFEST_V2_REQUIRED');
  });

  it('derives provider enablement from the manifest, not the legacy feature flag', () => {
    expect(fakeFinancialProviderEnabled(
      localEnv({ HX_FAKE_FINANCIAL_PROVIDER_ENABLED: 'false' }),
      evidence(manifest('local')),
      identity(BACKEND_REVISION, false),
    )).toBe(true);
  });

  it('rejects production and a staging-label spoof inside a Railway production environment', () => {
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: {
        HX_ENVIRONMENT: 'production',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      },
      release: evidence(manifest()),
      identity: identity(),
    })).toThrow('HX_ENVIRONMENT_MUST_BE_LOCAL_PREVIEW_OR_STAGING');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({ RAILWAY_ENVIRONMENT_NAME: 'production' }),
      release: evidence(manifest()),
      identity: identity(),
    })).toThrow('CALLER_SHAPED_HOSTED_ENVIRONMENT_REFUSED');
  });

  it('cannot turn production into the fake-value lane with environment flags or a mislabeled manifest', () => {
    const mislabeledProduction = manifest();

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

  it('derives production and Railway boundaries from ambient process state', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HX_ENVIRONMENT', 'production');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');
    vi.stubEnv('RAILWAY_PROJECT_NAME', 'hustlexp-production');
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: localEnv(),
      release: evidence(manifest('local')),
      identity: identity(BACKEND_REVISION, false),
    })).toThrow('PRODUCTION_RUNTIME_CANNOT_USE_FAKE_FINANCE');
  });

  it('requires module-owned hosted release and build evidence', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HX_ENVIRONMENT', 'staging');
    vi.stubEnv('SERVICE_ROLE', 'api');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');
    vi.stubEnv('RAILWAY_PROJECT_NAME', 'hustlexp-nonprod');
    vi.stubEnv('RAILWAY_PROJECT_ID', 'ambient-staging-project');
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'staging');
    vi.stubEnv('RAILWAY_ENVIRONMENT_ID', 'ambient-staging-environment');
    vi.stubEnv('HX_RELEASE_MANIFEST_JSON', '');
    vi.stubEnv('HX_RELEASE_MANIFEST_PATH', '');
    vi.stubEnv('HX_RELEASE_MANIFEST_SIGNATURE_JSON', '');
    vi.stubEnv('HX_RELEASE_MANIFEST_SIGNATURE_PATH', '');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: localEnv(),
      release: evidence(manifest('local')),
      identity: identity(),
      component: 'backend',
    })).toThrow('MODULE_MEASURED_BUILD_IDENTITY_REQUIRED');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: localEnv(),
      release: evidence(manifest()),
      component: 'backend',
    })).toThrow('EXACT_MANIFEST_REQUIRED');
  });

  it('cannot hide ambient financial credentials inside a sanitized caller env', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_ambient_must_be_seen');
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: localEnv(),
      release: evidence(manifest('local')),
      identity: identity(BACKEND_REVISION, false),
    })).toThrow('AMBIENT_LIVE_FINANCIAL_CREDENTIAL_STRIPE_SECRET_KEY');
  });

  it('rejects arbitrary database-shaped objects without an opaque live capability', () => {
    const arbitraryDatabase = {
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as LiveFakeFinancialDatabaseCapability;
    expect(() => createDatabaseBackedFakeFinancialProvider(arbitraryDatabase)).toThrow(
      'OPAQUE_LIVE_DATABASE_CAPABILITY_REQUIRED',
    );
  });

  it('rejects an arbitrary local database target before opening the module pool', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://hx_ci_runner@127.0.0.1:5432/arbitrary_test');
    vi.stubEnv('VITEST', 'true');
    vi.stubEnv('HX_ALLOW_CI_DB_RECREATE', 'true');
    await expect(issueLiveFakeFinancialDatabaseCapability({
      env: localEnv({ SERVICE_ROLE: 'backend' }),
      release: evidence(manifest('local')),
      identity: identity(BACKEND_REVISION, false),
      component: 'backend',
    })).rejects.toThrow('LOCAL_DATABASE_TARGET_NOT_ALLOWLISTED');
  });

  it('rejects a production project, local manifest in Railway, and mismatched preview lane', () => {
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({ RAILWAY_PROJECT_NAME: 'hustlexp-production' }),
      release: evidence(manifest()),
      identity: identity(),
    })).toThrow('CALLER_SHAPED_HOSTED_ENVIRONMENT_REFUSED');

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
    })).toThrow('CALLER_SHAPED_HOSTED_ENVIRONMENT_REFUSED');
  });

  it('requires complete, internally consistent Railway identity for preview and staging', () => {
    const exactRelease = evidence(manifest());
    for (const [override] of [
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
      })).toThrow('CALLER_SHAPED_HOSTED_ENVIRONMENT_REFUSED');
    }

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: {
        HX_ENVIRONMENT: 'staging',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      },
      release: exactRelease,
      identity: identity(),
    })).toThrow('CALLER_SHAPED_HOSTED_ENVIRONMENT_REFUSED');
  });

  it('rejects invalid, substituted, and environment-mismatched manifests', () => {
    const exactManifest = manifest('local');
    const invalid: ReleaseManifestEvidence = {
      ...evidence(exactManifest),
      status: 'invalid',
      manifest: null,
      errors: ['invalid'],
    };
    expect(nonproductionFakeFinanceEnabled({
      env: localEnv(), release: invalid, identity: identity(BACKEND_REVISION, false),
    })).toBe(false);

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: localEnv(),
      release: { ...evidence(exactManifest), digest: digest('b') },
      identity: identity(BACKEND_REVISION, false),
    })).toThrow('MANIFEST_DIGEST_MISMATCH');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: localEnv(),
      release: evidence(manifest('preview')),
      identity: identity(BACKEND_REVISION, false),
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
      candidate.environment = 'local';
      mutation(candidate);
      expect(nonproductionFakeFinanceEnabled({
        env: localEnv(),
        release: evidence(candidate),
        identity: identity(BACKEND_REVISION, false),
      })).toBe(false);
    }
  });

  it('rejects unfrozen runtime money state, live credentials, and external-value access', () => {
    const exactRelease = evidence(manifest('local'));
    for (const env of [
      localEnv({ HX_PAYMENT_CREATION_MODE: 'enabled' }),
      localEnv({ STRIPE_SECRET_KEY: 'sk_live_not_allowed' }),
      localEnv({ STRIPE_SECRET_KEY: 'sk_test_external_provider_not_allowed' }),
      localEnv({ HX_EXTERNAL_VALUE: ' TRUE ' }),
      localEnv({ HX_EXTERNAL_VALUE: '1' }),
      localEnv({ HX_LIVE_PROVIDER_ACCESS: 'On' }),
      localEnv({ HX_LIVE_PROVIDER_ACCESS: 'unexpected' }),
      localEnv({ UNRELATED_VALUE: ' pk_live_not_allowed' }),
    ]) {
      expect(nonproductionFakeFinanceEnabled({
        env, release: exactRelease, identity: identity(BACKEND_REVISION, false),
      })).toBe(false);
    }

    expect(nonproductionFakeFinanceEnabled({
      env: localEnv({
        HX_EXTERNAL_VALUE: ' FALSE ',
        HX_LIVE_PROVIDER_ACCESS: '0',
        HXOS_LOCAL_TEST_PAYMENT_SECRET: 'synthetic-only-secret',
      }),
      release: exactRelease,
      identity: identity(BACKEND_REVISION, false),
    })).toBe(true);
  });

  it('cannot reach hosted manifest or build checks before protected target enrollment', () => {
    const exactManifest = manifest();
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(),
      release: { ...evidence(exactManifest), source: '/run/hustlexp/release-manifest.json' },
      identity: identity(),
    })).toThrow('CALLER_SHAPED_HOSTED_ENVIRONMENT_REFUSED');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv(),
      release: evidence(exactManifest),
      identity: { ...identity(), source: 'HX_BUILD_REVISION' },
    })).toThrow('CALLER_SHAPED_HOSTED_ENVIRONMENT_REFUSED');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: stagingEnv({ RAILWAY_GIT_COMMIT_SHA: '9'.repeat(40) }),
      release: evidence(exactManifest),
      identity: identity(),
    })).toThrow('CALLER_SHAPED_HOSTED_ENVIRONMENT_REFUSED');
  });

  it('binds the selected manifest component to the nonproduction service role', () => {
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: localEnv({ SERVICE_ROLE: 'worker' }),
      release: evidence(manifest('local')),
      identity: identity(BACKEND_REVISION, false),
      component: 'backend',
    })).toThrow('MANIFEST_COMPONENT_ROLE_MISMATCH');

    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: localEnv({ SERVICE_ROLE: 'unknown' }),
      release: evidence(manifest('local')),
      identity: identity(BACKEND_REVISION, false),
      component: 'backend',
    })).toThrow('SERVICE_ROLE_INVALID');

    expect(fakeFinancialProviderEnabled(
      localEnv({ SERVICE_ROLE: 'worker' }),
      evidence(manifest('local')),
      identity(WORKER_REVISION, false),
    )).toBe(true);
  });

  it('requires the exact selected component revision in the local synthetic lane', () => {
    expect(() => assertNonproductionFakeFinanceAuthorized({
      env: localEnv(),
      release: evidence(manifest('local')),
      identity: identity(WORKER_REVISION, false),
    })).toThrow('MANIFEST_BACKEND_REVISION_MISMATCH');
  });
});
