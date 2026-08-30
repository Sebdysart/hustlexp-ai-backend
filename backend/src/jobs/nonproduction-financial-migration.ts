import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

import { buildIdentity, type BuildIdentity } from '../buildIdentity.js';
import { workerLogger } from '../logger.js';
import {
  readReleaseManifest,
  releaseManifestDigest,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
} from '../releaseManifest.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import {
  loadMigrationSql,
  productionMigrationRuntime,
  runEngineAutomationMigrationsOnConnectedClient,
  type MigrationClient,
  type MigrationOutcome,
  type MigrationRuntime,
  type MigrationSpec,
} from './engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from './engine-automation-migration-files.js';
import { engineMigrationArtifactDigest } from './engine-migration-manifest.js';
import { assertMigrationExecutionAuthorized } from './migration-execution-authority.js';
import {
  assertConfiguredNonproductionDatabaseTarget,
  assertConnectedNonproductionDatabaseTarget,
  type ExpectedNonproductionDatabaseTarget,
} from './nonproduction-database-target.js';

export const NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION =
  '20260827_fake_financial_provider_v1';
export const NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION =
  '20260903_fake_financial_provider_account_refresh_v2';
export const NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION =
  '20260910_fake_financial_settlement_completion_v3';
export const NONPRODUCTION_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_MIGRATION =
  '20260921_universal_v1_fake_financial_lifecycle_bridge_v1';
export const NONPRODUCTION_FAKE_FINANCIAL_MIGRATION =
  '20260922_universal_v1_fake_terminal_lifecycle_intent_v1';

export const NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES = [
  {
    name: NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION,
    fileName: '20260827_fake_financial_provider_v1.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v1',
  },
  {
    name: NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION,
    fileName: '20260903_fake_financial_provider_account_refresh_v2.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v2',
  },
  {
    name: NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION,
    fileName: '20260910_fake_financial_settlement_completion_v3.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v3',
  },
  {
    name: NONPRODUCTION_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_MIGRATION,
    fileName: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v4',
  },
  {
    name: NONPRODUCTION_FAKE_FINANCIAL_MIGRATION,
    fileName: '20260922_universal_v1_fake_terminal_lifecycle_intent_v1.sql',
    evidenceTable: 'hxos_fake_financial_schema_evidence_v5',
  },
] as const;

export interface NonproductionFinancialMigrationRuntime {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  release: ReleaseManifestEvidence;
  identity: BuildIdentity;
  databaseUrl: string;
  migrationSpecs: MigrationSpec[];
  migrationArtifactDigest(): Promise<string>;
  readText(filePath: string): Promise<string>;
  createClient(databaseUrl: string): MigrationClient;
}

export interface NonproductionFinancialDatabaseBootstrapRuntime {
  runRequiredMigrationsOnClient(
    client: MigrationClient,
    databaseUrl: string,
    expectedTarget: ExpectedNonproductionDatabaseTarget,
  ): Promise<MigrationOutcome[]>;
  financialMigration: NonproductionFinancialMigrationRuntime;
}

export interface NonproductionFinancialMigrationOutcome extends MigrationOutcome {
  migrations: MigrationOutcome[];
  releaseManifestDigest: string;
  migrationArtifactDigest: string;
}

export interface NonproductionFinancialBootstrapCompletion {
  schemaVersion: 1;
  status: 'complete';
  releaseManifestDigest: string;
  migrationArtifactDigest: string;
  releaseId: string;
  environment: 'local' | 'preview' | 'staging';
  requiredMigrationCount: number;
  financialMigrationStatus: MigrationOutcome['status'];
  completedAt: string;
}

interface BootstrapCompletionRow extends Record<string, unknown> {
  release_manifest_digest: string;
  migration_artifact_digest: string;
  release_id: string;
  release_environment: 'local' | 'preview' | 'staging';
  required_migration_count: number;
  financial_migration_status: MigrationOutcome['status'];
  completed_at: Date | string;
}

