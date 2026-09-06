import { verifyWorkOrderCommandAuthorityInCurrentSnapshot } from '../../src/jobs/work-order-command-role-authority.js';
// Orchestration isolation only; actual role/ACL verification is covered by PG fixtures.
vi.mock('../../src/jobs/work-order-command-role-authority.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/jobs/work-order-command-role-authority.js')>();
  return {
    ...actual,
    verifyWorkOrderCommandAuthorityInCurrentSnapshot: vi.fn(async () => ({
      status: 'READY',
      reasons: [],
    })),
  };
});
beforeEach(() => vi.mocked(verifyWorkOrderCommandAuthorityInCurrentSnapshot).mockClear());
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import type { QueryFn } from '../../src/db.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-financial-migration.js';
import {
  releaseManifestDigest,
  type ReleaseManifestV2,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';
import {
  readNonproductionFinancialBootstrapReadiness,
  type NonproductionFinancialReadinessDatabase,
  type NonproductionFinancialMigrationEvidence,
} from '../../src/services/payment/NonproductionFinancialBootstrapReadiness.js';

const REVISION = '1'.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

function manifest(): ReleaseManifestV2 {
  return {
    version: 2,
    environment: 'local',
    releaseId: 'test-local-finance-health-0001',
    createdAt: '2026-08-28T12:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: digest('f'),
    },
    components: {
      backend: {
        revision: REVISION,
        artifactDigest: digest('1'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('2'),
      },
      worker: {
        revision: REVISION,
        artifactDigest: digest('3'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('4'),
      },
      web: {
        revision: '2'.repeat(40),
        artifactDigest: digest('5'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: digest('6'),
      },
      migration: { revision: REVISION, artifactDigest: digest('7') },
      policy: { revision: '3'.repeat(40), artifactDigest: digest('8') },
      fixtures: {
        revision: '4'.repeat(40),
        artifactDigest: digest('9'),
        providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        providerImageDigest: digest('a'),
        databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        databaseImageDigest: digest('b'),
      },
    },
    infrastructure: {
      revision: '5'.repeat(40),
      artifactDigest: digest('c'),
      desiredTopologyDigest: digest('d'),
    },
    databaseTargets: {
      api: { component: 'api', environment: 'local', databaseTargetDigest: digest('e') },
      worker: { component: 'worker', environment: 'local', databaseTargetDigest: digest('f') },
      attester: { component: 'attester', environment: 'local', databaseTargetDigest: digest('1') },
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

function release(value = manifest()): ReleaseManifestEvidence {
  return {
    schema_version: 1,
    status: 'valid',
    digest: releaseManifestDigest(value),
    source: 'test',
    errors: [],
    manifest: value,
    authentication: {
      status: 'missing',
      algorithm: null,
      keyId: null,
      keyFingerprint: null,
      signatureDigest: null,
      source: 'none',
      errors: [],
    },
  };
}

function identity(): BuildIdentity {
  return {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision: REVISION,
    built_at: '2026-08-28T12:00:00.000Z',
    environment: 'development',
    clean_source: false,
    source: 'git',
    artifact_digest: digest('1'),
    artifact_verified: false,
  };
}

const expectedEvidence: readonly NonproductionFinancialMigrationEvidence[] =
  NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map((migration, index) => ({
    migrationName: migration.name,
    sha256: createHash('sha256').update(`${index}:${migration.name}`).digest('hex'),
  }));

const expectedCriticalMigrationEvidence: readonly NonproductionFinancialMigrationEvidence[] = [
  {
    migrationName: '20260916_provider_event_inbox_v1',
    sha256: '4'.repeat(64),
  },
  {
    migrationName: '20260917_financial_provider_command_journal_v1',
    sha256: '5'.repeat(64),
  },
  {
    migrationName: '20260918_universal_v1_prepared_financial_command_v1',
    sha256: '6'.repeat(64),
  },
  {
    migrationName: '20260919_provider_event_processing_v1',
    sha256: '7'.repeat(64),
  },
  {
    migrationName: '20260920_financial_provider_command_recovery_v1',
    sha256: '8'.repeat(64),
  },
  {
    migrationName: '20260928_provider_observation_normalization_v1',
    sha256: 'e'.repeat(64),
  },
  {
    migrationName: '20260923_legacy_escrow_insert_containment_v1',
    sha256: 'b'.repeat(64),
  },
  {
    migrationName: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1',
    sha256: '9'.repeat(64),
  },
  {
    migrationName: '20260922_universal_v1_fake_terminal_lifecycle_intent_v1',
    sha256: 'a'.repeat(64),
  },
  {
    migrationName: '20260926_universal_v1_change_order_three_phase_v1',
    sha256: 'c'.repeat(64),
  },
  {
    migrationName: '20260927_universal_v1_change_order_recovery_v1',
    sha256: 'd'.repeat(64),
  },
  {
    migrationName: '20261002_universal_v1_dispute_fake_release_gate_v8',
    sha256: 'f'.repeat(64),
  },
  {
    migrationName: '20261010_universal_v1_financial_security_event_expiry_v1',
    sha256: '3'.repeat(64),
  },
  {
    migrationName: '20261010_universal_v1_fake_financial_expiry_v9',
    sha256: '7'.repeat(64),
  },
  {
    migrationName: '20261011_universal_v1_fake_financial_expiry_recovery_v10',
    sha256: '8'.repeat(64),
  },
  {
    migrationName: '20261013_nonproduction_runtime_insert_authority_v1',
    sha256: '9'.repeat(64),
  },
  {
    migrationName: '20261014_universal_v1_work_order_command_ports_v1',
    sha256: 'b'.repeat(64),
  },
  {
    migrationName: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
    sha256: 'a'.repeat(64),
  },
  {
    migrationName: '20261015_universal_v1_work_order_bootstrap_seal_v1',
    sha256: 'c'.repeat(64),
  },
];

const sourceCriticalMigrationEvidence: readonly NonproductionFinancialMigrationEvidence[] =
  expectedCriticalMigrationEvidence.map(({ migrationName }) => ({
    migrationName,
    sha256: createHash('sha256')
      .update(readFileSync(path.resolve('backend/database/migrations', `${migrationName}.sql`)))
      .digest('hex'),
  }));

const expectedCriticalSchemaEvidence = [
  { identityName: 'relations', sha256: 'a'.repeat(64) },
  { identityName: 'constraints', sha256: 'b'.repeat(64) },
  { identityName: 'indexes', sha256: 'c'.repeat(64) },
  { identityName: 'functions', sha256: 'd'.repeat(64) },
  { identityName: 'triggers', sha256: 'e'.repeat(64) },
  { identityName: 'rewrite_rules', sha256: '3'.repeat(64) },
  { identityName: 'constraint_triggers', sha256: 'f'.repeat(64) },
  { identityName: 'policies', sha256: '1'.repeat(64) },
  { identityName: 'extensions', sha256: '2'.repeat(64) },
] as const;

interface SupportedDatabaseIdentityRow {
  server_encoding: string;
  database_encoding: string;
  locale_provider: string;
  lc_collate: string;
  lc_ctype: string;
  icu_locale: string | null;
  icu_rules: string | null;
  recorded_collation_version: string | null;
  actual_collation_version: string | null;
  is_template: boolean;
  allows_connections: boolean;
}

const supportedDatabaseIdentity = {
  server_encoding: 'UTF8',
  database_encoding: 'UTF8',
  locale_provider: 'c',
  lc_collate: 'en_US.utf8',
  lc_ctype: 'en_US.utf8',
  icu_locale: null,
  icu_rules: null,
  recorded_collation_version: null,
  actual_collation_version: null,
  is_template: false,
  allows_connections: true,
} satisfies SupportedDatabaseIdentityRow;

function readinessQuery(
  options: {
    completion?: boolean;
    mismatch?: boolean;
    missingFinalFinancialEvidence?: boolean;
    duplicateFinancialEvidence?: boolean;
    nullFinancialEvidence?: boolean;
    throwOnWorkOrderAuthority?: boolean;
    runtimeAuthority?: Record<string, unknown>;
    throwError?: boolean;
    throwOnCriticalSchema?: boolean;
    criticalMigrationMismatch?: boolean;
    criticalMigrationMissing?: boolean;
    criticalMigrationExtra?: boolean;
    criticalMigrationEvidence?: readonly NonproductionFinancialMigrationEvidence[];
    criticalSchemaMismatch?: (typeof expectedCriticalSchemaEvidence)[number]['identityName'];
    criticalSchemaMissing?: (typeof expectedCriticalSchemaEvidence)[number]['identityName'];
    criticalSchemaExtra?: boolean;
    authorityViolations?: readonly string[];
    serverVersionNumber?: unknown;
    serverVersionRowCount?: number;
    databaseIdentity?: Partial<Record<keyof SupportedDatabaseIdentityRow, unknown>>;
    databaseIdentityRowCount?: number;
    databaseIdentityReportedRowCount?: number;
    serverVersionReportedRowCount?: number;
    throwOnDatabaseIdentity?: boolean;
    v12AuthorityResultRowCount?: number;
    v12AuthorityEvidenceRowCount?: number | string;
    v12AuthorityEvidenceSha256?: string | null;
    v12AuthorityOrdinal146Sha256?: string | null;
    sealAuthorityEvidenceRowCount?: number | string;
    sealAuthorityEvidenceSha256?: string | null;
    sealAuthorityOrdinal146Sha256?: string | null;
    sealAuthorityV12Sha256?: string | null;
  } = {}
): QueryFn {
  return vi.fn(async (sql: string, values?: unknown[]) => {
    if (options.throwError) throw new Error('database detail must not leak');
    if (
      sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
      sql === "SET LOCAL search_path = 'pg_catalog'" ||
      sql === "SET LOCAL statement_timeout = '1000ms'" ||
      sql === "SET LOCAL lock_timeout = '250ms'"
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('hxos_nonproduction_postgresql_major_v1')) {
      const row = {
        server_version_num: Object.hasOwn(options, 'serverVersionNumber')
          ? options.serverVersionNumber
          : '160015',
      };
      const rows = Array.from({ length: options.serverVersionRowCount ?? 1 }, () => row);
      return { rows, rowCount: options.serverVersionReportedRowCount ?? rows.length };
    }
    if (sql.includes('hxos_nonproduction_database_identity_v1')) {
      if (options.throwOnDatabaseIdentity)
        throw new Error('database identity detail must not leak');
      const row = {
        ...supportedDatabaseIdentity,
        ...options.databaseIdentity,
      };
      const rows = Array.from({ length: options.databaseIdentityRowCount ?? 1 }, () => row);
      return { rows, rowCount: options.databaseIdentityReportedRowCount ?? rows.length };
    }
    if (sql.includes('FROM public.hxos_read_fake_financial_bootstrap_completion_v13(')) {
      if (options.completion === false) return { rows: [], rowCount: 0 };
      const exactManifest = manifest();
      expect(values).toEqual([
        releaseManifestDigest(exactManifest),
        exactManifest.components.migration.artifactDigest,
      ]);
      return {
        rows: [
          {
            release_id: exactManifest.releaseId,
            release_environment: 'local',
            required_migration_count: REQUIRED_MIGRATION_FILES.length,
            financial_migration_status: 'applied',
            completed_at: '2026-08-28T12:30:00.000Z',
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM public.hxos_read_fake_financial_schema_evidence_v13()')) {
      const rows = expectedEvidence
        .filter(
          (_, index) =>
            !options.missingFinalFinancialEvidence || index !== expectedEvidence.length - 1
        )
        .map((entry, index) => ({
          migration_name: entry.migrationName,
          evidence_sha256:
            options.nullFinancialEvidence && index === 1
              ? null
              : options.mismatch && index === 1
                ? '0'.repeat(64)
                : entry.sha256,
          applied_sha256: entry.sha256,
        }));
      if (options.duplicateFinancialEvidence) rows.push({ ...rows[0]! });
      return {
        rows,
        rowCount: rows.length,
      };
    }
    if (sql.includes('FROM public.hxos_read_fake_financial_applied_migrations_v13()')) {
      const criticalMigrationEvidence =
        options.criticalMigrationEvidence ?? expectedCriticalMigrationEvidence;
      expect(values).toEqual([criticalMigrationEvidence.map(({ migrationName }) => migrationName)]);
      const rows = criticalMigrationEvidence
        .filter(
          (_, index) =>
            !options.criticalMigrationMissing || index !== criticalMigrationEvidence.length - 1
        )
        .map((entry, index) => ({
          migration_name: entry.migrationName,
          applied_sha256:
            options.criticalMigrationMismatch && index === 1 ? '0'.repeat(64) : entry.sha256,
        }));
      if (options.criticalMigrationExtra) {
        rows.push({
          migration_name: 'unexpected_critical_migration',
          applied_sha256: 'f'.repeat(64),
        });
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('evidence_row_count')) {
      if (options.throwOnWorkOrderAuthority)
        throw new Error('HXUV1-FINOUT-13-47: synthetic ledger drift');
      const expectedV12Sha256 = expectedEvidence.find(
        ({ migrationName }) =>
          migrationName ===
          '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
      )!.sha256;
      const expectedOrdinal146Sha256 = (
        options.criticalMigrationEvidence ?? expectedCriticalMigrationEvidence
      ).find(
        ({ migrationName }) => migrationName === '20261014_universal_v1_work_order_command_ports_v1'
      )!.sha256;
      const expectedSealSha256 = expectedEvidence.find(
        ({ migrationName }) =>
          migrationName === '20261015_universal_v1_work_order_bootstrap_seal_v1'
      )!.sha256;
      const row = {
        session_database_role: 'hx_test_readiness_api',
        target_authority_id: '11111111-1111-4111-8111-111111111111',
        authority_version: 1,
        target_database_name: 'hx_test_readiness',
        observed_database_name: 'hx_test_readiness',
        environment: 'local',
        release_manifest_sha256: releaseManifestDigest(manifest()),
        v13_sql_sha256: expectedEvidence.at(-1)!.sha256,
        fake_financial_operations_relation: 'public.hxos_fake_financial_operations_v1',
        fake_financial_operation_events_relation: 'public.hxos_fake_financial_operation_events_v1',
        ...options.runtimeAuthority,
        evidence_row_count: options.v12AuthorityEvidenceRowCount ?? 1,
        evidence_v12_sha256: Object.hasOwn(options, 'v12AuthorityEvidenceSha256')
          ? options.v12AuthorityEvidenceSha256
          : expectedV12Sha256,
        evidence_ordinal146_sha256: Object.hasOwn(options, 'v12AuthorityOrdinal146Sha256')
          ? options.v12AuthorityOrdinal146Sha256
          : expectedOrdinal146Sha256,
        seal_evidence_row_count: options.sealAuthorityEvidenceRowCount ?? 1,
        seal_evidence_sha256: Object.hasOwn(options, 'sealAuthorityEvidenceSha256')
          ? options.sealAuthorityEvidenceSha256
          : expectedSealSha256,
        seal_evidence_ordinal146_sha256: Object.hasOwn(options, 'sealAuthorityOrdinal146Sha256')
          ? options.sealAuthorityOrdinal146Sha256
          : expectedOrdinal146Sha256,
        seal_evidence_v12_sha256: Object.hasOwn(options, 'sealAuthorityV12Sha256')
          ? options.sealAuthorityV12Sha256
          : expectedV12Sha256,
      };
      const rows = Array.from({ length: options.v12AuthorityResultRowCount ?? 1 }, () => row);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('financial_readiness_custody_v13')) {
      const rows = (options.authorityViolations ?? []).map((violation_code) => ({
        violation_code,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FOREIGN_KEY_TRIGGER_ENFORCEMENT_INVALID')) return { rows: [], rowCount: 0 };
    if (sql.includes('identity_documents')) {
      if (options.throwOnCriticalSchema) {
        throw new Error('catalog detail must not leak');
      }
      const rows: { identity_name: string; identity_sha256: string }[] =
        expectedCriticalSchemaEvidence
          .filter(({ identityName }) => identityName !== options.criticalSchemaMissing)
          .map((entry) => ({
            identity_name: entry.identityName,
            identity_sha256:
              entry.identityName === options.criticalSchemaMismatch ? '0'.repeat(64) : entry.sha256,
          }));
      if (options.criticalSchemaExtra) {
        rows.push({
          identity_name: 'unexpected_identity',
          identity_sha256: '0'.repeat(64),
        });
      }
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected readiness query: ${sql}`);
  }) as QueryFn;
}

function readinessDatabase(query: QueryFn): NonproductionFinancialReadinessDatabase {
  return {
    readOnlyAttestationTransaction: vi.fn(async (fn) => fn(query)),
  };
}

function options(query: QueryFn, exactRelease = release()) {
  return {
    environment: 'local',
    component: 'backend' as const,
    env: {
      HX_ENVIRONMENT: 'local',
      HX_PAYMENT_CREATION_MODE: 'frozen',
      HX_RUNTIME_DATABASE_NAME: 'hx_test_readiness',
      HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: 'hx_test_readiness_migration',
      HX_WORK_ORDER_API_DATABASE_ROLE: 'hx_test_readiness_api',
      HX_WORK_ORDER_WORKER_DATABASE_ROLE: 'hx_test_readiness_worker',
      HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: 'hx_test_readiness_attester',
      HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: 'hx_test_readiness_command',
      HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE: 'hx_test_readiness_assertion',
      HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE: 'hx_test_readiness_finance',
      HX_TELEMETRY_OWNER_DATABASE_ROLE: 'hx_test_readiness_telemetry',
    },
    release: exactRelease,
    identity: identity(),
    database: readinessDatabase(query),
    expectedFinancialEvidence: expectedEvidence,
    expectedCriticalMigrationEvidence,
    expectedCriticalSchemaEvidence,
  };
}

describe('nonproduction fake-finance bootstrap readiness', () => {
  it('reports production fake finance disabled without touching its database', async () => {
    const query = vi.fn() as unknown as QueryFn;
    const database = readinessDatabase(query);
    const result = await readNonproductionFinancialBootstrapReadiness({
      ...options(query, release(manifest())),
      database,
      environment: 'production',
      env: {
        HX_ENVIRONMENT: 'production',
        NODE_ENV: 'production',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      },
    });

    expect(result).toMatchObject({
      required: false,
      ready: true,
      status: 'disabled',
      environment: 'production',
    });
    expect(query).not.toHaveBeenCalled();
    expect(database.readOnlyAttestationTransaction).not.toHaveBeenCalled();
  });

  it('attests one exact manifest/bootstrap record and every current SQL checksum', async () => {
    const query = readinessQuery();
    const baseOptions = options(query);
    const exactOptions = {
      ...baseOptions,
      env: { ...baseOptions.env, NODE_ENV: 'test' },
    };
    const result = await readNonproductionFinancialBootstrapReadiness(exactOptions);

    expect(result).toMatchObject({
      required: true,
      ready: true,
      status: 'ready',
      releaseId: manifest().releaseId,
      releaseManifestDigest: releaseManifestDigest(manifest()),
      migrationArtifactDigest: manifest().components.migration.artifactDigest,
      requiredMigrationCount: REQUIRED_MIGRATION_FILES.length,
      fakeFinancialMigrationCount: expectedEvidence.length,
      matchedFakeFinancialMigrationCount: expectedEvidence.length,
      completedAt: '2026-08-28T12:30:00.000Z',
    });
    expect(query).toHaveBeenCalledTimes(9);
    expect(exactOptions.database.readOnlyAttestationTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(query).mock.calls.some(([sql]) => /^\s*SET\b/iu.test(sql))).toBe(false);
    const versionIdentitySql = vi.mocked(query).mock.calls[0]?.[0];
    expect(versionIdentitySql).toContain('hxos_nonproduction_postgresql_major_v1');
    expect(versionIdentitySql).toContain("current_setting('server_version_num')");
    const databaseIdentitySql = vi.mocked(query).mock.calls[1]?.[0];
    expect(databaseIdentitySql).toContain('hxos_nonproduction_database_identity_v1');
    for (const token of [
      "current_setting('server_encoding')",
      'pg_encoding_to_char(database_record.encoding)',
      'database_record.datlocprovider',
      'database_record.datcollate',
      'database_record.datctype',
      'database_record.daticulocale',
      'database_record.daticurules',
      'database_record.datcollversion',
      'pg_database_collation_actual_version',
      'database_record.datistemplate',
      'database_record.datallowconn',
    ]) {
      expect(databaseIdentitySql).toContain(token);
    }
    const schemaEvidenceSql = vi
      .mocked(query)
      .mock.calls.map(([sql]) => sql)
      .find((sql) => sql.includes('FROM public.hxos_read_fake_financial_schema_evidence_v13()'));
    expect(schemaEvidenceSql).toContain('migration_name, evidence_sha256, applied_sha256');
    const v12AuthoritySql = vi
      .mocked(query)
      .mock.calls.map(([sql]) => sql)
      .find((sql) => sql.includes('evidence_row_count'));
    expect(v12AuthoritySql).toContain(
      'hxos_read_universal_v1_fake_financial_runtime_authority_v13()'
    );
    expect(v12AuthoritySql).toContain('v12_sql_sha256');
    expect(v12AuthoritySql).toContain('ordinal146_sql_sha256');
    for (const [sql] of vi.mocked(query).mock.calls) {
      expect(sql).not.toMatch(
        /FROM public\.(?:applied_migrations|hxos_fake_financial_schema_evidence_v\d+|hxos_work_order_bootstrap_seal_evidence_v1|hxos_nonproduction_bootstrap_completion_v1)\b/u
      );
    }
    const catalogSql = vi
      .mocked(query)
      .mock.calls.map(([sql]) => sql)
      .find((sql) => sql.includes('identity_documents'));
    expect(catalogSql).toBeDefined();
    for (const token of [
      'provider_event_inbox_observations',
      'applied_migrations',
      'escrows',
      'hxos_fake_financial_schema_evidence_v1',
      'hxos_fake_financial_schema_evidence_v4',
      'hxos_fake_financial_schema_evidence_v5',
      'hxos_fake_financial_schema_evidence_v6',
      'hxos_fake_financial_schema_evidence_v7',
      'hxos_fake_financial_schema_evidence_v8',
      'hxos_fake_financial_schema_evidence_v9',
      'hxos_fake_financial_schema_evidence_v10',
      'hxos_fake_financial_schema_evidence_v11',
      'hxos_fake_financial_schema_evidence_v12',
      'hxos_fake_financial_legacy_expiry_noncompensable_facts_v10',
      'hxos_nonproduction_bootstrap_completion_v1',
      'hxos_fake_financial_operations_v1',
      'provider_event_inbox_receipts',
      'financial_provider_command_journal',
      'universal_v1_prepared_financial_commands',
      'provider_event_processing_state',
      'provider_event_processing_attempts',
      'provider_event_processing_outcomes',
      'financial_provider_command_recovery_leases',
      'financial_provider_command_dispatch_attempts',
      'financial_provider_command_outcome_facts',
      'enforce_legacy_escrow_insert_containment_v1',
      'universal_v1_fake_financial_lifecycle_bridges',
      'universal_v1_fake_terminal_plan_steps_v1',
      'universal_v1_fake_terminal_lifecycle_intents',
      'universal_v1_fake_provider_account_facts',
      'universal_v1_fake_reconciliation_bridges',
      'universal_v1_change_order_materialization_commands',
      'universal_v1_change_order_recovery_leases',
      'universal_v1_change_order_compensation_commands',
      'universal_v1_change_order_recovery_terminal_facts',
      'task_reconciliation_facts',
      'universal_v1_fake_terminal_plan_v1',
      'validate_universal_v1_fake_terminal_lifecycle_intent',
      'validate_universal_v1_fake_provider_account_fact',
      'universal_v1_reconciliation_snapshot_sha256_v1',
      'validate_universal_v1_fake_reconciliation_bridge',
      'require_universal_v1_fake_reconciliation_bridge',
      'require_universal_v1_double_entry_ledger_v1',
      'reject_universal_v1_fake_terminal_authority_mutation',
      'universal_v1_change_order_materialization_request_sha256',
      'enforce_universal_v1_change_order_materialization_command',
      'claim_universal_v1_change_order_recovery_v1',
      'claim_universal_v1_change_order_compensation_v1',
      'record_universal_v1_change_order_materialized_recovery_v1',
      'record_universal_v1_change_order_compensated_recovery_v1',
      'record_universal_v1_change_order_no_effect_recovery_v1',
      'universal_v1_change_order_recovery_resolution_v1',
      'enforce_universal_v1_dispute_release_gate_v1',
      'universal_v1_financial_security_is_current_v1',
      'universal_v1_effective_financial_security_expiry_v1',
      'enforce_universal_v1_dispatch_positive_expiry_v1',
      'enforce_universal_v1_location_access_expiry_v1',
      'enforce_universal_v1_fake_expiry_bridge_v9',
      'hxos_prepare_legacy_expiry_compensation_v10',
      'hxos_record_legacy_expiry_compensation_attempt_v10',
      'hxos_finalize_legacy_expiry_compensation_v10',
      'hxos_record_fake_financial_security_event_v1',
      'hxos_record_fake_reconciliation_fact_v1',
      'pg_get_constraintdef',
      'pg_get_indexdef',
      'index_record.indpred',
      'pg_get_functiondef',
      'pg_get_triggerdef',
      'pg_get_ruledef',
      'rewrite_rule_identities',
      'rewrite_record.ev_enabled',
      'rewrite_record.is_instead',
      'trigger_record.tgenabled',
      'critical_trigger_functions',
      'extension_function_members',
      'owner_superuser=',
      'source=',
      'binary=',
      'attribute.attisdropped',
      'constraint_trigger_identities',
      'policy_identities',
      'extension_identities',
      'pg_catalog.sha256',
      'pg_catalog.convert_to',
    ]) {
      expect(catalogSql).toContain(token);
    }
    const authoritySql = vi
      .mocked(query)
      .mock.calls.map(([sql]) => sql)
      .find((sql) => sql.includes('financial_readiness_custody_v13'));
    expect(authoritySql).toBeDefined();
    if (!authoritySql) throw new Error('Expected exact authority SQL');
    expect(authoritySql).toContain('pg_catalog.aclexplode');
    expect(catalogSql).not.toContain('to_regprocedure(');
    expect(verifyWorkOrderCommandAuthorityInCurrentSnapshot).toHaveBeenCalledWith(
      query,
      exactOptions.env,
      'apiRole'
    );
    const constraintSql = vi
      .mocked(query)
      .mock.calls.map(([sql]) => sql)
      .find((sql) => sql.includes('FOREIGN_KEY_TRIGGER_ENFORCEMENT_INVALID'));
    expect(constraintSql).toContain('referenced_relation');
    expect(constraintSql).toContain('disabled_internal_constraint_triggers');
  });

  it.each([
    ['PostgreSQL 15', '150015'],
    ['PostgreSQL 17', '170000'],
    ['a malformed version', 'not-a-version'],
  ] as const)('fails closed on unsupported %s before reading PG16 catalogs', async (_, version) => {
    const query = readinessQuery({ serverVersionNumber: version });
    const result = await readNonproductionFinancialBootstrapReadiness(options(query));

    expect(result).toMatchObject({
      ready: false,
      status: 'database_identity_mismatch',
      releaseId: manifest().releaseId,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(query)
        .mock.calls.some(([sql]) => sql.includes('hxos_nonproduction_database_identity_v1'))
    ).toBe(false);
  });

  it.each([0, 2])(
    'fails closed when PostgreSQL version identity returns %i rows',
    async (rowCount) => {
      const result = await readNonproductionFinancialBootstrapReadiness(
        options(readinessQuery({ serverVersionRowCount: rowCount }))
      );

      expect(result).toMatchObject({ ready: false, status: 'database_identity_mismatch' });
    }
  );

  it.each([0, 2])(
    'fails closed when PostgreSQL version identity reports rowCount %i for one row',
    async (reportedRowCount) => {
      const result = await readNonproductionFinancialBootstrapReadiness(
        options(readinessQuery({ serverVersionReportedRowCount: reportedRowCount }))
      );

      expect(result).toMatchObject({ ready: false, status: 'database_identity_mismatch' });
    }
  );

  it.each([160015, true, null, '160015 ', '16e4'] as const)(
    'fails closed when PostgreSQL version identity has noncanonical type/value %j',
    async (serverVersionNumber) => {
      const result = await readNonproductionFinancialBootstrapReadiness(
        options(readinessQuery({ serverVersionNumber }))
      );

      expect(result).toMatchObject({ ready: false, status: 'database_identity_mismatch' });
    }
  );

  it.each([
    ['server encoding', { server_encoding: 'SQL_ASCII' }],
    ['database encoding', { database_encoding: 'LATIN1' }],
    ['locale provider', { locale_provider: 'i' }],
    ['collation', { lc_collate: 'C' }],
    ['ctype', { lc_ctype: 'C' }],
    ['ICU locale', { icu_locale: 'en-US' }],
    ['ICU rules', { icu_rules: '&a<b' }],
    ['recorded collation version', { recorded_collation_version: '2.36' }],
    ['actual collation version', { actual_collation_version: '2.36' }],
    ['template flag', { is_template: true }],
    ['connection flag', { allows_connections: false }],
  ] satisfies readonly (readonly [string, Partial<SupportedDatabaseIdentityRow>])[])(
    'fails closed when the exact database %s differs',
    async (_, databaseIdentity) => {
      const query = readinessQuery({ databaseIdentity });
      const result = await readNonproductionFinancialBootstrapReadiness(options(query));

      expect(result).toMatchObject({
        ready: false,
        status: 'database_identity_mismatch',
        releaseId: manifest().releaseId,
      });
      expect(query).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(query)
          .mock.calls.some(([sql]) =>
            sql.includes('hxos_read_fake_financial_bootstrap_completion_v13')
          )
      ).toBe(false);
    }
  );

  it.each([0, 2])('fails closed when database identity returns %i rows', async (rowCount) => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ databaseIdentityRowCount: rowCount }))
    );

    expect(result).toMatchObject({ ready: false, status: 'database_identity_mismatch' });
  });

  it.each([0, 2])(
    'fails closed when database identity reports rowCount %i for one row',
    async (reportedRowCount) => {
      const result = await readNonproductionFinancialBootstrapReadiness(
        options(readinessQuery({ databaseIdentityReportedRowCount: reportedRowCount }))
      );

      expect(result).toMatchObject({ ready: false, status: 'database_identity_mismatch' });
    }
  );

  it.each([
    ['text', { server_encoding: ['UTF8'] }],
    ['nullable text', { icu_locale: false }],
    ['boolean', { allows_connections: 1 }],
  ] as const)('fails closed on database identity %s type drift', async (_, databaseIdentity) => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ databaseIdentity }))
    );

    expect(result).toMatchObject({ ready: false, status: 'database_identity_mismatch' });
  });

  it('collapses database-identity query failures without reading later evidence', async () => {
    const query = readinessQuery({ throwOnDatabaseIdentity: true });
    const result = await readNonproductionFinancialBootstrapReadiness(options(query));

    expect(result).toMatchObject({ ready: false, status: 'attestation_unavailable' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(query)
        .mock.calls.some(([sql]) =>
          sql.includes('hxos_read_fake_financial_bootstrap_completion_v13')
        )
    ).toBe(false);
  });

  it('derives every critical applied checksum from exact registered SQL bytes', async () => {
    const query = readinessQuery({
      criticalMigrationEvidence: sourceCriticalMigrationEvidence,
    });
    const result = await readNonproductionFinancialBootstrapReadiness({
      ...options(query),
      expectedCriticalMigrationEvidence: undefined,
    });

    expect(result).toMatchObject({ ready: true, status: 'ready' });
  });

  it('fails closed before querying schema when exact bootstrap completion is absent', async () => {
    const query = readinessQuery({ completion: false });
    const result = await readNonproductionFinancialBootstrapReadiness(options(query));

    expect(result).toMatchObject({ ready: false, status: 'bootstrap_missing' });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('fails closed when append-only schema and applied checksums do not agree', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ mismatch: true }))
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'schema_evidence_mismatch',
      matchedFakeFinancialMigrationCount: expectedEvidence.length - 1,
    });
  });

  it('fails closed when exact v13 append-only schema evidence is absent', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ missingFinalFinancialEvidence: true }))
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'schema_evidence_mismatch',
      matchedFakeFinancialMigrationCount: expectedEvidence.length - 1,
    });
  });

  it('fails closed when any critical migration applied evidence is missing, extra, or drifted', async () => {
    for (const queryOptions of [
      { criticalMigrationMissing: true },
      { criticalMigrationMismatch: true },
      { criticalMigrationExtra: true },
    ]) {
      const query = readinessQuery(queryOptions);
      const result = await readNonproductionFinancialBootstrapReadiness(options(query));

      expect(result).toMatchObject({
        ready: false,
        status: 'schema_evidence_mismatch',
        matchedFakeFinancialMigrationCount: expectedEvidence.length,
      });
      expect(query).toHaveBeenCalledTimes(5);
    }
  });

  it.each([{ duplicateFinancialEvidence: true }, { nullFinancialEvidence: true }])(
    'rejects malformed metadata receipts instead of treating the reader port as an approval: %j',
    async (drift) => {
      const result = await readNonproductionFinancialBootstrapReadiness(
        options(readinessQuery(drift))
      );
      expect(result).toMatchObject({ ready: false, status: 'schema_evidence_mismatch' });
    }
  );

  it('fails closed without exposing database details when the sealed authority reader rejects drift', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ throwOnWorkOrderAuthority: true }))
    );
    expect(result).toMatchObject({ ready: false, status: 'attestation_unavailable' });
    expect(JSON.stringify(result)).not.toContain('synthetic ledger drift');
  });

  it.each([
    ['the v12 aggregate row is absent', { v12AuthorityResultRowCount: 0 }],
    ['the v12 evidence table is empty', { v12AuthorityEvidenceRowCount: 0 }],
    ['the v12 evidence table is non-unique', { v12AuthorityEvidenceRowCount: 2 }],
    ['the v12 checksum is absent', { v12AuthorityEvidenceSha256: null }],
    ['the v12 checksum is wrong', { v12AuthorityEvidenceSha256: '0'.repeat(64) }],
    ['the ordinal146 checksum is absent', { v12AuthorityOrdinal146Sha256: null }],
    ['the ordinal146 checksum is wrong', { v12AuthorityOrdinal146Sha256: '0'.repeat(64) }],
    ['the seal evidence table is empty', { sealAuthorityEvidenceRowCount: 0 }],
    ['the seal evidence table is non-unique', { sealAuthorityEvidenceRowCount: 2 }],
    ['the seal checksum is absent', { sealAuthorityEvidenceSha256: null }],
    ['the seal checksum is wrong', { sealAuthorityEvidenceSha256: '0'.repeat(64) }],
    ['the sealed ordinal146 checksum is absent', { sealAuthorityOrdinal146Sha256: null }],
    ['the sealed ordinal146 checksum is wrong', { sealAuthorityOrdinal146Sha256: '0'.repeat(64) }],
    ['the sealed v12 checksum is absent', { sealAuthorityV12Sha256: null }],
    ['the sealed v12 checksum is wrong', { sealAuthorityV12Sha256: '0'.repeat(64) }],
  ])('fails closed when %s', async (_caseName, queryOptions) => {
    const query = readinessQuery(queryOptions);
    const result = await readNonproductionFinancialBootstrapReadiness(options(query));

    expect(result).toMatchObject({
      ready: false,
      status: 'schema_evidence_mismatch',
      matchedFakeFinancialMigrationCount: expectedEvidence.length,
    });
    expect(query).toHaveBeenCalledTimes(6);
  });

  it.each([
    ['relations', 'a dropped or malformed required relation'],
    ['constraints', 'a changed critical unique or check constraint'],
    ['indexes', 'a changed partial unique or claim index'],
    ['functions', 'a changed append-only reject function'],
    ['triggers', 'a missing or disabled append-only trigger'],
    ['rewrite_rules', 'changed view or table rewrite semantics'],
    ['constraint_triggers', 'changed internal constraint-trigger identity'],
    ['policies', 'changed row-security policy identity'],
    ['extensions', 'changed required extension identity'],
  ] as const)(
    'fails closed when the %s catalog identity detects %s',
    async (identityName, _reason) => {
      const result = await readNonproductionFinancialBootstrapReadiness(
        options(readinessQuery({ criticalSchemaMismatch: identityName }))
      );

      expect(result).toMatchObject({
        ready: false,
        status: 'schema_evidence_mismatch',
        matchedFakeFinancialMigrationCount: expectedEvidence.length,
      });
    }
  );

  it('fails closed when a required critical schema identity row is absent', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ criticalSchemaMissing: 'relations' }))
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'schema_evidence_mismatch',
    });
  });

  it('fails closed when an unexpected critical schema identity row is returned', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ criticalSchemaExtra: true }))
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'schema_evidence_mismatch',
    });
  });

  it.each([
    ['target_authority_id', null],
    ['target_authority_id', 'not-a-uuid'],
    ['target_authority_id', '11111111-1111-6111-8111-111111111111'],
    ['authority_version', 0],
    ['authority_version', '1'],
    ['authority_version', Number.MAX_SAFE_INTEGER + 1],
    ['session_database_role', 'hx_test_readiness_worker'],
    ['target_database_name', 'another_database'],
    ['observed_database_name', 'another_database'],
    ['environment', 'staging'],
    ['release_manifest_sha256', 'sha256:' + '0'.repeat(64)],
    ['v13_sql_sha256', '0'.repeat(64)],
    ['fake_financial_operations_relation', 'public.escrows'],
    ['fake_financial_operation_events_relation', 'public.financial_provider_command_journal'],
  ])('rejects sealed runtime binding drift in %s', async (field, value) => {
    const query = readinessQuery({ runtimeAuthority: { [field]: value } });
    const result = await readNonproductionFinancialBootstrapReadiness(options(query));
    expect(result).toMatchObject({ ready: false, status: 'database_authority_violation' });
    expect(vi.mocked(query).mock.calls.some(([sql]) => sql.includes('identity_documents'))).toBe(
      false
    );
  });

  it('binds worker readiness to the worker login and existing immutable release', async () => {
    const query = readinessQuery({
      runtimeAuthority: { session_database_role: 'hx_test_readiness_worker' },
    });
    const result = await readNonproductionFinancialBootstrapReadiness({
      ...options(query),
      component: 'worker',
    });
    expect(result).toMatchObject({ ready: true, status: 'ready' });
  });

  it('rejects an API login used as worker readiness', async () => {
    const query = readinessQuery();
    const result = await readNonproductionFinancialBootstrapReadiness({
      ...options(query),
      component: 'worker',
    });
    expect(result).toMatchObject({ ready: false, status: 'database_authority_violation' });
  });

  it('rejects missing expected database identity before reporting readiness', async () => {
    const query = readinessQuery();
    const base = options(query);
    const result = await readNonproductionFinancialBootstrapReadiness({
      ...base,
      env: { ...base.env, HX_RUNTIME_DATABASE_NAME: '' },
    });
    expect(result).toMatchObject({ ready: false, status: 'database_authority_violation' });
  });

  it('collapses catalog-attestation failures without disclosing database detail', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ throwOnCriticalSchema: true }))
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'attestation_unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('catalog detail must not leak');
  });

  it('fails closed when the current eight-role verifier refuses the bound snapshot', async () => {
    vi.mocked(verifyWorkOrderCommandAuthorityInCurrentSnapshot).mockImplementationOnce(async () => {
      return { status: 'BLOCKED', reasons: ['SYNTHETIC_ROLE_DRIFT'] } as Awaited<
        ReturnType<typeof verifyWorkOrderCommandAuthorityInCurrentSnapshot>
      >;
    });
    const query = readinessQuery();
    expect(await readNonproductionFinancialBootstrapReadiness(options(query))).toMatchObject({
      ready: false,
      status: 'database_authority_violation',
    });
    expect(
      vi.mocked(query).mock.calls.some(([sql]) => sql.includes('financial_readiness_custody_v13'))
    ).toBe(false);
  });

  it('fails closed on any explicit database authority-policy violation', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ authorityViolations: ['RUNTIME_ROLE_ELEVATED'] }))
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'database_authority_violation',
    });
  });

  it.each([
    'RETAINED_FUNCTION_MISSING_OR_CUSTODY_DRIFT',
    'RETAINED_FUNCTION_EXECUTE_GRANT',
    'RETAINED_FUNCTION_DEPENDENCY_EXECUTE_MISSING',
    'LEGACY_DIGEST_IDENTITY_OR_GRANT_DRIFT',
    'LEGACY_DIGEST_MISSING',
    'DEFERRED_GUARD_MODE_DRIFT',
    'RETAINED_COLUMN_GRANT',
    'DATABASE_UNSAFE_GRANT',
    'SCHEMA_CUSTODY_OR_GRANT_DRIFT',
  ])('fails closed on sealed-definer dependency violation %s', async (violation) => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ authorityViolations: [violation] }))
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'database_authority_violation',
    });
  });

  it('rejects contradictory production metadata before opening a transaction', async () => {
    const query = readinessQuery();
    const database = readinessDatabase(query);
    const result = await readNonproductionFinancialBootstrapReadiness({
      ...options(query),
      database,
      env: {
        HX_ENVIRONMENT: 'production',
        NODE_ENV: 'development',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      },
    });

    expect(result).toMatchObject({ ready: false, status: 'unauthorized' });
    expect(database.readOnlyAttestationTransaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not query or disclose details when fake-finance authority is absent', async () => {
    const query = readinessQuery();
    const invalidRelease: ReleaseManifestEvidence = {
      ...release(),
      status: 'unattributed',
      digest: 'unattributed',
      manifest: null,
    };
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(query, invalidRelease)
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'unauthorized',
      releaseId: null,
      releaseManifestDigest: null,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('collapses database failures to a non-sensitive unavailable status', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ throwError: true }))
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'attestation_unavailable',
      releaseManifestDigest: releaseManifestDigest(manifest()),
    });
    expect(JSON.stringify(result)).not.toContain('database detail must not leak');
  });
});
