import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import {
  NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES,
  NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION,
  runNonproductionFinancialDatabaseBootstrap,
  runNonproductionFinancialMigration,
  type NonproductionFinancialMigrationRuntime,
} from '../../src/jobs/nonproduction-financial-migration.js';
import {
  releaseManifestDigest,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';
import type { MigrationClient } from '../../src/jobs/engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  assertConfiguredNonproductionDatabaseTarget,
  assertConnectedNonproductionDatabaseTarget,
} from '../../src/jobs/nonproduction-database-target.js';

const REVISION = '1'.repeat(40);
const sha256 = (value: string) => `sha256:${value.repeat(64)}`;
const BASE_MIGRATION_SQL = 'CREATE TABLE fake_financial_evidence(id UUID);';
const REFRESH_MIGRATION_SQL = 'ALTER TABLE fake_financial_evidence ADD COLUMN refresh BOOLEAN;';
const SETTLEMENT_COMPLETION_MIGRATION_SQL =
  'ALTER TABLE fake_financial_evidence ADD COLUMN settlement_completion BOOLEAN;';
const LIFECYCLE_BRIDGE_MIGRATION_SQL =
  'ALTER TABLE fake_financial_evidence ADD COLUMN lifecycle_bridge BOOLEAN;';
const STAGING_DATABASE_URL =
  'postgresql://synthetic@postgres.railway.internal:5432/hustlexp_nonprod';
const STAGING_DATABASE_IDENTITY = {
  database_name: 'hustlexp_nonprod',
  role_name: 'synthetic',
  server_address: '10.42.0.8',
  server_port: 5432,
  schema_name: 'public',
  search_path: 'public',
  effective_schemas: ['public'],
};
const MIGRATION_SQL_BY_NAME = new Map([
  [NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION, BASE_MIGRATION_SQL],
  [NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION, REFRESH_MIGRATION_SQL],
  [
    NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION,
    SETTLEMENT_COMPLETION_MIGRATION_SQL,
  ],
  [NONPRODUCTION_FAKE_FINANCIAL_MIGRATION, LIFECYCLE_BRIDGE_MIGRATION_SQL],
]);
const MIGRATION_SHA_BY_NAME = new Map(
  [...MIGRATION_SQL_BY_NAME].map(([name, sql]) => [
    name,
    createHash('sha256').update(sql).digest('hex'),
  ]),
);
const REQUIRED_OUTCOMES = REQUIRED_MIGRATION_FILES.map(({ name, fileName }) => ({
  status: 'applied' as const,
  migration: name,
  sourcePath: `/app/backend/database/migrations/${fileName}`,
  sha256: createHash('sha256').update(name).digest('hex'),
}));