function normalizeArtifactDigest(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/u.test(normalized)) return `sha256:${normalized}`;
  if (/^sha256:[0-9a-f]{64}$/u.test(normalized)) return normalized;
  throw new Error('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_INVALID');
}

function sqlSha256(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function assertRequiredMigrationEvidence(required: readonly MigrationOutcome[]): void {
  if (required.length !== REQUIRED_MIGRATION_FILES.length) {
    throw new Error('NONPRODUCTION_REQUIRED_MIGRATION_EVIDENCE_INCOMPLETE');
  }
  for (const [index, expected] of REQUIRED_MIGRATION_FILES.entries()) {
    const outcome = required[index];
    if (
      !outcome
      || outcome.migration !== expected.name
      || !['applied', 'already_applied'].includes(outcome.status)
      || !outcome.sourcePath?.trim()
      || !/^[0-9a-f]{64}$/u.test(outcome.sha256)
    ) {
      throw new Error('NONPRODUCTION_REQUIRED_MIGRATION_EVIDENCE_MISMATCH');
    }
  }
}

function assertExactFakeFinancialMigrationChain(
  runtime: NonproductionFinancialMigrationRuntime,
): void {
  const exactSpecs = NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES;
  if (
    runtime.migrationSpecs.length !== exactSpecs.length
    || runtime.migrationSpecs.some((spec, index) => spec.name !== exactSpecs[index]?.name)
  ) {
    throw new Error('NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_CHAIN_MISMATCH');
  }
}

function fakeFinancialMigrationRuntime(
  runtime: NonproductionFinancialMigrationRuntime,
): MigrationRuntime {
  return {
    databaseUrl: runtime.databaseUrl,
    migrationSpecs: runtime.migrationSpecs,
    readText: runtime.readText,
    createClient: runtime.createClient,
  };
}

async function exactMigrationArtifactDigest(
  runtime: NonproductionFinancialMigrationRuntime,
  expectedDigest: string,
): Promise<string> {
  const artifactDigest = normalizeArtifactDigest(await runtime.migrationArtifactDigest());
  if (artifactDigest !== expectedDigest) {
    throw new Error('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_MISMATCH');
  }
  return artifactDigest;
}

async function applyVerifiedFakeFinancialMigration(
  client: MigrationClient,
  migrationName: string,
  evidenceTable: string,
  sql: string,
  sourcePath: string,
): Promise<MigrationOutcome> {
  const expectedSqlSha256 = sqlSha256(sql);
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      migrationName,
    ]);
    await client.query(`CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY,
      sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(
      'ALTER TABLE applied_migrations ADD COLUMN IF NOT EXISTS sha256 CHAR(64)'
    );
    const existing = await client.query<{ name: string; sha256: string | null }>(
      'SELECT name, sha256 FROM applied_migrations WHERE name = $1',
      [migrationName],
    );
    let status: MigrationOutcome['status'];
    if (existing.rows.length === 0) {
      await client.query(sql);
      await client.query(
        `INSERT INTO ${evidenceTable}
           (migration_name, migration_sql_sha256)
         VALUES ($1, $2)`,
        [migrationName, expectedSqlSha256],
      );
      await client.query(
        'INSERT INTO applied_migrations (name, sha256) VALUES ($1, $2)',
        [migrationName, expectedSqlSha256],
      );
      status = 'applied';
    } else {
      if (existing.rows[0]?.sha256?.trim() !== expectedSqlSha256) {
        throw new Error('NONPRODUCTION_FAKE_FINANCIAL_APPLIED_DIGEST_MISMATCH');
      }
      const evidence = await client.query<{ migration_sql_sha256: string }>(
        `SELECT migration_sql_sha256
         FROM ${evidenceTable}
         WHERE migration_name = $1`,
        [migrationName],
      );
      if (evidence.rows[0]?.migration_sql_sha256 !== expectedSqlSha256) {
        throw new Error('NONPRODUCTION_FAKE_FINANCIAL_SCHEMA_DIGEST_MISMATCH');
      }
      status = 'already_applied';
    }
    await client.query('COMMIT');
    return {
      status,
      migration: migrationName,
      sourcePath,
      sha256: expectedSqlSha256,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function applyFakeFinancialMigrationChainOnConnectedClient(
  client: MigrationClient,
  runtime: NonproductionFinancialMigrationRuntime,
  target: ExpectedNonproductionDatabaseTarget,
  releaseManifestDigestValue: string,
  artifactDigest: string,
): Promise<NonproductionFinancialMigrationOutcome> {
  await assertConnectedNonproductionDatabaseTarget(client, target);
  const exactSpecs = NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES;
  const migrationRuntime = fakeFinancialMigrationRuntime(runtime);
  const migrations = await Promise.all(runtime.migrationSpecs.map(async (spec) => ({
    spec,
    loaded: await loadMigrationSql(migrationRuntime, spec),
  })));

  const outcomes: MigrationOutcome[] = [];
  for (const [index, migration] of migrations.entries()) {
    const registration = exactSpecs[index];
    if (!registration || registration.name !== migration.spec.name) {
      throw new Error('NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_CHAIN_MISMATCH');
    }
    outcomes.push(await applyVerifiedFakeFinancialMigration(
      client,
      migration.spec.name,
      registration.evidenceTable,
      migration.loaded.sql,
      migration.loaded.sourcePath,
    ));
  }
  const outcome = outcomes.at(-1);
  if (!outcome) throw new Error('NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_CHAIN_EMPTY');
  workerLogger.info({ outcomes }, 'Nonproduction fake-financial migrations verified');
  return {
    ...outcome,
    migrations: outcomes,
    releaseManifestDigest: releaseManifestDigestValue,
    migrationArtifactDigest: artifactDigest,
  };
}

export function defaultNonproductionFinancialMigrationRuntime(): NonproductionFinancialMigrationRuntime {
  const cwd = process.cwd();
  return {
    env: process.env,
    release: readReleaseManifest(),
    identity: buildIdentity,
    databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
    migrationSpecs: NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map(({ name, fileName }) => ({
      name,
      candidatePaths: [
        path.join(cwd, 'backend/database/migrations', fileName),
        path.join('/app/backend/database/migrations', fileName),
      ],
    })),
    migrationArtifactDigest: () => engineMigrationArtifactDigest(),
    readText: (filePath) => readFile(filePath, 'utf8'),
    createClient: (databaseUrl): MigrationClient => {
      const client = new Client({ connectionString: databaseUrl });
      return {
        connect: async () => {
          await client.connect();
        },
        end: () => client.end(),
        query: (sql, values) => client.query(sql, values),
      };
    },
  };
}

export async function runNonproductionFinancialMigration(
  runtime: NonproductionFinancialMigrationRuntime = defaultNonproductionFinancialMigrationRuntime(),
): Promise<NonproductionFinancialMigrationOutcome> {
  const manifest = assertNonproductionFakeFinanceAuthorized({
    env: runtime.env,
    release: runtime.release,
    identity: runtime.identity,
    component: 'migration',
  });
  const target = assertConfiguredNonproductionDatabaseTarget(runtime.env, runtime.databaseUrl);
  assertExactFakeFinancialMigrationChain(runtime);
  const artifactDigest = await exactMigrationArtifactDigest(
    runtime,
    manifest.components.migration.artifactDigest,
  );
  const manifestDigest = releaseManifestDigest(manifest);
  const client = runtime.createClient(runtime.databaseUrl);
  await client.connect();
  try {
    return await applyFakeFinancialMigrationChainOnConnectedClient(
      client,
      runtime,
      target,
      manifestDigest,
      artifactDigest,
    );
  } catch (error) {
    workerLogger.fatal({ err: error }, 'Nonproduction fake-financial migration failed closed');
    throw error;
  } finally {
    await client.end();
  }
}

function mapCompletion(row: BootstrapCompletionRow): NonproductionFinancialBootstrapCompletion {
  return {
    schemaVersion: 1,
    status: 'complete',
    releaseManifestDigest: row.release_manifest_digest,
    migrationArtifactDigest: row.migration_artifact_digest,
    releaseId: row.release_id,
    environment: row.release_environment,
    requiredMigrationCount: Number(row.required_migration_count),
    financialMigrationStatus: row.financial_migration_status,
    completedAt: new Date(row.completed_at).toISOString(),
  };
}

function assertNonproductionFinancialBootstrapEvidence(
  manifest: ReleaseManifest,
  required: MigrationOutcome[],
  financial: NonproductionFinancialMigrationOutcome,
): void {
  assertRequiredMigrationEvidence(required);
  const exactFinancialChain = NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES;
  if (
    financial.migration !== NONPRODUCTION_FAKE_FINANCIAL_MIGRATION
    || financial.migrations.length !== exactFinancialChain.length
    || financial.migrations.some((outcome, index) => (
      outcome.migration !== exactFinancialChain[index]?.name
      || !['applied', 'already_applied'].includes(outcome.status)
      || !outcome.sourcePath?.trim()
      || !/^[0-9a-f]{64}$/u.test(outcome.sha256)
    ))
    || financial.status !== financial.migrations.at(-1)?.status
    || financial.sourcePath !== financial.migrations.at(-1)?.sourcePath
    || financial.sha256 !== financial.migrations.at(-1)?.sha256
    || !['applied', 'already_applied'].includes(financial.status)
    || !financial.sourcePath?.trim()
    || financial.releaseManifestDigest !== releaseManifestDigest(manifest)
    || financial.migrationArtifactDigest !== manifest.components.migration.artifactDigest
  ) {
    throw new Error('NONPRODUCTION_BOOTSTRAP_EVIDENCE_MISMATCH');
  }
}

async function recordNonproductionFinancialBootstrapCompletionOnConnectedClient(
  client: MigrationClient,
  target: ExpectedNonproductionDatabaseTarget,
  manifest: ReleaseManifest,
  required: MigrationOutcome[],
  financial: NonproductionFinancialMigrationOutcome,
): Promise<NonproductionFinancialBootstrapCompletion> {
  assertNonproductionFinancialBootstrapEvidence(manifest, required, financial);
  await assertConnectedNonproductionDatabaseTarget(client, target);
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('nonproduction-bootstrap-completion'), hashtext($1))`,
      [financial.releaseManifestDigest],
    );
    const values = [
      financial.releaseManifestDigest,
      financial.migrationArtifactDigest,
      manifest.releaseId,
      manifest.environment,
      required.length,
      financial.status,
    ];
    const inserted = await client.query<BootstrapCompletionRow>(
      `INSERT INTO hxos_nonproduction_bootstrap_completion_v1
         (release_manifest_digest, migration_artifact_digest, release_id,
          release_environment, required_migration_count, financial_migration_status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (release_manifest_digest, migration_artifact_digest) DO NOTHING
       RETURNING release_manifest_digest, migration_artifact_digest, release_id,
                 release_environment, required_migration_count,
                 financial_migration_status, completed_at`,
      values,
    );
    const selected = inserted.rows[0]
      ? inserted
      : await client.query<BootstrapCompletionRow>(
        `SELECT release_manifest_digest, migration_artifact_digest, release_id,
                release_environment, required_migration_count,
                financial_migration_status, completed_at
         FROM hxos_nonproduction_bootstrap_completion_v1
         WHERE release_manifest_digest = $1 AND migration_artifact_digest = $2`,
        values.slice(0, 2),
      );
    const row = selected.rows[0];
    if (!row) throw new Error('NONPRODUCTION_BOOTSTRAP_EVIDENCE_NOT_RECORDED');
    const completion = mapCompletion(row);
    if (
      completion.releaseId !== manifest.releaseId
      || completion.environment !== manifest.environment
      || completion.requiredMigrationCount !== required.length
      || (
        completion.financialMigrationStatus !== financial.status
        && !(
          completion.financialMigrationStatus === 'applied'
          && financial.status === 'already_applied'
        )
      )
    ) {
      throw new Error('NONPRODUCTION_BOOTSTRAP_EVIDENCE_CONFLICT');
    }
    await client.query('COMMIT');
    return completion;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function recordNonproductionFinancialBootstrapCompletion(
  runtime: NonproductionFinancialMigrationRuntime,
  required: MigrationOutcome[],
  financial: NonproductionFinancialMigrationOutcome,
): Promise<NonproductionFinancialBootstrapCompletion> {
  const manifest = assertNonproductionFakeFinanceAuthorized({
    env: runtime.env,
    release: runtime.release,
    identity: runtime.identity,
    component: 'migration',
  });
  const target = assertConfiguredNonproductionDatabaseTarget(runtime.env, runtime.databaseUrl);
  assertNonproductionFinancialBootstrapEvidence(manifest, required, financial);
  const client = runtime.createClient(runtime.databaseUrl);
  await client.connect();
  try {
    return await recordNonproductionFinancialBootstrapCompletionOnConnectedClient(
      client,
      target,
      manifest,
      required,
      financial,
    );
  } finally {
    await client.end();
  }
}

