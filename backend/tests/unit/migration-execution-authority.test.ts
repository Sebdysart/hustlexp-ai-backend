import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Model the immutable identity measured by the built migration image. Hosted
// authority must bind to this module-owned singleton, never to a shaped value
// supplied through a runtime object.
vi.mock('../../src/buildIdentity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/buildIdentity.js')>();
  return {
    ...actual,
    buildIdentity: Object.freeze({
      schema_version: 1,
      service: 'hustlexp-engine',
      revision: '1'.repeat(40),
      built_at: '2026-08-26T12:00:00.000Z',
      environment: 'production',
      clean_source: true,
      source: 'GITHUB_SHA',
      artifact_digest: `sha256:${'2'.repeat(64)}`,
      artifact_verified: true,
    }),
  };
});

import { buildIdentity, type BuildIdentity } from '../../src/buildIdentity.js';
import {
  abortMigrationOperation,
  assertMigrationExecutionReceipt,
  assertIssuedMigrationExecutionAuthority,
  assertMigrationExecutionSession,
  assertMigrationExecutionAuthorized,
  authorizeMigrationExecutionPlan,
  beginConstitutionalBaselineOperation,
  beginLegacyLocationBackfillOperation,
  beginMigrationArtifactOperation,
  completeMigrationExecutionSession,
  completeMigrationOperation,
  PINNED_NONPRODUCTION_RAILWAY_PROJECT_ID,
  PINNED_NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID,
  PINNED_PRODUCTION_RAILWAY_ENVIRONMENT_ID,
  PINNED_PRODUCTION_RAILWAY_PROJECT_ID,
} from '../../src/jobs/migration-execution-authority.js';
import {
  productionMigrationRuntime,
  runEngineAutomationMigration,
  runEngineAutomationMigrationsOnConnectedClient,
  type MigrationClient,
  type MigrationRuntime,
} from '../../src/jobs/engine-automation-migration.js';
import { engineMigrationArtifactDigest } from '../../src/jobs/engine-migration-manifest.js';
import {
  readReleaseManifest,
  releaseManifestDigest,
  releaseManifestSignaturePayload,
  type ReleaseManifestEvidence,
  type ReleaseManifestV2,
} from '../../src/releaseManifest.js';

const REVISION = '1'.repeat(40);
const EXECUTABLE_DIGEST = `sha256:${'2'.repeat(64)}`;
const MIGRATION_DIGEST = `sha256:${'3'.repeat(64)}`;
const LOCAL_DATABASE_URL = 'postgresql://hx_ci_runner@127.0.0.1:5432/hx_ci_system_test';
const TEST_KEY_ID = 'migration-authority-test-key';
const TEST_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('3f'.repeat(32), 'hex'),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const TEST_PUBLIC_KEY_PEM = createPublicKey(TEST_PRIVATE_KEY)
  .export({ type: 'spki', format: 'pem' })
  .toString();
const directories: string[] = [];