function release(
  environment: ReleaseManifest['environment'] = 'staging',
): ReleaseManifestEvidence {
  const manifest: ReleaseManifest = {
    version: 1,
    environment,
    releaseId: `test-${environment}-financial-0001`,
    createdAt: '2026-08-26T12:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: sha256('f'),
    },
    components: {
      backend: { revision: REVISION, artifactDigest: sha256('1'), imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE', imageDigest: sha256('2') },
      worker: { revision: REVISION, artifactDigest: sha256('3'), imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE', imageDigest: sha256('4') },
      web: { revision: '2'.repeat(40), artifactDigest: sha256('5'), imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE', imageDigest: sha256('6') },
      migration: { revision: REVISION, artifactDigest: sha256('7') },
      policy: { revision: '3'.repeat(40), artifactDigest: sha256('8') },
      fixtures: {
        revision: '4'.repeat(40), artifactDigest: sha256('9'), imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE', imageDigest: sha256('a'),
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
  return {
    schema_version: 1,
    status: 'valid',
    digest: releaseManifestDigest(manifest),
    source: 'HX_RELEASE_MANIFEST_JSON',
    errors: [],
    manifest,
    authentication: {
      status: 'verified',
      algorithm: 'ed25519',
      keyId: 'unit-test-release-authority',
      keyFingerprint: `sha256:${'e'.repeat(64)}`,
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
    source: 'RAILWAY_GIT_COMMIT_SHA',
    artifact_digest: release().manifest!.components.backend.artifactDigest,
    artifact_verified: true,
  };
}

function client(existing = false, overrides: {
  applied?: Partial<Record<string, string | null>>;
  schema?: Partial<Record<string, string | null>>;
  identityRows?: Array<Partial<typeof STAGING_DATABASE_IDENTITY>>;
} = {}): MigrationClient & { queries: string[] } {
  const queries: string[] = [];
  const applied = new Map<string, string | null>();
  const schema = new Map<string, string | null>();
  if (existing) {
    for (const migration of NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES) {
      const digest = MIGRATION_SHA_BY_NAME.get(migration.name) ?? null;
      applied.set(migration.name, digest);
      schema.set(migration.name, digest);
    }
  }
  for (const [name, digest] of Object.entries(overrides.applied ?? {})) applied.set(name, digest);
  for (const [name, digest] of Object.entries(overrides.schema ?? {})) schema.set(name, digest);
  let completion: Record<string, unknown> | null = null;
  return {
    queries,
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (sql.includes('current_database()::text AS database_name')) {
        return {
          rows: (overrides.identityRows ?? [STAGING_DATABASE_IDENTITY]).map((row) => ({
            ...STAGING_DATABASE_IDENTITY,
            ...row,
          })),
        };
      }
      if (sql.includes('SELECT name, sha256 FROM applied_migrations')) {
        const name = String(values?.[0] ?? '');
        return {
          rows: applied.has(name)
            ? [{ name, sha256: applied.get(name) }]
            : [],
        };
      }
      if (sql.includes('INSERT INTO applied_migrations')) {
        applied.set(String(values?.[0] ?? ''), String(values?.[1] ?? ''));
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO hxos_fake_financial_schema_evidence_v')) {
        schema.set(String(values?.[0] ?? ''), String(values?.[1] ?? ''));
        return { rows: [] };
      }
      if (sql.includes('FROM hxos_fake_financial_schema_evidence_v')) {
        const name = String(values?.[0] ?? '');
        const digest = schema.get(name);
        return {
          rows: digest ? [{ migration_sql_sha256: digest }] : [],
        };
      }
      if (sql.includes('INSERT INTO hxos_nonproduction_bootstrap_completion_v1')) {
        if (completion) return { rows: [] };
        completion = {
            release_manifest_digest: values?.[0],
            migration_artifact_digest: values?.[1],
            release_id: values?.[2],
            release_environment: values?.[3],
            required_migration_count: values?.[4],
            financial_migration_status: values?.[5],
            completed_at: '2026-08-26T12:30:00.000Z',
        };
        return { rows: [completion] };
      }
      if (sql.includes('FROM hxos_nonproduction_bootstrap_completion_v1')) {
        return { rows: completion ? [completion] : [] };
      }
      return { rows: [] };
    }) as MigrationClient['query'],
  };
}

function runtime(
  overrides: Partial<NonproductionFinancialMigrationRuntime> = {},
): NonproductionFinancialMigrationRuntime {
  const migrationClient = client();
  return {
    env: {
      NODE_ENV: 'production',
      SERVICE_ROLE: 'migration',
      HX_ENVIRONMENT: 'staging',
      HX_PAYMENT_CREATION_MODE: 'frozen',
      RAILWAY_PROJECT_NAME: 'hustlexp-nonprod',
      RAILWAY_PROJECT_ID: 'project-nonprod-1',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      RAILWAY_ENVIRONMENT_ID: 'environment-staging-1',
      HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST: release().digest,
      HX_NONPRODUCTION_DATABASE_NAME: 'hustlexp_nonprod',
      HX_NONPRODUCTION_DATABASE_ROLE: 'synthetic',
      HX_NONPRODUCTION_DATABASE_HOST: 'postgres.railway.internal',
      HX_NONPRODUCTION_DATABASE_PORT: '5432',
    },
    release: release(),
    identity: identity(),
    databaseUrl: STAGING_DATABASE_URL,
    migrationSpecs: NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map(({ name, fileName }) => ({
      name,
      candidatePaths: [`/app/backend/database/migrations/${fileName}`],
    })),
    migrationArtifactDigest: vi.fn(async () => '7'.repeat(64)),
    readText: vi.fn(async (filePath: string) => {
      const registration = NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.find(
        ({ fileName }) => filePath.endsWith(fileName),
      );
      const sql = registration ? MIGRATION_SQL_BY_NAME.get(registration.name) : undefined;
      if (!sql) throw new Error(`missing test migration: ${filePath}`);
      return sql;
    }),
    createClient: vi.fn(() => migrationClient),
    ...overrides,
  };
}

describe('nonproduction database target identity', () => {
  const localEnv = {
    HX_ENVIRONMENT: 'local',
    HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_ci_system_test',
    HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_ci_runner',
  };

  it('accepts exact loopback and source-pinned Compose targets with matching live identity', async () => {
    const loopback = assertConfiguredNonproductionDatabaseTarget(
      localEnv,
      'postgresql://hx_ci_runner@127.0.0.1:5432/hx_ci_system_test',
    );
    await expect(assertConnectedNonproductionDatabaseTarget(client(false, {
      identityRows: [{
        database_name: 'hx_ci_system_test',
        role_name: 'hx_ci_runner',
        server_address: '127.0.0.1',
        server_port: 5432,
        schema_name: 'public',
        search_path: 'public',
        effective_schemas: ['public'],
      }],
    }), loopback)).resolves.toEqual(expect.objectContaining({
      databaseName: 'hx_ci_system_test',
      roleName: 'hx_ci_runner',
      serverAddress: '127.0.0.1',
    }));

    const composeEnv = {
      HX_ENVIRONMENT: 'local',
      HXOS_LOCAL_TEST_DATABASE_NAME: 'hustlexp_startup_test',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'hustlexp_local_runner',
    };
    const compose = assertConfiguredNonproductionDatabaseTarget(
      composeEnv,
      'postgresql://hustlexp_local_runner@postgres:5432/hustlexp_startup_test',
    );
    const composeClient = client(false, {
      identityRows: [{
        database_name: 'hustlexp_startup_test',
        role_name: 'hustlexp_local_runner',
        server_address: '172.18.0.2',
        server_port: 5432,
        schema_name: 'public',
        search_path: 'public',
        effective_schemas: ['public'],
      }],
    });
    await expect(assertConnectedNonproductionDatabaseTarget(composeClient, compose)).resolves.toEqual(expect.objectContaining({
      databaseName: 'hustlexp_startup_test',
      serverAddress: '172.18.0.2',
    }));
    expect(composeClient.queries.some((sql) => (
      sql.includes("COALESCE(host(inet_server_addr()), 'local_socket') AS server_address")
    ))).toBe(true);
  });

  it('rejects public, DNS-like, and arbitrary private local hosts and a public Compose address', async () => {
    for (const host of ['localhost', 'db.example.test', '10.42.0.9']) {
      expect(() => assertConfiguredNonproductionDatabaseTarget(
        localEnv,
        `postgresql://hx_ci_runner@${host}:5432/hx_ci_system_test`,
      )).toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:LOCAL_DATABASE_HOST_NOT_ALLOWLISTED');
    }

    const compose = assertConfiguredNonproductionDatabaseTarget({
      HX_ENVIRONMENT: 'local',
      HXOS_LOCAL_TEST_DATABASE_NAME: 'hustlexp_startup_test',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'hustlexp_local_runner',
    }, 'postgresql://hustlexp_local_runner@postgres:5432/hustlexp_startup_test');
    await expect(assertConnectedNonproductionDatabaseTarget(client(false, {
      identityRows: [{
        database_name: 'hustlexp_startup_test',
        role_name: 'hustlexp_local_runner',
        server_address: '8.8.8.8',
        server_port: 5432,
        schema_name: 'public',
        search_path: 'public',
        effective_schemas: ['public'],
      }],
    }), compose)).rejects.toThrow(
      'NONPRODUCTION_DATABASE_TARGET_REFUSED:LIVE_LOCAL_DATABASE_ADDRESS_MISMATCH',
    );
  });
});

describe('nonproduction financial database migration', () => {
  it('authorizes before connecting and applies the exact migration atomically', async () => {
    const migrationClient = client();
    const actualRuntime = runtime({ createClient: vi.fn(() => migrationClient) });

    await expect(runNonproductionFinancialMigration(actualRuntime)).resolves.toEqual({
      status: 'applied',
      migration: NONPRODUCTION_FAKE_FINANCIAL_MIGRATION,
      sourcePath: '/app/backend/database/migrations/20260921_universal_v1_fake_financial_lifecycle_bridge_v1.sql',
      sha256: MIGRATION_SHA_BY_NAME.get(NONPRODUCTION_FAKE_FINANCIAL_MIGRATION),
      migrations: NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map(({ name, fileName }) => ({
        status: 'applied',
        migration: name,
        sourcePath: `/app/backend/database/migrations/${fileName}`,
        sha256: MIGRATION_SHA_BY_NAME.get(name),
      })),
      releaseManifestDigest: actualRuntime.release.digest,
      migrationArtifactDigest: sha256('7'),
    });
    expect(migrationClient.connect).toHaveBeenCalledOnce();
    expect(migrationClient.queries).toContain(BASE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(REFRESH_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(SETTLEMENT_COMPLETION_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(LIFECYCLE_BRIDGE_MIGRATION_SQL);
    expect(migrationClient.queries.at(-1)).toBe('COMMIT');
    expect(migrationClient.end).toHaveBeenCalledOnce();
  });

  it('is idempotent and does not execute migration SQL after recorded application', async () => {
    const migrationClient = client(true);
    await expect(runNonproductionFinancialMigration(runtime({
      createClient: () => migrationClient,
    }))).resolves.toEqual(expect.objectContaining({ status: 'already_applied' }));
    expect(migrationClient.queries).not.toContain(BASE_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(REFRESH_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(SETTLEMENT_COMPLETION_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(LIFECYCLE_BRIDGE_MIGRATION_SQL);
  });

  it('upgrades an exact v1 installation through the ordered append-only v4 bridge', async () => {
    const baseDigest = MIGRATION_SHA_BY_NAME.get(NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION);
    const migrationClient = client(false, {
      applied: { [NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION]: baseDigest },
      schema: { [NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION]: baseDigest },
    });

    const result = await runNonproductionFinancialMigration(runtime({
      createClient: () => migrationClient,
    }));

    expect(result.migrations.map(({ migration, status }) => ({ migration, status }))).toEqual([
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION,
        status: 'already_applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_MIGRATION,
        status: 'applied',
      },
    ]);
    expect(migrationClient.queries).not.toContain(BASE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(REFRESH_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(SETTLEMENT_COMPLETION_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(LIFECYCLE_BRIDGE_MIGRATION_SQL);
  });

  it('refuses an already-recorded migration without exact immutable SQL evidence', async () => {
    for (const storedDigest of [null, '0'.repeat(64)]) {
      const migrationClient = client(true, {
        schema: { [NONPRODUCTION_FAKE_FINANCIAL_MIGRATION]: storedDigest },
      });
      await expect(runNonproductionFinancialMigration(runtime({
        createClient: () => migrationClient,
      }))).rejects.toThrow('NONPRODUCTION_FAKE_FINANCIAL_SCHEMA_DIGEST_MISMATCH');
      expect(migrationClient.queries.at(-1)).toBe('ROLLBACK');
      expect(migrationClient.end).toHaveBeenCalledOnce();
    }
  });

  it('refuses a fake-finance applied row with missing or drifted canonical checksum evidence', async () => {
    for (const storedDigest of [null, '0'.repeat(64)]) {
      const migrationClient = client(true, {
        applied: { [NONPRODUCTION_FAKE_FINANCIAL_MIGRATION]: storedDigest },
      });
      await expect(runNonproductionFinancialMigration(runtime({
        createClient: () => migrationClient,
      }))).rejects.toThrow('NONPRODUCTION_FAKE_FINANCIAL_APPLIED_DIGEST_MISMATCH');
      expect(migrationClient.queries.at(-1)).toBe('ROLLBACK');
      expect(migrationClient.end).toHaveBeenCalledOnce();
    }
  });

  it('fails before reading SQL or creating a client for production and revision spoofing', async () => {
    for (const overrides of [
      {
        env: { HX_ENVIRONMENT: 'production', HX_PAYMENT_CREATION_MODE: 'frozen' },
      },
      {
        identity: { ...identity(), revision: '9'.repeat(40) },
      },
    ]) {
      const readText = vi.fn(async () => 'SHOULD NOT READ');
      const createClient = vi.fn(() => client());
      await expect(runNonproductionFinancialMigration(runtime({
        ...overrides,
        readText,
        createClient,
      }))).rejects.toThrow('NONPRODUCTION_FAKE_FINANCE_REFUSED');
      expect(readText).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it('fails before creating a client when DATABASE_URL is absent', async () => {
    const createClient = vi.fn(() => client());
    await expect(runNonproductionFinancialMigration(runtime({
      databaseUrl: '', createClient,
    }))).rejects.toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:DATABASE_URL_REQUIRED');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('refuses remote local targets before artifact reads, SQL reads, clients, or canonical work', async () => {
    const migrationArtifactDigest = vi.fn(async () => '7'.repeat(64));
    const readText = vi.fn(async () => 'SHOULD NOT READ');
    const createClient = vi.fn(() => client());
    const runRequiredMigrationsOnClient = vi.fn(async () => REQUIRED_OUTCOMES);
    const localRelease = release('local');
    const financialMigration = runtime({
      env: {
        SERVICE_ROLE: 'migration',
        HX_ENVIRONMENT: 'local',
        HX_PAYMENT_CREATION_MODE: 'frozen',
        HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_ci_system_test',
        HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_ci_runner',
      },
      release: localRelease,
      databaseUrl: 'postgresql://hx_ci_runner@db.example.test:5432/hx_ci_system_test',
      migrationArtifactDigest,
      readText,
      createClient,
    });

    await expect(runNonproductionFinancialDatabaseBootstrap({
      runRequiredMigrationsOnClient,
      financialMigration,
    })).rejects.toThrow(
      'NONPRODUCTION_DATABASE_TARGET_REFUSED:LOCAL_DATABASE_HOST_NOT_ALLOWLISTED',
    );
    expect(migrationArtifactDigest).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(runRequiredMigrationsOnClient).not.toHaveBeenCalled();
  });

  it('refuses missing or mismatched deployed bindings before any read or connection', async () => {
    const baseline = runtime();
    const cases = [
      {
        env: { ...baseline.env, HX_NONPRODUCTION_DATABASE_ROLE: undefined },
        databaseUrl: STAGING_DATABASE_URL,
        reason: 'HX_NONPRODUCTION_DATABASE_ROLE_REQUIRED',
      },
      {
        env: baseline.env,
        databaseUrl: 'postgresql://synthetic@postgres.railway.internal:5432/wrong_nonprod',
        reason: 'NONPRODUCTION_DATABASE_NAME_MISMATCH',
      },
      {
        env: { ...baseline.env, HX_NONPRODUCTION_DATABASE_PORT: '6432' },
        databaseUrl: STAGING_DATABASE_URL,
        reason: 'NONPRODUCTION_DATABASE_PORT_MISMATCH',
      },
    ];

    for (const testCase of cases) {
      const migrationArtifactDigest = vi.fn(async () => '7'.repeat(64));
      const readText = vi.fn(async () => 'SHOULD NOT READ');
      const createClient = vi.fn(() => client());
      const runRequiredMigrationsOnClient = vi.fn(async () => REQUIRED_OUTCOMES);
      await expect(runNonproductionFinancialDatabaseBootstrap({
        runRequiredMigrationsOnClient,
        financialMigration: runtime({
          env: testCase.env,
          databaseUrl: testCase.databaseUrl,
          migrationArtifactDigest,
          readText,
          createClient,
        }),
      })).rejects.toThrow(`NONPRODUCTION_DATABASE_TARGET_REFUSED:${testCase.reason}`);
      expect(migrationArtifactDigest).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      expect(runRequiredMigrationsOnClient).not.toHaveBeenCalled();
    }
  });

  it('refuses a live identity mismatch before canonical or fake SQL', async () => {
    const migrationClient = client(false, {
      identityRows: [{ role_name: 'unexpected_role' }],
    });
    const readText = vi.fn(async () => 'SHOULD NOT READ');
    const runRequiredMigrationsOnClient = vi.fn(async () => REQUIRED_OUTCOMES);
    await expect(runNonproductionFinancialDatabaseBootstrap({
      runRequiredMigrationsOnClient,
      financialMigration: runtime({
        readText,
        createClient: () => migrationClient,
      }),
    })).rejects.toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:LIVE_DATABASE_ROLE_MISMATCH');
    expect(migrationClient.connect).toHaveBeenCalledOnce();
    expect(migrationClient.end).toHaveBeenCalledOnce();
    expect(runRequiredMigrationsOnClient).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(migrationClient.queries).not.toContain(BASE_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(REFRESH_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(SETTLEMENT_COMPLETION_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(LIFECYCLE_BRIDGE_MIGRATION_SQL);
  });

  it('refuses an incomplete or reordered nonproduction migration chain before reading SQL', async () => {
    for (const migrationSpecs of [
      runtime().migrationSpecs.slice(0, 1),
      [...runtime().migrationSpecs].reverse(),
    ]) {
      const readText = vi.fn(async () => 'SHOULD NOT READ');
      const createClient = vi.fn(() => client());
      await expect(runNonproductionFinancialMigration(runtime({
        migrationSpecs,
        readText,
        createClient,
      }))).rejects.toThrow('NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_CHAIN_MISMATCH');
      expect(readText).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it('normalizes the engine bare digest and refuses a bundled artifact substitution', async () => {
    const createClient = vi.fn(() => client());
    await expect(runNonproductionFinancialMigration(runtime({
      migrationArtifactDigest: async () => sha256('6'),
      createClient,
    }))).rejects.toThrow('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_MISMATCH');
    expect(createClient).not.toHaveBeenCalled();

    await expect(runNonproductionFinancialMigration(runtime({
      migrationArtifactDigest: async () => 'not-a-digest',
      createClient,
    }))).rejects.toThrow('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_INVALID');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('closes the client and preserves a migration failure', async () => {
    const migrationClient = client();
    migrationClient.query = vi.fn(async (sql: string) => {
      migrationClient.queries.push(sql);
      if (sql.includes('current_database()::text AS database_name')) {
        return { rows: [STAGING_DATABASE_IDENTITY] };
      }
      if (sql.includes('CREATE TABLE fake_financial_evidence')) throw new Error('migration failed');
      return { rows: [] };
    }) as MigrationClient['query'];
    await expect(runNonproductionFinancialMigration(runtime({
      createClient: () => migrationClient,
    }))).rejects.toThrow('migration failed');
    expect(migrationClient.queries.at(-1)).toBe('ROLLBACK');
    expect(migrationClient.end).toHaveBeenCalledOnce();
  });

  it('runs canonical migrations first and never attempts fake finance after their failure', async () => {
    const order: string[] = [];
    const migrationClient = client();
    const financial = runtime({
      createClient: vi.fn(() => migrationClient),
      readText: vi.fn(async () => {
        order.push('financial');
        return 'SELECT 1;';
      }),
    });
    await expect(runNonproductionFinancialDatabaseBootstrap({
      runRequiredMigrationsOnClient: async (connectedClient, databaseUrl, expectedTarget) => {
        expect(connectedClient).toBe(migrationClient);
        expect(databaseUrl).toBe(STAGING_DATABASE_URL);
        expect(expectedTarget).toEqual(expect.objectContaining({
          databaseName: 'hustlexp_nonprod',
          roleName: 'synthetic',
          hostname: 'postgres.railway.internal',
          port: 5432,
        }));
        order.push('required');
        await connectedClient.query('SELECT canonical_required_marker');
        return REQUIRED_OUTCOMES;
      },
      financialMigration: financial,
    })).resolves.toEqual(expect.objectContaining({
      financial: expect.objectContaining({ migrationArtifactDigest: sha256('7') }),
      completion: expect.objectContaining({
        schemaVersion: 1,
        status: 'complete',
        releaseManifestDigest: financial.release.digest,
        migrationArtifactDigest: sha256('7'),
        requiredMigrationCount: REQUIRED_OUTCOMES.length,
      }),
    }));
    expect(order).toEqual([
      'required',
      'financial',
      'financial',
      'financial',
      'financial',
    ]);
    expect(financial.createClient).toHaveBeenCalledOnce();
    expect(migrationClient.connect).toHaveBeenCalledOnce();
    expect(migrationClient.end).toHaveBeenCalledOnce();
    const identityIndexes = migrationClient.queries.flatMap((sql, index) =>
      sql.includes('current_database()::text AS database_name') ? [index] : []
    );
    expect(identityIndexes).toHaveLength(3);
    expect(identityIndexes[0]).toBeLessThan(
      migrationClient.queries.indexOf('SELECT canonical_required_marker'),
    );
    expect(identityIndexes[1]).toBeLessThan(migrationClient.queries.indexOf('SELECT 1;'));
    expect(identityIndexes[2]).toBeLessThan(migrationClient.queries.findIndex((sql) =>
      sql.includes('INSERT INTO hxos_nonproduction_bootstrap_completion_v1')
    ));

    const readText = vi.fn(async () => 'SHOULD NOT READ');
    await expect(runNonproductionFinancialDatabaseBootstrap({
      runRequiredMigrationsOnClient: async () => {
        throw new Error('required migration failed');
      },
      financialMigration: runtime({ readText }),
    })).rejects.toThrow('required migration failed');
    expect(readText).not.toHaveBeenCalled();
  });

  it('requires complete canonical migration evidence before fake finance or a completion receipt', async () => {
    const readText = vi.fn(async () => BASE_MIGRATION_SQL);
    await expect(runNonproductionFinancialDatabaseBootstrap({
      runRequiredMigrationsOnClient: async () => [],
      financialMigration: runtime({ readText }),
    })).rejects.toThrow('NONPRODUCTION_REQUIRED_MIGRATION_EVIDENCE_INCOMPLETE');
    expect(readText).not.toHaveBeenCalled();
  });

  it('replays the same append-only completion receipt without mutating first-run evidence', async () => {
    const migrationClient = client();
    const financialMigration = runtime({ createClient: () => migrationClient });
    const bootstrapRuntime = {
      runRequiredMigrationsOnClient: async () => REQUIRED_OUTCOMES,
      financialMigration,
    };

    const first = await runNonproductionFinancialDatabaseBootstrap(bootstrapRuntime);
    const replay = await runNonproductionFinancialDatabaseBootstrap(bootstrapRuntime);
    expect(first.financial.status).toBe('applied');
    expect(replay.financial.status).toBe('already_applied');
    expect(replay.completion).toEqual(first.completion);
    expect(migrationClient.queries.filter((sql) =>
      sql.includes('UPDATE hxos_nonproduction_bootstrap_completion_v1')
      || sql.includes('DELETE FROM hxos_nonproduction_bootstrap_completion_v1')
    )).toEqual([]);
  });

  it('preflights nonproduction authority before the canonical migration chain opens a database', async () => {
    const runRequiredMigrationsOnClient = vi.fn(async () => []);
    await expect(runNonproductionFinancialDatabaseBootstrap({
      runRequiredMigrationsOnClient,
      financialMigration: runtime({
        env: { HX_ENVIRONMENT: 'production', HX_PAYMENT_CREATION_MODE: 'frozen' },
      }),
    })).rejects.toThrow('NONPRODUCTION_FAKE_FINANCE_REFUSED');
    expect(runRequiredMigrationsOnClient).not.toHaveBeenCalled();
  });

  it('exposes one explicit compiled nonproduction command and keeps production start separate', () => {
    const pkg = JSON.parse(readFileSync(
      new URL('../../../package.json', import.meta.url),
      'utf8',
    )) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:migrate:nonprod-financial']).toContain(
      'runNonproductionFinancialDatabaseBootstrap',
    );
    expect(pkg.scripts['db:migrate:nonprod-financial']).toContain('result.completion');
    expect(pkg.scripts.start).not.toContain('nonproduction-financial-migration');
    expect(pkg.scripts['start:workers']).not.toContain('nonproduction-financial-migration');
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION,
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION,
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION,
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_MIGRATION,
    );
  });
});
