import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import {
  NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_RECOVERY_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_THREE_PHASE_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_COMMAND_OUTBOX_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_DISPUTE_RELEASE_GATE_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_EXPIRY_RECOVERY_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_SECURITY_EXPIRY_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES,
  NONPRODUCTION_FAKE_FINANCIAL_RUNTIME_INSERT_AUTHORITY_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_TERMINAL_LIFECYCLE_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_WORK_ORDER_AUTHORITY_HARDENING_MIGRATION,
  NONPRODUCTION_FAKE_FINANCIAL_WORK_ORDER_BOOTSTRAP_SEAL_MIGRATION,
  recordNonproductionFinancialBootstrapCompletion,
  runNonproductionFinancialDatabaseBootstrap,
  runNonproductionFinancialMigration,
  type NonproductionFinancialDatabaseBootstrapRuntime,
  type NonproductionFinancialMigrationRuntime,
} from '../../src/jobs/nonproduction-financial-migration.js';
import {
  releaseManifestDigest,
  type ReleaseManifestV2,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';
import type { MigrationClient } from '../../src/jobs/engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  assertConfiguredNonproductionDatabaseTarget,
  assertConnectedNonproductionDatabaseTarget,
} from '../../src/jobs/nonproduction-database-target.js';

const REVISION = '1'.repeat(40);
const AMBIENT_FINANCIAL_CREDENTIAL_NAME =
  /^(?:STRIPE|ADYEN|BRAINTREE|PAYPAL|PLAID|DWOLLA|SQUARE|BANK|LIVE_(?:PAYMENT|PAYOUT)|(?:PAYMENT|PAYOUT)_PROVIDER).*?(?:SECRET|PRIVATE|API_?KEY|ACCESS_?TOKEN)/iu;
const sha256 = (value: string) => `sha256:${value.repeat(64)}`;
const LOCAL_DATABASE_URL = 'postgresql://hx_ci_runner@127.0.0.1:5432/hx_ci_system_test';
const LOCAL_DATABASE_IDENTITY = {
  database_name: 'hx_ci_system_test',
  role_name: 'hx_ci_runner',
  session_role_name: 'hx_ci_runner',
  server_address: '127.0.0.1',
  server_port: 5432,
  schema_name: 'public',
  search_path: 'public',
  effective_schemas: ['public'],
};
const migrationSql = (fileName: string) =>
  readFileSync(new URL(`../../database/migrations/${fileName}`, import.meta.url), 'utf8');