function manifest(environment: ReleaseManifestV2['environment'] = 'staging'): ReleaseManifestV2 {
  return {
    version: 2,
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
        providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        providerImageDigest: `sha256:${'b'.repeat(64)}`,
        databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        databaseImageDigest: `sha256:${'c'.repeat(64)}`,
      },
    },
    infrastructure: {
      revision: 'b'.repeat(40),
      artifactDigest: `sha256:${'c'.repeat(64)}`,
      desiredTopologyDigest: `sha256:${'d'.repeat(64)}`,
    },
    databaseTargets: {
      api: { component: 'api', environment, databaseTargetDigest: `sha256:${'e'.repeat(64)}` },
      worker: { component: 'worker', environment, databaseTargetDigest: `sha256:${'f'.repeat(64)}` },
      attester: { component: 'attester', environment, databaseTargetDigest: `sha256:${'1'.repeat(64)}` },
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

function fabricatedRelease(
  environment: ReleaseManifestV2['environment'] = 'preview'
): ReleaseManifestEvidence {
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

function signedRelease(exact: ReleaseManifestV2): ReleaseManifestEvidence {
  vi.stubEnv('HX_RELEASE_PROMOTION_MODE', exact.environment === 'staging' ? 'INITIAL' : '');
  vi.stubEnv('HX_PREVIOUS_RELEASE_MANIFEST_JSON', '');
  vi.stubEnv('HX_PREVIOUS_RELEASE_MANIFEST_PATH', '');
  const digest = releaseManifestDigest(exact);
  const directory = mkdtempSync(join(tmpdir(), 'hx-migration-authority-'));
  directories.push(directory);
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(exact), 'utf8');
  return readReleaseManifest(path, {
    signatureRaw: JSON.stringify({
      version: 1,
      algorithm: 'ed25519',
      keyId: TEST_KEY_ID,
      manifestDigest: digest,
      signature: sign(
        null,
        releaseManifestSignaturePayload(digest, exact.version),
        TEST_PRIVATE_KEY
      ).toString('base64'),
    }),
    signatureSource: 'unit-test-detached-signature',
    trustedPublicKeys: { [TEST_KEY_ID]: TEST_PUBLIC_KEY_PEM },
  });
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

function hostedEnv(
  environment: 'preview' | 'staging',
  exactRelease: ReleaseManifestEvidence
): Record<string, string> {
  return {
    NODE_ENV: 'production',
    HX_ENVIRONMENT: environment,
    ...(environment === 'staging' ? { HX_RELEASE_PROMOTION_MODE: 'INITIAL' } : {}),
    SERVICE_ROLE: 'migration',
    HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST: exactRelease.digest,
    RAILWAY_PROJECT_NAME: 'hustlexp-nonprod',
    RAILWAY_PROJECT_ID: 'runtime-untrusted-project-claim',
    RAILWAY_ENVIRONMENT_NAME: environment,
    RAILWAY_ENVIRONMENT_ID: `runtime-untrusted-${environment}-environment-claim`,
  };
}

function inertClient(): {
  client: MigrationClient;
  query: ReturnType<typeof vi.fn>;
  connection: { backendPid: number; sessionMarker: string | null };
} {
  const connection = { backendPid: 27_001, sessionMarker: null as string | null };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("set_config('search_path', 'public', false)")) {
      return { rows: [{ set_config: 'public' }] };
    }
    if (sql.includes('current_database()::text AS database_name')) {
      return {
        rows: [
          {
            database_name: 'hx_ci_system_test',
            role_name: 'hx_ci_runner',
            session_role_name: 'hx_ci_runner',
            server_address: '127.0.0.1',
            server_port: 5432,
            schema_name: 'public',
            search_path: 'public',
            effective_schemas: ['public'],
          },
        ],
      };
    }
    if (sql.includes("set_config('hustlexp.migration_session', $1, false)")) {
      connection.sessionMarker = String(values?.[0] ?? '');
      return {
        rows: [
          {
            backend_pid: connection.backendPid,
            session_marker: connection.sessionMarker,
          },
        ],
      };
    }
    if (sql.includes("current_setting('hustlexp.migration_session', true)")) {
      return {
        rows: [
          {
            backend_pid: connection.backendPid,
            session_marker: connection.sessionMarker,
          },
        ],
      };
    }
    return { rows: [] };
  });
  return {
    client: {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: query as MigrationClient['query'],
    },
    query,
    connection,
  };
}

function inertRuntime(client: MigrationClient): MigrationRuntime {
  return {
    databaseUrl: LOCAL_DATABASE_URL,
    migrationSpecs: [],
    readText: vi.fn(async () => ''),
    createClient: vi.fn((_databaseUrl: string) => client),
  };
}

function localAuthority() {
  return assertMigrationExecutionAuthorized({
    env: { NODE_ENV: 'test', HX_ENVIRONMENT: 'local', SERVICE_ROLE: 'migration' },
    migrationArtifactDigest: MIGRATION_DIGEST,
    databaseUrl: LOCAL_DATABASE_URL,
  });
}

