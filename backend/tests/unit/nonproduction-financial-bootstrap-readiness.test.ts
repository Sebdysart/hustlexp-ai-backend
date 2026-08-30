import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import type { QueryFn } from '../../src/db.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-financial-migration.js';
import {
  releaseManifestDigest,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';
import {
  readNonproductionFinancialBootstrapReadiness,
  type NonproductionFinancialReadinessDatabase,
  type NonproductionFinancialMigrationEvidence,
} from '../../src/services/payment/NonproductionFinancialBootstrapReadiness.js';

const REVISION = '1'.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

function manifest(environment: 'local' | 'production' = 'local'): ReleaseManifest {
  return {
    version: 1,
    environment,
    releaseId: `test-${environment}-finance-health-0001`,
    createdAt: '2026-08-28T12:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: digest('f'),
    },
    components: {
      backend: { revision: REVISION, artifactDigest: digest('1'), imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE', imageDigest: digest('2') },
      worker: { revision: REVISION, artifactDigest: digest('3'), imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE', imageDigest: digest('4') },
      web: { revision: '2'.repeat(40), artifactDigest: digest('5'), imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE', imageDigest: digest('6') },
      migration: { revision: REVISION, artifactDigest: digest('7') },
      policy: { revision: '3'.repeat(40), artifactDigest: digest('8') },
      fixtures: { revision: '4'.repeat(40), artifactDigest: digest('9'), imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE', imageDigest: digest('a') },
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
    sha256: String(index + 1).repeat(64),
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
    migrationName: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1',
    sha256: '9'.repeat(64),
  },
];

const sourceCriticalMigrationEvidence: readonly NonproductionFinancialMigrationEvidence[] =
  expectedCriticalMigrationEvidence.map(({ migrationName }) => ({
    migrationName,
    sha256: createHash('sha256').update(readFileSync(path.resolve(
      'backend/database/migrations',
      `${migrationName}.sql`,
    ))).digest('hex'),
  }));

const expectedCriticalSchemaEvidence = [
  { identityName: 'relations', sha256: 'a'.repeat(64) },
  { identityName: 'constraints', sha256: 'b'.repeat(64) },
  { identityName: 'indexes', sha256: 'c'.repeat(64) },
  { identityName: 'functions', sha256: 'd'.repeat(64) },
  { identityName: 'triggers', sha256: 'e'.repeat(64) },
  { identityName: 'constraint_triggers', sha256: 'f'.repeat(64) },
  { identityName: 'policies', sha256: '1'.repeat(64) },
  { identityName: 'extensions', sha256: '2'.repeat(64) },
] as const;

function readinessQuery(options: {
  completion?: boolean;
  mismatch?: boolean;
  throwError?: boolean;
  throwOnCriticalSchema?: boolean;
  criticalMigrationMismatch?: boolean;
  criticalMigrationMissing?: boolean;
  criticalMigrationExtra?: boolean;
  criticalMigrationEvidence?: readonly NonproductionFinancialMigrationEvidence[];
  criticalSchemaMismatch?: typeof expectedCriticalSchemaEvidence[number]['identityName'];
  criticalSchemaMissing?: typeof expectedCriticalSchemaEvidence[number]['identityName'];
  criticalSchemaExtra?: boolean;
  authorityViolations?: readonly string[];
} = {}): QueryFn {
  return vi.fn(async (sql: string, values?: unknown[]) => {
    if (options.throwError) throw new Error('database detail must not leak');
    if (
      sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
      || sql === "SET LOCAL search_path = 'pg_catalog'"
      || sql === "SET LOCAL statement_timeout = '1000ms'"
      || sql === "SET LOCAL lock_timeout = '250ms'"
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM public.hxos_nonproduction_bootstrap_completion_v1')) {
      if (options.completion === false) return { rows: [], rowCount: 0 };
      const exactManifest = manifest();
      expect(values).toEqual([
        releaseManifestDigest(exactManifest),
        exactManifest.components.migration.artifactDigest,
      ]);
      return {
        rows: [{
          release_id: exactManifest.releaseId,
          release_environment: 'local',
          required_migration_count: REQUIRED_MIGRATION_FILES.length,
          financial_migration_status: 'applied',
          completed_at: '2026-08-28T12:30:00.000Z',
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('WITH evidence AS')) {
      return {
        rows: expectedEvidence.map((entry, index) => ({
          migration_name: entry.migrationName,
          evidence_sha256: options.mismatch && index === 1 ? '0'.repeat(64) : entry.sha256,
          applied_sha256: entry.sha256,
        })),
        rowCount: expectedEvidence.length,
      };
    }
    if (sql.includes('SELECT name AS migration_name')) {
      const criticalMigrationEvidence = options.criticalMigrationEvidence
        ?? expectedCriticalMigrationEvidence;
      expect(values).toEqual([criticalMigrationEvidence.map(
        ({ migrationName }) => migrationName,
      )]);
      const rows = criticalMigrationEvidence
        .filter((_, index) => !options.criticalMigrationMissing || index !== 0)
        .map((entry, index) => ({
          migration_name: entry.migrationName,
          applied_sha256: options.criticalMigrationMismatch && index === 1
            ? '0'.repeat(64)
            : entry.sha256,
        }));
      if (options.criticalMigrationExtra) {
        rows.push({
          migration_name: 'unexpected_critical_migration',
          applied_sha256: 'f'.repeat(64),
        });
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('runtime_role AS')) {
      const rows = (options.authorityViolations ?? []).map((violation_code) => ({
        violation_code,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('identity_documents')) {
      if (options.throwOnCriticalSchema) {
        throw new Error('catalog detail must not leak');
      }
      const rows = expectedCriticalSchemaEvidence
        .filter(({ identityName }) => identityName !== options.criticalSchemaMissing)
        .map((entry) => ({
          identity_name: entry.identityName,
          identity_sha256: entry.identityName === options.criticalSchemaMismatch
            ? '0'.repeat(64)
            : entry.sha256,
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
    transaction: vi.fn(async (fn) => fn(query)),
  };
}

function options(query: QueryFn, exactRelease = release()) {
  return {
    environment: 'local',
    component: 'backend' as const,
    env: {
      HX_ENVIRONMENT: 'local',
      HX_PAYMENT_CREATION_MODE: 'frozen',
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
      ...options(query, release(manifest('production'))),
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
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('attests one exact manifest/bootstrap record and every current SQL checksum', async () => {
    const query = readinessQuery();
    const baseOptions = options(query);
    const exactOptions = {
      ...baseOptions,
      env: { ...baseOptions.env, NODE_ENV: 'production' },
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
    expect(exactOptions.database.transaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(query).mock.calls[0]?.[0]).toBe(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    expect(vi.mocked(query).mock.calls[1]?.[0]).toBe(
      "SET LOCAL search_path = 'pg_catalog'",
    );
    expect(vi.mocked(query).mock.calls[2]?.[0]).toBe(
      "SET LOCAL statement_timeout = '1000ms'",
    );
    expect(vi.mocked(query).mock.calls[3]?.[0]).toBe(
      "SET LOCAL lock_timeout = '250ms'",
    );
    const catalogSql = vi.mocked(query).mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('identity_documents'));
    expect(catalogSql).toBeDefined();
    for (const token of [
      'provider_event_inbox_observations',
      'applied_migrations',
      'hxos_fake_financial_schema_evidence_v1',
      'hxos_fake_financial_schema_evidence_v4',
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
      'universal_v1_fake_financial_lifecycle_bridges',
      'pg_get_constraintdef',
      'pg_get_indexdef',
      'index_record.indpred',
      'pg_get_functiondef',
      'pg_get_triggerdef',
      'trigger_record.tgenabled',
      'attribute.attisdropped',
      'constraint_trigger_identities',
      'policy_identities',
      'extension_identities',
      'pg_catalog.sha256',
      'pg_catalog.convert_to',
    ]) {
      expect(catalogSql).toContain(token);
    }
    const authoritySql = vi.mocked(query).mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('runtime_role AS'));
    expect(authoritySql).toContain('pg_catalog.aclexplode');
    expect(authoritySql).toContain('ELSE NULL::aclitem[] END');
    expect(authoritySql).toContain('RUNTIME_ROLE_ELEVATED');
    expect(authoritySql).toContain('OBJECT_OWNER_UNSAFE');
    expect(authoritySql).toContain('OBJECT_PUBLIC_GRANT');
    expect(authoritySql).toContain('OBJECT_ROGUE_GRANT');
    expect(authoritySql).toContain('RUNTIME_RELATION_PRIVILEGE_EXCEEDS_ALLOWLIST');
    expect(authoritySql).toContain('RUNTIME_FUNCTION_EXECUTE_GRANT');
    expect(authoritySql).toContain('RUNTIME_COLUMN_GRANT');
    expect(authoritySql).toContain('RUNTIME_GRANT_OPTION');
    expect(authoritySql).toContain('OWNER_HAS_LOGIN_MEMBER');
    expect(authoritySql).toContain('OWNER_HAS_ELEVATED_MEMBERSHIP');
    expect(authoritySql).toContain('PUBLIC_SCHEMA_CREATE');
    expect(authoritySql).toContain('SCHEMA_ROGUE_GRANT');
    expect(authoritySql).toContain("acl_item.object_name NOT IN");
    expect(authoritySql).toContain('DEFAULT_PUBLIC_GRANT');
    expect(authoritySql).toContain('FOREIGN_KEY_INTERNAL_TRIGGER_UNSAFE');
  });

  it('derives all six critical applied checksums from exact registered SQL bytes', async () => {
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
    expect(query).toHaveBeenCalledTimes(5);
  });

  it('fails closed when append-only schema and applied checksums do not agree', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(
      options(readinessQuery({ mismatch: true })),
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
      expect(query).toHaveBeenCalledTimes(7);
    }
  });

  it.each([
    ['relations', 'a dropped or malformed required relation'],
    ['constraints', 'a changed critical unique or check constraint'],
    ['indexes', 'a changed partial unique or claim index'],
    ['functions', 'a changed append-only reject function'],
    ['triggers', 'a missing or disabled append-only trigger'],
    ['constraint_triggers', 'changed internal constraint-trigger identity'],
    ['policies', 'changed row-security policy identity'],
    ['extensions', 'changed required extension identity'],
  ] as const)(
    'fails closed when the %s catalog identity detects %s',
    async (identityName) => {
      const result = await readNonproductionFinancialBootstrapReadiness(options(
        readinessQuery({ criticalSchemaMismatch: identityName }),
      ));

      expect(result).toMatchObject({
        ready: false,
        status: 'schema_evidence_mismatch',
        matchedFakeFinancialMigrationCount: expectedEvidence.length,
      });
    },
  );

  it('fails closed when a required critical schema identity row is absent', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(options(
      readinessQuery({ criticalSchemaMissing: 'relations' }),
    ));

    expect(result).toMatchObject({
      ready: false,
      status: 'schema_evidence_mismatch',
    });
  });

  it('fails closed when an unexpected critical schema identity row is returned', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(options(
      readinessQuery({ criticalSchemaExtra: true }),
    ));

    expect(result).toMatchObject({
      ready: false,
      status: 'schema_evidence_mismatch',
    });
  });

  it('collapses catalog-attestation failures without disclosing database detail', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(options(
      readinessQuery({ throwOnCriticalSchema: true }),
    ));

    expect(result).toMatchObject({
      ready: false,
      status: 'attestation_unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('catalog detail must not leak');
  });

  it('fails closed on any explicit database authority-policy violation', async () => {
    const result = await readNonproductionFinancialBootstrapReadiness(options(
      readinessQuery({ authorityViolations: ['RUNTIME_ROLE_ELEVATED'] }),
    ));

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
    expect(database.transaction).not.toHaveBeenCalled();
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
      options(query, invalidRelease),
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
      options(readinessQuery({ throwError: true })),
    );

    expect(result).toMatchObject({
      ready: false,
      status: 'attestation_unavailable',
      releaseManifestDigest: releaseManifestDigest(manifest()),
    });
    expect(JSON.stringify(result)).not.toContain('database detail must not leak');
  });
});