const MIGRATION_SQL_BY_NAME = new Map(
  NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map(({ name, fileName }) => [
    name,
    migrationSql(fileName),
  ])
);
const BASE_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION)!;
const REFRESH_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION
)!;
const SETTLEMENT_COMPLETION_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION
)!;
const LIFECYCLE_BRIDGE_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_MIGRATION
)!;
const TERMINAL_LIFECYCLE_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_TERMINAL_LIFECYCLE_MIGRATION
)!;
const CHANGE_ORDER_THREE_PHASE_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_THREE_PHASE_MIGRATION
)!;
const CHANGE_ORDER_RECOVERY_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_RECOVERY_MIGRATION
)!;
const DISPUTE_RELEASE_GATE_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_DISPUTE_RELEASE_GATE_MIGRATION
)!;
const SECURITY_EXPIRY_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_SECURITY_EXPIRY_MIGRATION
)!;
const EXPIRY_RECOVERY_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_EXPIRY_RECOVERY_MIGRATION
)!;
const RUNTIME_INSERT_AUTHORITY_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_RUNTIME_INSERT_AUTHORITY_MIGRATION
)!;
const WORK_ORDER_AUTHORITY_HARDENING_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_WORK_ORDER_AUTHORITY_HARDENING_MIGRATION
)!;
const WORK_ORDER_BOOTSTRAP_SEAL_MIGRATION_SQL = MIGRATION_SQL_BY_NAME.get(
  NONPRODUCTION_FAKE_FINANCIAL_WORK_ORDER_BOOTSTRAP_SEAL_MIGRATION
)!;
const FIRST_REQUIRED_MIGRATION_SQL = migrationSql(REQUIRED_MIGRATION_FILES[0]!.fileName);
const CONSTITUTIONAL_BASELINE_SQL = readFileSync(
  new URL('../../database/constitutional-schema.sql', import.meta.url),
  'utf8'
);
const MIGRATION_SHA_BY_NAME = new Map(
  [...MIGRATION_SQL_BY_NAME].map(([name, sql]) => [
    name,
    createHash('sha256').update(sql).digest('hex'),
  ])
);
const REQUIRED_OUTCOMES = REQUIRED_MIGRATION_FILES.map(({ name, fileName }) => ({
  status: 'applied' as const,
  migration: name,
  sourcePath: `/app/backend/database/migrations/${fileName}`,
  sha256: createHash('sha256').update(migrationSql(fileName)).digest('hex'),
}));

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (AMBIENT_FINANCIAL_CREDENTIAL_NAME.test(name)) vi.stubEnv(name, '');
  }
  vi.stubEnv('HX_LIVE_FINANCIAL_RAILS', 'false');
  vi.stubEnv('HX_LIVE_PROVIDER_ACCESS', 'false');
  vi.stubEnv('TASK_LOCATION_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('TASK_LOCATION_ENCRYPTION_KEY_ID', 'unit-location-v1');
  vi.stubEnv('TASK_LOCATION_DECRYPTION_KEYS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function release(
  environment: ReleaseManifestV2['environment'] = 'staging'
): ReleaseManifestEvidence {
  const manifest: ReleaseManifestV2 = {
    version: 2,
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
      backend: {
        revision: REVISION,
        artifactDigest: sha256('1'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: sha256('2'),
      },
      worker: {
        revision: REVISION,
        artifactDigest: sha256('3'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: sha256('4'),
      },
      web: {
        revision: '2'.repeat(40),
        artifactDigest: sha256('5'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: sha256('6'),
      },
      migration: { revision: REVISION, artifactDigest: sha256('7') },
      policy: { revision: '3'.repeat(40), artifactDigest: sha256('8') },
      fixtures: {
        revision: '4'.repeat(40),
        artifactDigest: sha256('9'),
        providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        providerImageDigest: sha256('a'),
        databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        databaseImageDigest: sha256('b'),
      },
    },
    infrastructure: {
      revision: '5'.repeat(40),
      artifactDigest: sha256('c'),
      desiredTopologyDigest: sha256('d'),
    },
    databaseTargets: {
      api: { component: 'api', environment, databaseTargetDigest: sha256('e') },
      worker: { component: 'worker', environment, databaseTargetDigest: sha256('f') },
      attester: { component: 'attester', environment, databaseTargetDigest: sha256('1') },
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

function client(
  existing = false,
  overrides: {
    applied?: Partial<Record<string, string | null>>;
    schema?: Partial<Record<string, string | null>>;
    identityRows?: Array<Partial<typeof LOCAL_DATABASE_IDENTITY>>;
    beforeCompletionLock?: () => Promise<void>;
  } = {}
): MigrationClient & {
  queries: string[];
  seedApplied(outcomes: readonly { migration: string; sha256: string }[]): void;
  deleteApplied(migration: string): void;
  seedSchema(migration: string, sha256: string): void;
} {
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
  let baselineReceiptTableExists = false;
  let schemaVersionsExists = false;
  let baselineReceipt: Record<string, unknown> | null = null;
  const backendPid = 8124;
  let coreMarker: string | null = null;
  let supplementalMarker: string | null = null;
  return {
    queries,
    seedApplied: (outcomes) => {
      for (const outcome of outcomes) applied.set(outcome.migration, outcome.sha256);
    },
    deleteApplied: (migration) => applied.delete(migration),
    seedSchema: (migration, sha256) => schema.set(migration, sha256),
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (sql.includes('current_database()::text AS database_name')) {
        return {
          rows: (overrides.identityRows ?? [LOCAL_DATABASE_IDENTITY]).map((row) => ({
            ...LOCAL_DATABASE_IDENTITY,
            ...row,
          })),
        };
      }
      if (sql.includes("set_config('hustlexp.migration_session'")) {
        coreMarker = String(values?.[0] ?? '');
        return { rows: [{ backend_pid: backendPid, session_marker: coreMarker }] };
      }
      if (sql.includes("current_setting('hustlexp.migration_session'")) {
        return { rows: [{ backend_pid: backendPid, session_marker: coreMarker }] };
      }
      if (sql.includes("set_config('hustlexp.supplemental_migration_session'")) {
        supplementalMarker = String(values?.[0] ?? '');
        return { rows: [{ backend_pid: backendPid, session_marker: supplementalMarker }] };
      }
      if (sql.includes("current_setting('hustlexp.supplemental_migration_session'")) {
        return { rows: [{ backend_pid: backendPid, session_marker: supplementalMarker }] };
      }
      if (sql.includes("pg_advisory_xact_lock(hashtext('nonproduction-bootstrap-completion')")) {
        await overrides.beforeCompletionLock?.();
        return { rows: [] };
      }
      if (sql.includes('AS receipt_table_exists')) {
        return { rows: [{ receipt_table_exists: baselineReceiptTableExists }] };
      }
      if (sql.includes('AS user_objects_exist')) {
        return { rows: [{ user_objects_exist: false }] };
      }
      if (sql === CONSTITUTIONAL_BASELINE_SQL) {
        schemaVersionsExists = true;
        return { rows: [] };
      }
      if (sql.includes('CREATE TABLE public.hustlexp_constitutional_baseline_receipts')) {
        baselineReceiptTableExists = true;
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO public.hustlexp_constitutional_baseline_receipts')) {
        baselineReceipt = {
          receipt_count: 1,
          singleton_true: true,
          receipt_version: Number(values?.[0]),
          baseline_name: String(values?.[1]),
          baseline_sha256: String(values?.[2]),
          provenance: String(values?.[3]),
          reconciliation_sha256: null,
          schema_versions_exists: schemaVersionsExists,
          immutable_trigger_count: 2,
          rejection_function_exists: true,
          applied_at_present: true,
        };
        return { rows: [] };
      }
      if (sql.includes('AS receipt_count')) {
        return {
          rows: [
            baselineReceipt ?? {
              receipt_count: 0,
              singleton_true: null,
              receipt_version: null,
              baseline_name: null,
              baseline_sha256: null,
              provenance: null,
              reconciliation_sha256: null,
              schema_versions_exists: schemaVersionsExists,
              immutable_trigger_count: 0,
              rejection_function_exists: false,
              applied_at_present: null,
            },
          ],
        };
      }
      if (sql.includes('SELECT name, sha256 FROM public.applied_migrations ORDER BY name')) {
        return {
          rows: [...applied].map(([name, sha256]) => ({ name, sha256 })),
        };
      }
      if (sql.includes('SELECT name, sha256 FROM public.applied_migrations')) {
        const name = String(values?.[0] ?? '');
        return {
          rows: applied.has(name) ? [{ name, sha256: applied.get(name) }] : [],
        };
      }
      if (sql.includes('INSERT INTO public.applied_migrations')) {
        applied.set(String(values?.[0] ?? ''), String(values?.[1] ?? ''));
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO public.hxos_') && sql.includes('_evidence')) {
        schema.set(String(values?.[0] ?? ''), String(values?.[1] ?? ''));
        return { rows: [] };
      }
      if (sql.includes('FROM public.hxos_') && sql.includes('_evidence')) {
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
  overrides: Partial<NonproductionFinancialMigrationRuntime> = {}
): NonproductionFinancialMigrationRuntime {
  const migrationClient = client();
  return {
    env: {
      SERVICE_ROLE: 'migration',
      HX_ENVIRONMENT: 'local',
      HX_PAYMENT_CREATION_MODE: 'frozen',
      HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_ci_system_test',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_ci_runner',
    },
    release: release('local'),
    identity: identity(),
    databaseUrl: LOCAL_DATABASE_URL,
    migrationSpecs: NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map(({ name, fileName }) => ({
      name,
      candidatePaths: [`/app/backend/database/migrations/${fileName}`],
    })),
    migrationArtifactDigest: vi.fn(async () => '7'.repeat(64)),
    readText: vi.fn(async (filePath: string) => {
      const registration = NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.find(({ fileName }) =>
        filePath.endsWith(fileName)
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
      'postgresql://hx_ci_runner@127.0.0.1:5432/hx_ci_system_test'
    );
    await expect(
      assertConnectedNonproductionDatabaseTarget(
        client(false, {
          identityRows: [
            {
              database_name: 'hx_ci_system_test',
              role_name: 'hx_ci_runner',
              server_address: '127.0.0.1',
              server_port: 5432,
              schema_name: 'public',
              search_path: 'public',
              effective_schemas: ['public'],
            },
          ],
        }),
        loopback
      )
    ).resolves.toEqual(
      expect.objectContaining({
        databaseName: 'hx_ci_system_test',
        roleName: 'hx_ci_runner',
        serverAddress: '127.0.0.1',
      })
    );

    const composeEnv = {
      HX_ENVIRONMENT: 'local',
      HXOS_LOCAL_TEST_DATABASE_NAME: 'hustlexp_startup_test',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'hustlexp_local_runner',
    };
    const compose = assertConfiguredNonproductionDatabaseTarget(
      composeEnv,
      'postgresql://hustlexp_local_runner@postgres:5432/hustlexp_startup_test'
    );
    const composeClient = client(false, {
      identityRows: [
        {
          database_name: 'hustlexp_startup_test',
          role_name: 'hustlexp_local_runner',
          session_role_name: 'hustlexp_local_runner',
          server_address: '172.18.0.2',
          server_port: 5432,
          schema_name: 'public',
          search_path: 'public',
          effective_schemas: ['public'],
        },
      ],
    });
    await expect(
      assertConnectedNonproductionDatabaseTarget(composeClient, compose)
    ).resolves.toEqual(
      expect.objectContaining({
        databaseName: 'hustlexp_startup_test',
        serverAddress: '172.18.0.2',
      })
    );
    expect(
      composeClient.queries.some((sql) =>
        sql.includes("COALESCE(host(inet_server_addr()), 'local_socket') AS server_address")
      )
    ).toBe(true);
  });

  it('rejects public, DNS-like, and arbitrary private local hosts and a public Compose address', async () => {
    for (const host of ['localhost', 'db.example.test', '10.42.0.9']) {
      expect(() =>
        assertConfiguredNonproductionDatabaseTarget(
          localEnv,
          `postgresql://hx_ci_runner@${host}:5432/hx_ci_system_test`
        )
      ).toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:LOCAL_DATABASE_HOST_NOT_ALLOWLISTED');
    }

    const compose = assertConfiguredNonproductionDatabaseTarget(
      {
        HX_ENVIRONMENT: 'local',
        HXOS_LOCAL_TEST_DATABASE_NAME: 'hustlexp_startup_test',
        HXOS_LOCAL_TEST_DATABASE_ROLE: 'hustlexp_local_runner',
      },
      'postgresql://hustlexp_local_runner@postgres:5432/hustlexp_startup_test'
    );
    await expect(
      assertConnectedNonproductionDatabaseTarget(
        client(false, {
          identityRows: [
            {
              database_name: 'hustlexp_startup_test',
              role_name: 'hustlexp_local_runner',
              session_role_name: 'hustlexp_local_runner',
              server_address: '8.8.8.8',
              server_port: 5432,
              schema_name: 'public',
              search_path: 'public',
              effective_schemas: ['public'],
            },
          ],
        }),
        compose
      )
    ).rejects.toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:LIVE_LOCAL_DATABASE_ADDRESS_MISMATCH');
  });
});

describe('nonproduction financial database migration', () => {
  it('authorizes before connecting and applies the exact migration atomically', async () => {
    const migrationClient = client();
    const actualRuntime = runtime({ createClient: vi.fn(() => migrationClient) });

    await expect(runNonproductionFinancialMigration(actualRuntime)).resolves.toEqual({
      status: 'applied',
      migration: NONPRODUCTION_FAKE_FINANCIAL_MIGRATION,
      sourcePath:
        '/app/backend/database/migrations/20261016_universal_v1_fake_financial_command_outbox_authority_v13.sql',
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
    expect(migrationClient.queries).toContain(TERMINAL_LIFECYCLE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(CHANGE_ORDER_THREE_PHASE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(CHANGE_ORDER_RECOVERY_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(DISPUTE_RELEASE_GATE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(SECURITY_EXPIRY_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(EXPIRY_RECOVERY_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(RUNTIME_INSERT_AUTHORITY_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(WORK_ORDER_AUTHORITY_HARDENING_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(WORK_ORDER_BOOTSTRAP_SEAL_MIGRATION_SQL);
    expect(migrationClient.queries.at(-1)).toBe('COMMIT');
    expect(migrationClient.end).toHaveBeenCalledOnce();
  });

  it('issues no SQL after an ambiguous fake-migration COMMIT', async () => {
    const migrationClient = client();
    const canonicalQuery = migrationClient.query;
    const commitError = new Error('fake migration commit outcome ambiguous');
    migrationClient.query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === 'COMMIT') {
        migrationClient.queries.push(sql);
        throw commitError;
      }
      return canonicalQuery(sql, values);
    }) as MigrationClient['query'];

    await expect(
      runNonproductionFinancialMigration(runtime({ createClient: () => migrationClient }))
    ).rejects.toBe(commitError);

    expect(migrationClient.queries.at(-1)).toBe('COMMIT');
    expect(migrationClient.queries).not.toContain('ROLLBACK');
    expect(migrationClient.end).toHaveBeenCalledOnce();
  });

  it('is idempotent and does not execute migration SQL after recorded application', async () => {
    const migrationClient = client(true);
    await expect(
      runNonproductionFinancialMigration(
        runtime({
          createClient: () => migrationClient,
        })
      )
    ).resolves.toEqual(expect.objectContaining({ status: 'already_applied' }));
    expect(migrationClient.queries).not.toContain(BASE_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(REFRESH_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(SETTLEMENT_COMPLETION_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(LIFECYCLE_BRIDGE_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(TERMINAL_LIFECYCLE_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(CHANGE_ORDER_THREE_PHASE_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(CHANGE_ORDER_RECOVERY_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(DISPUTE_RELEASE_GATE_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(SECURITY_EXPIRY_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(EXPIRY_RECOVERY_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(RUNTIME_INSERT_AUTHORITY_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(WORK_ORDER_AUTHORITY_HARDENING_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(WORK_ORDER_BOOTSTRAP_SEAL_MIGRATION_SQL);
  });

  it('upgrades an exact v1 installation through v12, the seal, and append-only v13', async () => {
    const baseDigest = MIGRATION_SHA_BY_NAME.get(NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION);
    const migrationClient = client(false, {
      applied: { [NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION]: baseDigest },
      schema: { [NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION]: baseDigest },
    });

    const result = await runNonproductionFinancialMigration(
      runtime({
        createClient: () => migrationClient,
      })
    );

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
        migration: NONPRODUCTION_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_TERMINAL_LIFECYCLE_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_THREE_PHASE_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_RECOVERY_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_DISPUTE_RELEASE_GATE_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_SECURITY_EXPIRY_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_EXPIRY_RECOVERY_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_RUNTIME_INSERT_AUTHORITY_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_WORK_ORDER_AUTHORITY_HARDENING_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_WORK_ORDER_BOOTSTRAP_SEAL_MIGRATION,
        status: 'applied',
      },
      {
        migration: NONPRODUCTION_FAKE_FINANCIAL_COMMAND_OUTBOX_MIGRATION,
        status: 'applied',
      },
    ]);
    expect(migrationClient.queries).not.toContain(BASE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(REFRESH_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(SETTLEMENT_COMPLETION_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(LIFECYCLE_BRIDGE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(TERMINAL_LIFECYCLE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(CHANGE_ORDER_THREE_PHASE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(CHANGE_ORDER_RECOVERY_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(DISPUTE_RELEASE_GATE_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(SECURITY_EXPIRY_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(EXPIRY_RECOVERY_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(RUNTIME_INSERT_AUTHORITY_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(WORK_ORDER_AUTHORITY_HARDENING_MIGRATION_SQL);
    expect(migrationClient.queries).toContain(WORK_ORDER_BOOTSTRAP_SEAL_MIGRATION_SQL);
  });

  it('refuses an already-recorded migration without exact immutable SQL evidence', async () => {
    for (const storedDigest of [null, '0'.repeat(64)]) {
      const migrationClient = client(true, {
        schema: { [NONPRODUCTION_FAKE_FINANCIAL_MIGRATION]: storedDigest },
      });
      await expect(
        runNonproductionFinancialMigration(
          runtime({
            createClient: () => migrationClient,
          })
        )
      ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCIAL_SCHEMA_DIGEST_MISMATCH');
      expect(migrationClient.queries.at(-1)).toBe('ROLLBACK');
      expect(migrationClient.end).toHaveBeenCalledOnce();
    }
  });

  it('refuses a fake-finance applied row with missing or drifted canonical checksum evidence', async () => {
    for (const storedDigest of [null, '0'.repeat(64)]) {
      const migrationClient = client(true, {
        applied: { [NONPRODUCTION_FAKE_FINANCIAL_MIGRATION]: storedDigest },
      });
      await expect(
        runNonproductionFinancialMigration(
          runtime({
            createClient: () => migrationClient,
          })
        )
      ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCIAL_APPLIED_DIGEST_MISMATCH');
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
      await expect(
        runNonproductionFinancialMigration(
          runtime({
            ...overrides,
            readText,
            createClient,
          })
        )
      ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCE_REFUSED');
      expect(readText).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it('holds hosted readText substitution before any client or transaction exists', async () => {
    const readText = vi.fn(async () => 'SELECT hosted_substitution;');
    const createClient = vi.fn(() => client());
    await expect(
      runNonproductionFinancialMigration(
        runtime({
          env: {
            NODE_ENV: 'production',
            SERVICE_ROLE: 'migration',
            HX_ENVIRONMENT: 'staging',
            HX_PAYMENT_CREATION_MODE: 'frozen',
            RAILWAY_PROJECT_NAME: 'hustlexp-nonprod',
            RAILWAY_PROJECT_ID: 'unenrolled-project',
            RAILWAY_ENVIRONMENT_NAME: 'staging',
            RAILWAY_ENVIRONMENT_ID: 'unenrolled-environment',
            HX_NONPRODUCTION_DATABASE_NAME: 'hustlexp_nonprod',
            HX_NONPRODUCTION_DATABASE_ROLE: 'synthetic',
            HX_NONPRODUCTION_DATABASE_HOST: 'postgres.railway.internal',
            HX_NONPRODUCTION_DATABASE_PORT: '5432',
          },
          release: release('staging'),
          databaseUrl: 'postgresql://synthetic@postgres.railway.internal:5432/hustlexp_nonprod',
          readText,
          createClient,
        })
      )
    ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCE_REFUSED');
    expect(readText).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('fails before creating a client when DATABASE_URL is absent', async () => {
    const createClient = vi.fn(() => client());
    await expect(
      runNonproductionFinancialMigration(
        runtime({
          databaseUrl: '',
          createClient,
        })
      )
    ).rejects.toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:DATABASE_URL_REQUIRED');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('refuses remote local targets before artifact reads, SQL reads, clients, or canonical work', async () => {
    const migrationArtifactDigest = vi.fn(async () => '7'.repeat(64));
    const readText = vi.fn(async () => 'SHOULD NOT READ');
    const createClient = vi.fn(() => client());
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

    await expect(
      runNonproductionFinancialDatabaseBootstrap({ financialMigration })
    ).rejects.toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:LOCAL_DATABASE_HOST_NOT_ALLOWLISTED');
    expect(migrationArtifactDigest).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('refuses missing or mismatched local bindings before any read or connection', async () => {
    const baseline = runtime();
    const cases = [
      {
        env: { ...baseline.env, HXOS_LOCAL_TEST_DATABASE_ROLE: undefined },
        databaseUrl: LOCAL_DATABASE_URL,
        reason: 'HXOS_LOCAL_TEST_DATABASE_ROLE_REQUIRED',
      },
      {
        env: baseline.env,
        databaseUrl: 'postgresql://hx_ci_runner@127.0.0.1:5432/wrong_test',
        reason: 'LOCAL_DATABASE_NAME_MISMATCH',
      },
      {
        env: baseline.env,
        databaseUrl: 'postgresql://wrong_ci_role@127.0.0.1:5432/hx_ci_system_test',
        reason: 'LOCAL_DATABASE_ROLE_MISMATCH',
      },
    ];

    for (const testCase of cases) {
      const migrationArtifactDigest = vi.fn(async () => '7'.repeat(64));
      const readText = vi.fn(async () => 'SHOULD NOT READ');
      const createClient = vi.fn(() => client());
      await expect(
        runNonproductionFinancialDatabaseBootstrap({
          financialMigration: runtime({
            env: testCase.env,
            databaseUrl: testCase.databaseUrl,
            migrationArtifactDigest,
            readText,
            createClient,
          }),
        })
      ).rejects.toThrow(`NONPRODUCTION_DATABASE_TARGET_REFUSED:${testCase.reason}`);
      expect(migrationArtifactDigest).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it('refuses a live identity mismatch before canonical or fake SQL', async () => {
    const migrationClient = client(false, {
      identityRows: [{ role_name: 'unexpected_role' }],
    });
    const readText = vi.fn(runtime().readText);
    await expect(
      runNonproductionFinancialDatabaseBootstrap({
        financialMigration: runtime({
          readText,
          createClient: () => migrationClient,
        }),
      })
    ).rejects.toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:LIVE_DATABASE_ROLE_MISMATCH');
    expect(migrationClient.connect).toHaveBeenCalledOnce();
    expect(migrationClient.end).toHaveBeenCalledOnce();
    expect(readText).toHaveBeenCalledTimes(NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.length);
    expect(migrationClient.queries).not.toContain(BASE_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(REFRESH_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(SETTLEMENT_COMPLETION_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(LIFECYCLE_BRIDGE_MIGRATION_SQL);
    expect(migrationClient.queries).not.toContain(TERMINAL_LIFECYCLE_MIGRATION_SQL);
  });

  it('refuses an incomplete or reordered nonproduction migration chain before reading SQL', async () => {
    for (const migrationSpecs of [
      runtime().migrationSpecs.slice(0, 1),
      [...runtime().migrationSpecs].reverse(),
    ]) {
      const readText = vi.fn(async () => 'SHOULD NOT READ');
      const createClient = vi.fn(() => client());
      await expect(
        runNonproductionFinancialMigration(
          runtime({
            migrationSpecs,
            readText,
            createClient,
          })
        )
      ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_CHAIN_MISMATCH');
      expect(readText).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it('refuses SQL-byte or source-path substitution before creating a client or issuing BEGIN', async () => {
    const baseline = runtime();
    const substitutedReadText = vi.fn(async (filePath: string) => {
      const sql = await baseline.readText(filePath);
      return filePath.endsWith(NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES[0].fileName)
        ? `${sql}\n-- substituted`
        : sql;
    });
    const substitutedClientFactory = vi.fn(() => client());
    await expect(
      runNonproductionFinancialMigration(
        runtime({
          readText: substitutedReadText,
          createClient: substitutedClientFactory,
        })
      )
    ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCIAL_CANONICAL_SOURCE_MISMATCH');
    expect(substitutedClientFactory).not.toHaveBeenCalled();

    const sourceSpecs = runtime().migrationSpecs.map((spec, index) => ({
      ...spec,
      candidatePaths:
        index === 0
          ? [`/tmp/${NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES[0].fileName}`]
          : spec.candidatePaths,
    }));
    const sourceReadText = vi.fn(baseline.readText);
    const sourceClientFactory = vi.fn(() => client());
    await expect(
      runNonproductionFinancialMigration(
        runtime({
          migrationSpecs: sourceSpecs,
          readText: sourceReadText,
          createClient: sourceClientFactory,
        })
      )
    ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCIAL_CANONICAL_SOURCE_MISMATCH');
    expect(sourceClientFactory).not.toHaveBeenCalled();
  });

  it('normalizes the engine bare digest and refuses a bundled artifact substitution', async () => {
    const createClient = vi.fn(() => client());
    await expect(
      runNonproductionFinancialMigration(
        runtime({
          migrationArtifactDigest: async () => sha256('6'),
          createClient,
        })
      )
    ).rejects.toThrow('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_MISMATCH');
    expect(createClient).not.toHaveBeenCalled();

    await expect(
      runNonproductionFinancialMigration(
        runtime({
          migrationArtifactDigest: async () => 'not-a-digest',
          createClient,
        })
      )
    ).rejects.toThrow('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_INVALID');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('closes the client and preserves a migration failure', async () => {
    const migrationClient = client();
    const canonicalQuery = migrationClient.query;
    migrationClient.query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === BASE_MIGRATION_SQL) throw new Error('migration failed');
      return canonicalQuery(sql, values);
    }) as MigrationClient['query'];
    await expect(
      runNonproductionFinancialMigration(
        runtime({
          createClient: () => migrationClient,
        })
      )
    ).rejects.toThrow('migration failed');
    expect(migrationClient.queries.at(-1)).toBe('ROLLBACK');
    expect(migrationClient.end).toHaveBeenCalledOnce();
  });

  it('authorizes the exact fake chain before DB work but executes it only after canonical success', async () => {
    const order: string[] = [];
    const migrationClient = client();
    const canonicalReadText = runtime().readText;
    const injectedRunner = vi.fn(async () => REQUIRED_OUTCOMES);
    const financial = runtime({
      createClient: vi.fn(() => migrationClient),
      readText: vi.fn(async (filePath) => {
        order.push('financial-authorized');
        return canonicalReadText(filePath);
      }),
    });
    const bootstrapRuntime = {
      financialMigration: financial,
      runRequiredMigrationsOnClient: injectedRunner,
    } as unknown as NonproductionFinancialDatabaseBootstrapRuntime;
    await expect(runNonproductionFinancialDatabaseBootstrap(bootstrapRuntime)).resolves.toEqual(
      expect.objectContaining({
        financial: expect.objectContaining({ migrationArtifactDigest: sha256('7') }),
        completion: expect.objectContaining({
          schemaVersion: 1,
          status: 'complete',
          receiptType: 'nonproduction-financial-bootstrap-diagnostic-v1',
          acceptanceEligible: false,
          releaseManifestDigest: financial.release.digest,
          migrationArtifactDigest: sha256('7'),
          requiredMigrationCount: REQUIRED_OUTCOMES.length,
        }),
      })
    );
    expect(injectedRunner).not.toHaveBeenCalled();
    expect(order).toEqual(
      NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map(() => 'financial-authorized')
    );
    expect(financial.createClient).toHaveBeenCalledOnce();
    expect(migrationClient.connect).toHaveBeenCalledOnce();
    expect(migrationClient.end).toHaveBeenCalledOnce();
    const identityIndexes = migrationClient.queries.flatMap((sql, index) =>
      sql.includes('current_database()::text AS database_name') ? [index] : []
    );
    expect(identityIndexes.length).toBeGreaterThanOrEqual(3);
    expect(identityIndexes[0]).toBeLessThan(
      migrationClient.queries.indexOf(FIRST_REQUIRED_MIGRATION_SQL)
    );
    expect(migrationClient.queries.indexOf(FIRST_REQUIRED_MIGRATION_SQL)).toBeLessThan(
      migrationClient.queries.indexOf(BASE_MIGRATION_SQL)
    );
    expect(identityIndexes.at(-1)).toBeLessThan(
      migrationClient.queries.findIndex((sql) =>
        sql.includes('INSERT INTO hxos_nonproduction_bootstrap_completion_v1')
      )
    );

    const failedClient = client();
    const canonicalQuery = failedClient.query;
    failedClient.query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === FIRST_REQUIRED_MIGRATION_SQL) throw new Error('required migration failed');
      return canonicalQuery(sql, values);
    }) as MigrationClient['query'];
    const failedRuntime = runtime();
    const readText = vi.fn(failedRuntime.readText);
    await expect(
      runNonproductionFinancialDatabaseBootstrap({
        financialMigration: runtime({
          readText,
          createClient: () => failedClient,
        }),
      })
    ).rejects.toThrow('required migration failed');
    expect(readText).toHaveBeenCalledTimes(NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.length);
    expect(failedClient.queries).not.toContain(BASE_MIGRATION_SQL);
    expect(failedClient.end).toHaveBeenCalledOnce();
  });

  it('cannot replace canonical core execution with injected shaped outcomes', async () => {
    const migrationClient = client();
    const canonicalQuery = migrationClient.query;
    migrationClient.query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === FIRST_REQUIRED_MIGRATION_SQL) throw new Error('canonical receipt unavailable');
      return canonicalQuery(sql, values);
    }) as MigrationClient['query'];
    const readText = vi.fn(runtime().readText);
    const shapedRunner = vi.fn(async () => REQUIRED_OUTCOMES);
    const bootstrapRuntime = {
      financialMigration: runtime({
        readText,
        createClient: () => migrationClient,
      }),
      runRequiredMigrationsOnClient: shapedRunner,
    } as unknown as NonproductionFinancialDatabaseBootstrapRuntime;
    await expect(runNonproductionFinancialDatabaseBootstrap(bootstrapRuntime)).rejects.toThrow(
      'canonical receipt unavailable'
    );
    expect(shapedRunner).not.toHaveBeenCalled();
    expect(readText).toHaveBeenCalledTimes(NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.length);
    expect(migrationClient.queries).not.toContain(BASE_MIGRATION_SQL);
  });

  it('refuses shaped outcomes and requires exact same-target ledger hashes before completion', async () => {
    const migrationClient = client();
    const actualRuntime = runtime({ createClient: () => migrationClient });
    const financial = await runNonproductionFinancialMigration(actualRuntime);
    const shaped = {
      ...financial,
      migrations: financial.migrations.map((entry) => ({ ...entry })),
    };
    const shapedClientFactory = vi.fn(() => migrationClient);
    await expect(
      recordNonproductionFinancialBootstrapCompletion(
        runtime({ createClient: shapedClientFactory }),
        REQUIRED_OUTCOMES,
        shaped
      )
    ).rejects.toThrow('NONPRODUCTION_BOOTSTRAP_OPAQUE_FINANCIAL_RECEIPT_REQUIRED');
    expect(shapedClientFactory).not.toHaveBeenCalled();

    const substitutedUrlClientFactory = vi.fn(() => migrationClient);
    await expect(
      recordNonproductionFinancialBootstrapCompletion(
        runtime({
          databaseUrl: 'postgresql://hx_ci_runner:substituted@127.0.0.1:5432/hx_ci_system_test',
          createClient: substitutedUrlClientFactory,
        }),
        REQUIRED_OUTCOMES,
        financial
      )
    ).rejects.toThrow('NONPRODUCTION_BOOTSTRAP_DATABASE_URL_MISMATCH');
    expect(substitutedUrlClientFactory).not.toHaveBeenCalled();

    migrationClient.seedApplied([
      ...REQUIRED_OUTCOMES.slice(1),
      { ...REQUIRED_OUTCOMES[0], sha256: '0'.repeat(64) },
    ]);
    const ledgerMismatchQueryStart = migrationClient.queries.length;
    await expect(
      recordNonproductionFinancialBootstrapCompletion(actualRuntime, REQUIRED_OUTCOMES, financial)
    ).rejects.toThrow('NONPRODUCTION_REQUIRED_MIGRATION_LEDGER_MISMATCH');
    const ledgerMismatchQueries = migrationClient.queries.slice(ledgerMismatchQueryStart);
    const beginIndex = ledgerMismatchQueries.indexOf('BEGIN');
    const lockIndex = ledgerMismatchQueries.findIndex((sql) =>
      sql.includes("pg_advisory_xact_lock(hashtext('nonproduction-bootstrap-completion')")
    );
    const ledgerReadIndex = ledgerMismatchQueries.findIndex((sql) =>
      sql.includes('SELECT name, sha256 FROM public.applied_migrations WHERE name = $1')
    );
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeGreaterThan(beginIndex);
    expect(ledgerReadIndex).toBeGreaterThan(lockIndex);
    expect(
      migrationClient.queries.some((sql) =>
        sql.includes('INSERT INTO hxos_nonproduction_bootstrap_completion_v1')
      )
    ).toBe(false);

    migrationClient.seedApplied(REQUIRED_OUTCOMES);
    migrationClient.seedSchema(NONPRODUCTION_FAKE_FINANCIAL_MIGRATION, '0'.repeat(64));
    await expect(
      recordNonproductionFinancialBootstrapCompletion(actualRuntime, REQUIRED_OUTCOMES, financial)
    ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCIAL_SCHEMA_DIGEST_MISMATCH');
    migrationClient.seedSchema(
      NONPRODUCTION_FAKE_FINANCIAL_MIGRATION,
      MIGRATION_SHA_BY_NAME.get(NONPRODUCTION_FAKE_FINANCIAL_MIGRATION)!
    );
    migrationClient.seedApplied([
      {
        migration: 'attacker_supplied_extra_migration',
        sha256: 'f'.repeat(64),
      },
    ]);
    await expect(
      recordNonproductionFinancialBootstrapCompletion(actualRuntime, REQUIRED_OUTCOMES, financial)
    ).rejects.toThrow('NONPRODUCTION_APPLIED_MIGRATION_SET_MISMATCH');
    migrationClient.deleteApplied('attacker_supplied_extra_migration');
    await expect(
      recordNonproductionFinancialBootstrapCompletion(actualRuntime, REQUIRED_OUTCOMES, financial)
    ).resolves.toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        status: 'complete',
        receiptType: 'nonproduction-financial-bootstrap-diagnostic-v1',
        acceptanceEligible: false,
        releaseManifestDigest: actualRuntime.release.digest,
      })
    );
    await expect(
      recordNonproductionFinancialBootstrapCompletion(actualRuntime, REQUIRED_OUTCOMES, financial)
    ).rejects.toThrow('NONPRODUCTION_BOOTSTRAP_OPAQUE_FINANCIAL_RECEIPT_REQUIRED');
  });

  it('issues no SQL after an ambiguous bootstrap-completion COMMIT', async () => {
    const migrationClient = client();
    const actualRuntime = runtime({ createClient: () => migrationClient });
    const financial = await runNonproductionFinancialMigration(actualRuntime);
    migrationClient.seedApplied(REQUIRED_OUTCOMES);
    const canonicalQuery = migrationClient.query;
    const commitError = new Error('bootstrap completion commit outcome ambiguous');
    let completionWriteSeen = false;
    migrationClient.query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO hxos_nonproduction_bootstrap_completion_v1')) {
        completionWriteSeen = true;
      }
      if (completionWriteSeen && sql === 'COMMIT') {
        migrationClient.queries.push(sql);
        throw commitError;
      }
      return canonicalQuery(sql, values);
    }) as MigrationClient['query'];
    const queryStart = migrationClient.queries.length;

    await expect(
      recordNonproductionFinancialBootstrapCompletion(actualRuntime, REQUIRED_OUTCOMES, financial)
    ).rejects.toBe(commitError);

    const completionQueries = migrationClient.queries.slice(queryStart);
    expect(completionQueries.at(-1)).toBe('COMMIT');
    expect(completionQueries).not.toContain('ROLLBACK');
  });

  it('atomically reserves an opaque financial proof against concurrent completion consumers', async () => {
    let announceLockReached!: () => void;
    let releaseLock!: () => void;
    const lockReached = new Promise<void>((resolve) => {
      announceLockReached = resolve;
    });
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let shouldHold = true;
    const migrationClient = client(false, {
      beforeCompletionLock: async () => {
        if (!shouldHold) return;
        shouldHold = false;
        announceLockReached();
        await holdLock;
      },
    });
    const actualRuntime = runtime({ createClient: () => migrationClient });
    const financial = await runNonproductionFinancialMigration(actualRuntime);
    migrationClient.seedApplied(REQUIRED_OUTCOMES);

    const first = recordNonproductionFinancialBootstrapCompletion(
      actualRuntime,
      REQUIRED_OUTCOMES,
      financial
    );
    await lockReached;
    const competingFactory = vi.fn(() => migrationClient);
    try {
      await expect(
        recordNonproductionFinancialBootstrapCompletion(
          runtime({ createClient: competingFactory }),
          REQUIRED_OUTCOMES,
          financial
        )
      ).rejects.toThrow('NONPRODUCTION_BOOTSTRAP_OPAQUE_FINANCIAL_RECEIPT_REQUIRED');
      expect(competingFactory).not.toHaveBeenCalled();
    } finally {
      releaseLock();
    }
    await expect(first).resolves.toEqual(
      expect.objectContaining({
        status: 'complete',
        acceptanceEligible: false,
      })
    );
  });

  it('replays the same append-only completion receipt without mutating first-run evidence', async () => {
    const migrationClient = client();
    const financialMigration = runtime({ createClient: () => migrationClient });
    const bootstrapRuntime: NonproductionFinancialDatabaseBootstrapRuntime = {
      financialMigration,
    };

    const first = await runNonproductionFinancialDatabaseBootstrap(bootstrapRuntime);
    const replay = await runNonproductionFinancialDatabaseBootstrap(bootstrapRuntime);
    expect(first.financial.status).toBe('applied');
    expect(replay.financial.status).toBe('already_applied');
    expect(replay.completion).toEqual(first.completion);
    expect(
      migrationClient.queries.filter(
        (sql) =>
          sql.includes('UPDATE hxos_nonproduction_bootstrap_completion_v1') ||
          sql.includes('DELETE FROM hxos_nonproduction_bootstrap_completion_v1')
      )
    ).toEqual([]);
  });

  it('preflights nonproduction authority before the canonical migration chain opens a database', async () => {
    await expect(
      runNonproductionFinancialDatabaseBootstrap({
        financialMigration: runtime({
          env: { HX_ENVIRONMENT: 'production', HX_PAYMENT_CREATION_MODE: 'frozen' },
        }),
      })
    ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCE_REFUSED');
  });

  it('exposes one explicit compiled nonproduction command and keeps production start separate', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:migrate:nonprod-financial']).toContain(
      'runNonproductionFinancialDatabaseBootstrap'
    );
    expect(pkg.scripts['db:migrate:nonprod-financial']).toContain('result.completion');
    expect(pkg.scripts['db:migrate:nonprod-financial']).toContain('diagnostic: true');
    expect(pkg.scripts['db:migrate:nonprod-financial']).toContain('acceptanceEligible: false');
    expect(pkg.scripts.start).not.toContain('nonproduction-financial-migration');
    expect(pkg.scripts['start:workers']).not.toContain('nonproduction-financial-migration');
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_MIGRATION
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_TERMINAL_LIFECYCLE_MIGRATION
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_THREE_PHASE_MIGRATION
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_RECOVERY_MIGRATION
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_DISPUTE_RELEASE_GATE_MIGRATION
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_SECURITY_EXPIRY_MIGRATION
    );
    expect(REQUIRED_MIGRATION_FILES.map(({ name }) => name)).not.toContain(
      NONPRODUCTION_FAKE_FINANCIAL_EXPIRY_RECOVERY_MIGRATION
    );
  });
});