function canonicalPlan() {
  const runtime = productionMigrationRuntime();
  const baselineSpec = runtime.bootstrapSpec;
  if (!baselineSpec) throw new Error('Canonical baseline spec is required');
  const baselinePath = baselineSpec.candidatePaths[0]!;
  return {
    baseline: {
      name: baselineSpec.name,
      sql: readFileSync(baselinePath, 'utf8'),
      sourcePath: baselinePath,
    },
    migrations: runtime.migrationSpecs.map((spec) => {
      const sourcePath = spec.candidatePaths[0]!;
      return {
        name: spec.name,
        sql: readFileSync(sourcePath, 'utf8'),
        sourcePath,
      };
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('explicit migration execution authority', () => {
  it('allows a disposable local command without release credentials or Railway access', () => {
    const authority = localAuthority();
    expect(authority).toMatchObject({
      environment: 'local',
      localOnly: true,
      releaseManifestDigest: null,
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(() => assertIssuedMigrationExecutionAuthority(authority)).not.toThrow();
    const session = authorizeMigrationExecutionPlan(authority, {
      databaseUrl: LOCAL_DATABASE_URL,
      client: {},
      migrations: [],
    });
    expect(session.databaseTarget).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(session).toMatchObject({ localTestOnly: true });
    expect(Object.isFrozen(session)).toBe(true);
    expect(() => assertIssuedMigrationExecutionAuthority(authority)).toThrow(
      'OPAQUE_AUTHORITY_TOKEN_REQUIRED'
    );
    expect(() => authorizeMigrationExecutionPlan(authority, {
      databaseUrl: LOCAL_DATABASE_URL,
      client: {},
      migrations: [],
    })).toThrow('OPAQUE_AUTHORITY_TOKEN_REQUIRED');
    expect(() => assertMigrationExecutionSession(session)).not.toThrow();
    expect(() => assertMigrationExecutionSession(structuredClone(session))).toThrow(
      'OPAQUE_EXECUTION_SESSION_REQUIRED'
    );
  });

  it.each([
    {
      label: 'remote host',
      databaseUrl: 'postgresql://hx_ci_runner@database.example.invalid:5432/hx_ci_system_test',
    },
    {
      label: 'administrative role',
      databaseUrl: 'postgresql://postgres@127.0.0.1:5432/hx_ci_system_test',
    },
    {
      label: 'arbitrary database',
      databaseUrl: 'postgresql://hx_ci_runner@127.0.0.1:5432/hustlexp',
    },
  ])('rejects a $label from the local migration lane', ({ databaseUrl }) => {
    expect(() =>
      assertMigrationExecutionAuthorized({
        env: { NODE_ENV: 'test', HX_ENVIRONMENT: 'local', SERVICE_ROLE: 'migration' },
        migrationArtifactDigest: MIGRATION_DIGEST,
        databaseUrl,
      })
    ).toThrow('LOCAL_ENGINE_DATABASE_TARGET_NOT_ALLOWLISTED');
  });

  it('rejects ambient Railway evidence even when the caller supplies a local env object', () => {
    vi.stubEnv('RAILWAY_PROJECT_ID', 'ambient-railway-project');
    expect(() => localAuthority()).toThrow('LOCAL_EXECUTION_CANNOT_TARGET_RAILWAY');
  });

  it('derives deployed environment and release evidence from ambient runtime state', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HX_ENVIRONMENT', 'preview');
    vi.stubEnv('SERVICE_ROLE', 'migration');
    vi.stubEnv('RAILWAY_PROJECT_NAME', 'hustlexp-nonprod');
    vi.stubEnv('RAILWAY_PROJECT_ID', 'ambient-preview-project');
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'preview-123');
    vi.stubEnv('RAILWAY_ENVIRONMENT_ID', 'ambient-preview-environment');
    vi.stubEnv('HX_RELEASE_MANIFEST_JSON', '');
    vi.stubEnv('HX_RELEASE_MANIFEST_PATH', '');
    vi.stubEnv('HX_RELEASE_MANIFEST_SIGNATURE_JSON', '');
    vi.stubEnv('HX_RELEASE_MANIFEST_SIGNATURE_PATH', '');

    expect(() => assertMigrationExecutionAuthorized({
      env: { NODE_ENV: 'test', HX_ENVIRONMENT: 'local', SERVICE_ROLE: 'migration' },
      release: fabricatedRelease(),
      identity: buildIdentity,
      migrationArtifactDigest: MIGRATION_DIGEST,
      databaseUrl: LOCAL_DATABASE_URL,
    })).toThrow('AUTHENTICATED_RELEASE_MANIFEST_REQUIRED');
  });

  it('rejects fabricated and cloned authenticated evidence before target evaluation', () => {
    const env = hostedEnv('preview', fabricatedRelease());
    expect(() =>
      assertMigrationExecutionAuthorized({
        env,
        release: fabricatedRelease(),
        identity: identity(),
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).toThrow('CALLER_SHAPED_DEPLOYED_ENVIRONMENT_REFUSED');

    const authenticated = signedRelease(manifest('preview'));
    expect(authenticated).toMatchObject({
      status: 'valid',
      authentication: { status: 'verified' },
    });
    expect(() =>
      assertMigrationExecutionAuthorized({
        env: hostedEnv('preview', authenticated),
        release: structuredClone(authenticated),
        identity: identity(),
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).toThrow('CALLER_SHAPED_DEPLOYED_ENVIRONMENT_REFUSED');
  });

  it('holds signed staging replay evidence while promotion authority remains unenrolled', () => {
    const exactRelease = signedRelease(manifest('staging'));
    expect(exactRelease).toMatchObject({
      status: 'valid',
      authentication: { status: 'verified' },
    });
    expect(() =>
      assertMigrationExecutionAuthorized({
        env: hostedEnv('staging', exactRelease),
        release: exactRelease,
        identity: identity(),
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).toThrow('CALLER_SHAPED_DEPLOYED_ENVIRONMENT_REFUSED');
  });

  it('rejects a caller-shaped identity even when every trust field looks valid', () => {
    const exactRelease = signedRelease(manifest('preview'));
    const env = hostedEnv('preview', exactRelease);
    expect(() =>
      assertMigrationExecutionAuthorized({
        env,
        release: exactRelease,
        identity: identity(),
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).toThrow('CALLER_SHAPED_DEPLOYED_ENVIRONMENT_REFUSED');
  });

  it('keeps module-measured build, artifact, migration, and approval failures ahead of target enrollment', () => {
    const exactRelease = signedRelease(manifest('preview'));
    const executableDrift = manifest('preview');
    executableDrift.components.backend.artifactDigest = `sha256:${'f'.repeat(64)}`;
    const executableDriftRelease = signedRelease(executableDrift);
    expect(() =>
      assertMigrationExecutionAuthorized({
        env: hostedEnv('preview', executableDriftRelease),
        release: executableDriftRelease,
        identity: buildIdentity,
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).toThrow('CALLER_SHAPED_DEPLOYED_ENVIRONMENT_REFUSED');

    const driftedManifest = manifest('preview');
    driftedManifest.components.migration.artifactDigest = `sha256:${'f'.repeat(64)}`;
    const driftedRelease = signedRelease(driftedManifest);
    expect(() =>
      assertMigrationExecutionAuthorized({
        env: hostedEnv('preview', driftedRelease),
        release: driftedRelease,
        identity: buildIdentity,
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).toThrow('CALLER_SHAPED_DEPLOYED_ENVIRONMENT_REFUSED');

    const missingApproval = hostedEnv('preview', exactRelease);
    delete missingApproval.HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST;
    expect(() =>
      assertMigrationExecutionAuthorized({
        env: missingApproval,
        release: exactRelease,
        identity: buildIdentity,
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).toThrow('CALLER_SHAPED_DEPLOYED_ENVIRONMENT_REFUSED');
  });

  it('keeps every hosted Railway target held behind null protected-source pins', () => {
    expect(() =>
      assertMigrationExecutionAuthorized({
        env: {
          NODE_ENV: 'test',
          SERVICE_ROLE: 'migration',
          RAILWAY_PROJECT_ID: 'must-not-be-local',
        },
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).toThrow('LOCAL_EXECUTION_CANNOT_TARGET_RAILWAY');

    expect(PINNED_NONPRODUCTION_RAILWAY_PROJECT_ID).toBeNull();
    expect(PINNED_NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID).toBeNull();
    expect(PINNED_PRODUCTION_RAILWAY_ENVIRONMENT_ID).toBeNull();
    expect(PINNED_PRODUCTION_RAILWAY_PROJECT_ID).toBeNull();

    const exactRelease = signedRelease(manifest('preview'));
    expect(() =>
      assertMigrationExecutionAuthorized({
        env: hostedEnv('preview', exactRelease),
        release: exactRelease,
        identity: buildIdentity,
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).toThrow('CALLER_SHAPED_DEPLOYED_ENVIRONMENT_REFUSED');
  });

  it('rejects copied opaque authorities before any connected-client query', async () => {
    const authority = localAuthority();
    const copiedAuthority = { ...authority };
    expect(() => assertIssuedMigrationExecutionAuthority(copiedAuthority)).toThrow(
      'OPAQUE_AUTHORITY_TOKEN_REQUIRED'
    );

    const { client, query } = inertClient();
    await expect(
      runEngineAutomationMigrationsOnConnectedClient(client, inertRuntime(client), copiedAuthority)
    ).rejects.toThrow('OPAQUE_AUTHORITY_TOKEN_REQUIRED');
    expect(query).not.toHaveBeenCalled();
  });

  it('binds a canonical authority to the exact plan and database target before any query', async () => {
    const databaseUrl = LOCAL_DATABASE_URL;
    const authority = assertMigrationExecutionAuthorized({
      env: { NODE_ENV: 'development', HX_ENVIRONMENT: 'local', SERVICE_ROLE: 'migration' },
      migrationArtifactDigest: await engineMigrationArtifactDigest(),
      databaseUrl,
    });
    expect(authority.databaseTarget).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const first = inertClient();
    await expect(
      runEngineAutomationMigrationsOnConnectedClient(
        first.client,
        {
          ...inertRuntime(first.client),
          databaseUrl,
          migrationSpecs: [{ name: 'caller_substituted', candidatePaths: ['/substituted.sql'] }],
          readText: vi.fn(async () => 'SELECT 1;'),
        },
        authority
      )
    ).rejects.toThrow('EXACT_CANONICAL_MIGRATION_PLAN_REQUIRED');
    expect(first.query).not.toHaveBeenCalled();

    const second = inertClient();
    await expect(
      runEngineAutomationMigrationsOnConnectedClient(
        second.client,
        {
          ...inertRuntime(second.client),
          databaseUrl: 'postgresql://hx_ci_runner@127.0.0.1:5432/hx_ci_fresh_test',
          migrationSpecs: [],
        },
        authority
      )
    ).rejects.toThrow('DATABASE_TARGET_MISMATCH');
    expect(second.query).not.toHaveBeenCalled();
  });

  it('rejects canonical plan subsets and reordered entries before any query', async () => {
    const authority = assertMigrationExecutionAuthorized({
      env: { NODE_ENV: 'development', HX_ENVIRONMENT: 'local', SERVICE_ROLE: 'migration' },
      migrationArtifactDigest: await engineMigrationArtifactDigest(),
      databaseUrl: LOCAL_DATABASE_URL,
    });
    const plan = canonicalPlan();
    const { client, query } = inertClient();

    expect(() =>
      authorizeMigrationExecutionPlan(authority, {
        databaseUrl: LOCAL_DATABASE_URL,
        client,
        baseline: plan.baseline,
        migrations: plan.migrations.slice(1),
      })
    ).toThrow('EXACT_CANONICAL_MIGRATION_PLAN_REQUIRED');

    expect(() =>
      authorizeMigrationExecutionPlan(authority, {
        databaseUrl: LOCAL_DATABASE_URL,
        client,
        baseline: plan.baseline,
        migrations: [plan.migrations[1]!, plan.migrations[0]!, ...plan.migrations.slice(2)],
      })
    ).toThrow('EXACT_CANONICAL_MIGRATION_PLAN_REQUIRED');
    const validSession = authorizeMigrationExecutionPlan(authority, {
      databaseUrl: LOCAL_DATABASE_URL,
      client,
      baseline: plan.baseline,
      migrations: plan.migrations,
    });
    expect(() => assertMigrationExecutionSession(validSession)).not.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('enforces incomplete completion, ordered single-use permits, and opaque receipts', async () => {
    const entry = { name: 'exact_local_migration', sql: 'SELECT 1;', sourcePath: '/exact.sql' };
    const { client } = inertClient();
    const authority = localAuthority();
    const session = authorizeMigrationExecutionPlan(authority, {
      databaseUrl: LOCAL_DATABASE_URL,
      client,
      migrations: [entry],
    });

    expect(() => completeMigrationExecutionSession(session, client)).toThrow(
      'MIGRATION_EXECUTION_PLAN_INCOMPLETE'
    );

    const permit = await beginMigrationArtifactOperation(session, entry, client);
    expect(() => completeMigrationOperation(session, structuredClone(permit), client)).toThrow(
      'OPAQUE_OPERATION_PERMIT_REQUIRED'
    );
    completeMigrationOperation(session, permit, client);

    await expect(beginMigrationArtifactOperation(session, entry, client)).rejects.toThrow(
      'MIGRATION_OPERATION_OUT_OF_ORDER'
    );
    const backfillPermit = await beginLegacyLocationBackfillOperation(session, client);
    completeMigrationOperation(session, backfillPermit, client);

    const receipt = completeMigrationExecutionSession(session, client);
    expect(receipt.operationCount).toBe(2);
    expect(() => assertMigrationExecutionReceipt(receipt)).not.toThrow();
    expect(() => assertMigrationExecutionReceipt(structuredClone(receipt))).toThrow(
      'OPAQUE_EXECUTION_RECEIPT_REQUIRED'
    );
    expect(() => assertMigrationExecutionSession(session)).toThrow(
      'OPAQUE_EXECUTION_SESSION_REQUIRED'
    );
    expect(() => authorizeMigrationExecutionPlan(authority, {
      databaseUrl: LOCAL_DATABASE_URL,
      client,
      migrations: [entry],
    })).toThrow('OPAQUE_AUTHORITY_TOKEN_REQUIRED');
  });

  it.each([
    {
      label: 'constitutional baseline',
      baseline: { name: 'baseline', sql: 'SELECT 0;', sourcePath: '/baseline.sql' },
      migrations: [],
      begin: (
        session: Parameters<typeof beginConstitutionalBaselineOperation>[0],
        client: MigrationClient,
      ) => beginConstitutionalBaselineOperation(
        session,
        { name: 'baseline', sql: 'SELECT 0;', sourcePath: '/baseline.sql' },
        client,
      ),
    },
    {
      label: 'migration artifact',
      migrations: [{ name: 'migration', sql: 'SELECT 1;', sourcePath: '/migration.sql' }],
      begin: (
        session: Parameters<typeof beginMigrationArtifactOperation>[0],
        client: MigrationClient,
      ) => beginMigrationArtifactOperation(
        session,
        { name: 'migration', sql: 'SELECT 1;', sourcePath: '/migration.sql' },
        client,
      ),
    },
    {
      label: 'legacy location backfill',
      migrations: [],
      begin: (
        session: Parameters<typeof beginLegacyLocationBackfillOperation>[0],
        client: MigrationClient,
      ) => beginLegacyLocationBackfillOperation(session, client),
    },
  ])('reserves the $label permit before asynchronous live readback', async ({
    baseline,
    migrations,
    begin,
  }) => {
    const { client, query } = inertClient();
    const baseQuery = query.getMockImplementation()!;
    let releaseReadback!: () => void;
    const readbackGate = new Promise<void>((resolveGate) => {
      releaseReadback = resolveGate;
    });
    let firstReadback = true;
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("set_config('search_path', 'public', false)") && firstReadback) {
        firstReadback = false;
        await readbackGate;
      }
      return baseQuery(sql, values);
    });
    const session = authorizeMigrationExecutionPlan(localAuthority(), {
      databaseUrl: LOCAL_DATABASE_URL,
      client,
      ...(baseline ? { baseline } : {}),
      migrations,
    });

    const first = begin(session, client);
    const concurrent = begin(session, client);
    releaseReadback();
    const settled = await Promise.allSettled([first, concurrent]);

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: expect.stringContaining('MIGRATION_OPERATION_ALREADY_ACTIVE'),
      }),
    });
    const fulfilled = settled.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof begin>>> =>
        result.status === 'fulfilled',
    );
    expect(fulfilled).toBeDefined();
    completeMigrationOperation(session, fulfilled!.value, client);
  });

  it('clears a pending permit reservation after live readback fails', async () => {
    const entry = { name: 'retry', sql: 'SELECT 1;', sourcePath: '/retry.sql' };
    const { client, query } = inertClient();
    const baseQuery = query.getMockImplementation()!;
    let failReadback = true;
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("set_config('search_path', 'public', false)") && failReadback) {
        failReadback = false;
        throw new Error('live readback unavailable');
      }
      return baseQuery(sql, values);
    });
    const session = authorizeMigrationExecutionPlan(localAuthority(), {
      databaseUrl: LOCAL_DATABASE_URL,
      client,
      migrations: [entry],
    });

    await expect(beginMigrationArtifactOperation(session, entry, client)).rejects.toThrow(
      'live readback unavailable',
    );
    const retry = await beginMigrationArtifactOperation(session, entry, client);
    completeMigrationOperation(session, retry, client);
  });

  it('allows an aborted operation retry but rejects a changed live backend connection', async () => {
    const first = { name: 'first', sql: 'SELECT 1;', sourcePath: '/first.sql' };
    const second = { name: 'second', sql: 'SELECT 2;', sourcePath: '/second.sql' };
    const { client, connection } = inertClient();
    const session = authorizeMigrationExecutionPlan(localAuthority(), {
      databaseUrl: LOCAL_DATABASE_URL,
      client,
      migrations: [first, second],
    });

    const failedPermit = await beginMigrationArtifactOperation(session, first, client);
    abortMigrationOperation(session, failedPermit, client);
    const retryPermit = await beginMigrationArtifactOperation(session, first, client);
    expect(retryPermit.operationIndex).toBe(failedPermit.operationIndex);
    completeMigrationOperation(session, retryPermit, client);

    connection.backendPid += 1;
    await expect(beginMigrationArtifactOperation(session, second, client)).rejects.toThrow(
      'CONNECTED_MIGRATION_SESSION_CHANGED'
    );
  });

  it('refuses the default raw migration sink before creating a database client', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HX_ENVIRONMENT', 'preview');
    vi.stubEnv('SERVICE_ROLE', 'migration');
    vi.stubEnv('HX_RELEASE_PROMOTION_MODE', '');
    vi.stubEnv('HX_RELEASE_MANIFEST_JSON', JSON.stringify(manifest('preview')));
    vi.stubEnv('HX_RELEASE_MANIFEST_SIGNATURE_JSON', '');
    vi.stubEnv('HX_RELEASE_MANIFEST_SIGNATURE_PATH', '');

    const { client } = inertClient();
    const runtime = inertRuntime(client);
    const createClient = vi.spyOn(runtime, 'createClient');
    await expect(runEngineAutomationMigration(runtime)).rejects.toThrow(
      'AUTHENTICATED_RELEASE_MANIFEST_REQUIRED'
    );
    expect(createClient).not.toHaveBeenCalled();
  });
});
