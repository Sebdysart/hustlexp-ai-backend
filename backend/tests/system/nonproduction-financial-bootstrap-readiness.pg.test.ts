import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import { db, hasDb } from '../../src/db.js';
import type { QueryFn } from '../../src/db.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { engineMigrationArtifactDigest } from '../../src/jobs/engine-migration-manifest.js';
import {
  defaultNonproductionFinancialMigrationRuntime,
  runNonproductionFinancialMigration,
} from '../../src/jobs/nonproduction-financial-migration.js';
import {
  releaseManifestDigest,
  type ReleaseManifestV2,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';
import { readNonproductionFinancialBootstrapReadiness } from '../../src/services/payment/NonproductionFinancialBootstrapReadiness.js';

const describePg = describe.sequential.skipIf(!hasDb);
const revision = '1'.repeat(40);
const artifactDigest = (value: string) => `sha256:${value.repeat(64)}`;
function assertDisposablePg16Database(): void {
  const parsed = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5432' ||
    parsed.username !== 'hx_ci_runner' ||
    !parsed.pathname.startsWith('/hx_ci_') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('bootstrap readiness PG proof requires an exact disposable hx_ci_* database');
  }
}

async function localAuthority(): Promise<{
  identity: BuildIdentity;
  manifest: ReleaseManifestV2;
  release: ReleaseManifestEvidence;
}> {
  const migrationArtifactDigest = `sha256:${await engineMigrationArtifactDigest()}`;
  const manifest: ReleaseManifestV2 = {
    version: 2,
    environment: 'local',
    releaseId: `local-readiness-pg-${randomUUID()}`,
    createdAt: '2026-08-28T21:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: artifactDigest('f'),
    },
    components: {
      backend: {
        revision,
        artifactDigest: artifactDigest('1'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: artifactDigest('2'),
      },
      worker: {
        revision,
        artifactDigest: artifactDigest('3'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: artifactDigest('4'),
      },
      web: {
        revision: '2'.repeat(40),
        artifactDigest: artifactDigest('5'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: artifactDigest('6'),
      },
      migration: { revision, artifactDigest: migrationArtifactDigest },
      policy: { revision: '3'.repeat(40), artifactDigest: artifactDigest('8') },
      fixtures: {
        revision: '4'.repeat(40),
        artifactDigest: artifactDigest('9'),
        providerImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        providerImageDigest: artifactDigest('a'),
        databaseImageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        databaseImageDigest: artifactDigest('b'),
      },
    },
    infrastructure: {
      revision: '5'.repeat(40),
      artifactDigest: artifactDigest('c'),
      desiredTopologyDigest: artifactDigest('d'),
    },
    databaseTargets: {
      api: { component: 'api', environment: 'local', databaseTargetDigest: artifactDigest('e') },
      worker: {
        component: 'worker',
        environment: 'local',
        databaseTargetDigest: artifactDigest('f'),
      },
      attester: {
        component: 'attester',
        environment: 'local',
        databaseTargetDigest: artifactDigest('1'),
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
  const identity: BuildIdentity = {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision,
    built_at: '2026-08-28T21:00:00.000Z',
    environment: 'development',
    clean_source: false,
    source: 'git',
    artifact_digest: artifactDigest('1'),
    artifact_verified: false,
  };
  return {
    identity,
    manifest,
    release: {
      schema_version: 1,
      status: 'valid',
      digest: releaseManifestDigest(manifest),
      source: 'pg-test',
      errors: [],
      manifest,
      authentication: {
        status: 'missing',
        algorithm: null,
        keyId: null,
        keyFingerprint: null,
        signatureDigest: null,
        source: 'none',
        errors: [],
      },
    },
  };
}

async function insertBootstrapCompletion(authority: Awaited<ReturnType<typeof localAuthority>>) {
  await db.query(
    `INSERT INTO public.hxos_nonproduction_bootstrap_completion_v1(
       release_manifest_digest, migration_artifact_digest, release_id,
       release_environment, required_migration_count, financial_migration_status
     ) VALUES ($1, $2, $3, 'local', $4, 'already_applied')`,
    [
      releaseManifestDigest(authority.manifest),
      authority.manifest.components.migration.artifactDigest,
      authority.manifest.releaseId,
      REQUIRED_MIGRATION_FILES.length,
    ]
  );
}

function runtimeDatabase(client: pg.Client) {
  return {
    readOnlyAttestationTransaction: async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query('SET LOCAL search_path=pg_catalog');
      await client.query("SET LOCAL statement_timeout='1000ms'");
      await client.query("SET LOCAL lock_timeout='250ms'");
      const query: QueryFn = async (sql, params) => {
        const result = await client.query(sql, params);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      };
      try {
        const value = await fn(query);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  };
}

describePg('nonproduction financial bootstrap PostgreSQL authority policy', () => {
  beforeAll(async () => {
    assertDisposablePg16Database();
    const version = await db.query<{ server_version_num: string }>(
      `SELECT current_setting('server_version_num') AS server_version_num`
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160_000);
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(170_000);

    const fakeFinancialSchema = await db.query<{ relation_name: string | null }>(
      `SELECT pg_catalog.to_regclass(
         'public.hxos_nonproduction_bootstrap_completion_v1'
       )::text AS relation_name`
    );
    if (fakeFinancialSchema.rows[0]?.relation_name === null) {
      const authority = await localAuthority();
      const runtime = defaultNonproductionFinancialMigrationRuntime();
      const exactDatabaseUrl = process.env.DATABASE_URL ?? '';
      const exactDatabaseTarget = new URL(exactDatabaseUrl);
      const exactDatabaseName = decodeURIComponent(
        exactDatabaseTarget.pathname.replace(/^\//u, '')
      );
      const exactDatabaseRole = decodeURIComponent(exactDatabaseTarget.username);
      await runNonproductionFinancialMigration({
        ...runtime,
        env: {
          HX_ENVIRONMENT: 'local',
          HX_PAYMENT_CREATION_MODE: 'frozen',
          HXOS_LOCAL_TEST_DATABASE_NAME: exactDatabaseName,
          HXOS_LOCAL_TEST_DATABASE_ROLE: exactDatabaseRole,
          SERVICE_ROLE: 'migration',
        },
        release: authority.release,
        identity: authority.identity,
        databaseUrl: exactDatabaseUrl,
      });
    }
  });

  it('executes the exact snapshot authority query and rejects the overprivileged runner', async () => {
    const authority = await localAuthority();
    await insertBootstrapCompletion(authority);

    const result = await readNonproductionFinancialBootstrapReadiness({
      environment: 'local',
      component: 'backend',
      env: {
        HX_ENVIRONMENT: 'local',
        NODE_ENV: 'development',
        HX_PAYMENT_CREATION_MODE: 'frozen',
      },
      release: authority.release,
      identity: authority.identity,
      database: db,
    });

    expect(result).toMatchObject({
      required: true,
      ready: false,
      status: 'database_authority_violation',
      environment: 'local',
      releaseId: authority.manifest.releaseId,
    });
  });

  it('returns the distinct fail-closed status before schema or ACL attestation on identity drift', async () => {
    const authority = await localAuthority();
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const baseDatabase = runtimeDatabase(client);
      let semanticCatalogQueries = 0;
      let authorityQueries = 0;
      const identityDriftDatabase = {
        readOnlyAttestationTransaction: <T>(fn: (query: QueryFn) => Promise<T>) =>
          baseDatabase.readOnlyAttestationTransaction((query) =>
            fn(async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
              const result = await query<R>(sql, params);
              if (sql.includes('identity_documents')) semanticCatalogQueries += 1;
              if (sql.includes('violations(violation_code)')) authorityQueries += 1;
              if (!sql.includes('hxos_nonproduction_database_identity_v1')) return result;
              return {
                rows: result.rows.map((row) => ({
                  ...row,
                  allows_connections: false,
                })) as R[],
                rowCount: result.rowCount,
              };
            })
          ),
      };

      const result = await readNonproductionFinancialBootstrapReadiness({
        environment: 'local',
        component: 'backend',
        env: {
          HX_ENVIRONMENT: 'local',
          NODE_ENV: 'development',
          HX_PAYMENT_CREATION_MODE: 'frozen',
        },
        release: authority.release,
        identity: authority.identity,
        database: identityDriftDatabase,
      });

      expect(result).toMatchObject({
        required: true,
        ready: false,
        status: 'database_identity_mismatch',
        releaseId: authority.manifest.releaseId,
      });
      expect(semanticCatalogQueries).toBe(0);
      expect(authorityQueries).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('executes live authority and identity SQL without activating held schema evidence', async () => {
    const authority = await localAuthority();
    await insertBootstrapCompletion(authority);
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const baseDatabase = runtimeDatabase(client);
      const captured: Array<{ identity_name: string; identity_sha256: string }> = [];
      let postgreSqlMajorIdentityExecutions = 0;
      let databaseIdentityExecutions = 0;
      const capturingDatabase = {
        readOnlyAttestationTransaction: <T>(fn: (query: QueryFn) => Promise<T>) =>
          baseDatabase.readOnlyAttestationTransaction((query) =>
            fn(async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
              const result = await query<R>(sql, params);
              if (sql.includes('violations(violation_code)')) {
                // Execute the exact policy SQL against PG16, but isolate the
                // schema-hash mechanism from this known-overprivileged fixture.
                return { rows: [], rowCount: 0 } as Awaited<ReturnType<QueryFn<R>>>;
              }
              if (sql.includes('hxos_nonproduction_postgresql_major_v1')) {
                postgreSqlMajorIdentityExecutions += 1;
              }
              if (sql.includes('hxos_nonproduction_database_identity_v1')) {
                databaseIdentityExecutions += 1;
              }
              if (sql.includes('identity_documents')) {
                captured.push(
                  ...(result.rows as Array<{
                    identity_name: string;
                    identity_sha256: string;
                  }>)
                );
              }
              return result;
            })
          ),
      };
      const placeholderEvidence = [
        'relations',
        'constraints',
        'indexes',
        'functions',
        'triggers',
        'rewrite_rules',
        'constraint_triggers',
        'policies',
        'extensions',
      ].map((identityName, index) => ({
        identityName,
        sha256: String(index + 1).repeat(64),
      }));
      const readinessOptions = {
        environment: 'local',
        component: 'backend' as const,
        env: {
          HX_ENVIRONMENT: 'local',
          NODE_ENV: 'development',
          HX_PAYMENT_CREATION_MODE: 'frozen',
        },
        release: authority.release,
        identity: authority.identity,
      };

      const discovery = await readNonproductionFinancialBootstrapReadiness({
        ...readinessOptions,
        database: capturingDatabase,
        expectedCriticalSchemaEvidence: placeholderEvidence,
      });
      expect(discovery.status).toBe('schema_evidence_mismatch');
      expect(postgreSqlMajorIdentityExecutions).toBe(1);
      expect(databaseIdentityExecutions).toBe(1);
      expect(captured).toHaveLength(9);
      expect(captured.every(({ identity_sha256 }) => /^[a-f0-9]{64}$/u.test(identity_sha256))).toBe(
        true
      );

      const exactEvidence = placeholderEvidence.map(({ identityName }) => {
        const entry = captured.find(({ identity_name }) => identity_name === identityName);
        expect(entry).toBeDefined();
        return {
          identityName,
          sha256: entry?.identity_sha256 ?? '',
        };
      });
      const mechanismOnly = await readNonproductionFinancialBootstrapReadiness({
        ...readinessOptions,
        database: capturingDatabase,
        expectedCriticalSchemaEvidence: exactEvidence,
      });
      expect(mechanismOnly).toMatchObject({ ready: true, status: 'ready' });
      expect(postgreSqlMajorIdentityExecutions).toBe(2);
      expect(databaseIdentityExecutions).toBe(2);
    } finally {
      await client.end();
    }
  });
});
