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
  runEngineAutomationMigrationsOnConnectedClientWithReceipt,
  type MigrationClient,
  type MigrationOutcome,
  type MigrationRuntime,
  type MigrationSpec,
} from './engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from './engine-automation-migration-files.js';
import { engineMigrationArtifactDigest } from './engine-migration-manifest.js';
import {
  assertMigrationExecutionReceipt,
  assertMigrationExecutionAuthorized,
} from './migration-execution-authority.js';
import {
  abortFakeFinancialMigrationOperation,
  assertFakeFinancialExecutionReceipt,
  authorizeFakeFinancialExecutionSession,
  beginFakeFinancialMigrationOperation,
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES,
  completeFakeFinancialExecutionSession,
  completeFakeFinancialMigrationOperation,
  type FakeFinancialExecutionReceipt,
  type FakeFinancialExecutionSession,
  type FakeFinancialMigrationPlanEntry,
} from './nonproduction-fake-financial-execution.js';
import {
  assertConfiguredNonproductionDatabaseTarget,
  assertConnectedNonproductionDatabaseTarget,
  type ExpectedNonproductionDatabaseTarget,
} from './nonproduction-database-target.js';

export const NONPRODUCTION_FAKE_FINANCIAL_BASE_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[0].name;
export const NONPRODUCTION_FAKE_FINANCIAL_ACCOUNT_REFRESH_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[1].name;
export const NONPRODUCTION_FAKE_FINANCIAL_SETTLEMENT_COMPLETION_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[2].name;
export const NONPRODUCTION_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[3].name;
export const NONPRODUCTION_FAKE_FINANCIAL_TERMINAL_LIFECYCLE_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[4].name;
export const NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_THREE_PHASE_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[5].name;
export const NONPRODUCTION_FAKE_FINANCIAL_CHANGE_ORDER_RECOVERY_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[6].name;
export const NONPRODUCTION_FAKE_FINANCIAL_DISPUTE_RELEASE_GATE_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[7].name;
export const NONPRODUCTION_FAKE_FINANCIAL_SECURITY_EXPIRY_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[8].name;
export const NONPRODUCTION_FAKE_FINANCIAL_EXPIRY_RECOVERY_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[9].name;
export const NONPRODUCTION_FAKE_FINANCIAL_RUNTIME_INSERT_AUTHORITY_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[10].name;
export const NONPRODUCTION_FAKE_FINANCIAL_WORK_ORDER_AUTHORITY_HARDENING_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[11].name;
export const NONPRODUCTION_FAKE_FINANCIAL_WORK_ORDER_BOOTSTRAP_SEAL_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[12].name;
export const NONPRODUCTION_FAKE_FINANCIAL_COMMAND_OUTBOX_MIGRATION =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[13].name;
export const NONPRODUCTION_FAKE_FINANCIAL_MIGRATION =
  NONPRODUCTION_FAKE_FINANCIAL_COMMAND_OUTBOX_MIGRATION;

export const NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES =
  CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES;

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
  financialMigration: NonproductionFinancialMigrationRuntime;
}

export interface NonproductionFinancialMigrationOutcome extends MigrationOutcome {
  migrations: readonly MigrationOutcome[];
  releaseManifestDigest: string;
  migrationArtifactDigest: string;
}

export interface NonproductionFinancialBootstrapCompletion {
  schemaVersion: 1;
  status: 'complete';
  receiptType: 'nonproduction-financial-bootstrap-diagnostic-v1';
  acceptanceEligible: false;
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

interface CanonicalMigrationEvidence {
  name: string;
  sha256: string;
  sourcePaths: readonly string[];
}

interface IssuedFinancialOutcomeProof {
  receipt: FakeFinancialExecutionReceipt;
  entries: readonly Readonly<FakeFinancialMigrationPlanEntry>[];
  databaseUrl: string;
  state: 'available' | 'reserved' | 'consumed';
}

const issuedFinancialOutcomes = new WeakMap<object, IssuedFinancialOutcomeProof>();

function normalizeArtifactDigest(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/u.test(normalized)) return `sha256:${normalized}`;
  if (/^sha256:[0-9a-f]{64}$/u.test(normalized)) return normalized;
  throw new Error('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_INVALID');
}