export function defaultNonproductionFinancialDatabaseBootstrapRuntime(): NonproductionFinancialDatabaseBootstrapRuntime {
  return {
    runRequiredMigrationsOnClient: async (client, databaseUrl, expectedTarget) => {
      const requiredRuntime = productionMigrationRuntime();
      if (
        expectedTarget.databaseUrl !== databaseUrl
        || requiredRuntime.databaseUrl !== databaseUrl
      ) {
        throw new Error('NONPRODUCTION_DATABASE_TARGET_REFUSED:CANONICAL_DATABASE_URL_MISMATCH');
      }
      return runEngineAutomationMigrationsOnConnectedClient(client, {
        ...requiredRuntime,
        databaseUrl,
      });
    },
    financialMigration: defaultNonproductionFinancialMigrationRuntime(),
  };
}

/**
 * The single nonproduction database entrypoint. Canonical append-only engine
 * migrations must succeed before the synthetic finance schema is considered.
 */
export async function runNonproductionFinancialDatabaseBootstrap(
  runtime: NonproductionFinancialDatabaseBootstrapRuntime =
    defaultNonproductionFinancialDatabaseBootstrapRuntime(),
): Promise<{
  required: MigrationOutcome[];
  financial: NonproductionFinancialMigrationOutcome;
  completion: NonproductionFinancialBootstrapCompletion;
}> {
  const manifest = assertNonproductionFakeFinanceAuthorized({
    env: runtime.financialMigration.env,
    release: runtime.financialMigration.release,
    identity: runtime.financialMigration.identity,
    component: 'migration',
  });
  const target = assertConfiguredNonproductionDatabaseTarget(
    runtime.financialMigration.env,
    runtime.financialMigration.databaseUrl,
  );
  assertExactFakeFinancialMigrationChain(runtime.financialMigration);
  const exactMigrationArtifactDigest = await runtime.financialMigration.migrationArtifactDigest();
  const artifactDigest = normalizeArtifactDigest(exactMigrationArtifactDigest);
  if (artifactDigest !== manifest.components.migration.artifactDigest) {
    throw new Error('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_MISMATCH');
  }
  assertMigrationExecutionAuthorized({
    env: runtime.financialMigration.env,
    release: runtime.financialMigration.release,
    identity: runtime.financialMigration.identity,
    migrationArtifactDigest: exactMigrationArtifactDigest,
  });
  const client = runtime.financialMigration.createClient(target.databaseUrl);
  await client.connect();
  try {
    await assertConnectedNonproductionDatabaseTarget(client, target);
    const required = await runtime.runRequiredMigrationsOnClient(
      client,
      target.databaseUrl,
      target,
    );
    assertRequiredMigrationEvidence(required);
    const financial = await applyFakeFinancialMigrationChainOnConnectedClient(
      client,
      runtime.financialMigration,
      target,
      releaseManifestDigest(manifest),
      artifactDigest,
    );
    const completion = await recordNonproductionFinancialBootstrapCompletionOnConnectedClient(
      client,
      target,
      manifest,
      required,
      financial,
    );
    return { required, financial, completion };
  } finally {
    await client.end();
  }
}