function sqlSha256(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function exactSourcePath(value: string): string {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function canonicalMigrationSourcePaths(fileName: string): readonly string[] {
  return Object.freeze([
    ...new Set(
      [
        path.join(process.cwd(), 'backend/database/migrations', fileName),
        path.join('/app/backend/database/migrations', fileName),
      ].map(exactSourcePath)
    ),
  ]);
}

async function readCanonicalMigrationSql(fileName: string): Promise<{
  sql: string;
  sourcePaths: readonly string[];
}> {
  const sourcePaths = canonicalMigrationSourcePaths(fileName);
  for (const sourcePath of sourcePaths) {
    try {
      const sql = await readFile(sourcePath, 'utf8');
      if (!sql.trim()) throw new Error('empty canonical migration');
      return { sql, sourcePaths };
    } catch {
      // Continue to the immutable image path.
    }
  }
  throw new Error('NONPRODUCTION_CANONICAL_MIGRATION_SOURCE_UNAVAILABLE');
}

async function canonicalRequiredMigrationEvidence(): Promise<
  readonly CanonicalMigrationEvidence[]
> {
  return Object.freeze(
    await Promise.all(
      REQUIRED_MIGRATION_FILES.map(async ({ name, fileName }) => {
        const canonical = await readCanonicalMigrationSql(fileName);
        return Object.freeze({
          name,
          sha256: sqlSha256(canonical.sql),
          sourcePaths: canonical.sourcePaths,
        });
      })
    )
  );
}

async function canonicalConstitutionalBaselineEvidence(): Promise<CanonicalMigrationEvidence> {
  const sourcePaths = Object.freeze([
    ...new Set(
      [
        path.join(process.cwd(), 'backend/database/constitutional-schema.sql'),
        path.join('/app/backend/database/constitutional-schema.sql'),
      ].map(exactSourcePath)
    ),
  ]);
  for (const sourcePath of sourcePaths) {
    try {
      const sql = await readFile(sourcePath, 'utf8');
      if (sql.trim()) {
        return Object.freeze({
          name: 'constitutional_schema_v1',
          sha256: sqlSha256(sql),
          sourcePaths,
        });
      }
    } catch {
      // Continue to the immutable image path.
    }
  }
  throw new Error('NONPRODUCTION_CANONICAL_BASELINE_SOURCE_UNAVAILABLE');
}

function assertRequiredMigrationEvidence(
  required: readonly MigrationOutcome[],
  canonical: readonly CanonicalMigrationEvidence[]
): void {
  if (required.length !== canonical.length) {
    throw new Error('NONPRODUCTION_REQUIRED_MIGRATION_EVIDENCE_INCOMPLETE');
  }
  for (const [index, expected] of canonical.entries()) {
    const outcome = required[index];
    if (
      !outcome ||
      outcome.migration !== expected.name ||
      !['applied', 'already_applied'].includes(outcome.status) ||
      !expected.sourcePaths.includes(exactSourcePath(outcome.sourcePath)) ||
      outcome.sha256 !== expected.sha256
    ) {
      throw new Error('NONPRODUCTION_REQUIRED_MIGRATION_EVIDENCE_MISMATCH');
    }
  }
}

function assertExactFakeFinancialMigrationChain(
  runtime: NonproductionFinancialMigrationRuntime
): void {
  const exactSpecs = NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES;
  if (
    runtime.migrationSpecs.length !== exactSpecs.length ||
    runtime.migrationSpecs.some((spec, index) => spec.name !== exactSpecs[index]?.name)
  ) {
    throw new Error('NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_CHAIN_MISMATCH');
  }
}

function fakeFinancialMigrationRuntime(
  runtime: NonproductionFinancialMigrationRuntime
): MigrationRuntime {
  return {
    databaseUrl: runtime.databaseUrl,
    migrationSpecs: runtime.migrationSpecs,
    readText: runtime.readText,
    createClient: runtime.createClient,
  };
}

async function exactFakeFinancialMigrationPlan(
  runtime: NonproductionFinancialMigrationRuntime
): Promise<readonly FakeFinancialMigrationPlanEntry[]> {
  assertExactFakeFinancialMigrationChain(runtime);
  const migrationRuntime = fakeFinancialMigrationRuntime(runtime);
  return Object.freeze(
    await Promise.all(
      NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_FILES.map(async (registration, index) => {
        const spec = runtime.migrationSpecs[index];
        if (!spec || spec.name !== registration.name) {
          throw new Error('NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_CHAIN_MISMATCH');
        }
        const [canonical, loaded] = await Promise.all([
          readCanonicalMigrationSql(registration.fileName),
          loadMigrationSql(migrationRuntime, spec),
        ]);
        const sourcePath = exactSourcePath(loaded.sourcePath);
        const canonicalSha256 = sqlSha256(canonical.sql);
        if (
          !canonical.sourcePaths.includes(sourcePath) ||
          sqlSha256(loaded.sql) !== canonicalSha256
        ) {
          throw new Error('NONPRODUCTION_FAKE_FINANCIAL_CANONICAL_SOURCE_MISMATCH');
        }
        return Object.freeze<FakeFinancialMigrationPlanEntry>({
          name: registration.name,
          evidenceTable: registration.evidenceTable,
          sql: loaded.sql,
          sourcePath: loaded.sourcePath,
          sha256: canonicalSha256,
        });
      })
    )
  );
}

async function exactMigrationArtifactDigest(
  runtime: NonproductionFinancialMigrationRuntime,
  expectedDigest: string
): Promise<string> {
  const artifactDigest = normalizeArtifactDigest(await runtime.migrationArtifactDigest());
  if (artifactDigest !== expectedDigest) {
    throw new Error('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_MISMATCH');
  }
  return artifactDigest;
}

function qualifiedEvidenceRelation(evidenceTable: string): string {
  if (!/^hxos_[a-z0-9_]{1,57}$/u.test(evidenceTable)) {
    throw new Error('NONPRODUCTION_FAKE_FINANCIAL_EVIDENCE_RELATION_INVALID');
  }
  return `public.${evidenceTable}`;
}

async function applyVerifiedFakeFinancialMigration(
  session: FakeFinancialExecutionSession,
  client: MigrationClient,
  runtime: NonproductionFinancialMigrationRuntime,
  entry: Readonly<FakeFinancialMigrationPlanEntry>
): Promise<MigrationOutcome> {
  const databaseUrl = runtime.databaseUrl;
  const permit = await beginFakeFinancialMigrationOperation(session, entry, client, databaseUrl);
  let transactionStarted = false;
  try {
    if (runtime.databaseUrl !== databaseUrl) {
      throw new Error('NONPRODUCTION_FAKE_FINANCIAL_DATABASE_URL_SUBSTITUTION');
    }
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [entry.name]);
    await client.query(`CREATE TABLE IF NOT EXISTS public.applied_migrations (
      name TEXT PRIMARY KEY,
      sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(
      'ALTER TABLE public.applied_migrations ADD COLUMN IF NOT EXISTS sha256 CHAR(64)'
    );
    const existing = await client.query<{ name: string; sha256: string | null }>(
      'SELECT name, sha256 FROM public.applied_migrations WHERE name = $1',
      [entry.name]
    );
    let status: MigrationOutcome['status'];
    if (existing.rows.length === 0) {
      await client.query(entry.sql);
      await client.query(
        `INSERT INTO ${qualifiedEvidenceRelation(entry.evidenceTable)}
           (migration_name, migration_sql_sha256)
         VALUES ($1, $2)`,
        [entry.name, entry.sha256]
      );
      await client.query(
        'INSERT INTO public.applied_migrations (name, sha256) VALUES ($1, $2)',
        [entry.name, entry.sha256]
      );
      status = 'applied';
    } else {
      if (existing.rows[0]?.sha256?.trim() !== entry.sha256) {
        throw new Error('NONPRODUCTION_FAKE_FINANCIAL_APPLIED_DIGEST_MISMATCH');
      }
      const evidence = await client.query<{ migration_sql_sha256: string }>(
        `SELECT migration_sql_sha256
         FROM ${qualifiedEvidenceRelation(entry.evidenceTable)}
         WHERE migration_name = $1`,
        [entry.name]
      );
      if (evidence.rows[0]?.migration_sql_sha256 !== entry.sha256) {
        throw new Error('NONPRODUCTION_FAKE_FINANCIAL_SCHEMA_DIGEST_MISMATCH');
      }
      status = 'already_applied';
    }
    // A failed COMMIT has an unknown server outcome. Clear rollback authority
    // before sending it so no later SQL is issued on an ambiguous session.
    transactionStarted = false;
    await client.query('COMMIT');
    completeFakeFinancialMigrationOperation(session, permit, client, databaseUrl);
    return {
      status,
      migration: entry.name,
      sourcePath: entry.sourcePath,
      sha256: entry.sha256,
    };
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    abortFakeFinancialMigrationOperation(session, permit, client, databaseUrl);
    throw error;
  }
}

async function applyFakeFinancialMigrationChainOnConnectedClient(
  client: MigrationClient,
  runtime: NonproductionFinancialMigrationRuntime,
  releaseManifestDigestValue: string,
  artifactDigest: string,
  execution: Awaited<ReturnType<typeof authorizeFakeFinancialExecutionSession>>
): Promise<{
  outcome: NonproductionFinancialMigrationOutcome;
  receipt: FakeFinancialExecutionReceipt;
}> {
  const outcomes: MigrationOutcome[] = [];
  for (const entry of execution.entries) {
    outcomes.push(
      await applyVerifiedFakeFinancialMigration(execution.session, client, runtime, entry)
    );
  }
  const outcome = outcomes.at(-1);
  if (!outcome) throw new Error('NONPRODUCTION_FAKE_FINANCIAL_MIGRATION_CHAIN_EMPTY');
  workerLogger.info({ outcomes }, 'Nonproduction fake-financial migrations verified');
  const receipt = completeFakeFinancialExecutionSession(
    execution.session,
    client,
    runtime.databaseUrl
  );
  const financial = Object.freeze<NonproductionFinancialMigrationOutcome>({
    ...outcome,
    migrations: Object.freeze(outcomes.map((entry) => Object.freeze({ ...entry }))),
    releaseManifestDigest: releaseManifestDigestValue,
    migrationArtifactDigest: artifactDigest,
  });
  issuedFinancialOutcomes.set(financial, {
    receipt,
    entries: execution.entries,
    databaseUrl: runtime.databaseUrl,
    state: 'available',
  });
  return { outcome: financial, receipt };
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
  runtime: NonproductionFinancialMigrationRuntime = defaultNonproductionFinancialMigrationRuntime()
): Promise<NonproductionFinancialMigrationOutcome> {
  const manifest = assertNonproductionFakeFinanceAuthorized({
    env: runtime.env,
    release: runtime.release,
    identity: runtime.identity,
    component: 'migration',
  });
  assertConfiguredNonproductionDatabaseTarget(runtime.env, runtime.databaseUrl);
  assertExactFakeFinancialMigrationChain(runtime);
  const artifactDigest = await exactMigrationArtifactDigest(
    runtime,
    manifest.components.migration.artifactDigest
  );
  const authority = assertMigrationExecutionAuthorized({
    env: runtime.env,
    release: runtime.release,
    identity: runtime.identity,
    migrationArtifactDigest: artifactDigest,
    databaseUrl: runtime.databaseUrl,
  });
  const plan = await exactFakeFinancialMigrationPlan(runtime);
  const manifestDigest = releaseManifestDigest(manifest);
  const client = runtime.createClient(runtime.databaseUrl);
  await client.connect();
  try {
    const execution = await authorizeFakeFinancialExecutionSession({
      authority,
      databaseUrl: runtime.databaseUrl,
      client,
      entries: plan,
    });
    const result = await applyFakeFinancialMigrationChainOnConnectedClient(
      client,
      runtime,
      manifestDigest,
      artifactDigest,
      execution
    );
    return result.outcome;
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
    receiptType: 'nonproduction-financial-bootstrap-diagnostic-v1',
    acceptanceEligible: false,
    releaseManifestDigest: row.release_manifest_digest,
    migrationArtifactDigest: row.migration_artifact_digest,
    releaseId: row.release_id,
    environment: row.release_environment,
    requiredMigrationCount: Number(row.required_migration_count),
    financialMigrationStatus: row.financial_migration_status,
    completedAt: new Date(row.completed_at).toISOString(),
  };
}

async function assertExactRequiredMigrationLedger(
  client: MigrationClient,
  canonical: readonly CanonicalMigrationEvidence[]
): Promise<void> {
  for (const expected of canonical) {
    const result = await client.query<{ name: string; sha256: string | null }>(
      'SELECT name, sha256 FROM public.applied_migrations WHERE name = $1',
      [expected.name]
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0]?.name !== expected.name ||
      result.rows[0]?.sha256?.trim() !== expected.sha256
    ) {
      throw new Error('NONPRODUCTION_REQUIRED_MIGRATION_LEDGER_MISMATCH');
    }
  }
}

async function assertExactFakeFinancialMigrationLedger(
  client: MigrationClient,
  entries: readonly Readonly<FakeFinancialMigrationPlanEntry>[]
): Promise<void> {
  for (const entry of entries) {
    const applied = await client.query<{ name: string; sha256: string | null }>(
      'SELECT name, sha256 FROM public.applied_migrations WHERE name = $1',
      [entry.name]
    );
    if (
      applied.rows.length !== 1 ||
      applied.rows[0]?.name !== entry.name ||
      applied.rows[0]?.sha256?.trim() !== entry.sha256
    ) {
      throw new Error('NONPRODUCTION_FAKE_FINANCIAL_APPLIED_DIGEST_MISMATCH');
    }
    const evidence = await client.query<{ migration_sql_sha256: string }>(
      `SELECT migration_sql_sha256
       FROM ${qualifiedEvidenceRelation(entry.evidenceTable)}
       WHERE migration_name = $1`,
      [entry.name]
    );
    if (evidence.rows.length !== 1 || evidence.rows[0]?.migration_sql_sha256 !== entry.sha256) {
      throw new Error('NONPRODUCTION_FAKE_FINANCIAL_SCHEMA_DIGEST_MISMATCH');
    }
  }
}

async function assertNoUnexpectedAppliedMigrations(
  client: MigrationClient,
  canonicalRequired: readonly CanonicalMigrationEvidence[],
  baseline: CanonicalMigrationEvidence,
  entries: readonly Readonly<FakeFinancialMigrationPlanEntry>[]
): Promise<void> {
  const allowed = new Map<string, string>([
    ...canonicalRequired.map(({ name, sha256 }) => [name, sha256] as const),
    [baseline.name, baseline.sha256] as const,
    ...entries.map(({ name, sha256 }) => [name, sha256] as const),
  ]);
  const result = await client.query<{ name: string; sha256: string | null }>(
    'SELECT name, sha256 FROM public.applied_migrations ORDER BY name'
  );
  const seen = new Set<string>();
  for (const row of result.rows) {
    if (seen.has(row.name) || allowed.get(row.name) !== row.sha256?.trim()) {
      throw new Error('NONPRODUCTION_APPLIED_MIGRATION_SET_MISMATCH');
    }
    seen.add(row.name);
  }
}

function assertNonproductionFinancialBootstrapEvidence(
  manifest: ReleaseManifest,
  required: readonly MigrationOutcome[],
  financial: NonproductionFinancialMigrationOutcome,
  canonicalRequired: readonly CanonicalMigrationEvidence[],
  entries: readonly Readonly<FakeFinancialMigrationPlanEntry>[]
): void {
  assertRequiredMigrationEvidence(required, canonicalRequired);
  if (
    financial.migration !== NONPRODUCTION_FAKE_FINANCIAL_MIGRATION ||
    financial.migrations.length !== entries.length ||
    financial.migrations.some(
      (outcome, index) =>
        outcome.migration !== entries[index]?.name ||
        !['applied', 'already_applied'].includes(outcome.status) ||
        exactSourcePath(outcome.sourcePath) !== exactSourcePath(entries[index]?.sourcePath ?? '') ||
        outcome.sha256 !== entries[index]?.sha256
    ) ||
    financial.status !== financial.migrations.at(-1)?.status ||
    financial.sourcePath !== financial.migrations.at(-1)?.sourcePath ||
    financial.sha256 !== financial.migrations.at(-1)?.sha256 ||
    !['applied', 'already_applied'].includes(financial.status) ||
    !financial.sourcePath?.trim() ||
    financial.releaseManifestDigest !== releaseManifestDigest(manifest) ||
    financial.migrationArtifactDigest !== manifest.components.migration.artifactDigest
  ) {
    throw new Error('NONPRODUCTION_BOOTSTRAP_EVIDENCE_MISMATCH');
  }
}

async function recordNonproductionFinancialBootstrapCompletionOnConnectedClient(
  client: MigrationClient,
  target: ExpectedNonproductionDatabaseTarget,
  manifest: ReleaseManifest,
  required: readonly MigrationOutcome[],
  financial: NonproductionFinancialMigrationOutcome,
  canonicalRequired: readonly CanonicalMigrationEvidence[],
  canonicalBaseline: CanonicalMigrationEvidence,
  entries: readonly Readonly<FakeFinancialMigrationPlanEntry>[],
  receipt: FakeFinancialExecutionReceipt
): Promise<NonproductionFinancialBootstrapCompletion> {
  assertFakeFinancialExecutionReceipt(receipt);
  assertNonproductionFinancialBootstrapEvidence(
    manifest,
    required,
    financial,
    canonicalRequired,
    entries
  );
  await assertConnectedNonproductionDatabaseTarget(client, target);
  let transactionStarted = false;
  await client.query('BEGIN');
  transactionStarted = true;
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('nonproduction-bootstrap-completion'), hashtext($1))`,
      [financial.releaseManifestDigest]
    );
    await assertExactRequiredMigrationLedger(client, canonicalRequired);
    await assertExactFakeFinancialMigrationLedger(client, entries);
    await assertNoUnexpectedAppliedMigrations(
      client,
      canonicalRequired,
      canonicalBaseline,
      entries
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
      values
    );
    const selected = inserted.rows[0]
      ? inserted
      : await client.query<BootstrapCompletionRow>(
          `SELECT release_manifest_digest, migration_artifact_digest, release_id,
                release_environment, required_migration_count,
                financial_migration_status, completed_at
         FROM hxos_nonproduction_bootstrap_completion_v1
         WHERE release_manifest_digest = $1 AND migration_artifact_digest = $2`,
          values.slice(0, 2)
        );
    const row = selected.rows[0];
    if (!row) throw new Error('NONPRODUCTION_BOOTSTRAP_EVIDENCE_NOT_RECORDED');
    const completion = mapCompletion(row);
    if (
      completion.releaseId !== manifest.releaseId ||
      completion.environment !== manifest.environment ||
      completion.requiredMigrationCount !== required.length ||
      (completion.financialMigrationStatus !== financial.status &&
        !(
          completion.financialMigrationStatus === 'applied' &&
          financial.status === 'already_applied'
        ))
    ) {
      throw new Error('NONPRODUCTION_BOOTSTRAP_EVIDENCE_CONFLICT');
    }
    transactionStarted = false;
    await client.query('COMMIT');
    return completion;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function recordNonproductionFinancialBootstrapCompletion(
  runtime: NonproductionFinancialMigrationRuntime,
  required: MigrationOutcome[],
  financial: NonproductionFinancialMigrationOutcome
): Promise<NonproductionFinancialBootstrapCompletion> {
  const manifest = assertNonproductionFakeFinanceAuthorized({
    env: runtime.env,
    release: runtime.release,
    identity: runtime.identity,
    component: 'migration',
  });
  const target = assertConfiguredNonproductionDatabaseTarget(runtime.env, runtime.databaseUrl);
  const proof = issuedFinancialOutcomes.get(financial);
  if (!proof || proof.state !== 'available') {
    throw new Error('NONPRODUCTION_BOOTSTRAP_OPAQUE_FINANCIAL_RECEIPT_REQUIRED');
  }
  if (proof.databaseUrl !== runtime.databaseUrl) {
    throw new Error('NONPRODUCTION_BOOTSTRAP_DATABASE_URL_MISMATCH');
  }
  proof.state = 'reserved';
  try {
    const [canonicalRequired, canonicalBaseline] = await Promise.all([
      canonicalRequiredMigrationEvidence(),
      canonicalConstitutionalBaselineEvidence(),
    ]);
    assertNonproductionFinancialBootstrapEvidence(
      manifest,
      required,
      financial,
      canonicalRequired,
      proof.entries
    );
    const client = runtime.createClient(runtime.databaseUrl);
    await client.connect();
    try {
      const completion = await recordNonproductionFinancialBootstrapCompletionOnConnectedClient(
        client,
        target,
        manifest,
        required,
        financial,
        canonicalRequired,
        canonicalBaseline,
        proof.entries,
        proof.receipt
      );
      proof.state = 'consumed';
      return completion;
    } finally {
      await client.end();
    }
  } catch (error) {
    if (proof.state === 'reserved') proof.state = 'available';
    throw error;
  }
}

export function defaultNonproductionFinancialDatabaseBootstrapRuntime(): NonproductionFinancialDatabaseBootstrapRuntime {
  return {
    financialMigration: defaultNonproductionFinancialMigrationRuntime(),
  };
}

/**
 * The single nonproduction database entrypoint. Canonical append-only engine
 * migrations must succeed before the synthetic finance schema is considered.
 */
export async function runNonproductionFinancialDatabaseBootstrap(
  runtime: NonproductionFinancialDatabaseBootstrapRuntime = defaultNonproductionFinancialDatabaseBootstrapRuntime()
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
    runtime.financialMigration.databaseUrl
  );
  assertExactFakeFinancialMigrationChain(runtime.financialMigration);
  const exactMigrationArtifactDigest = await runtime.financialMigration.migrationArtifactDigest();
  const artifactDigest = normalizeArtifactDigest(exactMigrationArtifactDigest);
  if (artifactDigest !== manifest.components.migration.artifactDigest) {
    throw new Error('NONPRODUCTION_MIGRATION_ARTIFACT_DIGEST_MISMATCH');
  }
  const coreAuthority = assertMigrationExecutionAuthorized({
    env: runtime.financialMigration.env,
    release: runtime.financialMigration.release,
    identity: runtime.financialMigration.identity,
    migrationArtifactDigest: artifactDigest,
    databaseUrl: runtime.financialMigration.databaseUrl,
  });
  const fakeFinancialAuthority = assertMigrationExecutionAuthorized({
    env: runtime.financialMigration.env,
    release: runtime.financialMigration.release,
    identity: runtime.financialMigration.identity,
    migrationArtifactDigest: artifactDigest,
    databaseUrl: runtime.financialMigration.databaseUrl,
  });
  const [plan, canonicalRequired, canonicalBaseline] = await Promise.all([
    exactFakeFinancialMigrationPlan(runtime.financialMigration),
    canonicalRequiredMigrationEvidence(),
    canonicalConstitutionalBaselineEvidence(),
  ]);
  const client = runtime.financialMigration.createClient(runtime.financialMigration.databaseUrl);
  await client.connect();
  try {
    const execution = await authorizeFakeFinancialExecutionSession({
      authority: fakeFinancialAuthority,
      databaseUrl: runtime.financialMigration.databaseUrl,
      client,
      entries: plan,
    });
    const coreExecution = await runEngineAutomationMigrationsOnConnectedClientWithReceipt(
      client,
      {
        ...productionMigrationRuntime(),
        databaseUrl: runtime.financialMigration.databaseUrl,
      },
      coreAuthority
    );
    assertMigrationExecutionReceipt(coreExecution.receipt);
    const required = coreExecution.outcomes;
    assertRequiredMigrationEvidence(required, canonicalRequired);
    await assertExactRequiredMigrationLedger(client, canonicalRequired);
    const executed = await applyFakeFinancialMigrationChainOnConnectedClient(
      client,
      runtime.financialMigration,
      releaseManifestDigest(manifest),
      artifactDigest,
      execution
    );
    const completion = await recordNonproductionFinancialBootstrapCompletionOnConnectedClient(
      client,
      target,
      manifest,
      required,
      executed.outcome,
      canonicalRequired,
      canonicalBaseline,
      execution.entries,
      executed.receipt
    );
    const proof = issuedFinancialOutcomes.get(executed.outcome);
    if (!proof) throw new Error('NONPRODUCTION_BOOTSTRAP_OPAQUE_FINANCIAL_RECEIPT_REQUIRED');
    proof.state = 'consumed';
    return { required, financial: executed.outcome, completion };
  } finally {
    await client.end();
  }
}
